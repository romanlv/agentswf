---
title: Run review variants across fixtures and compare them
summary: Run each variant on each fixture several times, isolated and scored, and report recall, cost and time with their spread.
type: story
status: todo
discovered_in: "autoresearch planning, 2026-09-23"
depends_on: ["003", "eval-isolation", "review-recall-scorer"]
---

# Run review variants across fixtures and compare them

Why it matters: this is the evaluation half of autoresearch, and it is useful on its own — a person
choosing between two models or lens sets gets an answer with a spread instead of one run's anecdote.

Notes:

- A variant is what `catalogue-review` already takes as arguments: runtime aliases (harness, model,
  placement), lens set, verifier runtime, `maxVerifyPerLens`. It runs through `runWorkflow` with
  injected runtime, as foundation §7 requires.
- At least three repetitions per variant and fixture. Report paired per-fixture differences against
  the incumbent, with standard errors clustered by MR; variants inside the interval are reported
  as indistinguishable, not ranked.
- The matrix always carries a plain single-agent review with no lenses as a baseline, and context
  size as an axis: a single agent matches optimised multi-agent workflows in published results,
  and more context lowered review recall on SWE-PRBench ([`autoresearch-practices`](../../research/autoresearch-practices.md)).
- Rows go to JSONL, one per run, with a report generated from them. `experiments/_archive/trial.ts`
  and `runner.ts` are the prior art to lift.
- A failed or contaminated run is a row with its spend, not a gap —
  [story 003](../003-failed-run-accounting.md) is why this depends on it.
- Concurrency (E4) has never been measured. Run sequentially first, or measure E4 before running
  variants in parallel.
- Its home in the repository is decided when it first runs ([ADR 0002](../../adr/0002-autoresearch-lives-here.md)):
  a folder, and a package only if something outside imports it.
