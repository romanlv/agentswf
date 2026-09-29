---
title: Compare a review variant with the incumbent
summary: A person with an idea runs it against what they have — a subset first, the full set if it looks promising — and gets recall, wrong claims, cost and time per fixture with their spread; the loop uses the same comparison.
type: story
status: todo
discovered_in: "autoresearch planning, 2026-09-23"
depends_on: ["003", "eval-isolation", "008"]
---

# Compare a review variant with the incumbent

Why it matters: this is the first use of everything before it. A person with an idea for a review
workflow asks "how does this compare with what we have?" and gets an answer with a spread instead
of one run's anecdote. The loop is the same comparison with an agent proposing
([ADR 0002](../../adr/0002-autoresearch-lives-here.md), amended 2026-09-26).

The shape, to refine:

```sh
awf-lab report {challenger} --baseline {baseline} [--cases {n}] [--trials 3]
```

- It builds on story 008's `awf-lab`, whose `run` makes and scores a variant's trials per case
  and whose `report` already sets variants side by side against a baseline; `--trials` above 1
  and `{case}/{trial}` beyond `/1` are refused until this lands. This adds several trials per case, the paired interval, early
  stopping and gating, without changing those commands.
- Reuse is an explicit decision per fixture, printed with counts and estimated cost before any
  spend (Harbor's `--diff`): variant hash or fixture digest changed, rerun; key revision or judge
  version changed, rejudge; metric code changed, recompute; environment failure, rerun; else reuse.
- Compare paired on fixture id and digest, which no framework ships: per-fixture improvements and
  regressions (Braintrust's view), plus the mean per-fixture difference with a bootstrap interval
  over fixtures; a tie when it spans zero. Every repeat is its own record, reduced in the metrics.
- Subsets are seeded, so the first {n} fixtures are the same for incumbent and challenger
  (promptfoo). A stopping hook asked before each fixture (Inspect's `EarlyStopping`) stops when the
  paired interval's upper bound is below zero.
- See [`eval-orchestration`](../../research/eval-orchestration.md).
- Only the new variant runs. The incumbent's scores are read from `scores/{set}/{variant}/`
  ([story 008](../008-review-scorer.md)), judged again from stored findings if the key or judge
  changed since.
- Subset first by default: a few fixtures, stop early if the idea is clearly worse, the full set
  only if it looks promising. Cost decides this. Judging is about $5 per run over the first set,
  but a heavy reviewer is $4–7 per fixture, so the full set at three repeats is $400–700 for one
  variant.
- The report is per fixture and overall: recall of `must-fix` and `should-fix`, wrong claims,
  noise, cost and time, each difference with its interval, a tie when it is within the noise.
- The person's variant records its `tunedOn` like the loop's: fixtures whose results shaped it.

Notes:

- A variant is any review workflow plus the arguments that configure it, and a way to read its
  output as findings (a variant file, [story 008](../008-review-scorer.md)). A lens catalogue
  with verifiers is one variant; a single agent with a short prompt is another. Each runs with
  `awf run`, as story 008 settles.
- Holdout is per variant: each records what it was tuned on (`tunedOn`), and fixtures outside that
  are its holdout.
- A variant is identified by a hash of its workflow, arguments and prompts, not a free name, and
  every record keeps it with the fixture's digest (Harbor).
- Every record says whether the reviewer failed or the environment broke; the two are counted apart.
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
- Records are story 008's files, one per run and judging, with the report generated from them.
  `experiments/_archive/trial.ts` and `runner.ts` are the prior art to lift.
- A failed or contaminated run is a record with its spend, not a gap —
  [story 003](../003-failed-run-accounting.md) is why this depends on it.
- Concurrency (E4) has never been measured. `awf-lab run --jobs {n}` (story 008) runs steps in
  parallel, every trial first and then every score, opt-in with a default of 1; running
  variants in parallel, and a default above 1, still wait on E4. Time measured under `--jobs` is
  not comparable with time measured one at a time.
- Its home is `packages/autoresearch`, beside story 005's format. A project's own variants live in
  its workflows repository and its fixture sets in its autoresearch repository, which imports the
  package.
