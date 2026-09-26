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
choosing between two models or two review workflows gets an answer with a spread instead of one run's anecdote.

Notes:

- A variant is any review workflow plus the arguments that configure it, and a way to read its
  output as findings (`ReviewVariant` in [story 005](../005-review-fixtures.md)). A lens catalogue
  with verifiers is one variant; a single agent with a short prompt is another. It runs through
  `runWorkflow` with injected runtime, as foundation §7 requires.
- Holdout is per variant: each records what it was tuned on (`tunedOn`), and fixtures outside that
  are its holdout.
- A variant is identified by a hash of its workflow, arguments and prompts, not a free name, and
  every row records it with the fixture's hash (Harbor).
- Every row says whether the reviewer failed or the environment broke; the two are counted apart.
- Try a new variant on a small subset first, and run the full set only if it looks promising.
- At least three repetitions per variant and fixture. Compare each variant with the current best
  fixture by fixture, and report how sure the difference is. Variants whose difference is within
  the noise are reported as tied, not ranked.
- A single agent with tools is a real contender, not only a baseline: Cursor's biggest gain came
  from one agent with aggressive prompts, more than from parallel passes and voting
  ([`review-eval-prior-art`](../../research/review-eval-prior-art.md)).
- The matrix always carries a plain single-agent review with no checklists as a baseline, and context
  size as an axis: a single agent matches optimised multi-agent workflows in published results,
  and more context lowered review recall on SWE-PRBench ([`autoresearch-practices`](../../research/autoresearch-practices.md)).
- Rows go to JSONL, one per run, with a report generated from them. `experiments/_archive/trial.ts`
  and `runner.ts` are the prior art to lift.
- A failed or contaminated run is a row with its spend, not a gap —
  [story 003](../003-failed-run-accounting.md) is why this depends on it.
- Concurrency (E4) has never been measured. Run sequentially first, or measure E4 before running
  variants in parallel.
- Its home is `packages/autoresearch`, beside story 005's format. A project's own variants and
  fixture sets live in that project's workflows repository, which imports the package.
