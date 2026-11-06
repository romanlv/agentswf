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
`present` makes of it or, for a workflow without `present` such as `check-readme`, the run's whole
record from `out.json`. So `awf run check-readme.ts > result.json` keeps the record, with the
verdict as its `value`, and none of the progress.

| Flag | What it changes |
| --- | --- |
| `--json` | Standard output gets the run's whole record, its `out.json`, even when the workflow has `present`. A run that doesn't complete prints its record too, once its agents have started. Questions for [a person](/guide/people) are not asked at the terminal. |
| `--no-watch` | Leaves out the tab a docker sandbox's panes get in the run's workspace ([Sandboxes](/guide/sandboxes)). |

When a run has TUI agents, `awf run` prints once, as the first one opens, a line starting
`agents` with the Herdr session the agents are in and the `herdr session attach` command that
shows them. Run it in another terminal to watch the agents work, or to type into one.
[Harnesses](/guide/harnesses) covers panes.

## `awf runs`: where a run stands

```text
$ awf runs
check-readme/20261101-0930-a1b2  running      11-01 09:30  14s
check-readme/20261031-1712-0c4e  completed    10-31 17:12  41s      $0.03
check-readme/20261031-1650-9d1f  stopped      10-31 16:50  2m 05s   $0.06
```

A row per run, newest first: its name, its status, when it started, how long it took, and an
estimate at list prices where its agents reported usage. It lists 20; `--limit {n}` lists another
number. A run of a workflow with [events](/guide/events) that is waiting shows what it waits for.
A run an earlier awf made, before its record had a format, is listed `unreadable`, and nothing
else of it is read ([Data](/reference/data)).

Name a run to see it in depth: its attempts, the stages of the last one, and each agent's state,
turns and last activity. Under it is what to run next.

```text
$ awf runs check-readme/20261101-0930-a1b2
check-readme/20261101-0930-a1b2  running  stage review  14s
  stage review   running    12s
    reviewer          working         turn 1  9s  last: tool Bash  grep -n "awf " README.md (09:30:09)
next: awf logs check-readme/20261101-0930-a1b2 --after c2.WzQsMix7ImExIjozMTg3fV0 --wait 90s
```

A running run ends with a `next:` line, the `awf logs` command that waits for what comes next.
One that ended says where its record is, and why when it didn't complete. A failed one adds a
`see:` line, the logs of the agent that failed, and one that can go on adds its `continue:`
command. A run whose process is gone without ending, as after a crash, is `interrupted`.
[Runs](/guide/runs) says what each status means and how a continue goes on.

## `awf logs`: what a run did

```text
$ awf logs check-readme/20261101-0930-a1b2
check-readme/20261101-0930-a1b2  running  stage review
@e1 09:30:02 attempt 1 started
@e2 09:30:02 review  stage started
@e3 09:30:02 reviewer  opened  claude
@e4 09:30:05 review  reviewer  turn started
@a1.4b1 09:30:06 review  reviewer  prompt  412 chars
@a1.9e2 09:30:09 review  reviewer  tool Bash  grep -n "awf " README.md
next: awf logs check-readme/20261101-0930-a1b2 --after c2.WzQsMix7ImExIjozMTg3fV0 --wait 90s
```

`awf logs` merges two sources by time: the run's own events (stages, turns, messages, tool calls,
`wf.log` lines) and what each agent did in its harness, read from the harness's own session files:
its prompts, its tool calls and their results, its messages. Without a run named it reads the
newest run here, and notes any other that is running. It shows the last 40 events.

Each line starts with a handle: `@e…` for the run's events, `@r…` for a fork's session or one an
agent moved to, from `run.jsonl`, and `@a…` for an agent's activity; `--json` has every agent's
first session too. A line is cut short;
`awf logs {run} @{handle} --full` prints it whole.

```sh
awf logs {run} --agent reviewer       # one agent, and the messages to and from it
awf logs {run} --stage review         # one stage
awf logs {run} @a1.9e2 --full           # one event's whole text
awf logs {run} --limit 200            # more than the last 40
```

`--full` masks common credential shapes, but the text is what the agent saw and wrote: treat it as
you would its session.

Every answer ends with what to run next. While the run goes, that is a `next:` command that gets
only what is new: `--after {cursor}` reads from where the last answer stopped, oldest first, and
`--wait {duration}`, such as `90s` and up to `5m`, waits for the first new event when there is
none yet, answering once it comes or the time is up. Once the run is over the last line says so: `run ended: …`, or
`run interrupted · continue: …`. `--follow` instead prints each event as it comes and returns when
the run ends.

## Following a run from another agent

A coding session can start a run and keep working, or follow a run someone else started. It needs
no tool beyond its shell:

1. **Start it as a long command,** in the background if your harness has one. Its stderr is not a
   terminal, so the first line is `awf: {workflow}/{id} started · watch: awf logs {workflow}/{id}`.
   That line's prefix is stable to match on.
2. **Name the run by that reference** in every later command, never by "the newest": another run
   may start beside it.
3. **Read with the `watch:` command,** then run each answer's `next:` exactly, and stop at an
   answer with no `next:`, which ends `run ended` or `run interrupted`. Each call returns within
   its `--wait`, so it never holds a tool call for the length of the run, as `--follow` would.
4. **Read the result** from the finished `awf run`'s output, or with `awf runs {workflow}/{id}`.

For a program, `--json` on `awf runs` and `awf logs` prints one document, versioned with `"v"`.
`awf logs --json` gives the events with their text, a `cursor`, and `next` as an argument list
while there is more; `awf runs {run} --json`, `"v": 2`, gives the status, attempts, stages and
agents, and `continue` where a run can go on; [awf runs](/reference/awf#runs) lists the states
it uses. `--follow` doesn't take `--json`; page with `--after` and `--wait`. [Runs](/guide/runs) has `awf run`'s exit codes.

To hand the session itself to the run, so that it becomes one of the run's agents, use
`awf run --here`: [Calling session](/guide/calling-session).

## Catches

- **They look where the run is kept.** `awf runs` and `awf logs` read `.awf/runs` under the
  current directory. A run started with `--cwd` or `--run-root` is read with the same flag; the
  commands awf prints repeat it for you.
- **"The newest" moves.** `awf logs` without a run reads whichever run started last here, which
  may not be yours once another starts beside it. Name the run when it matters.
- **The estimate is not a bill.** It prices the tokens the agents reported at list prices;
  [Cost](/guide/cost) says what it does and doesn't mean.

## Next

- [Runs](/guide/runs): statuses, exit codes, and going on from a stopped run.
- [awf](/reference/awf): every option of `awf run`, `awf runs` and `awf logs`.
- [Data](/reference/data): what a run's folder holds.
