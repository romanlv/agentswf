---
title: Score a review run against a fixture's answer key
summary: Label each finding a run produced against the graded answer key, and report what it caught by severity, what it got wrong, how noisy it was, and what it cost.
type: story
status: todo
discovered_in: "autoresearch planning, 2026-09-23"
depends_on: ["005"]
---

# Score a review run against a fixture's answer key

Why it matters: we need numbers per run that can be compared across runs and variants. Catching
problems isn't enough on its own: a review that also makes wrong claims or buries its findings in
nitpicks is worse, even at the same recall. Findings are worded differently every time, and
matching by line fails. One line can hold two problems, and one problem can be reported where it's
called from.

How it works:

- A judge reads a run's findings (in the common `ReviewFinding` shape from
  [story 005](../005-review-fixtures.md)) and the answer key. It matches on each known problem's
  `mechanism`, not the original comment text. The judge is itself a small awf workflow.
- Every finding gets one label:
  - **hit**: it's a known problem;
  - **new**: a real problem, of any severity, that isn't in the key;
  - **noise**: not wrong, but no use: vague, off-topic, restating the code, or pure preference;
  - **wrong**: a false claim. Repeating one of the key's `refuted` claims is a sure sign;
  - **duplicate**: the same point as an earlier finding in the run;
  - **unsettled**: the same claim as one of the key's `unconfirmed` exclusions. It counts neither way.
- One judge call per fixture labels all its findings at once, so each known problem is claimed by
  at most one finding and later ones are duplicates. Otherwise a run could score high just by
  saying everything twice. Two findings are duplicates if a single change would fix both; when in
  doubt they stay separate (Martian).
- Not being in the key is never enough to call a finding wrong (SWE-PRBench).
- Location is evidence for the judge, not a gate: a correct finding on a nearby line still counts.
- A decision model can settle the confident hits first, leaving the judge the rest: `matchFindings`
  in [story 006](../006-typed-decisions.md) decided 72% of comments at 99% accuracy (findings S8).
- Every score comes with written feedback: what was missed, and why. The loop reads it.
- The judge also grades `new` findings by severity and category, so they can join the key.
  No person checks them: independent graders from a model family other than the finder's vote on
  them, as `draft-key` does. The finding is copied into `key/evidence/runs/` so the key never
  points at a run directory that may be cleaned up. It's added with that as its source, which bumps
  the key's `revision`, and earlier runs are re-scored against it. Issue ids are never renumbered
  across revisions.

What it reports per run:

- **Recall by severity:** the share of `must-fix` and `should-fix` problems caught, and a weighted
  recall over all but nits (3, 2, 1). Nits are reported apart. Every missed `must-fix` is named.
- **Precision:** hits and new findings, over all findings that aren't duplicates.
- **Wrong claims:** their share of all findings. This is what makes people stop trusting a
  reviewer; aim for under 10%.
- **Noise:** the share of noise, the share of findings that are only nits, and the total words,
  as a measure of verbosity.
- Recall by category, and problems in code the MR didn't touch (`scope: "context"`) reported
  separately.
- Recall split by where each known problem came from: an earlier AI reviewer's comment, a
  person's, a bot's, a fix nobody commented on, or a run. Most keys come from one earlier AI
  reviewer, so a variant that imitates it scores well on its comments; the split shows that.
- Every score records the key's `revision` and `procedure`; scores are compared only on the same.
- Every score also records the fixture's digest from `set.json`, and runs `verifySet` first, so a
  fixture changed since the set was sealed is caught. A set has no clean MRs yet, so it can't count
  false alarms on code with nothing wrong; add them once there's a way to know an MR is clean.
- A score can count only some categories, for example just `correctness` and `security`. A true
  finding outside them is neither rewarded nor penalised.
- The run's cost and time (story 002), and the judge's own cost, kept separate.

The judge:

- It must agree with itself across model families. Two judges from different families label the
  same runs; aim for κ ≥ 0.7 between them, and settle disagreements by a third vote.
- Use a different model family from the reviewer being scored, because models favour their own
  output.
- Pin its version, and store its model and prompt version with every score. Raw findings are kept
  apart from scores, so a new judge re-scores old runs without re-running the reviewers.
- Sanity checks before trusting it: an `oracle` variant that returns the key's own problems must
  score full recall, and a `nop` variant that returns nothing must score zero (Harbor).
- When several strong variants agree on something the key lacks, that goes to the graders first.

Its home: `packages/autoresearch`, beside story 005's format. It only reads run records and never
reaches into the engine ([ADR 0002](../../adr/0002-autoresearch-lives-here.md)). The scored-run
record will have readers of its own, so design it with the same care as the fixture format.

Evidence: [`autoresearch-practices`](../../research/autoresearch-practices.md), the grading
section of [`review-fixtures`](../../research/review-fixtures.md#grading), and
[`review-eval-prior-art`](../../research/review-eval-prior-art.md).
