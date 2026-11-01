---
title: An agent learns wfa from its help
type: story
status: todo
priority: P3
epic: launch
discovered_in: "story 033, 2026-10-24"
depends_on: ["033"]
---

# An agent learns wfa from its help

`wfa -h`, run outside a session, says only that wfa "must be run through the launcher the workflow
engine installed". Inside one, a bad call prints the usage, but nothing lists what wfa can do.

Why it matters: [[033-cli-help|033]] made `awf -h` the way an agent finds the operator's commands.
An agent inside a run has its prompt, which names the `wfa` command it needs, so this matters less
than `awf -h` did; it matters once an agent is expected to find `wfa message` or other calls on its
own.

Notes: `packages/engine/src/agent-cli/cli.ts` (`usage`, `messageUsage`). wfa compiles against
contract only and talks over the wire, so its help can't come from the engine's `commands.ts`; it needs its own,
smaller table. Out of 033's scope because it has its own readers and its own wire.
