# 0008 — A pane agent continues in its pane

**Decided:** 2026-10-01, in [[015-native-compaction|story 015]]. **Replaces:** `foundation.md`'s
rule that each distinct operation receives an operation pane, and that the next operation waits
until the prior pane is released; and story 001's refusal of a second operation on a pane agent.

**Amended:** 2026-10-05, [[021-turn-liveness-and-limits|story 021]], to require native release
before returning workflow success and permit bounded cooperative check-ins.

## What was decided

- **A pane agent keeps one pane for all its operations.** Its first operation starts the harness
  there; each later operation, turn or compaction, is prompted into the same agent.
- **The next operation waits for the agent to settle, not for the pane to be released.** Before
  prompting, the host waits on Herdr until the agent is idle, done or blocked, within the
  operation's deadline. Blocked settles the operation `blocked` without prompting.
- **An accepted answer waits for bounded native release before workflow success.** Saving the
  answer is acknowledged immediately; the agent can finish its command and wrap up. The engine
  waits for fresh native completion, including receipt of an already dispatched check-in. If
  release remains uncertain, keep the saved answer as evidence and fail closed. Stopping an
  observer is not proof the agent stopped.
- **Cooperative waits stay inside one operation.** On measured placements, `wf waiting` permits
  another check-in under the fixed deadline. Native queue acceptance and model receipt are
  separate signals. Unsupported combinations retain their explicit limitations.
- **A pane agent that is done is not driven again.** Cancelling an operation once its harness
  runs, or a relaunch that does not start, ends it, and a later operation on that agent fails. Its pane is closed, or, where the
  workflow's `keepPane` says, left open with its harness released from the run
  ([pane layout](../design/pane-layout.md), 2026-10-06); either way the session is no longer the
  run's.
- **Each operation still has fresh result authority**: its own call id, slot and schema.

## Why

Story 001 refused a second operation because nothing proved the previous pane released, and a
fresh pane needed that proof. Continuing in the same pane avoids restarting the agent, but a
workflow must still wait for the prior native turn to release before consuming its artifacts
or advancing dependent work. A prompt must reach the agent and settle against the right turn. E8 drove four dependent steps through claude, codex, pi and
cursor panes this way: a prompt pushed while a turn was working was queued, not lost, in all
four, and context and cache stayed warm. Herdr's own help says its prompt wait does not track
turns, which is why the host waits for the agent to settle before prompting.

The use that asked for it: one agent carrying a ticket from plan to tested MR, compacted between
stages (ADR 0007). Without continuation, a pane agent could not be compacted and then used.

## Not decided

- Reopening or moving a session still needs an identity observer and its own release proof
  ([[herdr-pane-settlement]]). Native-turn release does not establish that detached processes
  or external jobs stopped. Story 021's measured support is recorded in [[021-implementation-proof]].
- What an operator typing into a driven pane mid-turn does to settlement. Not measured.
