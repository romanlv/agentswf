---
title: Grow an answer key from what scored runs find
type: story
status: todo
priority: P2
epic: loop
discovered_in: "story 008 refinement, 2026-09-26"
depends_on: ["008"]
---

# Grow an answer key from what scored runs find

Graders from other model families vote on a scored run's `new` and `wrong` findings; confirmed ones
join the key's `issues` or `refuted`, copied into its evidence, with the revision bumped and earlier
runs re-scored.

Why it matters: a key drafted from one earlier reviewer's comments under-counts what a better
reviewer finds, so its `new` findings look like noise to recall. Adding the real ones makes later
scores fairer and keeps keys from rewarding imitation of that reviewer. The false claims matter
too: a confirmed `wrong` finding added to `refuted` makes a later repeat a sure `wrong`, as the
drafted refuted claims are now, and takes that call off the judges.

Notes: split out of [story 008](../008-review-scorer.md), whose score records keep every `new`
finding and the key revision, so this needs no format change there. The rules, from the
retired `review-recall-scorer` todo: independent graders from a family other than the
finder's vote; the finding is copied into `key/evidence/runs/` so the key never points at a run
directory that may be cleaned up; issue ids are never renumbered; earlier runs are re-scored.
When several strong variants agree on something the key lacks, that goes to the graders first.
