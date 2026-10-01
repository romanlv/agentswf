# 0008 — A pane agent continues in its pane

**Decided:** 2026-10-01, in [[015-native-compaction|story 015]]. **Replaces:** `foundation.md`'s
rule that each distinct operation receives an operation pane, and that the next operation waits
until the prior pane is released; and story 001's refusal of a second operation on a pane agent.

## What was decided

- **A pane agent keeps one pane for all its operations.** Its first operation starts the harness
  there; each later operation, turn or compaction, is prompted into the same agent.
- **The next operation waits for the agent to settle, not for the pane to be released.** Before
  prompting, the host waits on Herdr until the agent is idle, done or blocked, within the
  operation's deadline. Blocked settles the operation `blocked` without prompting.
- **An answered turn is left to finish in its pane**, as a headless one is left to finish its
  process. Stopping it after its grace stops the host's wait, never the agent.
- **A pane that was closed is not reopened.** Cancelling an operation or failing to start the
  agent closes the pane, and a later operation on that agent fails: the session went with it.
- **Each operation still has fresh result authority**: its own call id, slot and schema.

## Why

Story 001 refused a second operation because nothing proved the previous pane released, and a
fresh pane needed that proof. Continuing in the same pane needs no release: the agent is never
stopped between operations. What it needs instead is that a prompt reaches the agent and is
settled against the right turn. E8 drove four dependent steps through claude, codex, pi and
cursor panes this way: a prompt pushed while a turn was working was queued, not lost, in all
four, and context and cache stayed warm. Herdr's own help says its prompt wait does not track
turns, which is why the host waits for the agent to settle before prompting.

The use that asked for it: one agent carrying a ticket from plan to tested MR, compacted between
stages (ADR 0007). Without continuation, a pane agent could not be compacted and then used.

## Not decided

- Verified release and an identity observer ([`herdr-pane-settlement`](../stories/todo/herdr-pane-settlement.md)):
  still needed for anything that reopens or moves a session, nothing here does.
- What an operator typing into a driven pane mid-turn does to settlement. Not measured.
