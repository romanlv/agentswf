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
| `parked` | a workflow with events waits with no process ([Events](/guide/events)) | 0 |
| `stopped` | `wf.stop(reason)`, or a stage awf can neither reuse nor run (see [going on](#going-on-from-a-stopped-run) below) | 3 |
| `failed` | the workflow threw | 1 |
| `timed-out` | the attempt passed `--timeout` | 1 |
| `cancelled` | a signal, such as Ctrl-C | 128 + the signal's number |

A refusal, such as an id that's taken or a flag a continue can't take, exits 2 and starts no
attempt.

A completed attempt prints what the workflow's `present` makes of its value; a workflow without
`present` prints the whole `out.json` record. Any other ending prints the stage it ended in,
why, and the exact command to go on.

`awf runs` and `awf logs`, which read runs rather than start them, exit 0 on any read that worked,
1 when there is no such run (for `awf logs`, also a cursor or handle that doesn't fit it), 2 on a
usage error, and 3 when the run's files can't be read.

## Stages

In outline, with the work left out (the sample above has it whole):

```ts
const plan = await wf.stage("plan", { result: PLAN, summary: (p) => p.doc }, async () => { … });
await wf.stage("notify", async () => { … }); // no result: it only has to happen
```

A stage runs its work once and records what it returns, checked by its `result` schema.
`summary` is its line in the progress view. On a later attempt a stage with a succeeded record is
**reused**: its work isn't called, no agent in it is opened or asked anything, and `wf.stage`
returns the recorded value.

That gives a stage three rules:

- **Its only output is its return value.** A variable assigned inside a reused stage stays unset.
  Return what later stages need: a path, a branch, a commit.
- **Code between stages runs on every attempt**, agent turns included. Keep it safe to repeat;
  pushing, posting, creating things and turns you don't want repeated go inside a stage.
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
A record it can't reuse, because the code changed under it, stops the attempt at that stage;
[Durability](/guide/durability) says when, and what a continue redoes after a crash.

### Redo from a stage

```sh
awf run ship-ticket.ts --id ABC-1 --continue --from-stage build
```

`--from-stage` reuses everything before the stage and runs it and every stage after it, even ones
that succeeded. Use it when a stage's record is wrong, after a fix you want this run to have, or
on a completed run: a plain continue of a completed run is refused, with its recorded stages
listed to choose from.

A run with [events](/guide/events) redoes the same way, on a continue, and its record differs
from a plain run's only in when the later records move: each as the code reaches its stage, not
all at once. The stages before it are reused by content. After it, in this attempt and every later
one, a stage whose record is older than the redo runs again when the code enters it, so an attempt
that parks partway still leaves the next wake to redo the rest. A race keeps the answer it
recorded, so a stage after one runs on the same event; an event `receive` or `select` took and
acknowledged isn't taken again, so a stage that handled one isn't reached, keeps its record and
isn't redone. An attempt that would park before it reaches the stage stops instead, as one that
never reaches it does.

### Start part-way

A new run can start at a stage too, with nothing recorded before it: a build for a plan written by
hand. Each earlier stage that returns a value needs one, given in a file. In three steps:

1. Start at the stage. The attempt stops before any stage's work runs, and lists each value it
   needs as a type, such as `plan: {doc: string}`, with the command to go on, ending
   `--values {file}`:

   ```sh
   awf run ship-ticket.ts --from-stage build -- ABC-1
   ```

2. Write the values, a JSON object by stage name, to `values.json`:

   ```json
   { "plan": { "doc": "docs/ABC-1.md" } }
   ```

3. Run the printed command with your file:

   ```sh
   awf run ship-ticket.ts --id ABC-1 --continue --from-stage build --values values.json
   ```

Each value is checked against its stage's `result` and recorded as if the stage had run. A stage
with no `result` needs no value. `--values` goes only with `--from-stage`.

## The record

A run's record, `out.json` and the rest, is kept in `.awf/runs/{workflow}/{id}`:
[How it works](/guide/how-it-works#the-record) says what's in it, and [Data](/reference/data) has
the layout. A new run whose first attempt ends before its workflow starts, such as a harness that
fails to install, leaves no folder, so the same command starts it again.

## Catches

- **A continue runs in the project the run is kept in.** It looks in `.awf/runs` under `--cwd`,
  so continue from the same directory, or give the same `--cwd` or `--run-root`.
- **A reused stage is not checked against the world.** The branch it recorded may have been
  deleted since; a check between stages can stop on what it can see.

## Next

- [Durability](/guide/durability): what survives a crash or a code change between attempts.
- [Stages](/reference/workflow-api#stages) in the workflow API, and `awf run` in
  [the awf reference](/reference/awf).
- [Continuing an earlier attempt](/reference/testing-api#continuing-an-earlier-attempt): test
  a continue for free, as this page's sample is.
- [Plan, implement, review](/patterns/plan-implement): a full workflow in stages.
