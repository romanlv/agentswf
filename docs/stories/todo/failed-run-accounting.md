---
title: Report what a failed run spent
summary: runWorkflow reads usage when a run ends, but a workflow that throws has no result to carry the accounting on.
type: story
status: todo
discovered_in: "story 002, Task 3"
depends_on: ["002"]
---

# Report what a failed run spent

Why it matters: an autoresearch loop pays for the variants that fail as well as the ones that
finish. Story 002 reads every agent's usage when the run ends, including runs whose body throws,
but `runWorkflow` then rethrows the body's error and the accounting goes with it. A variant that
crashes after twenty agents looks free.

Notes: the error `runWorkflow` throws could carry the accounting, or `output.json` could be written
for a failed run too. Either changes what a caller sees, so it needs its own design pass.
`packages/engine/src/workflow-runner.ts` (`startWorkflow`) and `operator-cli.ts` are the places.
