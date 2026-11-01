# 0013 — The agent's command is `wfa`, a workflow's context is `wf`, and the command lives in the engine

**Decided:** 2026-10-31. **Amends:** ADR 0005, which kept the agent's command `wf` and, in its
amendment, made it the package `@agentswf/wf` in `packages/wf`; [`foundation.md`](../foundation.md)'s
package list, where `wf` was the fourth package.

## What was decided

- **The command an agent runs inside its session is `wfa`:** `wfa result`, `wfa send`, `wfa reply`,
  `wfa tool`, `wfa waiting`, `wfa peers`. The engine installs it per agent as before, and its
  bundle is `wfa.js`.
- **A workflow names its context `wf`** by convention: `async run(wf, args)`, `wf.stage(...)`,
  `wf.agents.open(...)`. Nothing enforces the name; the examples, the `awf init` template and the
  docs use it.
- **The command is no package of its own.** Its source is `packages/engine/src/agent-cli`, and
  `@agentswf/wf` is gone. The engine bundles it from there by path.

## Why

Workflows were written `workflow.agents`, `workflow.stage`, about a hundred times across the
examples. `wf` is the short name that reads as the run's, but it was the agent's command, and a
workflow file holds both sides: code calling the context and prompts telling an agent which command
to type. `wf.stage(...)` beside "run `wf send`" would name two things on opposite sides of the wire
alike. The command is typed by agents, from prompts the engine writes, so its name costs least to
change; the trailing `a` reads as "agent", and an agent that types `wf` from habit gets "command
not found" rather than a wrong call.

The package existed to make the wire boundary visible: the command is bundled into one file an
agent's sandbox can read, so it imports contract only and never touches a run directory.
Foundation's test for a package is that something outside it imports it, and the only importer was
the engine. A path rule holds the boundary as well, as one already does for `engine/src/accounting`:
`scripts/check-boundaries.ts` lets `engine/src/agent-cli` import contract and its own files only,
and no `fs`. Folding it in leaves one published package fewer and no name to choose for it.

## Not decided

- What becomes of `@agentswf/wf`'s published betas on npm: deprecated with a pointer to `agentswf`,
  or left. Publishing anything is the operator's step.
