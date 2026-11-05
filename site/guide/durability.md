---
title: Durability
description: What survives a failed step, a stop, a crash, a closed laptop or a code change, and what a continue reuses and redoes.
---

# Durability

A run of coding agents takes minutes to hours, and things go wrong partway through: an agent
gives no answer, you press Ctrl-C, the machine reboots, or you fix a bug in the workflow and want
to go on. This page says what is still there afterwards and what a continue does with it, so you
know what runs again. [Runs](/guide/runs) explains ids, attempts and the commands.

The short version: a run keeps the value of each **stage** that succeeded. Whatever ends an
attempt, the next one reuses those values and picks up at the first stage without one.

## An example

Three stages, each one agent's turn:

<<< @/../examples/site/guide/durability.ts#flow

You start it with an id, so you can come back to it:

```sh
awf run fix-issue.ts --id 212 -- "#212: dates before 1970 parse as null"
```

Say the reviewer never answers. The attempt stops in `review`, with `plan` and `implement`
recorded. You go on:

```sh
awf run fix-issue.ts --id 212 --continue
```

`plan` and `implement` are reused: their work isn't called, so no agent is opened or asked
anything, and each `wf.stage(…)` returns the value recorded the first time. Only `review` runs
again. A test shows it, with no agents and no cost:

<<< @/../examples/site/guide/durability.test.ts#continue

## What survives what

| What happens | The attempt ends | What is kept | What a continue does |
| --- | --- | --- | --- |
| The work in a stage throws | `failed` | every stage that succeeded; this one recorded `failed` | redoes this stage, then the rest |
| `wf.stop(reason)` inside a stage | `stopped` | as above; this one recorded `stopped` | redoes this stage |
| `wf.stop(reason)` between stages | `stopped` | every stage record, unchanged | runs the code between stages again, so the check checks again |
| `--timeout` runs out | `timed-out` | as for a throw; the stage it was in is recorded `failed` | redoes that stage, with no deadline unless you give one again |
| Ctrl-C, `kill`, or the terminal closing | `cancelled` | as for a throw; the open stage is recorded `failed` | redoes that stage |
| A crash: `kill -9`, a second Ctrl-C before the attempt has ended, the power, a reboot | no ending: the run reads `interrupted` | every stage that ended before it; the one in flight has no record | starts at the stage in flight |
| The laptop sleeps | nothing, until it wakes | everything | depends on how it then ends ([below](#a-sleeping-laptop)) |
| You change the code between attempts | | every stage record | runs the new code, reusing the records that still fit it ([below](#when-the-code-changes)) |
| The run completed | `completed` | everything | refused, unless `--from-stage` names a stage to redo |

In a run without events, a crash inside the stage `--from-stage` named leaves that redo to the
next continue: it starts at that stage again, and says so. It doesn't carry the crashed attempt's
`--values`, so a stage before it with no record to reuse stops for its value.

A stage is the unit: nothing finer is kept. Two agent turns in one stage are redone together, so
a step worth keeping on its own is a stage of its own. A workflow with no stages keeps nothing to
reuse, and a continue runs all of it again.

### A sleeping laptop

Sleep pauses awf and its agents, but not the clock. A deadline is a time of day, so the time
asleep counts against `--timeout` and every other deadline, and a run past its deadline ends
`timed-out` soon after the machine wakes. A sleep that ends in a shutdown is a crash.

## What a continue reuses and what it redoes

As the workflow enters each stage, the continue decides:

- **Before the start point,** each stage with a succeeded record is reused. Its value is checked
  against the stage's `result` schema as it is now, and handed back; its work is never called.
- **The start point** is the first stage entered with no succeeded record, or the stage
  `--from-stage` names. From there, every stage runs, even those that succeeded before: a review
  of an implementation that is being redone is stale. Their old records stay in the run's
  `run.jsonl`; nothing is deleted.
- **Agents start fresh.** A continue opens its agents anew, and they remember nothing of the
  stages it reused. That is why the `review` prompt names the commit and the branch.

The progress view marks each reused stage `↺`, with the attempt that ran it, and its age once it
is over an hour old, so a stale record doesn't slip past you.

## When the code changes

Continuing after a fix is the main use, so a code change is expected. The run belongs to the
workflow's `meta.name`, not its file: you can continue from a moved or copied file. awf checks
what it reuses, from coarse to fine:

| What changed | What happens |
| --- | --- |
| `prepare` no longer accepts the run's recorded arguments | the continue is refused: start a new run |
| `meta.version`'s major (under `0.x`, its minor), when both the record and the code have one | the attempt stops at the first stage recorded by the other version |
| A stage's `result` schema rejects its recorded value, or the stage gained or lost a `result` | the attempt stops at that stage, saying why |
| A stage was added or renamed | it has no record, so a plain continue starts there; after `--from-stage`, the attempt stops, listing the recorded stages it never reached |
| A stage was removed | its record is never asked for, and stays in `run.jsonl` |
| A prompt, a model or anything else | records are reused as they are |

Each stop names the stage, and the command it prints goes on with `--from-stage {stage}`, which
redoes it and everything after. A minor version, a reworded prompt or a new model redoes
nothing: whether this run should redo a stage after a fix is your call, made with `--from-stage`.
An optional field added to a `result` keeps old records valid; a required one means redoing that
stage.

## After a crash

An attempt with no ending whose process is gone reads `interrupted` in `awf runs` and
`awf logs`, and `awf logs` prints the command that goes on. The next attempt names each
interrupted one and the Herdr workspace its panes were in, the one named
`awf fix-issue 212 #1`. Those panes stay open until the next run that opens a TUI agent, which
closes the workspaces of runs whose process is gone. The agents' turns up to the crash are in the
run's event log. What it used is read from its agents' sessions by the next attempt, as it starts,
and counted in the run's [cost](/guide/cost#where-the-numbers-come-from).

Two continues of one run at once can't both run: the second is refused, naming the attempt still
running and its process.

## Runs that wait for events

A workflow with `events` parks between events, with no process left running, so a crash or a
closed laptop costs it nothing. Its stages work differently: one that succeeded is reused for the
rest of the run, whatever `meta.version` the code has, so the table
[above](#when-the-code-changes) doesn't apply to it. [Events](/guide/events) covers these runs.

## Catches

- **A crash can leave an agent working.** Each agent's harness runs in a process group of its
  own, so killing awf doesn't kill it, and it may still be editing your files. Check that none
  from the crashed attempt is still running before you continue.
- **A stage runs its work, then writes its record.** A crash between the two runs the work
  again on the next attempt. A push or a post that must not happen twice checks first whether it
  already did.
- **A check on a stage's value belongs inside that stage.** Written between stages, a continue
  reuses the value and stops again. awf notices a continue that ran no stage and stopped where
  the last attempt did, and says which stage to redo.
- **A renamed stage has no record.** A plain continue runs it and every stage after it.
- **The runs live in `.awf/runs`** under the folder the run works in, which awf keeps out of git
  ([the record](/guide/how-it-works#the-record)). Deleting it, as `git clean -xfd` does, deletes
  everything a continue would reuse.

## See also

- [Runs](/guide/runs): ids, attempts, `--continue`, `--from-stage` and `--values`.
- [Stages](/reference/workflow-api#stages) in the workflow API.
- [Continuing an earlier attempt](/reference/testing-api#continuing-an-earlier-attempt):
  testing a workflow's second attempt, which catches code that only works on the first.
- The full model, with the record formats:
  [`design/runs-and-stages.md`](https://github.com/romanlv/agentswf/blob/main/docs/design/runs-and-stages.md)
  on GitHub.
