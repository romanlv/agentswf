---
title: Try claude opus 5.5 as the judge's second voter
type: story
status: todo
priority: P3
epic: loop
discovered_in: "story 008, match first"
depends_on: ["008"]
---

# Try claude opus 5.5 as the judge's second voter

The panel's claude voter, sonnet, was its slowest and costliest part; opus 5.5 at a pinned effort,
on only the findings Jev leaves, may be the second family worth keeping.

Why it matters: a panel is two model families so a majority isn't one model agreeing with itself.
In story 008's trial the claude voter, `claude-sonnet-5`, finished last on every panel judging but
one, read 47.2M tokens to sol's 11.7M, came to about 80% of the panel's list price, and ran to the
20-minute limit in all four panel timeouts. The match-first judge's second voter is `gpt-5.6-terra`
for now, in codex or in pi: another model, not another family. Deferred because Claude usage is
short, not because opus was measured.

Notes:

- Run it as the match-first judge's second voter (`--rest codex/gpt-6-sol,claude/claude-opus-5-5`
  in the data repository's `judges/`), so it sees only the findings Jev leaves, about half.
- Pin its effort: today a headless claude agent takes `CLAUDE_EFFORT` from whatever launched it
  ([story 020](../020-agent-effort.md)), or its timings measure the operator's session.
- Compare at low and medium effort with sonnet at the same, on accuracy (the comments, the oracle,
  κ with the panel), time per judging and list price, with story 008's `scripts/judges.ts`.
- Claude's billing on a subscription login is unverified ([`billing-provenance`](billing-provenance.md)).
