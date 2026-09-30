---
title: Test a workflow's deadlines on a virtual clock
summary: A workflow test can't check its own deadlines deterministically, because every engine deadline is a real timer; a clock that skips while every fake is idle would make a hung agent under a 30-minute deadline time out in milliseconds, the same way every time.
type: story
status: todo
discovered_in: "story 012, design review, 2026-09-30"
depends_on: ["012"]
---

# Test a workflow's deadlines on a virtual clock

Why it matters: story 012's tests script `reply.timedOut()` to reach a timed-out turn, which is
enough for what a workflow does with one. They can't check deadlines themselves: a `parallel`
whose deadline passes, or a run that ends mid-loop. In its prototype, a hung turn whose deadline
equalled the run's ended as `timed-out` in 4 runs of 6 and failed the run in the other 2.

Notes:

- Temporal's rule is the one to copy ([[workflow-testing]]): the clock skips while nothing runs,
  and a scripted step says how long it took (`.After(d)` in Temporal Go, Conductor's
  `executionTime`).
- It needs a quiescence signal, and today's fake turns go over real I/O: the result socket
  (`node:net`) and whatever files a script writes.
- The engine's timers aren't in one place: `deadlines.ts`, `result-slots.ts`, `run-usage.ts`, 15
  `Date.now()` calls in `workflow-runner.ts`, and `session-core`'s `finishGraceMs` in harness.
- Author code reads the clock too. `{ unixMilliseconds }` is author-visible, and a workflow may
  compute a deadline from `Date.now()`, so an engine-only clock would disagree with the
  workflow's own arithmetic.
- Once this ships, `reply.hang()` and the stall limit change meaning (instant; virtual), and a
  scripted answer can say how long its turn took. Story 012 sketches it as
  `answer(WORK, value).took("12m")`, beside `.spent(…)` for a turn's cost once a workflow can
  read spend mid-run. Say so where story 012 documents them.
- Done when the prototype's race gives the same outcome in 50 runs of 50, and the live
  `failed-run` eval shows production timing unchanged.
