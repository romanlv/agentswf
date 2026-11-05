---
title: awf commands
description: Every awf command, with its usage, options and exit codes, as the command itself prints them.
outline: [2, 3]
pageClass: wrap-text-blocks
---

# awf commands

`awf` is the operator's command: you run workflows, follow them and answer them with it. An agent
inside a run never types `awf`; it answers with [`wfa`](/guide/how-it-works#the-words).

Each command's help below is the file `awf {command} -h` prints, included as it is, so this page
and the command can't disagree. The prose around it says what the command is for and which page
teaches it.

## Help {#help}

```sh
awf -h               # the commands, grouped; also awf, awf help, awf --help
awf help run         # one command's usage, options, exit codes; awf run -h
awf help reference   # every command's usage lines, on one page
awf --version
```

An unknown command exits 2 and names the commands it is closest to; a workflow file given as a
command gets the `awf run` line it meant.

## JSON {#json}

With `--json`, stdout always ends with one document. When the command worked, it is the
result. When it failed, it is a refusal, and stderr still says why, for people:

```json
{"v": 1, "code": "no-run", "error": "no run review-mr/7 under /work/.awf/runs, or in a project awf knows"}
```

A document with `code` is a refusal; no result has one. Check for it first, as the exit code
doesn't tell them apart: `awf emit` exits 1 with a full result when the run's attempt didn't
start, and `awf tick` exits 1 with the runs it woke when it couldn't wake some. A command that
prints a line per item, as `awf inbox --json` does, ends with its refusal. A usage error is a
refusal too, whenever `--json` is anywhere in the arguments before `--`. The exit codes are each
command's own, as its help says.

A code means the same in every command that prints it, and is the word
[`ClientError`](/reference/client-api#clienterror) throws for the same failure:

| `code` | The command failed because | Printed by |
| --- | --- | --- |
| `usage` | its arguments can't be parsed, or two of them clash | every command |
| `no-run` | there is no such run | `run`, `emit`, `runs`, `logs`, `inbox`, `reply`, `send` |
| `ambiguous` | a run's id names runs of two workflows or projects; with `choices` when they are known | `emit`, `runs`, `logs`, `inbox`, `reply`, `send` |
| `id` | a run or event id the grammar refuses, or one another run has | `run`, `emit`, `runs`, `logs`, `inbox`, `reply`, `send` |
| `file` | the workflow file is missing, doesn't load, or doesn't export the workflow | `run`, `emit` |
| `event` | the workflow doesn't take the event's name or data, or takes no events | `emit` |
| `prepare` | the workflow refuses its arguments or options | `run`, `emit` |
| `no-id` | a workflow with events, and no run named | `run` |
| `other-args` | a run there, started with other arguments or options | `run` |
| `not-started` | no attempt started: Ctrl-C, a session not taken, a claim given up, or a run that is running, completed or gone | `run` |
| `unreachable` | the run's files can't be read, or it doesn't answer | `run`, `emit`, `runs`, `logs`, `inbox`, `reply`, `send` |
| `cursor` | a cursor or handle doesn't fit | `logs`, `inbox` |
| `no-engine`, `other-engine` | the project's `agentswf` is missing, or another version than this awf | `run`, `emit`, `runs`, `logs`, `inbox`, `reply`, `send` |
| `project` | the workflow isn't in a project | `run`, `emit` |
| `internal-error` | something failed that isn't the caller's, such as a file awf couldn't write; `error` says what | every command |

`awf reply` and `awf send` also refuse for the [participant's reasons](#reply).

A command's `--json` carries `"v"`, which changes when a field is renamed or removed. It is 1 for
every command but two at 2: `awf runs {run} --json`, whose agent and stage states are
[a fixed set](#runs), and `awf send --json` and `awf reply --json`, whose refusal `stopped` is
[`peer-stopped`](#reply). A refusal carries its command's `"v"`.

## Durations {#durations}

`--timeout` and `--wait` take a duration, as a workflow does: a decimal and `s`, `m`, `h` or `d`,
such as `90s`, `1.5h` or `1d`. Until 0.1.0 two older forms still work, each with a line on
standard error naming its replacement: a whole number of `ms`, `--timeout 500ms`, and a bare
number of seconds for `--wait`, `--wait 90`.

## Run a workflow

### awf run {#run}

Starts a run of a workflow file, or continues one with `--id` and `--continue`.
[Quick start](/guide/quick-start) runs one for the first time; [Runs](/guide/runs) covers ids,
attempts, stages, `--continue`, `--from-stage` and `--values`, and owns the exit codes of an
attempt. `--timeout` is on [Timeouts](/guide/timeouts), `--sandbox` on
[Sandboxes](/guide/sandboxes), `--here` on [Calling session](/guide/calling-session), and
`--workspace` and `--keep-panes` on [Harnesses](/guide/harnesses#where-panes-go).

```text
<!--@include: @/../packages/engine/src/help/run.txt-->
```

### awf test {#test}

Runs a workflow's tests, each agent replaced by scripted answers: no agent starts, nothing is
metered. [Testing](/guide/testing) teaches writing them; the [Testing API](/reference/testing-api)
lists the calls.

```text
<!--@include: @/../packages/engine/src/help/test.txt-->
```

### awf init {#init}

Sets up a folder for writing workflows, with a `hello` workflow and its test to start from.
[Quick start](/guide/quick-start) begins with it.

```text
<!--@include: @/../packages/engine/src/help/init.txt-->
```

### awf emit {#emit}

Sends an event to a workflow with events, starting its run or waking the one that waits; or, by
the run's ref, to a run that is there, as a participant's message to its code, `{key}:reply`.
[Events](/guide/events) covers workflows with events; [Hosting events](/guide/hosting-events)
calls `awf emit` from a webhook or a CI job.

```text
<!--@include: @/../packages/engine/src/help/emit.txt-->
```

### awf tick {#tick}

Wakes the waiting runs of workflows with events whose timers are due, and continues the ones that
crashed. Run it on a schedule: [Hosting events](/guide/hosting-events) covers that.

```text
<!--@include: @/../packages/engine/src/help/tick.txt-->
```

## Look at runs

### awf runs {#runs}

Lists the runs here, or shows one in depth: its attempts, its stages, what each agent is doing,
and what to run next. [Following runs](/guide/following-runs) teaches it.

```text
<!--@include: @/../packages/engine/src/help/runs.txt-->
```

In `awf runs {run}`, and its `--json`, an agent's state is one word, the one `wfa peers` uses:

| State | The agent |
| --- | --- |
| `idle` | has had no turn yet |
| `working` | is in a turn |
| `waiting` | is in a turn, after `wfa waiting`; `live` has its reason and check-in |
| `awaiting-reply` | is in a turn, awaiting a peer's reply; `live` names the peer and until when |
| `answered`, `unanswered`, `blocked`, `timed-out`, `failed`, `cancelled` | ended its last turn so |
| `stopped` | was stopped while in a turn |
| `interrupted` | was in a turn when the run's process went (version 1 said `was working`) |

A stage's state is `running`, `interrupted`, `reused`, `provided`, or how it ended: `succeeded`,
`stopped` or `failed`.

### awf logs {#logs}

What a run did and is doing, its events and its agents' sessions merged by time, read once or
followed. [Following runs](/guide/following-runs) teaches it, including following a run from
another agent.

```text
<!--@include: @/../packages/engine/src/help/logs.txt-->
```

## Coordinate a run from outside

### awf inbox {#inbox}

Reads what agents said to a participant outside the run, a person or an app, and what it said
back. [Answering for a participant](/guide/people) teaches it.

```text
<!--@include: @/../packages/engine/src/help/inbox.txt-->
```

### awf reply and awf send {#reply}

`awf reply` answers a question an agent asked; `awf send` messages an agent first, or, with
the deprecated `--event-id`, a run's code, which `awf emit {run} {key}:reply` replaces. They
share one help.
[Answering for a participant](/guide/people) teaches both.

<a id="send"></a>

```text
<!--@include: @/../packages/engine/src/help/reply.txt-->
```

With `--json`, each prints one line, `{"v": 2, "code": "delivered", "id": …}`, or a refusal with
its `code` and `error`: `not-found`, `ended`, `no-participant`, `unknown-agent`, `ambiguous`
(with `choices`), `expired`, `no-route`, `peer-stopped`, `closed`, `too-large`, `limit`,
`inbox-full`, or `unsupported-version`, when the run's engine is another version of awf than the
command's, as after installing awf anew while the run is live. Version 1 named `peer-stopped`
`stopped`.

## This machine

### awf allowance {#allowance}

What is left of each harness's plan, as the harness itself shows it.
[Harnesses](/guide/harnesses) explains subscription and metered; [Cost](/guide/cost) covers a
run's time and tokens.

```text
<!--@include: @/../packages/engine/src/help/allowance.txt-->
```
