---
title: Flaky turn deadline test
summary: A wall-clock assertion in workflow-runner.test.ts fails under full-suite load.
type: story
status: todo
discovered_in: 018-workflow-stages
depends_on: []
---

# Flaky turn deadline test

Why it matters: `bun test` failed once with nothing wrong in the code, which teaches people to rerun
failures instead of reading them.

Notes: "an accepted result cannot disable the native turn deadline"
(`packages/engine/src/workflow-runner.test.ts`) gives the run a 20 ms deadline and asserts the
attempt settles within 200 ms of `performance.now()`. One full-suite run on 2026-10-04 took 913 ms;
the test passed five times out of five on its own. The fix is to assert what the deadline caused,
the turn ended by the native deadline rather than by the accepted result, instead of how long it
took, or to drive it with a controlled clock. The test predates story 018.
