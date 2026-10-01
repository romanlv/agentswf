---
title: Fork a compacted agent, so several agents start from the same base
summary: After compacting an agent, start one or more new agents from its compacted session with the harness's own fork, instead of each re-reading the task from scratch.
type: story
status: todo
discovered_in: "story 015, the operator's review, 2026-10-01"
depends_on: []
---

# Fork a compacted agent, so several agents start from the same base

Why it matters: a workflow that has one agent understand a task (read the ticket, plan, review
the doc) and then hands parts of it to several agents pays for that understanding once per agent,
or passes it on as a prompt the workflow wrote. Compacting first and forking the result would give
each new agent the same context, already small, written by the harness: the review agents of a
ticket could start from the implementer's compacted session instead of a cold brief.

What is measured ([`findings/native-compaction.md`](../../findings/native-compaction.md), C10):
claude (`claude -p --resume {id} --fork-session`), codex (`codex exec fork {id}`, and
`thread/fork` on its app-server) and pi (`pi --fork {id} --session-id {new}`) each fork a
compacted session into a new one, the compaction carried over and the original untouched. A fork
answered from the compacted context in every case. Codex's summary is encrypted, so reading the
context out and replaying it is not an option there; its fork carries it anyway.

What has to be settled first:

- Foundation defers any fork in an interface until E7's cost split is settled; E7 found forking a
  prepared agent saves correctness and almost never tokens. A compacted base is the case E7 did not
  measure: the base is small, so the trade may come out the other way. Measure it before
  designing.
- The author surface. Something like `agent.fork({ key, ... }): Promise<AgentRef>`, opening a new
  logical agent from an existing one's session; it is a published type and wants an ADR.
- Placement. A headless fork is a new process on a forked session id. A pane fork means starting
  the harness in a new pane on that session (`claude --resume {id} --fork-session`, `codex fork
  {id}`); continuation in a new pane is what
  [`herdr-pane-settlement`](herdr-pane-settlement.md) still defers.
- Sandboxes: a fork needs the parent's session files, which live in the parent's harness home.
- Accounting: a forked session's files begin with the parent's turns; the usage read must not
  count them twice.
