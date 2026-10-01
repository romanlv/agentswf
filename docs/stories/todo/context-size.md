---
title: Show an agent's context size to the workflow
summary: How full an agent's context is, after each operation and especially after a fork or compaction, read from what the harness logs.
type: story
status: todo
discovered_in: "story 016, the operator's review, 2026-10-01"
depends_on: []
---

# Show an agent's context size to the workflow

Why it matters: the operator asked for it, at least after a fork or a compaction. A workflow that
compacts by stage cannot see whether it needed to, or what the compaction left. Foundation §7 gave
"context usage / dump zone detection" a home in `harness`, beside liveness and usage, and ADR 0007
left "tokens before and after" off the compaction's answer.

What is there already:

- Every harness logs each request's input tokens, cached and not, and the last request's total is
  the context's size. awf's usage readers read them at run end
  ([`fork-cache.md`](../../findings/fork-cache.md) used them per request).
- Claude's `compact_boundary` row carries `preTokens` and `postTokens`. Codex's app-server sends
  `thread/tokenUsage/updated` with the last request's usage. pi's compaction entry records its own
  counts.

What to settle:

- Where it appears. It could go on each `TurnOutcome.usage` record, which is a published record
  format, or on a separate `agent.context()`.
- Reading files mid-run. Today they are read only once the run has ended (story 002). A pane's
  transcript may not hold its last request yet, the same timing problem pane forks have.
- Cursor logs none.
