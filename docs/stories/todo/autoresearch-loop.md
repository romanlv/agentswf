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

- It is the comparison in `variant-matrix-runner` with an agent as the proposer; it adds the
  proposer, the log and the spend cap, and nothing else.
- The proposer changes one variable at a time — the workflow's shape, a checklist, model per
  stage, prompt, verifier limit — and records why. The matrix scores it; it is kept only if it beats the
  incumbent beyond the spread.
- The objective has to be stated before the first run: recall of `must-fix` and `should-fix`
  known problems as a floor, wrong claims as a ceiling, then noise, cost and time. A scalar that trades a
  missed `must-fix` for dollars is the wrong one.
- Selection happens on the fixtures the variant is tuned on. Anything used to keep or discard a
  variant joins its `tunedOn` (story 005), as GEPA's validation set does. The holdout is checked
  rarely, for a final candidate: a holdout consulted every round overfits like any other test set
  (Dwork et al.).
- Each try is logged as parent, change, score difference, interval and decision, so the history is
  a tree that can be read back (autoresearch, OpenEvolve).
- Shaped like Karpathy's `autoresearch`: one editable variant file, a human-written `program.md`
  that steers the proposer, a read-only scorer, a results log, and a simplicity tie-break — fewer
  agents or less spend at equal recall.
- A change is kept only when its gain exceeds the paired interval, and acceptance tightens in later
  rounds: in one study helpful changes fell from 70% to 43% of proposals as rounds went on.
- The proposer is told why each known issue was missed, GEPA-style, from tuning fixtures only. It
  is the most sample-efficient mutation signal measured.
- A spend cap per loop, enforced from the accounting, not trusted to the proposer.
- Evidence: [`autoresearch-practices`](../../research/autoresearch-practices.md).
- An earlier, private experiment suggests where to start: routing budget moved recall more than
  prompt wording did.
