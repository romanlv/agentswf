---
title: Make a comparison decide what it can, sooner
type: story
status: todo
discovered_in: "story 011, task 7's live check, 2026-09-30"
priority: P0
epic: loop
depends_on: ["011"]
---

# Make a comparison decide what it can, sooner

Give the standard comparison, whose futility stop is built, an equivalence margin the dataset can
resolve, have check say what a verdict can decide, and make run --baseline cheaper and faster, from
what story 011's live check cost.

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

The first live loop (2026-10-01, data repository `reports/2026-10-01-first-live-loop.md`) hit the
same wall, at 1 trial a case: a try of +0.035 [−0.01, +0.08] ran all 23 tuning cases, about 3 hours
and $24, because +0.05 was still in reach at the look at 16. What it asks of this story, in its
order:

1. **Run the cases up to each look in parallel** (`--ahead`, below). Cases ran one at a time, about
   6 minutes each.
2. **Stop a try at its first look unless it is clearly promising**: at 8 cases, unless the gain
   there is at least `minGain`. A screening rule, stricter than the futility stop, which stops
   only when the upper bound is below `minGain`. It trades some missed small gains for cost; with
   1 trial a case a gain under ~0.10 can't be shown anyway.
3. **A resolution at 1 trial a case.** `check` needs two trials to split the variance, so the
   proposer was told no target size. Use the variance measured on the same dataset at 2 trials
   (story 011's runs), saying where it came from.

Notes, the design changes first. Story 011's task 8 built the futility stop (`minGain`, at looks,
in the default comparison at 0.05) and `check`'s tie line; the rest is open.

- **A futility stop (built in 011, task 8).** `pairedComparison({ minGain })`: stop when the primary's upper bound is below
  the smallest gain worth having, at looks only, as built. It would have stopped this run at the
  look at 8 cases (upper bound +0.045 < +0.05), half the spend. Futility stops add no false wins
  (research §3). It fits the published `Verdict` as `undecided` with `stop: true` and a reason, or
  as a new verdict value, `not-better`, which is a published change to settle first.
- **The keep rule, settled by the user (2026-09-30):** the same quality, faster and cheaper, is
  better. "The same quality" must be something the dataset can show: recall shown no worse than a
  non-inferiority margin it resolves (from `check`'s tie line), guards within theirs. Open: whether
  cheaper or faster alone is enough, as the tie-breakers decide today, or both are needed, as the
  user put it.
- **An equivalence margin the dataset can resolve.** Either set `equivalence` from `check`'s
  resolution (about ±0.08 for 33 cases here), or let "no gain of `minGain` or more" at the plan's
  end be what opens the tie-breakers. Which is right for the loop, keep or discard, is the question
  to settle: a loop wants "not better, and cheaper or faster?" more than "equal".
- **Found in task 8's review, for the keep rule:** with `minGain` equal to `equivalence` (both
  0.05 in the default), a challenger shown within ±0.05 at a look before the last also stops on
  `minGain`, before the tie-breakers run at the plan's end: "equal on recall but cheaper" can't be
  reached under the default. Moot at today's variance, where a tie is out of reach anyway. And a
  real regression whose interval still reaches above 0 stops as `undecided`, not `worse`: at a true
  −0.10, 35% of runs in simulation. Both are discards for a keep-or-discard loop; a loop that must
  tell worse from not better reads the interval in the reason.
- **`check` says what a verdict can decide** (the tie's reach built in 011, task 8; `minGain` not
  yet, as `check` doesn't read the comparison's settings): with the measured variance, how many cases a tie at
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
- A held-out confirmation, against the winner's curse
  ([automated weak-to-strong researcher](https://alignment.anthropic.com/2026/automated-w2s-researcher/)),
  is built in [story 013](../013-autoresearch-loop.md): `awf-lab loop --final` checks the kept
  incumbent on a holdout the loop never compared on.
