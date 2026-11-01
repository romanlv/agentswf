---
title: Durability
description: What survives a failed step, a stop, a crash, a closed laptop or a code change, and what a continue reuses and redoes.
---

# Durability

A run of coding agents takes minutes to hours, and things go wrong partway through: an agent
gives no answer, you press Ctrl-C, the machine reboots, or you fix a bug in the workflow and want
to go on. This page says what is still there afterwards and what `--continue` does with it, so
you know what you are paying for again. [Runs](/guide/runs) explains ids, attempts and the
`--continue` command itself.

The short version: a run keeps the value of each **stage** that succeeded. Whatever ends an
attempt, the next one reuses those values and picks up at the first stage without one.

## An example

Three stages, each one agent turn:

<<< @/../examples/site/guide/durability.ts#flow

Say the reviewer rejects the fix. The attempt stops in `review`, with `plan` and `implement`
recorded. You fix the code, or nothing at all, and go on:

```sh
awf run fix-issue.ts --id 212 --continue
```

`plan` and `implement` are reused: their work isn't called and no agent is asked anything. Each
`wf.stage(…)` call returns the value recorded the first time, and `review` runs again. A test
shows it, with no agents and no cost:

<<< @/../examples/site/guide/durability.test.ts#continue

## What survives what

| What happens | The attempt ends | What is kept | What a continue does |
| --- | --- | --- | --- |
| The work in a stage throws, such as a turn's outcome you turn into an error | `failed` | every stage that succeeded; this one recorded `failed` | redoes this stage, then the rest |
| `wf.stop(reason)` inside a stage | `stopped` | as above; this one recorded `stopped` | redoes this stage |
| `wf.stop(reason)` between stages | `stopped` | every stage record, unchanged | runs the code between stages again, so the check checks again |
| `--timeout` runs out | `timed-out` | as for a throw; the stage it was in is recorded `failed` | redoes that stage, with no deadline unless you give one again |
| Ctrl-C, `kill`, or the terminal closing | `cancelled` | as for a throw; the open stage is recorded `failed` | redoes that stage |
| A crash: `kill -9`, a second Ctrl-C, the power, a reboot | no ending: the run reads `interrupted` | every stage that ended before it; the one in flight has no record | starts at the stage in flight |
| The laptop lid closes | nothing ends: awf and its agents sleep with the machine | everything | nothing to do: the attempt is still running |
| You change the code between attempts | | every stage record | runs the new code, reusing records that still fit it ([below](#when-the-code-changes)) |
| The run completed | `completed` | everything | refused, unless `--from-stage` names a stage to redo |

A stage is the unit: nothing finer is kept. Two agent turns in one stage are redone together, so
a step worth keeping on its own is a stage of its own. A workflow with no stages keeps nothing to
reuse, and a continue runs all of it again.

A sleep that ends in a shutdown, or a battery that runs out, is a crash.

## What a continue reuses and what it redoes

As the workflow enters each stage, the continue decides:

- **Before the start point,** each stage with a succeeded record is reused. Its value is checked
  against the stage's `result` schema as it is now, and handed back; its work is never called.
- **The start point** is the first stage entered with no succeeded record, or the stage
  `--from-stage` names. From there, every stage runs, even those that succeeded before: a review
  of an implementation that is being redone is stale. Their old records move to `replaced/` in
  the run's folder; nothing is deleted.

Two things run on every attempt whatever was reused: the code between stages, and the agents,
which start fresh and remember nothing of the reused stages. That is why the `review` prompt above
names the commit and the branch. [Runs](/guide/runs#stages) has the rules this gives a stage.

The progress view marks each reused stage `↺`, with the attempt that ran it, and its age once it
is over an hour old, so a stale record doesn't slip past you.

## When the code changes

Continuing after a fix is the main use, so a code change is expected. The run belongs to the
workflow's `meta.name`, not its file: you can continue from a moved or copied file. awf checks
what it reuses, from coarse to fine:

| What changed | What happens |
| --- | --- |
| `prepare` no longer accepts the run's recorded arguments | the continue is refused: start a new run |
| `meta.version`'s major (under `0.x`, its minor) | the attempt stops at the first stage recorded by the old version |
| A stage's `result` schema rejects its recorded value | the attempt stops at that stage, listing the problems |
| A stage was added or renamed | it has no record, so a plain continue starts there |
| A stage was removed | its record is never asked for, and moves to `replaced/` at the next start point |
| A prompt, a model or anything else | records are reused as they are |

Each stop names the stage, and the command it prints goes on with `--from-stage {stage}`, which
redoes it and everything after. A minor version, a reworded prompt or a new model redoes
nothing: whether this run should redo a stage after a fix is your call, made with `--from-stage`.
An optional field added to a `result` keeps old records valid; a required one means redoing that
stage.

## After a crash

Every record file but the appended logs is written to a temporary file and renamed into place,
so a crash leaves the old file or the new one, never half of either. An attempt with no ending whose process is gone reads
`interrupted` in `awf runs` and `awf logs`, and `awf logs` prints the command that goes on.

The next attempt names each interrupted one and the Herdr workspace its panes may still be open
in, `awf fix-issue 212 #1`, and leaves them alone: you may be reading one. The agents' turns
up to the crash are in the run's event log, `turns.jsonl`. An interrupted attempt has no usage
totals in its record, since those are written when an attempt ends.

Two `awf run --continue` of one run at once can't both run: the second is refused, naming the
attempt still running and its process.

## Runs that wait for events

A workflow with `events` parks between events: its attempt ends `parked` and its process exits.
A parked run has nothing to lose to a crash or a closed laptop. Events sent meanwhile wait in its
mailbox, and the next event, or `awf tick` once a timer is due, continues it. Its agents reopen
on the sessions they had (after a crash, on new ones), its stages are reused wherever they are
entered, and after a crash the events it took and never acknowledged come back once. [Events](/guide/events) covers these runs.

## Catches

- **A stage runs its work, then writes its record.** A crash between the two runs the work
  again on the next attempt. A push or a post that must not happen twice checks first whether it
  already did.
- **A test sees the second attempt only if you write one.** `testWorkflow` with `recorded` runs
  the workflow as a continue, which catches a variable assigned inside a stage and read after it,
  or a turn between stages that a continue would ask again.
- **A check on a stage's value belongs inside that stage.** Written between stages, a continue
  reuses the value and stops again. awf notices a continue that ran no stage and stopped where
  the last attempt did, and says which stage to redo.
- **The runs live in `.awf/runs`,** in the directory the run works in, ignored by git.
  `git clean -xfd` deletes them, and with them everything a continue would reuse.

## See also

- [Runs](/guide/runs): ids, attempts, `--continue`, `--from-stage` and `--values`.
- [Stages](/reference/workflow-api#stages) in the workflow API.
- [Continuing over recorded stages](/reference/testing-api#continuing-over-recorded-stages):
  testing a workflow's second attempt.
- The full model, with the record formats:
  [`design/runs-and-stages.md`](https://github.com/romanlv/agentswf/blob/main/docs/design/runs-and-stages.md)
  on GitHub.
