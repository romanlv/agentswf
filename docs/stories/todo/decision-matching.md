---
title: Make match first the review scorer's judge
summary: Jev settles the findings an answer key already answers and agents with the code label the rest; measured on story 008's stored findings it matches the panel's accuracy in a fifth of the time and list price, and it lives in the data repository until it moves into the package.
type: story
status: todo
discovered_in: "story 006, Tasks 3 and 4, moved out when it closed; measured in story 008"
depends_on: ["008"]
---

# Make match first the review scorer's judge

Planned in [story 011](../011-compare-variants.md), which joins this todo with its sibling; its "Ideas and where they go" says where each note below went. This file stays until story 011 is approved.

Why it matters: the panel, story 008's default judge, has every voter read the change, key and
code for every finding, and takes about 5 minutes and $0.81 at list price a judging. Most findings
need no code: the key already answers them. Story 008 measured it on the trial's stored findings
([story 008](../008-review-scorer.md), "Match first"): Jev settles about half of
all findings and two thirds of those the key answers, right 96–100% of the time; with sol in codex
and terra in pi voting on the rest, the judge scores 86–90% on the comments over two runs (the
panel 87%), 100% on the oracle and κ 0.84–0.87 with the panel, in about a minute and $0.15 a
judging, five fixtures in 5 minutes. Holding the hit issues out of the key, it called 13–15 of 17
findings of them `new`.

Notes:

- The code is in the data repository's `judges/`, written to move: `matching.ts` (the questions
  and the pure `settleMatches`, with tests) to `packages/lab/src/review/judge/`,
  `voting.ts` in place of the panel's own voting (the panel is `voteOnRest` with nothing settled),
  and `match.workflow.ts` as the judge workflow beside `judge.workflow.ts`. `scripts/match.ts`
  re-settles stored answers at any cut; its logic belongs with the report.
- Moving code the panel imports changes what it measures only if the code does: bump the panel's
  version when it does, so its stored judgings stop counting, and not otherwise.
- Before `voting.ts` can be the panel's voting: share `Case`/`readCase` and the answer schema with
  `judge.workflow.ts`, one claimed-issues helper in `panel.ts` (it is inline in three places), and
  keep `workflow.parallel` labelling. The panel's own prompt changes with it, and so its version.
- Decide the default's voters. The second is OpenAI's for now; claude opus 5.5 is
  [`judge-opus-voter`](judge-opus-voter.md). The sample is 22 judgings; two runs of one judge
  differ by 3 points on the comments.
- Decide whether `noise` and a repeat of a refuted claim, which Jev settles surely, still need a
  code read. `labelProblems` requires `read` for both today, so they go to the agents.
- Bring the per-turn bound (`--turn`: a timed-out turn asked again once in a fresh session) to
  the panel too, or retire the panel.
- The one wrong settled match was a finding with the right symptom and a false cause. Text can't
  tell them apart; a check per hit that asked lost true hits and caught none.
- Jev picks among what it is offered: with a finding's own issue out of the key, it matched a
  neighbouring issue at p 0.97. A genuinely new problem that resembles a known one is settled as
  a hit on it.
