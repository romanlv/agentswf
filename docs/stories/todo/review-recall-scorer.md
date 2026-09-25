---
title: Score a review run against a fixture's known issues
summary: Match a run's findings to the known issues by failure mechanism and report recall, novel findings, cost and time.
type: story
status: todo
discovered_in: "autoresearch planning, 2026-09-23"
depends_on: ["historical-review-fixtures"]
---

# Score a review run against a fixture's known issues

Why it matters: the loop needs one comparable number per run, and a finding is worded differently
every time. Line proximity alone mismatches; the same file and line can hold two mechanisms, and one
mechanism can be reported at its caller.

Notes:

- Matching is by failure mechanism, so it is a judge with a rubric — itself a small awf workflow
  reading the fixture and the run's `output.json`, which since story 003 has an `outcome`: only a
  `succeeded` run has findings to score. The rubric and matching method are R6 in
  `braintrust/docs/projects/code-reviews/review-architecture-options.md` §9.
- Output per run: recall per known issue, weighted by severity, with `issue`-severity misses listed
  by name; the findings matching nothing, as candidates; cost and wall time from story 002's
  accounting.
- Every finding gets one of three labels: matched, correct but unlisted, or fabricated. Matching is
  one-to-one, so one finding cannot claim several issues. Without a fabrication count the loop
  raises recall by flooding findings — SWE-PRBench and SWR-Bench both score this way.
- A candidate is not a false positive because history missed it. Candidates go to adjudication, and
  confirmed ones join the fixture's known issues — the best-known set of the braintrust doc. The
  judge's own cost is reported apart from the variant's.
- The judge is validated against human labels on at least ~30 findings, targeting κ ≥ 0.7, and
  comes from a different model family than the reviewer it scores (self-enhancement bias). The
  judge is pinned; changing it resets every comparison. Evidence: [`autoresearch-practices`](../../research/autoresearch-practices.md).
- It is a consumer, per [ADR 0002](../../adr/0002-autoresearch-lives-here.md): it reads the run
  record and never reaches into the engine. **The scored-run record is a format with readers**; design
  it with the fixture format.
