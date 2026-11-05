---
title: Data
description: "Where awf keeps what: a run's folder in .awf/runs and each file in it, what awf keeps per machine in ~/.awf, and what is safe to delete."
outline: [2, 3]
---

# Data

awf keeps everything in plain files: a run's record in the project it worked in, under
`.awf/runs`, and a few things per machine under `~/.awf`. There is no database and no server, so
you, an agent or `cat` can read any of it. [How it works](/guide/how-it-works#the-record) gives
the short version; this page is the full layout.

You rarely need to open the files: `awf runs` and `awf logs` read them for you, and
`awf run --json` prints `output.json` ([awf commands](/reference/awf)).

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

awf writes `.gitignore` containing `*` into the runs folder the first time it makes a run there,
so no run is committed by accident. The runs folder, each workflow's and each run's folder are
made readable by you alone, which is what keeps everything in them private: they hold prompts'
values and paths. The JSON records written whole are also mode `0600`; the `.jsonl` files and
`decisions/` get your default mode.

## A run's folder

```text
.awf/runs/
  .gitignore              *
  {workflow}/
    {id}/
      run.json            what the run is: written once, as the run is made
      attempts/
        1.json            one per awf run of this run
        2.json
      run.jsonl           what the run settled: each stage's end, each agent's native session
      log.jsonl           the run's event log
      calls/
        {operationId}/    one per turn: call.json, candidates.jsonl, result.json, screen.txt
      decisions/
        {n}.json          each decision the latest attempt asked
      skills/             the run's checked snapshot of each skill, when agents are given any
      agents/{uuid}/      the skills placed for an agent on the host; a codex agent's own home
      staging/            where a harness home is built before it moves into place
      forks/              a forked session's files, copied out of a parent with a home of its own
      output.json         the last ended attempt's result and accounting
      report.md           the last ended attempt's report, when the workflow writes one
      mailbox.jsonl       with events only: the run's events and what its waits took
      process.log         with events only: the output of attempts awf started in the background
    {id}.lock             with events only: held while an event is added to the run
```

`run.json`, the attempt files and `output.json` each have a `version`, as does each line of
`log.jsonl` and `mailbox.jsonl`; a call's files, the decision files and `run.jsonl`'s lines have
none. A newer awf may add fields and kinds of line; a reader of the log skips a line of a kind it
doesn't know, and refuses a record whose `version` is newer than it reads rather than misread it.
A reader of `run.jsonl` refuses a line of a kind it doesn't know: a continue acts on every line.

The versioned JSON records are replaced whole, never edited in place: a crash leaves the old file
or the new one. The `.jsonl` files are appended to. Temporary files and folders (`.tmp-*`,
`.new-*`) that a crash leaves in a workflow's folder or in `attempts/` are ignored, and removed
once they are a day old.

### run.json

What the run is, fixed for its life. A continue, and a wake, take its arguments, `--cwd`,
`--sandbox`, `--workspace` and `--keep-panes` from here.

| Field | Meaning |
| --- | --- |
| `id`, `workflow` | the run's id and the workflow's `meta.name` |
| `argv` | the workflow arguments as given, not as parsed: a continue parses them again with the code as it is then |
| `cwd` | where every attempt works |
| `sandbox` | `--sandbox`'s spec as its file gave it, or `null` |
| `created` | when the run was made |
| `events`, `env.PATH`, `file` | a run of a workflow with `events` only: the `PATH` every attempt runs with, and the file it was first started from |
| `panes` | `{ workspace?, keep? }`, `--workspace` and `--keep-panes` as given: `"run"`, `"origin"` or `{ "name": … }`, and `never`, `on-failure` or `always`. Absent when neither was, and for a run an event started |

A run's status, current stage and last attempt are not stored: they are read off the other files,
so they can't go stale.

### attempts/{n}.json

One per `awf run` of the run, numbered from 1. Written when the attempt starts, and again, whole,
when it ends.

| Field | Meaning |
| --- | --- |
| `attempt` | its number |
| `file` | the workflow file it ran |
| `workflowVersion` | the workflow's `meta.version`, when it has one |
| `flags` | `timeout` and `fromStage`, when given |
| `pid`, `processStart` | the process running it, and when that process started: an attempt is live while it has no `ended` and that process exists |
| `started`, `ended` | its times; no `ended` while it runs, or after a crash |
| `outcome`, `stage`, `reason` | how it ended: `completed`, `parked`, `stopped`, `failed`, `timed-out` or `cancelled`; the stage it ended in, and why, when it didn't complete |
| `stages` | each stage it entered, `ran` or `reused`, with its outcome, the attempt that ran it, its time and its summary |
| `accounting` | its totals and a row per stage; absent for an attempt that never ended |
| `messageLimits` | the [messaging](/guide/messaging) limits it ran under |
| `unacknowledged` | a completed run with `events` only: how many events in its mailbox no wait took |

An attempt with no `ended` whose process is gone is `interrupted`
([Durability](/guide/durability#after-a-crash)).

### run.jsonl

What the run settled, a line at a time, which a continue reads. Every line has `kind`, `attempt`
and `at`. An attempt writes `claimed` before anything else, and a line an earlier attempt adds
after it is ignored. Each line is written whole and synced before the step it settles returns.

| Kind | Fields |
| --- | --- |
| `claimed` | none: the attempt begins writing |
| `stage` | a stage's end: `name`, `outcome` (`succeeded`, `stopped` or `failed`) and `reason`, `started`, `summary`, `value` after a JSON round trip, `provided` when no turn ran it, `redo` on the stage its attempt started at |
| `session` | an agent's native session, as soon as it is known: `agent`, `harness`, `session`, the `operation` it was seen in, and a sandboxed agent's `home` |

A stage's current record is its latest `stage` line, and a continue reuses it when it
`succeeded`. Every start point is a redo: the stage `--from-stage` names, or the first stage a
continue doesn't reuse, gets `redo`, and from then on a stage entered after it whose line is from
an earlier attempt runs again. Nothing is deleted, so a redone stage's old value, such as a branch
it named, is still in its earlier line. An agent's latest `session` line is the session a
[wake](/reference/workflow-api#events) reopens it on, where it can be: one given skills or a
sandbox, or now on another harness, starts anew.

### log.jsonl

The run's event log: a line per turn, nudges included, and per compaction, as each settles, and
around them what the run did. Each line has `kind`, `version` and `attempt`, and every line but a `turn` or `compact` has `at`.

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

A line holds no tokens or cost: what a turn used is read from the agent's session files once the
attempt ends. Nothing a continue does reads this file; the sessions are `run.jsonl`'s. A crash
keeps every turn that settled before it, and a line it tore is skipped. `awf logs` reads this file
and the agents' own session files together.

### calls/{operationId}/

One folder per turn, named by its operation id, the `operationId` of its lines in `log.jsonl`.

- `call.json`: the prompt the agent was given and its schema.
- `candidates.jsonl`: every `wfa result` the agent sent, accepted or not, with the error that
  refused it. A refused answer is kept as evidence.
- `result.json`: the one accepted answer.
- `liveness.jsonl`: diagnostics of the turn's delivery and nudges, which nothing decides on.
- `screen.txt`: what the agent's pane showed when the turn or compaction ended without an
  answer, or its agent failed to start: escape codes stripped, at most its last 64 KiB. Kept as
  evidence, never read to settle anything. `awf logs` names it on the turn's line. A headless
  agent has no pane and leaves none.

### decisions/{n}.json

Each [decision](/guide/decisions) the attempt asked, numbered from 1 in the order asked: the
record (model, outcome, tokens), the state and questions sent, and the answers, so a threshold can
be fitted again later without asking the model. Numbering starts again with each attempt, which
writes over the files of the same numbers: the folder holds the latest attempt's decisions, with
an earlier attempt's left only past the latest's count.

### output.json

The last ended attempt's result: what `awf run --json` prints. Each attempt that ends replaces it,
so its `attempt` says whose it is. An attempt that fails before its workflow starts removes the
earlier one.

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
| `stages` | each stage entered, as in the attempt file |
| `report` | the workflow's report, when it wrote one |
| `accounting` | time, tokens and estimated cost: totals, `byStage`, `byModel`, `byAgent`, the price table (`basis`), billing, and the models it has no price for ([Cost](/guide/cost)) |
| `usage` | every turn, with its agent, settings, times, sessions, billing and tokens by model |
| `artifacts` | the run's folder |
| `sandboxes` | each sandbox the run opened, with its spec, provider and the agents in it |
| `skills` | the skills each agent was given, with their source, commit and digest |
| `panes` | where each TUI agent's pane went in Herdr: its `pane` as the workflow wrote it (or a deprecated `layout` and `keepPane`), and in `placed` where it landed and whether it was kept |
| `decisions` | every decision asked |

A run that failed or was cancelled once its agents started keeps an `output.json` too, with what
it used and why it ended.

### report.md

The workflow's report, written when its `report` returns one. An attempt that writes none removes
the earlier attempt's.

### Runs with events

A run of a workflow with `events` keeps three more files:

- `mailbox.jsonl`: the run's events as they came, its timers, and which events each wait took.
  Senders, the run and `awf tick` append to it, each holding the run's lock.
- `{id}.lock`, beside the run's folder: that lock, held only while a line is added.
- `process.log`: the output of every attempt that `awf emit` or `awf tick` started in the
  background, where there is no terminal to print to.

### Skills given to agents

An agent given [skills](/guide/agents#instructions-and-skills) gets a copy, made in the run's folder:
`skills/sources/` holds the run's checked snapshot of each, and `agents/{uuid}/` the copy placed
for an agent on the host, while `staging/` is where a harness home is built before it is moved
into place. What each agent was given is in `output.json`'s `skills`.

A codex agent on the host given skills runs with a harness home of its own,
`agents/{uuid}/home`, seeded with copies of your codex login. Its sessions are kept there, not in
`~/.codex`, so `awf logs` and the run's usage read them from the run's folder.

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
  as `~/.claude/projects` or `~/.codex/sessions`. awf doesn't copy them; `awf logs` and the usage
  in `output.json` are read from them.

## What is safe to delete

Nothing awf keeps is needed by another run, and nothing is read from a deleted run again. What you
lose is the run itself:

- **A run's folder**, once `awf runs` doesn't show it `running`. You lose its record and the
  chance to continue it. A run whose host codex agents were given skills holds copies of your
  codex login in `agents/`, so delete its folder, or that folder, once you are done with it. A parked run of a workflow with `events` is not running, but deleting it
  drops the events it is waiting on; a starting event for its id later makes a new run. A run with
  `events` that has returned refuses every later event, so deleting its folder is how its id
  starts again.
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

Don't edit a record to change what a continue does: start part-way with `--from-stage` and
`--values` instead ([Runs](/guide/runs#going-on-from-a-stopped-run)).
