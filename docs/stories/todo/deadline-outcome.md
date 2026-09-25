---
title: Tell a run that ran out of time from one that crashed
summary: Decide whether output.json gets a `timed-out` outcome, before readers depend on three values.
type: story
status: todo
discovered_in: "story 003, Task 2 review"
depends_on: ["003"]
---

# Tell a run that ran out of time from one that crashed

Why it matters: story 003's `OutputRecord` v2 records a run past its deadline as `failed`, so the
only way to tell a timeout from a crash is to parse `error`. An autoresearch loop will want to
count variants that ran out of time separately from ones that broke.

Notes: adding a fourth `outcome` value later breaks readers that switch over all three; an optional
field added later does not. Decide before `review-recall-scorer` or `variant-matrix-runner` read
the record. A run's deadline surfaces as `DeadlineExceededError` in `WorkflowRunError.cause`; a
`parallel` stage's deadline thrown out of the body is the same class, so the two may need telling
apart. `packages/contract/src/records.ts`, `packages/engine/src/operator-cli.ts`.
