---
title: Evaluate a second kind of workflow, and make the lab's case side generic
summary: Build a dataset of triage tickets with known routes, and turn awf-lab's review-only dataset, restore and variant into a case kind that both reviews and triage implement.
type: story
status: todo
discovered_in: "story 011, decision 1, 2026-09-30"
depends_on: ["011"]
---

# Evaluate a second kind of workflow, and make the lab's case side generic

Why it matters: story 011 makes the scorer and the comparison generic, so any workflow's per-case
numbers can be compared. What a case is, how its environment is restored, and how a variant is
handed one are still review's (`defineReviewVariant`, the snapshot bundle, `request.md`).
[[evaluation]] and foundation §10 wait for a second kind before generalising them, so the seam is
drawn from two real uses rather than guessed from one.

Notes:

- Candidate: `examples/triage` (story 006) routes tickets with a decision model. A case is a
  ticket and its right route; the environment is nothing, or a read-only knowledge folder; the
  scorer is code (route matches), so no agent judges it. Cheap cases make it a good contrast to
  reviews.
- What becomes generic: a case kind declares its case format and checks, how a trial's environment
  is prepared (review: restore the checkout; triage: none), how a variant is given a case (argv
  placeholders), and which scorers apply. `defineEnvironment` from [[evaluation]] is the likely
  shape.
- The records keep one format per kind; the metric vector and the comparison are already shared
  from story 011.
- Proves the autoresearch loop is not review-specific before the loop is built.
