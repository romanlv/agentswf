# 0011 — A run continues from its stages

**Decided:** 2026-10-04, in [[018-workflow-stages|story 018]]; the model is [[runs-and-stages]].
**Amends:** [`foundation.md`](../foundation.md) §10, which shelves journal and resume "after
deciding effect boundaries, persistence and versioning (E6)". This decides all three for one
narrower case, a run continued from its stages, and leaves the journal shelved.

## What was decided

- **A run is one piece of work, with numbered attempts.** It has an id, unique within its workflow:
  given with `--id`, derived by the workflow's `id(args)`, or generated. Each `awf run` of it is an
  attempt. `--continue {id}` adds an attempt with the argv the run was started with.
- **A workflow marks its stages inline,** with `workflow.stage(name, options?, work)`. A stage
  returns nothing, or a value its `result` schema checks. One stage is open at a time, entered at
  most once per attempt.
- **A continue reuses what succeeded and runs the rest.** Until the attempt reaches its start point,
  `--from-stage` or else the first stage with no succeeded record, a stage's work isn't called and
  its recorded value is returned. From the start point on, every stage runs, and the records it
  makes stale move to `replaced/`. A record that no longer fits (its schema rejects it, another
  major `meta.version`) stops the attempt with the command to go on; it never reruns on its own.
- **State moves into the project,** from `~/.awf/runs` to `.awf/runs/{workflow}/{id}/` in the
  run's working directory, as files: `run.json` once, an attempt file each, one record per stage.
  Nothing that can be read off them is stored. Why: a run belongs to the work, is found where the
  work is, and goes when the project goes, as Terraform's state does. The costs, accepted:
  `git clean -xfd` deletes runs, each git worktree has its own, every sandbox provider must hide the
  folder, and runs already in `~/.awf/runs` aren't moved. `--run-root` puts them elsewhere.
- **Stage names are durable keys.** A renamed stage has no record, so a continue reruns it, or
  stops after `--from-stage`; the message lists recorded stages the code never reached.
- **`stop` and `stopped`.** `workflow.stop(reason)` ends an attempt `stopped`, apart from `failed`.
- **A breaking change to the author API:** `present` and `report` take the ending (`completed` with
  its value, or how it stopped, with its stages) instead of the result, so a stopped run can report
  what its stages found. Every workflow with `present` or `report` changes with it.

## Why this isn't the shelved journal

E6 found the journal replays, and that replay is not enough: a step whose real input is the working
tree replays a stale answer silently; a resume reruns every side effect the script performs; an
agent's side effects don't come back with its value; a clock or random value in a prompt never
hits; an unstable fan-out admission order replays nothing; and the key misses the harness version,
model and environment. Its honest scope was read-only fan-outs over inputs pinned in the prompt.
E6 was offline unit tests, with no live runs.

Stages answer each by not replaying calls at all:

- **Effect boundaries are the stages.** A succeeded stage never runs again: reusing it runs no
  code. A stage that is redone, interrupted, or reached after `--from-stage` runs again from its
  start, so its side effects must be safe to repeat. E6's "reruns every side effect" shrinks to the
  side effects of the stages being redone; it doesn't go away. The code between stages runs on
  every attempt, and is the workflow's to keep safe to repeat.
- **What carries over is a value the workflow chose,** checked by a schema, holding world
  identifiers (a branch, a worktree, an MR), not a cache keyed on prompts. Records are keyed by
  stage name, so a clock in a prompt and fan-out order don't arise, and stages can't run in
  parallel.
- **A stale world isn't detected, as with the journal.** A reused value can name a worktree a fresh
  sandbox or `git clean` removed, which is E6's lost agent side effect. The continue shows what it
  reuses and from which attempt, and a check between stages can stop on what it can see.
- **Persistence** is the run folder above: written by one attempt at a time, each record replaced
  whole and turns appended. Claiming the run's folder and each attempt's file, each one system
  call, are the only locks.
- **Versioning** is the operator's: an optional `meta.version`, whose major stops a continue on older
  records, and schemas on every reused value. A minor change reuses; redoing a stage after a fix is
  `--from-stage`. No code is hashed. A change of harness, model or environment doesn't invalidate a
  record; only `meta.version`'s major does.

Restarting after a fix is the main use, so code changing between attempts is expected, the opposite
of deterministic replay.

## What it rules out

- **Replaying calls, turns or steps** to resume inside a stage. An interrupted stage reruns from
  its start. `Steps` stays unbuilt; if it is built, a step is a durable unit inside a stage, and
  needs its own decision on E6's findings.
- **Stages in parallel, nested, or in a child workflow.** Parallel work goes inside one stage. The
  rule can be relaxed later; a workflow relying on it couldn't be taken back.
- **Rerunning a stage silently.** A record that is there but doesn't fit stops the attempt; rerunning
  is the operator's `--from-stage`.
- **Changing a run's input.** argv is fixed for the run; different input is a different run.

## Evidence

- The implement-ticket prototype: two live runs on AIRS-1515, the second continuing in qa after a
  code fix, with a side effect at a stage boundary that ran again (`~/dev/braintrust/agent/workflows/
  implement-ticket/run-notes.md`).
- E6 ([findings](../findings/README.md), "What the journal cannot replay"). Its tests are in git
  history only: `git show fd34b33:experiments/_archive/journal-limits.test.ts`.
- GitHub Actions' runs and attempts, `dbt retry`, make's rule that a rebuilt step outdates
  what follows; Temporal, Restate and DBOS for what not to copy ([[runs-and-stages#Later, on the
  same model]]).
