---
title: Keep the evidence of a pane that didn't answer
type: story
status: todo
priority: P0
epic: observability
discovered_in: "implement-ticket rerun; story 001, task 7"
depends_on: []
---

# Keep the evidence of a pane that didn't answer

A turn that ends without an answer, or an agent that fails to start, leaves in the run record what
the pane showed, so a person can tell a real `blocked` from a misread one.

Why it matters: a turn settled `blocked`, `unanswered` or timed out keeps no screen, and closing
the run closes the pane unless the workflow said `keepPane: "on-failure"` (story 026). In the
implement-ticket rerun a worker that was mid-tool-call was settled `blocked`, likely a
misclassification, and nothing was left to check it against. A settlement bug can't be found or
fixed without this.

Notes:

- **Non-answered outcomes.** Save `agent read --source detection` in the call dir with every
  non-answered outcome, and name it in `output.json`.
- **Start failures.** In story 001's first live run every `agent.start` failed and the run record
  kept no native diagnostic, so the Herdr rejection was lost with the workspace. Keep a redacted
  `agent.start` diagnostic in the engine-owned run record, without raw command arguments or unsafe
  provider output.
- The record shape and redaction boundary are a durable-evidence decision: settle them before
  building, with [[run-record-layout]].
- Split from [[herdr-pane-settlement]], whose measurement work this doesn't wait on: the screen is
  evidence, not settlement authority.
