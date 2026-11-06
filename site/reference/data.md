---
title: Data
description: "Where awf keeps what: a run's folder in .awf/runs and each file in it, what awf keeps per machine in ~/.awf, and what is safe to delete."
outline: [2, 3]
---

# Data

awf keeps everything in plain files. A run's record lives in the project it worked in, under
`.awf/runs`, and a few things are kept per machine, under `~/.awf`. There is no database and no
server, so you, an agent or `cat` can read any of it. [How it works](/guide/how-it-works#the-record)
gives the short version; this page is the full layout.

You rarely need to open the files: `awf runs` and `awf logs` read them for you, and
`awf run --json` prints `out.json` ([awf commands](/reference/awf)).

## Where a run is kept

```text
{cwd}/.awf/runs/{workflow}/{id}/
```

- `{cwd}` is `--cwd`, else the folder you ran `awf` in. `--run-root {dir}` replaces `.awf/runs`,
  so the run lands in `{dir}/{workflow}/{id}`.
- `{workflow}` is the workflow's `meta.name`, never its file name. `{id}` is the run's id
  ([Runs](/guide/runs#id-attempts-and-status)).
- A run of a workflow with `events` lives in its workflow file's project: the nearest folder at or
  above the file that holds `.awf/`, else the file's own folder, whoever sends the event
  ([Events](/guide/events)).

awf writes a `.gitignore` holding `*` into the runs folder the first time it makes a run there, so
no run is committed by accident. Only you can open the runs folder and the folders under it,
which keeps everything in them private: they hold the values in prompts, and paths. Files
written whole, such as `run.json` and `screen.txt`, are also mode `0600`; the `.jsonl` files get
your default mode.

## A run's folder

```text
.awf/runs/{workflow}/{id}/
  run.json           what the run is: its arguments and folder, written once
  attempts/{n}.json  each time the run was run: how it ended, and what it returned
  run.jsonl          what the run settled: its stages, agents' sessions, timers and waits
  in.jsonl           the events it was sent (a workflow with events only)
  log.jsonl          what happened, in order: what awf logs shows
  ops/{key}.{n}/     each turn, compaction or decision: what was asked, answered and used
  out.json           the last attempt's result and accounting, as --json prints it
  report.md          the last attempt's report, when the workflow writes one
  launches/          the output of attempts awf started in the background (events only)
  work/              scratch: skills and harness homes for the attempt's agents
.awf/runs/{workflow}/{id}.lock   held while an event is added, or the run is made, woken or parks (events only)
```

The files fall in four groups, and the first is the only one a continue decides from:

| Group | Files | What reads them |
| --- | --- | --- |
| **The record** | `run.json`, `attempts/`, `run.jsonl`, `in.jsonl` | a continue and a wake, to know what is done; `awf runs`, for a run's status |
| **Evidence** | `ops/`, `log.jsonl`, `launches/` | you and `awf logs`; `awf runs` adds up what the operations used |
| **Views** | `out.json`, `report.md` | you; each ended attempt writes them again |
| **Scratch** | `work/` | the agents of the attempt that made it |

A run's status, its current stage and its last attempt are not stored anywhere: `awf runs` works
them out from the files, so they can't go stale.

### Which file to open

| To find out | Open |
| --- | --- |
| what the run returned | `out.json`'s `value`, or the last completed attempt's `value` |
| how each attempt ended, and why | `attempts/{n}.json`: `outcome`, `stage`, `reason` |
| which stages are done, and their values | the `stage` lines of `run.jsonl` |
| what an agent was asked, and what it answered | `ops/{key}.{n}/op.json` and `result.json`; every answer it tried is in `answers.jsonl` |
| why a TUI turn ended without an answer | `ops/{key}.{n}/screen.txt`, the agent's last screen |
| what a turn used | `ops/{key}.{n}/spend.json`, or `awf runs` for the run's total |
| which events came in, and which wait took each | `in.jsonl`, then `run.jsonl`'s `took` and `race` lines |
| what happened, in order | `awf logs`, which reads `log.jsonl` and the agents' sessions |

## A run, read through

This workflow asks an agent to multiply two numbers in one stage, waits 20 seconds for a
`tour.go` event saying what to add, then has the agent add it, or 9, in a second stage:

<<< @/../examples/site/reference/data.ts#tour

An `awf emit` of `tour.start` with `{"a":17,"b":23}` started it, and it ran three times. The first
attempt parked at the race; no `tour.go` came, so `awf tick` woke it once the timer was due, and
the second attempt completed; then
`awf run --continue --from-stage second` redid the second stage. Its folder:

```text
.awf/runs/tour/demo/
  run.json
  attempts/1.json  2.json  3.json
  run.jsonl
  in.jsonl
  log.jsonl
  ops/solver.1/  solver.2/  solver.3/
  out.json
  launches/20261105-0612-01140d.log  20261105-0612-e6e606.log
```

`in.jsonl` holds the one event it was sent, the one that started it:

```json
{"id":"awf.9c797de55bf2f3c1","name":"tour.start","data":{"a":17,"b":23},"from":"operator","at":"2026-11-05T11:12:10.975Z","starts":true}
```

`run.jsonl` tells the three attempts. Trimmed, without each line's `at`:

```json
{"kind":"claimed","attempt":1}
{"kind":"session","attempt":1,"agent":"solver","harness":"codex","session":"01a1ab68-…","operation":"solver.1"}
{"kind":"stage","attempt":1,"name":"first","outcome":"succeeded","started":"…","value":391}
{"kind":"timer","attempt":1,"name":"wake","due":"2026-11-05T11:12:40.685Z","when":"20s"}
{"kind":"wait","attempt":1,"label":"waiting for go or 20s","takes":[{"name":"tour.go"},{"name":"timer:due","from":"wake"}],"race":"wait"}
{"kind":"claimed","attempt":2}
{"kind":"wait","attempt":2,"label":"waiting for go or 20s","takes":[{"name":"tour.go"},{"name":"timer:due","from":"wake"}],"race":"wait"}
{"kind":"race","attempt":2,"name":"wait","branch":"wake","took":[{"id":"awf.timer.51391bf0ab33e827","timer":"wake"}]}
{"kind":"session","attempt":2,"agent":"solver","harness":"codex","session":"01a1ab68-…","operation":"solver.2"}
{"kind":"stage","attempt":2,"name":"second","outcome":"succeeded","started":"…","value":400}
{"kind":"claimed","attempt":3}
{"kind":"session","attempt":3,"agent":"solver","harness":"codex","session":"01a1ab68-…","operation":"solver.3"}
{"kind":"stage","attempt":3,"name":"second","outcome":"succeeded","started":"…","value":409,"redo":true}
```

1. **Attempt 1** writes `claimed`, which makes the file its own, records the agent's codex session as soon as it is known, and
   settles stage `first` with its value. It sets the timer, writes the wait it parks on, and
   ends `parked`.
2. **Attempt 2** runs the code from the top. `first` has a succeeded line, so it is reused and
   writes nothing. The race is entered again: it writes its wait again, finds the timer due,
   and the `race` line says `wake` won and what it took. The agent reopens on the same session, so it remembers 391, and
   `second` settles.
3. **Attempt 3** reuses `first`, and the race, which already has a winner. `--from-stage second`
   makes `second` its start point, so `second` runs again, and its line carries `redo`. The agent
   reopens on the same session once more, which remembers its last answer, 400, so this time it
   answers 409: redoing a stage doesn't rewind an agent's memory. The old line, with 400, stays
   above it: nothing is deleted.

Each attempt also left an operation folder, numbered across the run. `ops/solver.1/op.json` says
what was asked. Trimmed:

```json
{
  "id": "solver.1",
  "attempt": 1,
  "kind": "turn",
  "agent": "solver",
  "execution": { "harness": "codex", "model": "gpt-6-luna", "placement": "headless" },
  "stage": "first",
  "question": "What is 17 multiplied by 23?",
  "schema": { "type": "object", "required": ["answer"], "properties": { "answer": { "type": "integer" } } }
}
```

Beside it, `result.json` holds the answer, `{ "value": { "answer": 391 } }`, and `spend.json` the
tokens the turn used, read from codex's session file. `attempts/2.json` ended `completed` with the
value `{ "first": 391, "second": 400 }`, and `attempts/3.json` with `{ "first": 391, "second": 409 }`:
the latest is the run's result, and `out.json` is that attempt's view of it.

## Each file

### run.json

What the run is, fixed for its life. A continue, and a wake, take its arguments, `--cwd`,
`--sandbox`, `--workspace` and `--keep-panes` from here.

| Field | Meaning |
| --- | --- |
| `format` | the version of the run's record, `1` ([Formats](#formats)) |
| `id`, `workflow` | the run's id and the workflow's `meta.name` |
| `argv` | the workflow arguments as given, not as parsed: a continue parses them again with the code as it is then |
| `cwd` | where every attempt works |
| `sandbox` | `--sandbox`'s spec as its file gave it, or `null` |
| `created` | when the run was made |
| `events`, `env.PATH`, `file` | a run of a workflow with `events` only: the `PATH` every attempt runs with, and the file it was first started from |
| `panes` | `{ workspace?, keep? }`, `--workspace` and `--keep-panes` as given: `"run"`, `"origin"` or `{ "name": … }`, and `never`, `on-failure` or `always`. Absent when neither was, and for a run an event started |

### attempts/{n}.json

One per time the run is run, by `awf run` or by a background launch of `awf emit` or `awf tick`,
numbered from 1. Written when the attempt starts, and again, whole,
when it ends.

| Field | Meaning |
| --- | --- |
| `attempt` | its number |
| `kind` | `attempt`, or `failed-launch` for a background launch that never began (below) |
| `file` | the workflow file it ran |
| `workflowVersion` | the workflow's `meta.version`, when it has one |
| `flags` | `timeout` and `fromStage`, when given |
| `pid`, `processStart` | the process running it, and when that process started: an attempt is live while it has no `ended` and that process exists |
| `launch` | the background launch that started it, whose output is `launches/{launch}.log` |
| `started`, `ended` | its times; no `ended` while it runs, or after a crash |
| `outcome`, `stage`, `reason` | how it ended: `completed`, `parked`, `stopped`, `failed`, `timed-out` or `cancelled`; the stage it ended in, and why, when it didn't complete |
| `value` | with `completed`: what `run` returned, the run's result |
| `messageLimits` | the [messaging](/guide/messaging) limits it ran under |

What an attempt did is not in its file: its stages are its `run.jsonl` lines, and what it used is
its operations' `spend.json`. The events that came in and no wait has taken yet are worked out
from `in.jsonl` and `run.jsonl`'s `wait`, `took` and `race` lines.

- An attempt with no `ended` whose process is gone is `interrupted`
  ([Durability](/guide/durability#after-a-crash)).
- An attempt that `awf emit` or `awf tick` started in the background, and that exited before it
  could begin, such as one whose file no longer loads, is written by the launcher instead:
  `kind: "failed-launch"`, `failed` with its `reason`, its `launch` and the `file` it tried, and
  no process.
- A run is shown, and continued, from the last attempt that ran. Three failed, timed-out or
  crashed attempts in a row make a run with events `stuck`.

### run.jsonl

What the run settled, one JSON line per fact, appended as it happens. This is the file a continue
and a wake read to know what is done. Every line has `kind`, `attempt` and `at`, and is written
whole and synced to disk before the step it settles returns, so a crash loses none that
returned.

An attempt writes `claimed` before anything else. From then on the file is that attempt's: a line
an earlier attempt adds after it is ignored.

**Stages**

| Kind | Fields |
| --- | --- |
| `claimed` | none: the attempt begins writing |
| `stage` | a stage's end: `name`, `outcome` (`succeeded`, `stopped` or `failed`) and `reason`, `started`, `summary`, `value` after a JSON round trip, `provided` when it wasn't run: its value came from `--values`, or it returns nothing and comes before `--from-stage`, `redo` on the stage its attempt started at |

**Agents**

| Kind | Fields |
| --- | --- |
| `session` | an agent's native session, as soon as it is known: `agent`, `harness`, `session`, the `operation` it was seen in, `home`, the agent's own harness home when it has one, `sandbox`, the sandbox it ran in, and `skills`, the skills its harness was given, as `awf open` reopens them |
| `turn-started` | a turn `start()` began: `agent`, `turn`, `meta` and `execution` |
| `turn-ended` | its end, which a wait takes as `agent:ended`: its `id`, `agent`, `turn`, `began`, the attempt that started it, and `end`, what the code was handed. The next attempt writes a failed end for a turn a crash left running |

**Timers and waits**

| Kind | Fields |
| --- | --- |
| `timer` | a timer as first set: `name`, `due`, and `when` as the code gave it; when cancelled, the same line again with `cancelled` |
| `wait` | a wait as it starts: its `label`, what it `takes`, its `stage` or `race`, and outside those the event ids it `acks`, or `returns` when an attempt's first wait hands back what an earlier one took |
| `took` | what a wait returned, by id, with a `stage` when it was in one; held until a later wait acknowledges it |
| `race` | a race's winning `branch`, and what it `took` |

A timer that comes due is never written as an event: the wait or race that takes it names it by
an id awf derives from the timer's name, with `timer` beside it, and a time `wf.at()` read by its
`branch` and `due`.

**What a continue reuses.** A stage's record is its latest `stage` line; when that line
`succeeded`, a continue hands its value back instead of running the stage. Each attempt has a
start point, which its stage line marks `redo`: the stage `--from-stage` names, or, in a run
without events, the first stage it doesn't reuse, a new run's first stage included. A stage
entered after the start point whose line is older than the redo runs again, in this attempt and
the ones after it. Nothing is deleted, so a redone stage's old value, such as a branch it named,
is still in its earlier line. [Durability](/guide/durability#what-a-continue-reuses-and-what-it-redoes)
says what a continue does when the code has changed.

**Where an agent resumes.** An agent's latest `session` line is the session a continue or a
[wake](/reference/workflow-api#events) reopens it on, where it can be: one given skills or a
sandbox, or now on another harness, starts anew.

### in.jsonl

With `events` only: each event senders gave the run, a line each, as it came. A line has `at`,
`id`, `name`, `data`, `from`, and `starts` on the event that started the run. A sender appends
while holding the run's lock, `{id}.lock` beside the run's folder, which is also held while the
run is made or woken, and as it parks. An event that starts a run is in the file before the run's folder appears. What the run
did with each event is in `run.jsonl`'s `wait`, `took` and `race` lines.

### log.jsonl

The run's event log, for people: a line per turn, nudges included, and per compaction, as each
settles, and around them what the run did. Each line has `kind`, `version` and `attempt`, and
every line but a `turn` or `compact` has `at`.

| Kinds | What they record |
| --- | --- |
| `turn`, `compact` | a settled turn or compaction: `agent`, `operationId`, `stage`, `label`, the settings it ran at (`execution`), `deliveredAt`, `settledAt` and `outcome` |
| `attempt-started`, `attempt-ended` | an attempt's span |
| `stage-started`, `stage-ended` | a stage's span; a reused or provided stage writes only its end |
| `operation-started`, `operation-failed` | a turn delivered, or failing before it settled |
| `agent-opened`, `agent-stopped`, `agent-forked` | an agent's life: where it runs, the `sandbox` it was admitted to and the `domains` its harness added there, its skills, its pane and whether that pane was kept |
| `sandbox-opened` | a sandbox, as it opened |
| `log`, `warning` | the workflow's `wf.log`, and awf's warnings |
| `decision-asked`, `decision-ended` | a decision |
| `route-*`, `message-*`, `request-ended`, `participant-*` | [messaging](/guide/messaging) and [people](/guide/people) |
| `tool-called`, `tool-ended`, `tool-refused` | [tools](/guide/tools) |

A line holds no tokens or cost: what a turn used is in its operation's `spend.json`. Nothing a
continue does reads this file. A crash keeps every line written before it, and a line it tore is
skipped. `awf logs` reads this file, `run.jsonl` and the agents' own session files together.

### ops/{key}.{n}/ {#ops}

One folder per operation: an agent's turn, message operation or compaction, or a decision. The
folder's name is the operation's id, the `operationId` of its lines in `log.jsonl` (a decision's
lines call it `operation`):

- `reviewer.3` is the third operation of the agent keyed `reviewer`;
- `triage.2` is the second asking of the decision keyed `triage`.

`{n}` counts from 1 across all the run's attempts, so no attempt writes over another's. A nudge
is part of the operation it nudges. Agents and decisions share one set of keys, so a decision
can't take an agent's key, nor an agent a decision's.

| File | What it holds |
| --- | --- |
| `op.json` | what the operation is: its `id`, `kind` (`turn`, `message`, `compact` or `decision`), when it started (`at`), the `attempt` and `stage` it ran in; but for a decision, the `agent`, its settings (`execution`) and the folder it worked in (`cwd`); for a turn, what the agent was asked and the schema of its answer |
| `answers.jsonl` | every `wfa result` the agent sent, accepted or not, with the error that refused it |
| `result.json` | the one accepted answer |
| `decision.json` | a [decision](/guide/decisions)'s record (model, outcome, tokens), the state and questions sent, and the answers, so a threshold can be fitted again later without asking the model. The record's `artifact` names this file |
| `spend.json` | what an agent's operation used, read from its sessions: its `billing`, its tokens by model (`spend`, absent when they couldn't be read), what was billed per token when the harness reports it, and its times, `deliveredAt` and `settledAt` |
| `live.jsonl` | diagnostics of the operation's delivery and nudges, which nothing decides on |
| `screen.txt` | what a TUI agent's pane showed when the turn or compaction ended without an answer, or its agent failed to start: escape codes stripped, at most its last 64 KiB. `awf logs` names it on the turn's line |

- `op.json` is written as the operation starts, before any line names it, so its number is never
  used again, however it ends. A message operation whose message was withdrawn before it opened
  keeps its folder, so a key's numbers may skip.
- `spend.json` holds no price: `awf runs` and a later attempt's closing line price it as they add
  it up, with today's table. The attempt writes it as it ends. For an attempt that was interrupted,
  or whose read a second Ctrl-C cut short, the next attempt writes it as it starts, with
  `settledBy`, while the sessions are still there. It is written once.
- A refused answer and a screen are kept as evidence, and never read to settle anything. A
  headless agent has no pane, and leaves no `screen.txt`.

### out.json

The last ended attempt's result: what `awf run --json` prints. Each attempt that ends replaces it,
so its `attempt` says whose it is, and an attempt that fails before its workflow starts removes
the earlier one. It is a second copy of what the record keeps: the value is the attempt file's,
what was used the operations', the stages `run.jsonl`'s. Its `accounting` is priced with the table
the attempt ran with. A run that failed or was cancelled once its agents started keeps an
`out.json` too, with what it used and why it ended.

| Field | Meaning |
| --- | --- |
| `version` | `5` |
| `ref` | the run's ref, `{workflow}/{runId}`, as the other run documents have it |
| `runId`, `attempt` | the run's id, and the attempt that wrote this |
| `workflow` | `name` and `file` |
| `outcome` | `completed`, `parked`, `stopped`, `failed`, `timed-out` or `cancelled` |
| `value` | with `completed`: what `run` returned |
| `reason`, `stage`, `needs` | with the last four: why, the stage it ended in, and the stages whose values `--values` must give to start part-way |
| `label`, `until` | with `parked`: its wait's label, and when its earliest timer is due |
| `stages` | each stage it entered, `ran` or `reused`, with its outcome, the attempt that ran it, its time and its summary |
| `report` | the workflow's report, when it wrote one |
| `accounting` | time, tokens and estimated cost: totals, `byStage`, `byModel`, `byAgent`, the price table (`basis`), billing, and the models it has no price for ([Cost](/guide/cost)) |
| `usage` | every turn, with its agent, settings, times, sessions, billing and tokens by model |
| `artifacts` | the run's folder |
| `sandboxes` | each sandbox the run opened, with its spec, provider and the agents in it |
| `skills` | the skills each agent was given, with their source, commit and digest |
| `panes` | where each TUI agent's pane went in Herdr: its `pane` as the workflow wrote it (or a deprecated `layout` and `keepPane`), and in `placed` where it landed and whether it was kept |
| `decisions` | every decision asked |

### report.md

The workflow's report, written when its `report` returns one. An attempt that writes none removes
the earlier attempt's.

### launches/{launch}.log

With `events` only: the output of each attempt that `awf emit` or `awf tick` started in the
background, where there is no terminal to print to. The attempt's file names its `launch`.

### work/

The harness's scratch, used only by the attempt that made it:

- `work/skills/sources/`: the run's checked snapshot of each
  [skill](/guide/agents#instructions-and-skills) its agents are given.
- `work/agents/{uuid}/`: the skills placed for an agent on the host, and a codex agent's own home.
- `work/staging/`: where a harness home is built before it moves into place.
- `work/forks/`: a forked session's files, copied out of a parent with a home of its own.

What each agent was given is in `out.json`'s `skills`, and on its `agent-opened` line.

A codex agent on the host given skills runs with a harness home of its own,
`work/agents/{uuid}/home`, seeded with copies of your codex login. Its sessions are kept there,
not in `~/.codex`, as its `session` line's `home` says, so `awf logs` and the run's usage read
them from the run's folder.

### Formats

`run.json`'s `format` versions the record as a whole: `run.json`, the attempt files, `run.jsonl`
and `in.jsonl`. This awf reads format 1. A run whose `run.json` has no `format`, because an
earlier awf made it, or has another one, or is format 1 but lacks a field it requires, is listed
`unreadable` by `awf runs`, and nothing else of it is read: continuing it, sending it an event or
reading its log is refused, and `awf tick` counts it in one line and leaves it be.

`out.json` has a `version`, as does each line of `log.jsonl`; an operation's files have none. A
newer awf may add fields and kinds of line. A reader of `log.jsonl` skips a kind it doesn't know,
but a reader of `run.jsonl` refuses one, since a continue acts on every line.

The JSON files are replaced whole, never edited in place, so a crash leaves the old file or the
new one. The `.jsonl` files are only appended to. Temporary files and folders (`.tmp-*`,
`.new-*`) that a crash leaves in a workflow's folder or in `attempts/` are ignored, and removed
once they are a day old.

## Per machine: `~/.awf`

What awf keeps for every run on the machine, whatever their run root.

| Path | What it holds |
| --- | --- |
| `~/.awf/projects` | each project awf has started a run with events in, one absolute path a line: where a run named to `awf runs`, `awf logs`, `awf reply` or `awf send` is looked for after the current folder, and what `awf tick --all` wakes |
| `~/.awf/sandboxes/{workflow}/{id}/{uuid}/` | each sandbox a run opened: `homes/`, the harness home of each agent in it, holding a copy of its login and its native session files; under docker, `quarantine/`, where a protected file an agent changed is moved |
| `~/.awf/coordinator/` | a socket per live run that has an outside participant or events, which `awf reply`, `awf send` and an event's nudge reach it through, removed when the run ends; `AWF_COORDINATOR_DIR` moves it ([Configuration](/reference/configuration)) |
| `~/.awf/herdr/config.toml` | the Herdr config of the sessions awf starts: no toasts, no sound. Written when absent and never overwritten, so you may edit it |
| `~/.awf/herdr/sessions/`, `~/.awf/herdr/locks/` | which Herdr workspace each live run's panes are in, and short locks while one is made |
| `~/.awf/callers/` | a mark per session an `awf run --here` is driving, so a second run can't drive it too |

Sandbox homes are outside the project on purpose: no agent can reach `~/.awf`, and a run root that
holds `~/.awf/sandboxes` is refused.

## Elsewhere

- **The skills cache**, `~/.cache/awf/skills` (`$XDG_CACHE_HOME/awf/skills` when that is set): the
  repositories skills were fetched from, kept so the next run fetches less.
- **Each agent's socket and `wfa` launcher**, in a folder of its own under `/tmp/awf-*`, which the
  run removes when it closes.
- **The agents' own sessions**: a harness on the host keeps its session files in its own home, such
  as `~/.claude/projects` or `~/.codex/sessions`. awf doesn't copy them; `awf logs` and each
  operation's `spend.json` are read from them.

## What is safe to delete

Nothing awf keeps is needed by another run, and nothing is read from a deleted run again. What you
lose is the run itself:

- **A run's folder**, once `awf runs` doesn't show it `running`. You lose its record and the
  chance to continue it. A run whose host codex agents were given skills holds copies of your
  codex login in `work/agents/`, so delete its folder, or that folder, once you are done with it.
- **A run's views and scratch, `out.json`, `report.md` and `work/`**, once no attempt of it is
  running: a continue needs none of them. Deleting `work/` loses its codex agents' activity in
  `awf logs`, and what they used if no attempt has read it yet.
- **A parked run with `events`** is not running, but deleting it drops the events it is waiting
  on; a starting event for its id later makes a new run. A run with `events` that has returned
  refuses every later event, so deleting its folder is how its id starts again.
- **All of `.awf/runs`**, when no run in it is running or parked. `git clean -xfd` deletes it
  too, as it does any ignored folder.
- **`~/.awf/sandboxes/{workflow}/{id}`**, once that run has ended and you won't read its sandboxed
  agents with `awf logs` or continue it. Its homes hold copies of your logins, so delete them when
  you are done with a run you sandboxed.
- **The skills cache**, while no run is running: a run fetches a skill whenever an agent given
  one opens. The next run fetches again.
- **Temporary files** (`.tmp-*`, `.new-*`) and a `/tmp/awf-*` folder whose run has ended: awf
  removes them itself; deleting them sooner does no harm once their run is gone.

Keep `~/.awf/projects` while you have runs with events you want `awf tick --all` to wake: a
project missing from it is not woken. Deleting a line for a project you removed is fine.

Don't edit the record to change what a continue does: start part-way with `--from-stage` and
`--values` instead ([Runs](/guide/runs#going-on-from-a-stopped-run)).
