---
id: "003"
title: Report what a failed run spent
summary: A run that fails or is cancelled still reads its agents' spend, rejects with it, and keeps it in output.json.
type: story
status: done
discovered_in: "story 002, Task 3"
depends_on: ["002"]
---

# Report what a failed run spent

## Outcome

A run whose body throws, overruns its deadline, fails cleanup or is cancelled still reads what
every agent spent. `runWorkflow` rejects with a `WorkflowRunError` that carries the same usage,
times and accounting a successful result does, with the original error as its `cause`. `awf run`
prints the accounting and writes `output.json` for that run, marked with how it ended.

Why now: an autoresearch loop pays for the variants that fail as well as the ones that finish. The
variant matrix ([`variant-matrix-runner`](todo/variant-matrix-runner.md)) records a failed run as a
row with its spend, not a gap. Today a variant that crashes after twenty agents looks free.

## Scope

In scope:

- reading usage on every failure path of a run that opened its host;
- the error `startWorkflow`'s result rejects with;
- `OutputRecord` version 2, with an outcome, written for every run that opened its host;
- `awf run` printing the accounting, and with `--json` the record, for a failed run.

Out of scope:

- a run that fails before its host opens: no agent ran, and it still rejects with the plain error;
- keeping a successful body's value when only cleanup failed;
- reading v1 `output.json` files: nothing in the repository reads them.

## Context and evidence

- Fact: on failure `startWorkflow` throws before `ledger.settle`, so nothing is read
  (`packages/engine/src/workflow-runner.ts`, the `result` closure). Story 002 says so under
  "Out of reach". The todo's claim that usage is already read on failure was wrong.
- Fact: `RunLedger.settle(signal)` returns the records unread when `signal` is already aborted
  (`packages/engine/src/run-usage.ts`). A cancelled run's signal is aborted by the cancellation,
  so passing it through would lose exactly the runs an operator stopped.
- Fact: a stop that arrives while spend is being read cuts the read short, and a test holds that
  (`run-usage.test.ts`, "stopping the run while its spend is read keeps the records as they
  settled").
- Fact: `OutputRecord` is written only by `operator-cli.ts`. `review-recall-scorer` plans to read
  it; nothing reads it yet.
- Constraint: `packages/contract` is pure; the record type changes there, the I/O stays in engine.
- Constraint: reading spend is bounded by `ACCOUNTING_GRACE_MILLISECONDS` (20 s) plus the status
  command bound. A cancelled `awf run` can now take that long to exit; a second Ctrl-C still kills
  the process, as the CLI's handlers are `once`.

## Code map

### engine

- `packages/engine/src/workflow-runner.ts` — `startWorkflow`, `WorkflowRunResult`,
  `WorkflowRunHandle.stop`: settle on every path; reject with `WorkflowRunError`; `stop` treats a
  `WorkflowRunError` caused by cancellation as the stop it asked for.
- `packages/engine/src/operator-cli.ts` — `runOperatorCli`, `findCancellation`, `errorDetail`:
  write the record on failure and look through `cause`.
- `packages/engine/src/run-usage.ts` — checked; `settle` needs no change.
- `packages/engine/src/index.ts` — re-exports `workflow-runner`, so the error is public.
- Tests: `workflow-runner.test.ts` asserts `WorkflowCancelledError`, `DeadlineExceededError` and
  `AggregateError` on `handle.result`; those now look at `cause`. `run-usage.test.ts` gains the
  failed-run reads. `tests/operator-cli.test.ts` drives `runOperatorCli` with an injected runtime;
  Task 2 adds the failed-run record to it.

### contract

- `packages/contract/src/records.ts` — `OutputRecord`, `OUTPUT_RECORD_VERSION`.

### docs

- `examples/README.md`, `docs/status.md`, `todo/variant-matrix-runner.md`,
  `todo/review-recall-scorer.md` mention `output.json` or depend on this story.

## Proposed design

**Engine.** One type holds what a finished run is known by, spend included:

```ts
export type SettledRun = {
  runId: string;
  usage: SettledOperation[];
  startedAt: string;
  finishedAt: string;
  accounting: RunAccounting;
};
export type WorkflowRunResult<Result> = SettledRun & { value: Result };
export class WorkflowRunError extends Error implements SettledRun { /* cause: the run's error */ }
```

- Every path after the host opens reaches `ledger.settle`. A failure then rejects with
  `WorkflowRunError`, whose `cause` is exactly what is thrown today — the body's error, or the
  `AggregateError` with cleanup errors — and whose message is that error's message.
- The read's signal is a fresh one that aborts on a stop arriving after the read begins. The
  stop or deadline that ended the body does not cut its own read short.
- `letFinish` still runs only for a successful body; a failed run's turns are killed with the host.

**Record.** `OutputRecord` version 2 is a union on `outcome`:

```ts
type OutputRecord = {
  version: 2; runId; workflow; accounting; usage; artifacts;
} & (
  | { outcome: "succeeded"; value: JsonValue; report?: string }
  | { outcome: "failed" | "cancelled"; error: string }
);
```

`cancelled` is the operator stopping the run; a deadline is `failed`. `error` is the text `awf run`
already prints.

**CLI.** On a `WorkflowRunError`, `awf run` writes `output.json`, prints the accounting to stderr
as on success, then the existing "run failed" line. With `--json` it also prints the record on
stdout, since `outcome` says it failed; without it stdout stays empty. Exit codes are unchanged.

Alternatives rejected:

- A result union such as `{ ok: false, error, accounting }` — every caller changes, and one that
  forgets to check `ok` takes a failure for a success.
- Adding the accounting to the thrown error object — it mutates an error the engine does not own,
  and a workflow can throw a value that is not an object.
- Leaving `output.json` to successful runs, or a separate `failure.json` — the user chose one
  record for every run, so a reader finds each run in the same place.
- Reading a cancelled run's spend under the cancelling signal — it returns at once, unread.

## Tasks at a glance

- [x] 1. A failed or cancelled run rejects with its spend
- [x] 2. `awf run` keeps and prints a failed run's record

## Open questions

None.

## Task execution rule

Process one task at a time, through the gates in [`README.md`](README.md).

## Task details

### 1. A failed or cancelled run rejects with its spend

Outcome: `handle.result` rejects with a `WorkflowRunError` carrying settled usage and accounting.

Execution:

- [x] Plan
- [x] Implement
- [x] Review
- [x] Resolve
- [x] Verify

Work:

- `SettledRun`, `WorkflowRunError`, settling on the failure path under its own signal, and `stop`.
- Existing runner tests updated to look at `cause`.

Done when:

- a body that throws after an agent logged spend rejects with that spend in `usage` and in
  `accounting`, and `cause` is the body's error;
- the same holds for a run cancelled through `stop` and through the caller's signal, and for a
  deadline;
- a stop during a failed run's read still cuts it short;
- a failure before the host opens rejects with the plain error.

### 2. `awf run` keeps and prints a failed run's record

Outcome: every run that opened its host leaves an `output.json` that says how it ended. A run
directory without one is a run whose host never opened, or whose process was killed (a second
Ctrl-C).

Execution:

- [x] Plan
- [x] Implement
- [x] Review
- [x] Resolve
- [x] Verify

Work:

- `OutputRecord` v2 in contract; the CLI writes it on success and failure.
- Failed-run cases in `tests/operator-cli.test.ts`.
- `examples/README.md` and `status.md`.

Done when:

- a failing workflow leaves `output.json` with `outcome: "failed"`, its `error` and its spend, and
  exits 1; a cancelled one says `cancelled` and exits 130;
- `--json` prints that record on stdout for a failed run; stdout is empty without it;
- a successful run's record is unchanged but for `version` and `outcome`.

## Verification

Automated:

- [x] `bun test` — 441 pass, 0 fail (2026-09-24)
- [x] `bun run check` — clean

Live, on subscription sessions (2026-09-24; Herdr 0.8.2):

- [x] `WF_LIVE_EVAL=1 bun tests/failed-run.eval.ts`, added by this story: a crash after a codex
  answer exits 1 with `outcome: "failed"` and 19k tokens known; a SIGINT during the second turn
  exits 130 with `outcome: "cancelled"` and 38k tokens known. 20 s, ~$0.05.
- [x] `WF_LIVE_EVAL=1 bun tests/minimum-review.eval.ts`: passes, and now reports its spend — its
  host wrapper had dropped the factory's accounting. 42 s, ~$0.29, usage known 2/2.
- [x] `bun awf run examples/quick-check/workflow.ts -- codex`: `outcome: "succeeded"`, version 2.
- [x] `bun run eval`, after the evals moved to cheap models (codex `gpt-6-luna`, claude haiku)
  and the control plane to `/tmp`: 3/3 passed, ~$0.12. Ctrl-C to its process group cancelled the
  running eval's agent, left no codex process or `/tmp/awf-*` directory, and started no other eval.

## Review record

### Task 1

- Architecture and scope: checked the seam (the error belongs in engine beside
  `WorkflowCancelledError`; contract untouched), interface size, compatibility of `stop` and the
  CLI's cancellation lookup, and scope. Findings:
  - Important — a stop after the body ended but before the read began was ignored, so the read ran
    its full grace. Fixed: the read's controller exists from the start and any stop after the body
    ends aborts it; test "a stop during a finished run's cleanup skips the read", which fails
    against the first version.
  - Minor — the read's abort listener was never removed. Fixed.
  - Minor — the host-construction test would pass on a wrapped error. Fixed: it asserts the plain
    error.
- Correctness and proof: checked races around stop, a second stop, the deadline path, whether
  settle can hang, listener leaks, and that each test fails when the fix is reverted. Findings:
  - Important — the same stop-before-read gap. Fixed as above.
  - Minor — nothing proved `stop()` rethrows a failure that is not a cancellation. Fixed: the
    test asserts `stop()` rejects with the run's own error.
  - Minor — `summarizeRun` throwing would lose the original failure. Rejected: it is pure over
    records the engine built, and a bug there should surface, not be masked.
  - Minor — a run cancelled through the caller's signal cannot have its read cut short, as the
    signal is already aborted. Accepted as is: `runWorkflow` callers bound it by the grace, and
    the CLI's second Ctrl-C kills the process, which then writes no `output.json` (Task 2 notes it).
  - Note — an `AggregateError` of cancellation plus cleanup errors still makes `stop()` throw, as
    before this story.

### Task 2

- Architecture and scope: checked the record shape (a union on `outcome` over optional fields,
  the version bump), contract purity, the CLI's placement, docs and comments. Findings:
  - Important — the docs said every run with a run directory gets `output.json`; one whose host
    never opened, or whose process a second Ctrl-C killed, does not. Fixed: the README, usage
    text and this story now say "once its agents have started" and what a missing record means.
  - Minor — a deadline is `failed`, told from a crash only by the `error` text. Left for the
    human: a fourth outcome is a record-format decision (see Human review).
  - Minor — `recordOf` has no declared return type. Kept: it is checked where it is spread into
    `OutputRecord`, and `Omit` would not distribute over the union.
- Correctness and proof: checked every exit path, outcome per path, stderr order, stdout with and
  without `--json`, the directory written, and that the tests fail on revert. Findings:
  - Important — a succeeded run whose `report.md` failed to save lost its `output.json` and
    accounting. Fixed: `writeReport` treats a failed save like a failed render.
  - Minor — `--json` printed nothing when saving a failed run's record failed. Fixed: it prints
    the record regardless.
  - Minor — a throw inside the failure branch would skip runtime cleanup. Rejected: everything
    there is pure apart from the write, which is caught.
  - Minor — test gaps. Added: a deadline is recorded `failed`; cancellation with cleanup errors
    is recorded `cancelled`. Not added: SIGTERM (its exit-code mapping predates this story) and a
    cleanup-only failure (covered at the runner).

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

- Live runs found that a SIGINT landing during the end-of-run read, after the body succeeded, cuts
  the read and loses the spend: [`todo/interrupted-accounting-read`](todo/interrupted-accounting-read.md).
- Also added [`docs/testing.md`](../testing.md) and `bun run eval`, which runs every live eval on
  the cheapest models. On codex `gpt-6-luna` the agents mistyped the launcher's long macOS temp path
  (`…/gn/T/…` as `…/gnT/…`) in 3 of 8 sessions, so the control plane's directory moved from the
  system temp dir to `/tmp` (`CONTROL_PLANE_ROOT`); `failed-run` then passed 4 of 4.
- Task 2: the report is written before the record as before, but its failure no longer stops the
  record. No test forces a failed `report.md` write.
- Task 1: a stop arriving after the body ends now skips or cuts the read on both paths, as it did
  on the success path before. Verification: `bun test` 439 pass, 0 fail; `bun run check` clean
  (2026-09-24).

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Set the story status to `awaiting-human-review` and present the outcome.
- [x] 2026-09-24: the human asked for a way to test it live, which became `bun run eval` and
  [`docs/testing.md`](../testing.md), then approved committing once a review of the whole change
  came back clean.
  - The eval tooling's review found that Ctrl-C killed an eval without stopping its agents, and
    that a failed eval reported no cost. Both fixed.
  - Minor fixes: the runner resolves `bun` from `process.execPath`, matches evals by exact name,
    and prints each passing eval's artifacts. `failed-run` reads `output.json` itself. The cost
    figures in the docs now agree.
  - Kept: a host whose `/tmp` is read-only cannot run agents; noted in `testing.md`.
- [x] Marked `done`.

Left open:

- whether a deadline gets its own `outcome` rather than `failed` — settled by
  [story 008](008-review-scorer.md): `timed-out`;
- a Ctrl-C during the end-of-run read loses the spend —
  [`todo/interrupted-accounting-read`](todo/interrupted-accounting-read.md).
