---
title: Release one agent while its run stays live
type: story
status: todo
priority: P3
epic: long-runs
discovered_in: "story 036, design review, 2026-10-28"
depends_on: ["036"]
---

# Release one agent while its run stays live

After [[036-agent-keep-alive|story 036]], an agent with `keepAlive` keeps the whole run live, and
every agent's pane stays with it until the run parks. A run holding an investigator worth keeping
beside an agent that is done keeps both panes for the window.

Releasing one agent alone would close its pane and keep its session, and its next turn would resume
the session in a new pane within the same attempt. Today nothing can:

- the harness refuses a session whose pane closed: "this agent's pane was closed, so its session
  cannot be continued" (`packages/harness/src/adapters/herdr.ts:1360-1366`), and compaction, `set`
  and fork refuse the same way;
- ADR 0008 says why: a close acknowledgement doesn't prove the process gone, and a codex session a
  killed process held refused a second writer;
- the only per-agent close, `LogicalAgent.close`, is terminal, and the run's record shows one pane
  per agent per attempt.

It would need a harness operation that releases a pane with a proof the process is gone, as
`relaunchAt` settles before it replaces a pane; a release in the logical agent that is queued with
its operations and isn't a close; rules for `keepPane` and the caller agent; and a record of several
panes per attempt. Worth building once a workflow holds a second agent beside a kept one.
