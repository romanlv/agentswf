---
title: Stop a comparison as soon as a gain worth having is out of reach
summary: Give the standard comparison a futility stop and an equivalence margin the dataset can resolve, have check say what a verdict can decide, and make run --baseline cheaper and faster, from what story 011's live check cost.
type: story
status: todo
discovered_in: "story 011, task 7's live check, 2026-09-30"
depends_on: ["011"]
---

# Stop a comparison as soon as a gain worth having is out of reach

Why it matters: story 011's live check compared the codex baseline with a public review skill
added, over 16 cases × 2 trials: $27.40 at list price and about 4 hours, and it ended `undecided`
at its `--cases 16` cap. Recall was −0.01 [−0.08, +0.06]: the variants are about equal, and the
standard comparison has no way to say so early. The autoresearch loop proposes many small
changes, most of them no better; each would cost the whole dataset and still end undecided.

Why the current design can't conclude on equals:

- `worse` needs the interval wholly below 0, and `better` a gain past the O'Brien–Fleming bound at
  a look. Between equals, neither fires, by design.
- `tie` is judged only at the plan's end, and needs recall shown within ±0.05. At 33 cases × 2
  trials the interval is about ±0.05 wide at best (`check`'s resolution, ~0.08–0.12), so equals
  seldom show it: the README's own simulation says so. The plan runs out, `undecided`.
- Tie-breakers (cost, time) decide only after a tie on recall, so a slower equal (here +36 s a
  case, [+16, +55]) is never called worse on time.

Notes, the design changes first:

- **A futility stop.** `pairedComparison({ minGain })`: stop when the primary's upper bound is below
  the smallest gain worth having, at any case or at looks. It would have stopped this run at the
  look at 8 cases (upper bound +0.045 < +0.05), half the spend. Futility stops add no false wins
  (research §3). It fits the published `Verdict` as `undecided` with `stop: true` and a reason, or
  as a new verdict value, `not-better`, which is a published change to settle first.
- **An equivalence margin the dataset can resolve.** Either set `equivalence` from `check`'s
  resolution (about ±0.08 for 33 cases here), or let "no gain of `minGain` or more" at the plan's
  end be what opens the tie-breakers. Which is right for the loop, keep or discard, is the question
  to settle: a loop wants "not better, and cheaper or faster?" more than "equal".
- **`check` says what a verdict can decide:** with the measured variance, how many cases a tie at
  the comparison's margin needs, and whether `minGain` is resolvable at all, before any spend.
- **Run the baseline once, whole.** Its trials were $10.57 of the $27.40. Two trials of every case
  once, and each challenger pays only its own; `check` then knows the variance up front. An
  operating step in the data repository, and worth a line in the README.
- **Throughput:** `run --baseline --ahead {n}` starts the next cases' trials while a case is being
  scored, wasting at most n cases on a stop. Today `--jobs` runs within one case only, so 16 cases
  took about 4 hours.
- **Smaller CLI fixes:** estimate a new variant's cost from the baseline's history, not "unknown";
  `list` flags a config `scorer` that no longer exists, as it does the comparison; one progress
  line per case with the spend so far and the next look.

Checked against Anthropic's posts on evals and hill-climbing (2026-09-30):

- Already as they advise: trials a case averaged per case and the case as the unit, so the
  interval is clustered on it; paired differences; a power analysis (`check`'s resolution);
  suspect cases (0% on every trial is "most often a broken task"); headroom (saturation); tasks from
  real failures. Sources: [a statistical approach to model evaluations](https://www.anthropic.com/research/statistical-approach-to-model-evals),
  [demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
- The power analysis is advice, not a gate: they size the eval to the effect before running it,
  and `run --baseline` does not. Hence `check` saying what a verdict can decide, above.
- "Large effect sizes mean small samples suffice" holds early; a loop's small tweaks (one skill)
  are the small-effect regime, where 33 cases cannot resolve a gain. The futility stop is what
  makes that regime cheap: the automated researchers "design fast, cheap experiments to test the
  hypothesis first", then commit to the full run.
- **Not covered yet: a held-out confirmation.** A loop that keeps the best of many variants on the
  same cases overfits them (the winner's curse), and the automated weak-to-strong researchers
  cherry-picked seeds and exploited dataset structure until tested on held-out data
  ([automated weak-to-strong researcher](https://alignment.anthropic.com/2026/automated-w2s-researcher/)).
  Counting whole cases and the oldest k trials already stops re-running for a better seed; a
  kept variant should also be confirmed on cases the loop never compared on.
