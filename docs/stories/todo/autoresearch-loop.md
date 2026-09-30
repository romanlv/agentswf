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
- From Anthropic's `hillclimb` and `cost-hillclimb` guides
  ([research §8](../../research/variant-comparison.md#8.%20Anthropic's%20build-eval%20and%20hillclimb)),
  improved where they are weak:
  - One hypothesis per try, saved as a patch and kept or reverted whole. A scope file says what the
    proposer may and may not change.
  - The proposer predicts the effect and names the mechanism the records must show; it describes
    a failure's behaviour and never copies case content into the variant.
  - A proposal whose best case is under the comparison's resolution (story 011's `check`) is
    refused before it spends.
  - After two or three rounds without a verdict, one round sorts the tuning failures by root
    cause; suspect cases go to an audit, not to the proposer.
  - Unlike the guide, the holdout is not consulted every round, and the headline is the kept
    variant confirmed on fresh trials, not the score of the round that selected it.
  - Later: a model × effort staircase per stage, from `cost-hillclimb`.
- The proposer's input, per research's "For awf" (e): per case and trial, the metrics, the outcome,
  the feedback text and a pointer to the run; the comparison with its parent and the decision; the
  history tree; the metric specs and the comparison in force; the spend left. Tuning cases only.
- A thin agent skill that drives story 011's `check`, `run` and `report`, so a person or an agent
  gets the checks without following a long guide.
