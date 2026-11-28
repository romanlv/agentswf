---
title: A fork's timeout is its own, and says so
type: story
status: todo
priority: P1
epic: long-runs
discovered_in: "factory review in production, runs 2619, 2638 and 2639, 2026-11-27"
depends_on: []
---

# A fork's timeout is its own, and says so

When a fork runs out of time, the error names the fork and its limit, so it can't be taken for the
run's deadline. The limit also holds up on a loaded machine.

Why it matters: on 2026-11-27, three factory review runs ended about 6 minutes into a 60-minute
attempt with "Deadline exceeded". A lens fork had exceeded its fixed 60 s, and the error it threw
was the run deadline's `DeadlineExceededError`, with only a timestamp. The factory's `flow.ts`
couldn't tell the two apart and ended the whole run, not just the lens. It was worked around in
the factory (0d19bc2): a failed fork now costs only that lens.

Notes:
- `FORK_TIMEOUT_MS = 60_000`, `packages/engine/src/workflow-runner.ts:463`. Its comment says a fork
  only copies a session file (F7). Under a load average of 19–29, with Herdr TUI panes, it took
  longer than that. Measure where the time goes before choosing a new limit: the queue behind the
  parent's active turn, the copy, or the pane start.
- `DeadlineExceededError`, `packages/contract/src/workflow/timing.ts:7`, carries only `deadline`.
  It could carry what timed out (`fork of {key}`, `run`, `scope`), or a fork could reject with its
  own error. Either is part of the published author surface, so design it first.
- Related: [[concurrent-agents]] (the load), [[woken-run-bounds]] (a woken run's deadline).
