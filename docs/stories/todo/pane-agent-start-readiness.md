---
title: Preserve and classify pane agent-start diagnostics
summary: Retain redacted Herdr start errors and retry only failures that can become ready.
type: story
status: todo
discovered_in: "001 Task 7 live evaluation"
depends_on: []
---

# Preserve and classify pane agent-start diagnostics

Why it matters: the first bounded live workflow created both Herdr workspaces, but all five
`agent.start` attempts per pane failed and no Claude or Codex launch was observed. The
workflow retained only incomplete outcomes and the run record retained no native start diagnostic,
so the exact Herdr rejection could not be recovered from its artifacts after workspace cleanup.

Known context: the adapter now creates valid compact names, retries only exact `agent_pane_busy`,
and failed evaluations retain mode-0600 safe outcome evidence. Those evaluator and adapter fixes do
not close this todo.

Unresolved deliverable: retain a redacted native `agent.start` diagnostic in the engine-owned run
record. A failed pane launch must remain diagnosable after workspace cleanup without copying the
capability, raw command arguments, or unsafe provider output. Refine the record shape and redaction
boundary before implementation because this changes durable evidence.

The original retained evidence is under
`/var/folders/4g/s95glx9x6n71bq4hc08ly2gm0000gn/T/awf-minimum-review-J4rjad` while available. Do not
repeat the live evaluation without a new explicit execution decision.
