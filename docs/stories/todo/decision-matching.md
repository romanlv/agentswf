---
title: Match review findings to an answer key with a decision model
summary: `matchFindings` in autoresearch settles the confident matches of a run's findings to key issues with Jev, and a measurement on a variant's own findings says whether the scorer should use it.
type: story
status: todo
discovered_in: "story 006, Tasks 3 and 4, moved out when it closed"
depends_on: ["006"]
---

# Match review findings to an answer key with a decision model

Why it matters: the review scorer (story 008) matches every finding of every run to a key issue,
and its agent judge reads all of a fixture's findings in one call. On review comments Jev settled
72% of matches at 99% accuracy, for under $0.0001 each (findings S8), so a pre-match could leave
the judge only the hard ones. Those comments are the ones the keys were drafted from, so the number
that matters is on findings a review variant produced, and it is unmeasured.

Notes: story 006 designed both tasks; its code map, "Task details" 3 and 4, and open questions for
Task 4 are the plan. `decide` and the `jev` alias are built, and `examples/triage` shows the call as
a plain function.

- `packages/autoresearch/src/review/match.ts`: `matchFinding(finding, key)` returns the call, one
  choice over the key's issues (their `mechanism`) plus `none`. `matchFindings` splits the results
  at a threshold (0.9 from S8): a decided match is taken, anything else and a decided `none` go to
  the judge, and two findings on one issue are the scorer's to label as duplicates.
- `match.workflow.ts`, run by path over a fixture set and a findings file. It checks the plumbing by
  reproducing S8 on the private set's comments (about $0.01; the data goes only to Jev).
- The measurement needs a review variant's findings, labelled. Where they come from, and whether an
  LLM baseline may see the private set, are open.
