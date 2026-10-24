---
title: An agent learns wf from its help
type: story
status: todo
priority: P3
epic: launch
discovered_in: "story 033, 2026-10-24"
depends_on: ["033"]
---

# An agent learns wf from its help

`wf -h`, run outside a session, says only that wf "must be run through the launcher the workflow
engine installed". Inside one, a bad call prints the usage, but nothing lists what wf can do.

Why it matters: [[033-cli-help|033]] made `awf -h` the way an agent finds the operator's commands.
An agent inside a run has its prompt, which names the `wf` command it needs, so this matters less
than `awf -h` did; it matters once an agent is expected to find `wf message` or other calls on its
own.

Notes: `packages/wf/src/cli.ts` (`usage`, `messageUsage`). wf compiles against contract only and
talks over the wire, so its help can't come from the engine's `commands.ts`; it needs its own,
smaller table. Out of 033's scope because it has its own readers and its own wire.
