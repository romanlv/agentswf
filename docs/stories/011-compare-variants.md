---
id: "011"
title: Say whether a workflow variant beats the incumbent, and how sure that is
summary: The evaluating project defines its scorer, which turns a trial into named per-case metrics, and its comparison, which turns two variants' per-case metrics into a verdict; awf-lab runs several trials per case, calls both, and stops when the comparison says so. The lab ships a standard paired comparison and match first as the review scorer.
type: story
status: done
discovered_in: "variant-matrix-runner and decision-matching todos, 2026-09-29"
depends_on: ["008", "010"]
---

# Say whether a workflow variant beats the incumbent, and how sure that is

## Outcome

Someone with an idea for a workflow asks "is this better than what we have?" and gets an answer
with its uncertainty, not one run's anecdote. The same answer is what the autoresearch loop acts on
([[autoresearch-loop]]), so it works for any workflow evaluated against cases with known answers,
not only reviews.

The project doing the evaluation owns two things, and awf-lab owns the running:

| | Who writes it | What it gets | What it returns | Review's, shipped by the lab |
| --- | --- | --- | --- | --- |
| **scorer** | the project, or reuses one | one trial and its case | named numbers for that trial, each with a direction | match first; a review's numbers are named in `review/metrics/named.ts` |
| **comparison** | the project, or reuses one | both variants' numbers, case by case | better, worse, tie or undecided, whether to stop, and why | `pairedComparison({ … })`, as `default` |
| **running** | awf-lab | — | trials, scores, the report, the stop | — |

GEPA's `should_accept` works the same way: it gets both candidates' per-case scores, so it can pair
cases ([[variant-comparison#7. Who defines the scorer and the comparison|research §7]]). This story
joins two todos, [[variant-matrix-runner]] and [[decision-matching]]: several trials per case
multiply scoring, and match first scores at a fifth of the panel's time and list price.

## How it works

```text
awf-lab check {baseline}                    headroom, resolution, how close a tie can be shown,
                                            failures, suspect cases; from records, no spend
awf-lab run {challenger} --baseline {baseline} --trials 2
  per case, in the dataset's seeded order:
    trials still missing, for both variants ─▶ awf run each
    scorer ─▶ per trial { "recall.weighted": 0.5, "wrong": 0, … }   + cost and time, from awf-lab
    comparison over the whole cases both have
       ─▶ undecided, stop: false            carry on
       ─▶ better / worse / tie, stop: true  spend no more
       ─▶ undecided, stop: true             no answer worth having is in reach
awf-lab report {challenger} --baseline {baseline}
    the same comparison over stored records: the same verdict
```

The package's comparison, `default` (a workspace's own `*.compare.ts` replaces it):

```ts
// packages/lab/src/review/lab/default.compare.ts
export default pairedComparison({
  version: "1.1.0",
  primary: "recall.weighted",
  guards: [                                       // may not get worse by more than the margin
    { metric: "wrong", margin: 0.05 },
    { metric: "precision", margin: 0.05 },
  ],
  looks: [8, 16],                                 // "better" only at these case counts, and the end
  minGain: 0.05,                                  // stop at a look once a gain of 0.05 is out of reach
  equivalence: 0.05,                              // tie-breakers only if recall is shown within ±0.05
  tiebreak: [                                     // and then only by more than a margin
    { metric: "cost", margin: 0.05 },
    { metric: "time", margin: 30 },
  ],
});
```

- **The comparison's input** is, per variant, `{ case, trial, outcome, metrics }` for every trial of
  the whole cases so far, where `outcome` is `scored`, `variant-failed` (a result, scored by each
  metric's failure value) or `missing`. It sees no finding, key or label, so one comparison serves
  every kind of workflow.
- **`pairedComparison`**, the rule the research supports for 5–40 costly cases
  ([[variant-comparison]]): each variant's trials averaged per case, a paired t interval on the
  per-case differences, and cases won, tied and lost beside it. `worse` as soon as the primary's
  interval is below 0 or a guard's past its margin. `better` only at a planned look, past an
  O'Brien–Fleming bound, with every guard within its margin. With `minGain`, a look before the last
  stops a challenger that can no longer gain that much. At the plan's end come the tie-breakers,
  then a tie. There's never a weighted sum.
- **Several trials a case** (`--trials k`, or `trials` in the config): a case counts only once all
  k are run and scored, so a look is never taken twice at one count. Trials are numbered by age.
- **What reruns:** a new variant version, case digest or sandbox setting reruns the trial; a new
  scorer version or key revision re-scores it; a new metric or comparison only recomputes, since
  neither is stored.

The lab README has the full rules, the simulated rates, and the command line.

## Scope

In scope, all built: `@agentswf/lab/compare`; comparison files and `--comparison`; `--trials`;
`run --baseline` with the comparison's stop; match first as the one review scorer, with the panel
retired; `awf-lab check`.

Out of scope:

- The proposer, the history, the spend cap and the holdout: [[autoresearch-loop]].
- A second kind of case's dataset, restore and runner: [[second-case-kind]].
- Several challengers at once, and variants run in parallel.
- A stored metrics record: the numbers are derived, and storing them would freeze a format one kind
  used.

## Context and evidence

- At 5–40 cases the paired t interval holds its coverage and the bootstrap doesn't; futility stops
  add no false wins; checking every case with a fixed interval gives 25% false wins (research §1,
  §3).
- On the codex baseline, weighted recall varies with sd 0.19 between cases and 0.13 between trials
  of one case (experiment 1). So 33 cases × 2 trials resolve differences of about 0.08–0.12, and 8
  cases only about 0.19–0.27.
- Constraint: `lab` imports contract only and runs workflows through `awf run` (boundary 5).
- Constraint: throwaway live checks run on codex, not claude.

## Code map

- `packages/lab/src/compare/`: pure, imports nothing. `types.ts`, `paired.ts`
  (`pairedComparison`, `perCase`, `compareMetric`), `resolution.ts` (`varianceOf`, `resolution`,
  `tieReach`), and `stats.ts` (the t distribution and O'Brien–Fleming bounds).
- `packages/lab/src/review/metrics/named.ts`: a review's metrics by name.
- `packages/lab/src/review/lab/`:
  - `default.compare.ts`;
  - `report.ts`, which counts whole cases only and calls the comparison;
  - `against.ts`, which runs `run --baseline` case by case;
  - `check.ts`;
  - `plan.ts`, `where.ts` and `execute.ts`, which handle trials by number.
- `packages/lab/src/review/judge/`: match first. `matching.ts` settles what Jev is sure of,
  `voting.ts` has the voters label the rest, `case.ts` reads a judged case (does I/O), and
  `match.workflow.ts` and `judge.workflow.ts` hold the panel form. `lab/match-first.scorer.ts` is
  the built-in.

## Proposed design

What this story publishes, approved by the user on 2026-09-30:

- `@agentswf/lab/compare`: `MetricSpec`, `CaseScore`, `ComparedMetric`, `Verdict`,
  `ComparisonInput`, `Comparison`, `defineComparison`, `pairedComparison` and `PairedOptions`,
  `perCase`, `compareMetric`, and `COMPARISON_KIND` (`awf.comparison/1`). `minGain` is an optional
  option added in task 8.
- A comparison file: the default export of a `Comparison`, found by `awf-lab.json`'s `comparisons`
  globs, named by its file and versioned in semver. `default` is reserved.
- A review's metric names: `recall.weighted`, `recall.must-fix`, `recall.should-fix`,
  `recall.could-fix`, `precision`, `wrong`, `noise`, `cost` (USD) and `time` (seconds).
- `awf-lab.json`: `comparison`, `comparisons`, `trials`, and a `scorer` that is optional
  (`match-first` when absent).
- Output formats:
  - `awf.lab-report/4`: a verdict per challenger, plus `trials`;
  - `awf.lab-list/3`: the comparisons;
  - `awf.lab-check/1`: new.
- Stored records keep their formats.

Alternatives rejected:

- A comparison built into awf-lab and configured by an objective: the project couldn't change the
  rule.
- A comparison over aggregates: it can't pair cases.
- A bootstrap interval: it undercovers at these sizes.
- Anytime-valid confidence sequences: 2–7× wider than t at n ≤ 40.
- A weighted sum: it trades a missed must-fix for dollars.

## Tasks at a glance

Built in this order: 2 and 3 (slice 1), 4, 5, 1, 6, 7, 8.

- [x] 1. Match first is the review scorer; the panel retires
- [x] 2. `compare/` and `pairedComparison`, from per-case numbers (slice 1)
- [x] 3. `report` calls the comparison (slice 1)
- [x] 4. Several trials per case
- [x] 5. `run --baseline`: per-case scheduling and the comparison's stop
- [x] 6. `awf-lab check`: headroom, resolution, scorer self-agreement, failures, suspect cases
- [x] 7. Live check on codex: a real challenger against the baseline
- [x] 8. A futility stop, and `check` says how close a tie can be shown

## Open questions

For the human review. The user's answers of 2026-09-30 are recorded.

- **Task 1, done:** the data repository's `awf-lab.json` named the retired `panel`; it names
  `match-first` since the approval (the file is untracked there, so nothing was committed).
- **Task 1, answered, "measure it":** how often a noise label Jev settled alone is wrong. Moved to
  [[jev-noise-audit]].
- **Task 7, still open:** extend the live run to all 33 cases (about $25)? The stored records reach
  16 cases, past the look at 8 where 1.1.0 would have stopped; at 16 the upper end is +0.058, so
  `run --cases 33` would carry on to the last look.
- **Task 7, answered:** keep `variants/one-codex-skill.variant.ts`? Not yet; it stays uncommitted.
- **Task 7, raised by the user and answered yes:** hold out cases the loop never tunes on. Moved to
  [[autoresearch-loop]], with why 33 cases are too few to split.
- **Task 8, answered:** the keep rule for equals. The same quality, faster and cheaper, is better.
  Moved to [[comparison-efficiency]].
- **Task 8, left to me:** the smallest recall gain worth having. See decision 6.
- **The story, answered:** approved, 2026-09-30.

## Decisions

Settled with the user on 2026-09-30.

1. **Generic now: the scorer and the comparison; a second kind of case next.**
   - `compare/` is proved by a synthetic kind of case in its tests.
   - The dataset, restore and variant stay review's until a second real kind:
     [[second-case-kind]].
2. **Review's standard comparison:**
   - weighted recall is the primary;
   - the guards are wrong claims (+0.05) and precision (−0.05);
   - the tie-breakers are cost ($0.05 a case), then time (30 s a case), used only when recall is
     shown within ±0.05;
   - "better" is claimed at 8 and 16 cases and at the end.
3. **Match first's voters are codex for now:** sol in codex and terra in pi, luna to break ties.
   Claude voters wait ([[judge-opus-voter]]).
4. **One review scorer: match first; the panel retires.**
   - Jev settles the findings the key already answers, and voters label the rest.
   - The panel is match first with nothing settled (`--sure 1`).
   - Stored `panel@1` scores still read.
5. **A sure Jev settles `noise` on its own; `wrong` still needs a code read.**
   - Whether a finding is vague is a matter of its text, which Jev reads. A claim is shown false
     only in the code.
   - Noise counts in precision, a guard, so how often Jev is wrong on it is to be measured
     ([[jev-noise-audit]]).
6. **`default`'s `minGain` is 0.05** (left to me).
   - A gain the dataset can't show is not one a comparison can keep. At 33 cases × 2 trials, a gain
     must be about +0.06–0.08 for its interval to clear 0 at all, so stopping for gains under 0.05
     loses no verdict the dataset could give.
   - On a baseline near 0.25, 0.05 is a fifth more recall, which is worth having.
   - As cases grow and the reach narrows, lower it, with a version bump.

## Ideas and where they go

Everything raised while planning that this story didn't build, and where it went. The rest was
built here.

| Idea | Where |
| --- | --- |
| Measure how often a noise label Jev settled alone is wrong | [[jev-noise-audit]] |
| The keep rule for equals: the same quality, faster and cheaper, is better; a non-inferiority margin the dataset resolves | [[comparison-efficiency]] |
| Run the baseline once on the whole dataset; `run --ahead n`; a cost estimate for a new variant; a progress line | [[comparison-efficiency]] |
| A held-out set, chosen before the first proposal and checked rarely; the headline is fresh trials of the kept variant | [[autoresearch-loop]] |
| Proposer input, one hypothesis per try, predicted effect, refusing proposals under the resolution, root-cause rounds, stricter later rounds, GEPA's Pareto front for parents, a model × effort staircase, a thin agent skill | [[autoresearch-loop]] |
| A second kind of case (triage), and scorers that declare their own metrics | [[second-case-kind]] |
| Claude voters for match first | [[judge-opus-voter]] |
| A betting e-process when looks can't be planned; marking verdicts under 10 cases indicative; flagging a trial whose profile differs from the baseline's; a page showing every case in full; rebuild variance | later, no todo yet |

## Task details

Each task was a thin slice, connected end to end and used by a fresh agent before the next. Only
where the build departs from the plan is recorded here. The code and the lab README are the
record of the rest.

### Slice 1 (tasks 2, 3): a verdict in `report --baseline`

Differences from the plan:

- **Tie-breakers have margins**, and decide only when recall is shown within ±`equivalence`.
  - Without a margin, two copies of the baseline called one `worse` on cost.
  - Without the equivalence, a cheaper variant up to 0.25 lower on recall would be `better`.
- **The plan is the dataset** (`planned`), not the reader's `--cases`, or every `report` would be an
  unplanned look. Selections by hand or by result (`--only`, `--where`, `--categories`) get no
  verdict.
- **A comparison is `{ kind, version, compare }`**, so the report names the rule that decided.
  `Verdict.metrics` is typed, so any comparison's metrics render alike.
- **The metrics are named in the lab**, not declared by the scorer, until the second kind of case.

### Task 4: several trials per case

- A case is whole when all k trials are run and scored. The comparison gets whole cases only, so
  `ComparisonInput` is unchanged.
- The package default stays 1 trial, so older records keep reporting.

### Task 5: `run --baseline`

- It starts past the whole cases already stored, and its verdict is `report`'s on the same
  records. The first build could stop on a verdict `report` never gives, so a loop would run
  forever.
- `--jobs` runs one case's steps at once, never two cases.
- A case that can't be made whole exits 1. The budget spans cases.
- `--json` stays the steps run; the verdict is read from `report --json`.

### Task 1: match first

- **Named `match-first`, not `match`:** the data repository has its own `match` scorer with stored
  `match@1`–`4` scores.
- The shared reader is `judge/case.ts`, added to the files the boundary check lets do I/O.
- A voter must still read the code before calling a finding noise. A sure noise that repeats an
  earlier finding is that finding's duplicate.

### Task 6: `awf-lab check`

- Resolution uses the paired t test the comparison runs, not z as experiment 1 did. With z, power
  at 8 cases was 67%, not 80%.
- Failure kinds are read from records, so `CaseScore.outcome` is unchanged.
- `--rescore n` keeps no score.

### Task 7: live check on codex

The two cases that score 0 everywhere were audited first: they are hard cases, not broken keys, and
they stay. The run itself is under Implementation notes.

### Task 8: a futility stop, and how close a tie can be shown

- `minGain` is checked at looks only, so peeking doesn't stop a real gain. `Verdict` is unchanged.
- `check` prints the interval's half-width between equal variants: how close to 0 a tie can be
  shown.
- The review's findings that stood:
  - Some real losers stop `undecided` before they show `worse` (35% at a true −0.10). A variant is
    discarded either way, and the reason shows the interval.
  - With `minGain` equal to `equivalence`, a challenger that is equal stops before cost and time
    decide. That goes to the keep rule in [[comparison-efficiency]].

## Verification

- [x] `pairedComparison` against table values, and simulations: "better" at most 3% under no
  difference; `minGain` stopping a true gain of 0.10 in at most 1% of runs.
- [x] A comparison file from a test workspace replaces the standard one in `run` and `report`.
- [x] `bun test` (889 pass), `bun run check` (Biome, tsc, boundaries).
- [x] Live on codex: a challenger against the baseline over 8, then 16 cases, 2 trials each.

## Review record

- **Slice 1:** three fresh agents (statistics, wiring, docs), then three more rounds, including
  20,000-input property checks. Fixed:
  - progress counted wrongly under missing values;
  - rounding made "better" of identical data;
  - the tie-breakers weren't monotone;
  - the O'Brien–Fleming constant was coarse;
  - failed trials counted as scored;
  - comparisons went unchecked.
- **Task 4:** fixed `show` and `--only` numbering, gaps listed per trial, `--jobs` misnumbering
  trials, and the hidden sandbox reason.
- **Task 5:** fixed the shorter-prefix stop, the not-run count, the budget spanning cases, and
  `--rest-from` being ignored.
- **Task 1:** decision 5's premise was corrected (noise counts in precision), the voter's read of
  noise was restored, and noise followed by a duplicate was fixed.
- **Task 6:** z was replaced by t; a composite README sample, `--md` and the confirmation when
  already decided were fixed.
- **Task 8:** the `Verdict` doc was fixed, and tests added for a lower-is-better primary and for a
  challenger past the bound but short of `minWon`.

## Readiness

- [x] Outcome, evidence, published surface and tasks settled; approved 2026-09-30.

## Implementation notes

### Experiment 1: trial-to-trial variance (2026-09-29)

The codex baseline was run as three identical variants on the first 12 cases: 36 trials, $11.70,
plus $4.47 of scoring, at list price.

- Weighted recall has sd 0.19 between cases and 0.13 between trials of one case. A case has few
  issues, so one found or missed moves it by up to 0.5.
- To see +0.10: 34–55 cases with one trial a case, 21–42 with two, 17–38 with three. A workspace
  comparing variants sets 2 trials: enough to measure trial noise, then spend on cases.
- Precision sits at its ceiling, so it serves as a guard, not a primary.

### Task 7: the live run (2026-09-30)

`run one-codex-skill --baseline one-codex-r1 --scorer match-first --cases 16 --trials 2`: the
baseline plus a public review skill. The prediction was no gain, and perhaps more time.

- 52 trials and 52 scorings, about 4 hours, $27.40 at list price, no failures.
- `undecided` after every case. At 16 cases, weighted recall was −0.0095 [−0.077, +0.058] (won 3,
  tied 6, lost 7). Precision went 0.94 → 0.98 and wrong claims 0.06 → 0.02. Time was +36 s a case,
  [+16, +55].
- As predicted: no gain in recall, and more time. The stop never fired: there was no futility stop,
  and a tie at ±0.05 is out of reach. Task 8 followed. Under `default` 1.1.0, `report --cases 8`
  on these records says "stopped at look 1 of 3, no gain of 0.05 in reach", so a fresh run would
  have stopped there; at 16 cases it is still `undecided`, next look at 33.

### Task 8: the simulation (2026-09-30)

33 cases at experiment 1's variance, 2,000 runs each:

| True gain | Before (1.0.0) | After (1.1.0) |
| --- | --- | --- |
| none, 2 trials a case | 31 cases on average; "better" 2.4%, "worse" 11%, tie 18% | 26 cases; 29% stopped early; "better" 2.1%, "worse" 6%, tie 10% |
| +0.10 | "better" 99% | "better" 99%; 0.1% stopped early |

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] The story is `awaiting-human-review`; the outcome, decisions, reviews and verification are
  above.
- [x] Approved by the user, 2026-09-30.
- [x] Marked `done`, and `Stories at a glance` updated.
