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
