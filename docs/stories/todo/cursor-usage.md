---
title: Record a headless cursor agent's tokens
summary: cursor-agent's headless JSON now reports each turn's tokens, cache reads included, and awf records none for cursor.
type: story
status: todo
discovered_in: "story 016, measuring cursor's fork, 2026-10-04"
depends_on: []
---

# Record a headless cursor agent's tokens

Why it matters: a cursor agent's operations record no usage at all, so a run's totals leave it
out and the fork eval cannot check a cursor fork's cache (fork-cache F11). Foundation §8 says
cursor records usage nowhere; on cursor-agent 2026.10.01, `cursor-agent -p --output-format json`
ends with `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }` for the turn.

Notes:

- Every other harness's usage is read at run end from its session files
  (`HarnessSpec.readSessionUsage`). Cursor's `store.db` keeps its blobs encrypted, so the turn's
  stdout is the source, which needs a path for usage read per turn rather than per session.
- Whether `inputTokens` includes the cached part is unmeasured; a resume read 109 / 37,004, which
  suggests it does not.
- It is one figure per turn, not per request, as pi's `turn_end` is per request; a turn of several
  requests is one record.
- Still no dollar figure: a cursor step stays unpriceable without one.
- Panes print nothing to read, and Herdr names no cursor session.
