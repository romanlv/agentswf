# 0006 — A workflow's tests run on a second composition root

**Decided:** 2026-09-30, in [[012-workflow-tests|story 012]]. **Replaces:** `foundation.md` §6
rule 4, under which only `engine/src/operator-runtime.ts` installed providers and only test files
imported the fakes.

## What was decided

- **`engine/src/workflow-testing/` is a second composition root.** Where `operator-runtime.ts`
  installs the Herdr and headless hosts, srt and docker, and OpenRouter, it installs a scripted
  host over the harness's fake adapter (`@agentswf/harness/testing`), the fake sandbox provider
  (`@agentswf/sandbox/testing/fake`) and a scripted decision provider.
  Between them is the production engine, unchanged: `runWorkflow`, the session core, result slots,
  the nudge, `parallel` and deadlines.
- **It is not a test file, and ships.** It is exported as `@agentswf/engine/workflow-testing`, and
  served to a workflow outside the repository as `agentswf/testing`, the second published author
  surface after `agentswf/workflow`. It imports no test runner, so an author's test decides how it
  runs.
- **It may import the fakes, never a provider.** `scripts/check-boundaries.ts` holds it to that,
  and to importing no `bun:test`. So both fakes it imports ship too, and are imported by a path
  that brings no test runner: the sandbox fake by `testing/fake`, not the `testing` index, which
  also holds the conformance suite.

## Why

A workflow's author needs to test its logic without agents, and the engine is what gives that
logic its meaning: which turn is nudged, what `parallel` cancels, what a schema refuses. A fake
`WorkflowContext` would re-implement all of it and drift. Running the real engine needs something
to install fakes where a run installs providers, outside a test file, because an author's test
imports it. The alternative, an author wiring `createFakeAdapter`, sockets and bindings by hand,
is what `tests/` does today, 20–40 lines before the first assertion.

## Not decided

- How `agentswf/testing` is packed at the launch; it goes the way `agentswf/workflow` goes
  (ADR 0005).
