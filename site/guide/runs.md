---
title: Runs
description: A run's id, attempts and status, how an attempt ends, and going on from a stopped run with stages, --continue, --from-stage and --values.
---

# Runs

A [run](/guide/how-it-works#the-words) is one piece of work, such as shipping a ticket. Agents
stop without answering, a laptop closes, a prompt turns out wrong: a run is built for that. You
mark its steps as stages, and when an attempt stops part-way, the next one reuses every stage that
succeeded and starts at the one that didn't.

<<< @/../examples/site/guide/runs.ts

Saved as `ship-ticket.ts`:

```sh
awf run ship-ticket.ts -- ABC-1                   # attempt 1: the planner answers, the builder doesn't
awf run ship-ticket.ts --id ABC-1 --continue      # attempt 2: plan is reused, build runs
```

The first attempt records `plan`, then stops in `build` and exits 3. The second doesn't open the
planner at all: `wf.stage("plan", …)` returns the value attempt 1 recorded, and only `build` runs.

## Id, attempts and status

A run is named `{workflow}/{id}`: `meta.name`, and an id that is, in order of preference,

- given with `--id`;
- returned by the workflow's `id(args)`, as `ship-ticket` does, so the run of `ABC-1` is always
  `ship-ticket/ABC-1`;
- or generated: local time and four hex digits, `20261004-1532-a7f3`.

An id is letters, digits, `.`, `_`, `@` and `-`, starting with a letter or digit, up to 128
characters. A new run on an id that exists is refused, as is one that differs from it only in case.

Each `awf run` of a run is an **attempt**, numbered from 1. `wf.runId` is the same in every
attempt, and `wf.attempt` is the attempt's number.

A run's status is read off its last attempt: `running` while its process is alive, how it ended
once it has, and `interrupted` when it never ended and its process is gone, as after a crash.
[Following runs](/guide/following-runs) shows it with `awf runs`.

## How an attempt ends

| Outcome | When | Exit code |
| --- | --- | --- |
| `completed` | the workflow returned | 0 |
| `stopped` | `wf.stop(reason)`, or a stage awf can neither reuse nor run: a record that no longer fits, a value `--from-stage` lacks | 3 |
| `failed` | the workflow threw | 1 |
| `timed-out` | the attempt passed `--timeout` | 1 |
| `cancelled` | a signal, such as Ctrl-C | 128 + the signal's number |

A refusal, such as an id that's taken or a flag a continue can't take, exits 2 and starts no
attempt. A workflow with events can also end `parked`, waiting with no process:
[Events](/guide/events) covers it.

A completed attempt prints what the workflow's `present` makes of its value, or the value as JSON.
Any other prints the stage it ended in, why, and the exact command to go on.

## Stages

```ts
const plan = await wf.stage("plan", { result: PLAN, summary: (p) => p.doc }, async () => { … });
await wf.stage("notify", async () => { … }); // no result: it only has to happen
```

A stage runs its work once and records what it returns, checked by its `result` schema.
`summary` is its line in the progress view. On a later attempt a stage with a succeeded record is
**reused**: its work isn't called, no agent in it is opened or asked anything, and `wf.stage`
returns the recorded value.

That gives a stage four rules:

- **Its only output is its return value.** A variable assigned inside a reused stage stays unset.
  Return what later stages need: a path, a branch, a commit.
- **Code between stages runs on every attempt.** Keep it safe to repeat; pushing, posting and
  creating things go inside a stage.
- **Agents start fresh in each attempt.** The builder above knows nothing of the planner's
  session, so its prompt names the plan's file.
- **One stage at a time, each name once per attempt.** A loop or a `parallel` goes inside a
  stage. Names are lowercase letters, digits, `.`, `_`, `@` and `-`.

A `wf.stop` inside a stage records that stage stopped, so a continue redoes it. Between stages it
changes no record, and a continue runs the same check again. A check that means "redo this
stage" belongs inside the stage.

## Going on from a stopped run

```sh
awf run ship-ticket.ts --id ABC-1 --continue
```

`--continue` adds an attempt to the run `--id` names, with the arguments, `--cwd` and `--sandbox`
it was started with: giving others is refused, since different input is a different run. It
reuses the stages that succeeded, up to the first with no succeeded record, and runs from there.

The file may have changed since: fixing the workflow and continuing is the main use. A record is
reused only while its value fits the stage's current `result`, and while `meta.version` has the
same major (the same minor under `0.x`). A record that fails either stops the attempt at that stage
rather than rerunning it, and the stop names the command to go on.

### Redo from a stage

```sh
awf run ship-ticket.ts --id ABC-1 --continue --from-stage build
```

`--from-stage` reuses everything before the stage and runs it and every stage after it, even ones
that succeeded. Use it when a stage's record is wrong, after a fix you want this run to have, or
on a completed run: a plain continue of a completed run is refused, with its recorded stages
listed to choose from.

### Start part-way

A new run can start at a stage too, with nothing recorded before it: a build for a plan written by
hand. Each earlier stage that returns a value needs one, from `--values`, a JSON file of values by
stage name:

```sh
awf run ship-ticket.ts --from-stage build -- ABC-1
awf run ship-ticket.ts --id ABC-1 --continue --from-stage build --values values.json
```

```json
{ "plan": { "doc": "docs/ABC-1.md" } }
```

Without `--values`, the first command stops before any stage's work runs and lists each value it
needs, with its schema; the command it prints to go on names the file. Each value is checked
against its stage's `result` and recorded as if the stage had run. A stage with no `result` needs
no value. `--values` goes only with `--from-stage`.

## The record

A run is kept in `.awf/runs/{workflow}/{id}` under `--cwd`, or under `--run-root` when you give
one. awf ignores `.awf/runs` in git for you. Each attempt and each stage record is a small file
there, beside `output.json`, the last attempt's full result, which `awf run --json` prints.
[Data](/reference/data) has the layout.

A new run whose first attempt ends before its workflow starts, such as a harness that fails to
install, leaves no folder, so the same command starts it again.

## Catches

- **A continue runs in the project the run is kept in.** It looks in `.awf/runs` under `--cwd`,
  so continue from the same directory, or give the same `--cwd` or `--run-root`.
- **The world isn't checked.** A reused stage's branch may have been deleted since. Its record
  says which attempt made it; a check between stages can stop on what it can see.
- **A renamed stage has no record.** A plain continue runs it; after `--from-stage` it stops,
  listing the recorded stages the code never reached.
- **Agent turns between stages run again on every attempt.** Put them inside a stage unless
  repeating them is the point.

What survives a crash, a closed laptop or a killed process, and what a continue redoes after one,
is [Durability](/guide/durability).

## Next

- [Stages](/reference/workflow-api#stages) in the workflow API, and `awf run` in
  [the awf reference](/reference/awf).
- [Continuing over recorded stages](/reference/testing-api#continuing-over-recorded-stages): test
  a continue for free, as this page's sample is.
- [Plan, implement, review](/patterns/plan-implement): a full workflow in stages.
