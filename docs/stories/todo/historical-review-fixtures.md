---
title: Historical review fixtures from merged MRs
summary: Rebuild merged GitLab MRs as they were when review started, with the issues review found and the fixes that followed as the answer key.
type: story
status: todo
discovered_in: "autoresearch planning, 2026-09-23"
depends_on: []
---

# Historical review fixtures from merged MRs

Why it matters: an autoresearch loop over review workflows needs something to score against. Cost
and wall time are already recorded (story 002); quality is not, and foundation §13.5 says whatever
stands in for it must be emitted here, or the loop finds the cheapest way to be wrong. A merged MR
already holds the answer: the code as it was when review started, the comments reviewers added, and
the fixes that followed.

Notes:

- This is experiment E1 and research item R1 in
  `braintrust/docs/projects/code-reviews/review-architecture-options.md` §6 and §9. Nothing found
  shows either has been run.
- A fixture holds: the reviewed snapshot (`base_sha`, `start_sha`, `head_sha` of the first reviewed
  MR version), the MR description as it was then, and the known issues. Each known issue keeps its
  provenance: GitLab project, MR iid, discussion and note ids, the full diff position, and the
  confirmation basis — fixed by a later version touching the commented lines, accepted, deferred,
  or refuted (the reviewer backed down).
- The cheap first slice needs no reconstruction. Findings a ledger in `braintrust/docs/reviews/`
  marks `deferred` or `accepted` are still in the merged code, so the merged head is the snapshot.
  `braintrust/docs/projects/code-reviews/workflow-experiment.md` scored AIRS-1413 this way.
- The expensive slice uses GitLab's MR versions and discussion positions. The open question is
  recoverability: whether force-pushed or rebased versions' SHAs stay fetchable, and whether the
  stored diff is enough when they do not. Measure on about five MRs across ordinary, rebased,
  force-pushed and old cases before anything depends on it.
- **The fixture format is an expensive decision.** The scorer, the matrix runner and every stored
  result read it. Design it on paper against the first five fixtures, then fix it.
- Fixtures contain private AIR code and GitLab data, so the data does not live in this repository.
  Proposed split: the format here, the builder and the data in braintrust or under `~/.awf/fixtures`.
- Bias: the lens catalogue was mined from these MRs, so replaying them measures recovery of known
  patterns, not generalisation. Keep later, unmined MRs as a temporal holdout from the start (E9).
- A fixture's known-issue list grows: novel findings confirmed by adjudication are added with their
  own provenance ([`review-recall-scorer`](review-recall-scorer.md)).
- Exclude what published benchmarks exclude ([`autoresearch-practices`](../../research/autoresearch-practices.md)): bot-authored comments, nits and questions that
  name no defect, and MRs with fewer than two substantive findings. A post-merge bug later traced
  back to the MR is an extra known issue, as in SWR-Bench.
- Five fixtures design the format; they do not score. Comparing variants needs tens of MRs, sized
  by a power analysis on the first runs' variance.

Done when: five end-to-end fixtures, a recoverability report with exclusion rules, and the fixture
format written down.
