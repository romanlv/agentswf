---
title: Following runs
description: Watching a run while it goes and reading it after, from your terminal or from another agent, with awf run's progress, awf runs and awf logs.
---

# Following runs

A run takes minutes, sometimes hours, and you don't have to sit in the terminal that started it.
Three things show you what it is doing: `awf run`'s own progress, `awf runs` for where the run
stands, and `awf logs` for what it did, event by event, its agents' own work included. All of it
is read from the run's record, so any terminal, or another agent, can follow a run it didn't
start. The examples follow `check-readme`, the one-stage workflow on
[How it works](/guide/how-it-works#a-small-workflow).

```sh
awf runs                                  # the runs here, newest first
awf runs check-readme/{id}                # one run: its stages, its agents, what to run next
awf logs check-readme/{id} --follow       # each event as it comes, until the run ends
```

## What `awf run` shows

On a terminal, `awf run` keeps one block redrawn in place: the run's name, its current stage and
how long it has taken; a row per stage, `✓` once it succeeded, `↺` when it was reused, and the
current one with each agent working in it, its model, placement and time; and the stages an
earlier attempt recorded, still to come, dimmed. A line from `wf.log` or a message between agents
prints above the block. When the run ends, the block keeps each stage's row with what its agents
used, and a closing block says how the run ended and where its record is.

Anywhere else, such as piped to a file or run from an agent's shell, it writes one line per
change, timed from the start, after a first line that names the run:

```text
awf: check-readme/20261101-0930-a1b2 started · watch: awf logs check-readme/20261101-0930-a1b2
[0:00] ▶ stage review
[0:00] ▶ reviewer · sonnet
[0:41] ✓ reviewer · 41s
[0:41] ✓ stage review · 41s
```

All of that goes to standard error. Standard output carries only the result: what the workflow's
`present` makes of it, or its value as JSON. So `awf run check-readme.ts > verdict.json` keeps the
answer and nothing else.

| Flag | What it changes |
| --- | --- |
| `--json` | Standard output gets the run's whole record, its `output.json`, instead of what `present` makes of the result; a run that failed or was cancelled once its agents started prints its record too. A coordinator's questions are not asked at the terminal. |
| `--no-watch` | A sandbox with its own Herdr, as a docker box has, gets no tab in the run's workspace; awf still prints the command that shows its panes. |

When an agent runs in a pane, `awf run` prints where once, as the first one opens:

```text
agents   herdr session {session} · workspace "awf check-readme {id} #1" · HERDR_DISABLE_SOUND=1 herdr session attach {session}
```

Attach from another terminal to watch the agents work, or to type into one.
[Harnesses](/guide/harnesses) covers panes.

## `awf runs`: where a run stands

```text
$ awf runs
messaging/20261012-2309-a2e5    completed    10-12 23:09  50s     $0.01
review-loop/20261012-2120-d300  cancelled    10-12 21:20  1m11s   $0.21
review-loop/20261012-2117-0dc5  completed    10-12 21:17  1m36s   $1.09
```

A row per run, newest first: its name, its status, when it started, how long it took, and an
estimate at list prices where its agents reported usage. It lists 20; `--limit {n}` lists another
number. A run of a workflow with [events](/guide/events) that is waiting shows what it waits for.

Name a run to see it in depth: its attempts, the stages of the last one, and each agent's state,
turns and last activity. Under it is what to run next.

```text
$ awf runs review-loop/20261012-2120-d300
review-loop/20261012-2120-d300  cancelled  1m11s  $0.21
    reviewer:maintainability   cancelled    1 turn
    reviewer:correctness       answered     1 turn  last: message  788 chars (21:20:47)
reason: workflow cancelled by operator
records: /work/app/.awf/runs/review-loop/20261012-2120-d300 (report.md, output.json)
continue: awf run examples/minimum-review/review-loop.ts --id 20261012-2120-d300 --continue
```

A running run ends with a `next:` line, the `awf logs` command that waits for what comes next. A
failed one ends with a `see:` line, the logs of the agent that failed. A run whose process is
gone without ending, as after a crash, is `interrupted`, and ends with its `continue:` command.
[Runs](/guide/runs) says what each status means and how a continue goes on.

## `awf logs`: what a run did

```text
$ awf logs messaging/20261012-2309-a2e5 --limit 6
messaging/20261012-2309-a2e5  completed
(showing 6 of 23; raise --limit for more)
@e18 23:10:04 reviewer  message 2 observed
@e19 23:10:04 reviewer  turn ended  answered  39s
@e20 23:10:04 route reviewer → implementer closed  attempt-ended
@e21 23:10:04 implementer  stopped
@e22 23:10:04 reviewer  stopped
@e23 23:10:04 attempt 1 ended  completed
run ended: completed in 50s · result: awf runs messaging/20261012-2309-a2e5
```

`awf logs` merges two sources by time: the run's own events (stages, turns, messages, tool calls,
`wf.log` lines) and what each agent did in its harness, read from the harness's own session files:
its prompts, its tool calls and their results, its messages. Without a run named it reads the
newest run here, and notes any other that is running.

Each line starts with a handle: `@e…` for the run's events, `@a…` for an agent's activity. A
line is cut short; the handle gets it whole.

```sh
awf logs {run} --agent reviewer       # one agent, and the messages to and from it
awf logs {run} --stage review         # one stage
awf logs {run} @a1.646cf --full       # one event's whole text
awf logs {run} --limit 200            # more than the last 40
```

`--full` masks common credential shapes, but the text is what the agent saw and wrote: treat it as
you would its session.

Every answer ends with the command that gets only what is new. While the run goes, that is:

```text
next: awf logs check-readme/20261101-0930-a1b2 --after c1.WzgseyJhMSI6NDI2ODQwfV0 --wait 90
```

`--after {cursor}` reads from where the last answer stopped, oldest first. `--wait {seconds}`, up
to 300, waits for the first new event when there is none yet, and answers once it comes or the
time is up. `--follow` instead prints each event as it comes and returns when the run ends.

## Following a run from another agent

A coding session can start a run and keep working, or follow a run someone else started. It needs
no tool beyond its shell:

1. **Start it as a long command,** in the background if your harness has one. Its stderr is not a
   terminal, so the first line is `awf: {workflow}/{id} started · watch: awf logs {workflow}/{id}`.
   That line's prefix is stable to match on.
2. **Name the run by that reference** in every later command, never by "the newest": another run
   may start beside it.
3. **Read with the `watch:` command,** then run each answer's `next:` exactly, and stop at
   `run ended`. Each call returns within its `--wait`, so it never holds a tool call for the
   length of the run, as `--follow` would.
4. **Read the result** from the finished `awf run`'s output, or with `awf runs {workflow}/{id}`.

For a program, `--json` on `awf runs` and `awf logs` prints one document, versioned with `"v": 1`.
`awf logs --json` gives the events with their text, a `cursor`, and `next` as an argument list
while there is more; `awf runs {run} --json` gives the status, attempts, stages and agents, and
`continue` where a run can go on. `--follow` doesn't take `--json`; page with `--after` and
`--wait`.

To hand the session itself to the run, so that it becomes one of the run's agents, use
`awf run --here`: [Calling session](/guide/calling-session).

## Catches

- **They look where the run is kept.** `awf runs` and `awf logs` read `.awf/runs` under the
  current directory. A run started with `--cwd` or `--run-root` is read with the same flag; the
  commands awf prints repeat it for you. A run you name is also looked for in each project where
  awf started a run with events.
- **"The newest" moves.** `awf logs` without a run reads whichever run started last here, which
  may not be yours once another starts beside it. Name the run when it matters.
- **The estimate is not a bill.** It prices the tokens the agents reported at list prices;
  [Cost](/guide/cost) says what it does and doesn't mean.

## Next

- [awf](/reference/awf): every option and exit code of `awf run`, `awf runs` and `awf logs`.
- [Runs](/guide/runs): statuses, attempts, and going on from a stopped run.
- [Data](/reference/data): what a run's folder holds.
