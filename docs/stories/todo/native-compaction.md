---
title: Compact an agent with its harness's own compact command
summary: Make agent.compact run the harness's native compaction, with an optional focus, so one agent can carry a long multi-stage task the way an operator does with /compact.
type: story
status: todo
discovered_in: "an implement-a-ticket workflow written against the author surface, 2026-10-01"
depends_on: [herdr-pane-settlement]
---

# Compact an agent with its harness's own compact command

Why it matters: the way an operator gets a ticket from plan to tested MR by hand is one session
with a compaction between stages: plan → `/compact` → implement, fix review findings, open the MR →
`/compact` → test plan, record, publish. The operator reports that this works well; the only part
handed to separate agents was the review. A workflow cannot do this today. `AgentRef.compact` is in
the contract and rejects as `unavailable`, and a pane agent takes one operation. So the workflow
written for this opens a fresh agent for every step: seven or more agents where the operator used
two sessions, and a fixer that never saw why the implementer chose what it did.

## What exists

- The contract has `compact(spec: CompactSpec): Promise<TurnOutcome<string>>`, with
  `CompactSpec = { id, prompt, deadline }` (`packages/contract/src/workflow/agents.ts:214`, `:237`).
- The harness session core accepts an operation of kind `"compact"` and sequences it after the
  agent's earlier operations (`packages/harness/src/session-core.ts:299`).
- The engine's `AgentRef.compact()` returns `unavailable("AgentRef.compact")`
  (`packages/engine/src/workflow-runner.ts:1015`).
- The design describes compaction as a prompt: the agent is asked to summarize, and only an
  `answered` summary replaces its context (`docs/design/README.md:65`, `:164`).

## The design change

That design asks the agent to write its own summary through `wf result`. What the operator used
is the harness's native command, often with a focus: `/compact focus on the ticket details`, or a
review loop's `/compact` naming what to keep and what to drop. Proposed:

- `compact({ prompt })` sends the harness's native compaction, with `prompt` as its focus
  (`/compact {prompt}` in a claude or codex pane; whatever a headless resume accepts).
- The outcome is `answered` with the summary the harness wrote, read from its session record, not
  answered by the agent. Claude's transcript marks it (`isCompactSummary`); codex's needs looking at.
- Any other outcome leaves the prior context, as the current contract says.

`CompactSpec` is a published type and its shape survives this; what changes is what `prompt` means
(a focus for the harness, not an instruction to the agent) and where the answer comes from. Settle
that in a design note or ADR before any code.

## To measure first

- Does `/compact {focus}` work when typed into a Herdr pane, for claude and for codex, and how does
  the host tell that it finished? It produces no `wf result`, so settlement is not the same
  question herdr-pane-settlement answers for a turn.
- Does a headless resume compact: `claude -p --resume {session}` with `/compact`, and codex's
  `exec resume`? If one cannot, `compact` on that placement is refused when the agent opens, not
  at the call.
- Where each harness writes the summary, and whether a session's usage reading still adds up
  across a compaction.

## Testing a workflow that compacts

The workflow-testing host fails any compaction today
(`packages/engine/src/workflow-testing/host.ts:122`). A workflow's test needs to see each
compaction in `run.turnsOf` with its focus, and to script one that doesn't finish, so it can check
what the workflow does then. Whether a compaction takes an entry in an agent's script list or is
met on its own is part of the design.

## Depends on

[`herdr-pane-settlement`](herdr-pane-settlement.md): compacting a pane agent and then giving it
more work is a second operation on that agent, which the pane host refuses today. Pane
continuation comes first; compaction is the next operation after it.

## What it unlocks

The ticket workflow can follow the operator's session instead of opening a fresh agent per step:
one agent reviews the doc → compacts → implements, fixes each review round, opens the MR →
compacts → plans the testing and records it. Review stays separate agents, which is the part that
already worked that way.
