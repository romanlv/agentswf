---
title: Fold a message into a running claude turn
type: story
status: todo
priority: P2
epic: authoring
discovered_in: "story 029 review, 2026-10-11"
depends_on: ["029"]
---

# Fold a message into a running claude turn

A message to a claude pane that is working reaches the model between tool calls, as E8 showed claude
does, instead of waiting for the turn to end.

Why it matters: the one-way shape in [[messaging#Routes by shape]], lenses reporting to a fixer while
both work, needs it. Story 029 delivers only at turn boundaries, so until this lands a finding
reaches a busy fixer only when its turn ends.

Notes:

- The pane path waits for the agent to settle before typing (`harness/src/adapters/herdr.ts`, the
  E8 comment), and `session-core` allows one active turn (`assertIdle`). Typing while busy is new
  machinery, confirmed by `claude-receipt`.
- A message typed as a turn ends can start a native turn; the engine has to adopt it as the next
  message operation and never type the message again. Herdr's prompt wait does not track turns.
- Codex, pi and cursor stay boundary-only: a message queued natively in a busy pane can outlive
  its operation.
- The headless long-lived modes (stream-json `priority: "next"`, codex `turn/steer`, pi rpc
  `steer`) are in [[messaging#Q2. How soon does `deliver` reach a busy headless agent?|Q2]].
