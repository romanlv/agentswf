---
title: Let an agent propose review variants and keep the better ones
summary: Close the loop — an agent changes one variable, the matrix runs it, and the change is kept only if the score improves within budget.
type: story
status: todo
discovered_in: "autoresearch planning, 2026-09-23"
depends_on: ["variant-matrix-runner"]
---

# Let an agent propose review variants and keep the better ones

Why it matters: this is the loop [ADR 0002](../../adr/0002-autoresearch-lives-here.md) and the
foundation's vision name — runs that improve runs. It is the easy part once the matrix runner exists,
and building it earlier would optimise against a weak or leaky answer key.

Notes:

- The proposer changes one variable at a time — lens set or routing budget, model per stage,
  prompt, verifier limit — and records why. The matrix scores it; it is kept only if it beats the
  incumbent beyond the spread.
- The objective has to be stated before the first run: recall of `issue`-severity known defects as a
  floor, then cost and time. A scalar that trades a missed `issue` for dollars is the wrong one.
- Selection happens on the tuning fixtures. The holdout is checked rarely, for a final candidate:
  a holdout consulted every round overfits like a dev set (Dwork et al.). The temporal holdout is
  untouched until then.
- Shaped like Karpathy's `autoresearch`: one editable variant file, a human-written `program.md`
  that steers the proposer, a read-only scorer, a results log, and a simplicity tie-break — fewer
  lenses or less spend at equal recall.
- A change is kept only when its gain exceeds the paired interval, and acceptance tightens in later
  rounds: in one study helpful changes fell from 70% to 43% of proposals as rounds went on.
- The proposer is told why each known issue was missed, GEPA-style, from tuning fixtures only. It
  is the most sample-efficient mutation signal measured.
- A spend cap per loop, enforced from the accounting, not trusted to the proposer.
- Evidence: [`autoresearch-practices`](../../research/autoresearch-practices.md).
- `braintrust/docs/projects/code-reviews/workflow-experiment.md` suggests where to start: routing
  budget moved recall more than prompt wording did.
