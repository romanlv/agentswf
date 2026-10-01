---
title: Run a headless codex agent on one app-server for its whole life, so its forks hit the cache
summary: Codex's forks read their parent's prompt cache only when ephemeral, and an ephemeral thread lives only as long as its app-server process; a codex agent kept on one app-server could fork that way.
type: story
status: todo
discovered_in: "story 016, measuring fork and the prompt cache, 2026-10-01"
depends_on: ["016"]
---

# Run a headless codex agent on one app-server for its whole life

Why it matters: a codex fork pays its parent's whole context once, uncached, where a claude or pi
fork reads it from the cache ([`fork-cache.md`](../../findings/fork-cache.md), F4). Codex routes its
cache by the root thread's session id, and gives a fork a new one, except an ephemeral fork, which
keeps its parent's: 807 uncached and 24,320 cached on its first request (F5). An ephemeral thread is
never written to disk, so a codex agent turned into one has to live on a single `codex app-server`
for all its turns. awf runs headless codex as `exec` and `exec resume`, a process per turn.

What it would take:

- A codex headless backend on one long-lived app-server per agent: `thread/start`, `turn/start`,
  `thread/compact/start`, `thread/fork` with `ephemeral: true`, and close on the agent's close.
  Compaction already speaks this protocol (`spec.ts`, `compactHeadless`).
- Usage. An ephemeral thread writes no rollout, so its tokens come from the server's
  `thread/tokenUsage/updated` notifications, not from files. That is a second reader shape for one
  harness, and the run-end read assumes files.
- A fork that outlives its process is gone. A run that crashes loses the fork's session, which a
  persisted fork keeps.
- Check first whether openai/codex#44716 has landed: a persisted fork that inherits the cache key
  would make this unnecessary.
