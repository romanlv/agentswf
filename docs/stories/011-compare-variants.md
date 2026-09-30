---
id: "011"
title: Say whether a workflow variant beats the incumbent, and how sure that is
summary: The evaluating project defines its scorer, which turns a trial into named per-case metrics, and its comparison, which turns two variants' per-case metrics into a verdict; awf-lab runs several trials per case, calls both, and stops when the comparison says so. The lab ships a standard paired comparison and match first as the review scorer.
type: story
status: in-progress
discovered_in: "variant-matrix-runner and decision-matching todos, 2026-09-29"
depends_on: ["008", "010"]
---

# Say whether a workflow variant beats the incumbent, and how sure that is

## Outcome

Someone with an idea for a workflow asks "is this better than what we have?" and gets an answer
with its uncertainty, not one run's anecdote. The same answer is what the autoresearch loop acts on
([[autoresearch-loop]]), so it has to work for any workflow evaluated
against cases with known answers, not only reviews.

The project doing the evaluation owns two things, and awf-lab owns the running:

| | Who writes it | What it gets | What it returns | Review's, shipped by the lab |
| --- | --- | --- | --- | --- |
| **scorer** | the project, or reuses one | one trial and its case | named numbers for that trial, each with a direction | today the panel; match first after task 1. A review's numbers are named in `review/metrics/named.ts` |
| **comparison** | the project, or reuses one | both variants' numbers, case by case | better, worse, tie or undecided, whether to stop, and why | `pairedComparison({ … })` |
| **running** | awf-lab | — | trials, scores, the report, the stop | — |

This is how the projects that let you plug a comparison in do it: GEPA's `should_accept` gets both
candidates' per-case scores, and awf-lab's comparison does too, so it can pair cases
([[variant-comparison#7. Who defines the scorer and the comparison|research §7]]).

This story joins two todos: [[variant-matrix-runner]] and
[[decision-matching]], because several trials per case multiply
scoring, and match first scores at a fifth of the panel's time and list price
([[008-review-scorer#Match first|story 008]]).

## How it works

In the data repository, the project picks a scorer and a comparison, or writes its own. The
comparison as built in slice 1 (the package's own, `default`):

```ts
// packages/lab/src/review/lab/default.compare.ts: how two variants' numbers become a verdict
import { pairedComparison } from "../../compare";

export default pairedComparison({
  version: "1.0.0",
  primary: "recall.weighted",
  guards: [                                       // may not get worse by more than the margin
    { metric: "wrong", margin: 0.05 },
    { metric: "precision", margin: 0.05 },
  ],
  looks: [8, 16],                                 // "better" only at these case counts, and the end
  equivalence: 0.05,                              // tie-breakers only if recall is shown within ±0.05
  tiebreak: [                                     // and then only by more than a margin
    { metric: "cost", margin: 0.05 },
    { metric: "time", margin: 30 },
  ],
});
```

A workspace's own is a `*.compare.ts` found by `awf-lab.json`'s `comparisons` globs and picked by
`"comparison"` or `--comparison`. The scorer stays as story 008 made it; match first becomes the
built-in and default in task 1 (decision 4).

```text
awf-lab run {challenger} --baseline {baseline} --cases 8 --trials 2          (task 5)
  per case, in the dataset's seeded order:
    trials still missing, for both variants ─▶ awf run each
    scorer ─▶ per trial { "recall.weighted": 0.5, "wrong": 0, … }   + cost and time, added by awf-lab
    comparison(baseline's trials so far, challenger's, the metrics' specs, the plan's size)
       ─▶ { verdict: "undecided", stop: false, … }      carry on
       ─▶ { verdict: "worse",     stop: true,  … }      stop: spend no more
awf-lab report {challenger} --baseline {baseline}                             (slice 1)
    the same comparison over stored records, and its verdict
```

**The scorer's numbers.** A metric is a name, a direction (higher or lower is better), and what a
failed trial scores. A number is per trial, and `null` where it doesn't apply, such as
must-fix recall on a case with no must-fix issue. Cost and time are added by awf-lab from the
trial's record, so every comparison can use them. The numbers are computed from stored records, not
stored: a new metric needs no rerun.

**The comparison's input** is, per variant, `{ case, trial, outcome, metrics }` for every trial so
far, where `outcome` is `scored`, `variant-failed` (a result: its metrics take their failure value)
or `missing` (never started, or the scorer failed: left out and retried). It sees no finding, key or
label, so one comparison serves every kind of workflow.

**The standard comparison**, `pairedComparison`, is the rule the research supports for 5–40 costly
cases ([[variant-comparison]]):

- average each variant's trials per case, then take the per-case difference;
- a paired t interval on those differences; cases won, tied and lost beside it; below 5 cases,
  counts only;
- stop as soon as the primary metric's interval is wholly below zero: "stopped: looked worse";
- "better" only at a planned look, against an O'Brien–Fleming bound, and only if every guard is
  within its margin; peeking after every case with a plain interval gives 25% false wins;
- at the plan's end, the tie-breakers in order, each one-sided on the primary's equivalence; then
  a tie if the primary is shown within it; never a weighted sum across metrics.

A project that wants something else, such as a point comparison while exploring, or a stricter rule
for later loop rounds, writes its own `.compare.ts` with the same signature.

**Before trusting a comparison: `awf-lab check`.** Anthropic's `build-eval` guide runs diagnostics
before any hill-climbing
([[variant-comparison#8. Anthropic's build-eval and hillclimb|research §8]]).
awf-lab does the same from stored records, spending only on what it has to re-score:

```text
awf-lab check one-agent-bare --cases 12
headroom     weighted recall 0.27 (max 0.75): room to improve
resolution   with 12 cases × 2 trials, differences under ~0.15 are noise; 33 cases resolve ~0.1
scorer       re-scored 6 trials: same labels on 94% of findings (κ 0.9)
failures     0 environment, 0 scorer, 0 variant of 36 trials
suspect      2 cases score 0 on every trial of every variant: F, L; read them before counting
```

- **Headroom**: warns when the baseline is at 95% or more, as the guide does, so no change could
  show.
- **Resolution**: the smallest difference the planned cases and trials can see, from the measured
  between- and within-case variance, paired. The guide's `1/√(n·reps)` treats repeats as
  independent cases; this doesn't.
- **Scorer self-agreement**: the same scorer on a sample of stored trials again. A scorer that
  disagrees with itself sets a floor under every comparison. Match first's is unmeasured.
- **Failures by kind**: environment, scorer and variant apart, and a run whose profile differs from
  the baseline's flagged.
- **Suspect cases**: a case every variant fails on every trial is the guide's tell for an ambiguous
  task or a broken key. Flagged, never dropped silently.

`run --baseline` prints the headroom and resolution lines before it spends, beside the estimate.

**What is reused, and what runs again.** Before spending, `run` prints per case what it will do and
why, with counts and the estimate, as Harbor's `--diff` does
([[eval-orchestration#For awf]]):

| Changed since the stored record | Action |
| --- | --- |
| the variant's `{major}.{minor}`, the case digest, or the sandbox setting | run the trial again, then score it |
| the scorer's `{major}.{minor}` or the key revision | score the stored trial again |
| a metric, or the comparison | recompute: no spend, since neither is stored |
| the trial never started, or the scorer failed | run that step again |
| nothing | reuse |

A trial whose variant failed on its own is a result and is reused, never re-run until it passes.
Most of this exists since story 008 (`plan.ts`); what's new is k trials per case, and the recompute
row, which falls out of not storing metrics.

**Subsets and holdout.** `--cases n` already takes the first n of one seeded order, the same for
every variant, so 8 then 16 extends rather than resamples (`selection.ts`). A variant's `tunedOn`
cases are marked in the report and counted apart; which cases a proposer may read is the loop's.

## Scope

In scope:

- `@agentswf/lab/compare`: the `Comparison` type, `MetricSpec`, `pairedComparison`, pure.
- A scorer declares `metrics`; `reviewMetrics` for review scorers.
- Comparison files, `awf-lab.json`'s `comparison`, `--comparison` on `run` and `report`.
- `--trials k` on every command; `{case}/{trial}` beyond `/1`.
- `run --baseline`: per-case scheduling, and the comparison's `stop`.
- Match first moved into `judge/` as the one review scorer; the panel retires (decision 4).
- `awf-lab check`: headroom, resolution, scorer self-agreement, failures by kind, suspect cases.
- Failure kinds in the comparison's input: `missing` split into environment and scorer.

Out of scope:

- The proposer, the history and the spend cap: [[autoresearch-loop]].
- A second kind of case's dataset, restore and runner (decision 1, [[second-case-kind]]).
- Several challengers at once, and variants in parallel: E4 is unmeasured.
- A stored metrics record: the numbers are derived; storing them freezes a format one kind used.

## Context and evidence

- Fact: every project surveyed has the project write the scorer; only GEPA and OpenEvolve take a
  pluggable keep-or-discard, and only GEPA's gets per-case scores of both (research §7).
- Fact: at 5–40 cases the paired t interval holds its coverage and the bootstrap doesn't; futility
  stops add no false wins; checking every case with a fixed interval gives 25% false wins (research
  §1, §3).
- Fact: match first scores 86–90% against the panel's 87% on the comments, 100% on the oracle, κ
  0.84–0.87 with the panel, at $0.15 and a minute a scoring against $0.81 and five (story 008).
  Its voters are codex and pi; Jev needs `OPENROUTER_API_KEY`.
- Fact: on the baseline, weighted recall varies with sd 0.19 between cases and 0.13 between trials
  of one case; at the first dataset's 33 cases with two trials each, differences of about 0.1 are detectable,
  at 8 cases only about 0.2 (Implementation notes, experiment 1).
- Constraint: `lab` imports contract only and runs workflows through `awf run` (boundary 5).
- Constraint: throwaway live checks run on codex, not claude.

## Code map

- `packages/lab/src/compare/` (slice 1, pure, imports nothing): the types, `pairedComparison`,
  `perCase`, `compareMetric`; `stats.ts` for the t distribution and O'Brien–Fleming bounds.
- `packages/lab/src/review/metrics/named.ts` (slice 1): `REVIEW_METRICS` and `namedMetrics`, per
  trial from `count()` and `metrics()`. Metrics declared by the scorer wait for
  [[second-case-kind]].
- `packages/lab/src/review/lab/cli.ts`: the refusals of more than one trial ("story 011, task 4")
  go.
- `packages/lab/src/review/lab/plan.ts:66`: `currentTrial` becomes the newest k in the setting.
- `packages/lab/src/review/lab/execute.ts`: per-case scheduling under `--baseline`, and `stop`.
- `packages/lab/src/review/lab/report.ts` (slice 1): calls the comparison per challenger over the
  cases the pair shares, checks its verdict; `compareCases` stays, by weighted recall, for the
  JSON's won/lost lists and `--where lost`. `format/output.ts` carries the verdict.
- `packages/lab/src/review/format/workspace.ts` and `lab/workspace.ts` (slice 1): `comparison`
  and `comparisons` globs, and the built-in `default`.
- `packages/lab/src/review/judge/`: `matching.ts` and its test, `voting.ts`, `match.workflow.ts`
  from the data repository's `scorers/`, and a built-in `match` scorer; `Case`/`readCase` and the
  answer schema shared with `judge.workflow.ts`. What moving them involves:
  - They are in the data repository's `scorers/`, not `judges/` as story 008 and the todo say, and
    are uncommitted there. The four files name nothing private; `lib.ts` and `scripts/` do
    (fixture ids, the project's name) and stay.
  - `Case`/`readCase` and the answer schema are duplicated between `lib.ts` and
    `judge.workflow.ts`; the claimed-issues helper is inline in three places (`judge.workflow.ts`,
    `voting.ts`, `check.ts`). One copy each, in `panel.ts`.
  - `voting.ts` runs voters with `Promise.all`, losing the panel's `workflow.parallel` label; it
    takes 0–2 voters where the panel takes exactly 2.
  - Settings as measured: Jev settles a match at p ≥ 0.9 (`--sure`; at 0.85 accuracy falls to
    92%); a voter's turn is bounded at 6 minutes and a timed-out turn is asked again once in a
    fresh session (`--turn`; the slowest seen took 3.6).
  - A sure `noise` is settled, not left (decision 5): `matching.ts`'s `settleMatches`, and
    `packages/lab/src/review/judge/check.ts:80`, which today requires lines read for `noise`.
  - `scripts/match.ts`, which re-settles stored Jev answers at other cuts, belongs with `check` or
    the report, not in the scorer.
  - The panel's `judge.workflow.ts` voting is replaced by `voting.ts` (decision 4); `panel.scorer.ts`
    leaves the built-ins, and `panel@1.0` records stay readable.
- `scripts/check-boundaries.ts` (slice 1): `compare/` imports nothing; `review/metrics` and
  `review/lab` may import it, `review/format` may not.

## Proposed design

As built in slice 1; the first draft's differences are listed under "Slice 1, as built".

```ts
type MetricSpec = { name: string; direction: "higher" | "lower"; onVariantFailure: number | "missing" };

type CaseScore = {
  case: string;
  trial: number;
  outcome: "scored" | "variant-failed" | "missing";  // unknown ones are to be read as missing
  metrics: Readonly<Record<string, number | null>>;
};

type ComparedMetric = {
  name: string;
  role: "primary" | "guard" | "tiebreak" | "reported";
  cases: number;                 // both have a value; each case's value the mean of its trials
  baseline: number | null; challenger: number | null; difference: number | null;
  interval?: [number, number];   // paired t, two-sided; absent below 5 cases
  won: number; tied: number; lost: number;
};

type Verdict = {
  verdict: "better" | "worse" | "tie" | "undecided";
  stop: boolean;                 // undecided with stop: the plan ran out without an answer
  reason: string;
  metrics: ComparedMetric[];
};

type ComparisonInput = {
  baseline: readonly CaseScore[]; challenger: readonly CaseScore[];
  metrics: readonly MetricSpec[];
  planned: number;               // the dataset's size: looks count towards it
};

type Comparison = { kind: "awf.comparison/1"; version: string; compare(input: ComparisonInput): Verdict };
```

`CaseScore.outcome` may gain `environment-failed` and `scorer-failed` if `check` needs them apart
(task 6); a comparison reads any outcome it doesn't know as `missing`, so that isn't breaking.

**What this publishes, and is costly to change later** (AGENTS.md: settle before building). What
slice 1 publishes, approved by the user on 2026-09-30:

- `@agentswf/lab/compare`: the types above, `defineComparison`, `pairedComparison` and its
  `PairedOptions` (`primary`, `guards` and `tiebreak` as `{ metric, margin }`, `equivalence`,
  `looks`, `confidence`, `minWon`, `version`, which is required), `perCase`,
  `compareMetric`, and `COMPARISON_KIND` (`awf.comparison/1`). A project's comparison files import
  them.
- A comparison file: a default export of a `Comparison`, found by `awf-lab.json`'s `comparisons`
  globs, named by file, versioned in semver. `default` is the package's and reserved.
- A review's metric names, which comparison files name: `recall.weighted`, `recall.must-fix`,
  `recall.should-fix`, `recall.could-fix`, `precision`, `wrong`, `noise`, and `cost` (USD, `null`
  when unpriced) and `time` (seconds) from awf-lab.
- `awf-lab.json`: `comparison`, `comparisons`. `awf.lab-report/4`: per challenger its verdict, the
  comparison's name and version, or why no verdict was given. `awf.lab-list/3`: the comparisons.
- Changed meaning: `--where lost` and the report JSON's won/lost/tied count by weighted recall
  alone, no longer then precision.
- Not yet: `defineReviewScorer({ metrics })` ([[second-case-kind]]); `trials` in the config (task
  4). Not published: stored records keep their formats; verdicts and metrics are computed from
  them, never stored.

Alternatives rejected:

- **Metrics declared by a case kind, not the scorer**: two scorers of one kind may measure
  different things (κ exists only with two voters); every framework surveyed hangs metric
  names on the scorer (research §5, §7).
- **One comparison built into awf-lab**, configured by an objective: the project couldn't change
  the rule, and the loop's later rounds want a stricter one.
- **A comparison over aggregates** (OpenEvolve's `replace_cell`): can't pair cases.
- **A bootstrap interval** as the todo said: undercovers at our sizes (research §1).
- **Anytime-valid confidence sequences** as the standard rule: 2–7× wider than t at n ≤ 40.
- **A weighted sum** (OpenEvolve's `combined_score`): trades a missed must-fix for dollars.

## Tasks at a glance

Built in this order: 2 and 3 (slice 1), 4, 5, 1, 6, 7.

- [ ] 1. Match first is the review scorer; the panel retires
- [x] 2. `compare/` and `pairedComparison`, from per-case numbers (slice 1). Reporting between-
  and within-case variance moved to task 6, which needs task 4's trials
- [x] 3. `report` calls the comparison (slice 1). A scorer declaring its own metrics moved to
  [[second-case-kind]]; until then a review's are `review/metrics/named.ts`
- [ ] 4. Several trials per case
- [ ] 5. `run --baseline`: per-case scheduling and the comparison's stop
- [ ] 6. `awf-lab check`: headroom, resolution, scorer self-agreement, failures, suspect cases
- [ ] 7. Live check on codex: a real challenger against the baseline

## Decisions

Settled with the user on 2026-09-30.

1. **Generic now: the scorer and the comparison; a second kind of case next.** `compare/` is
   proved by a synthetic kind in its tests. The dataset, restore and variant stay review's until a
   second real kind, triage tickets with known routes, which is the next story
   ([[second-case-kind]]).
2. **Review's standard comparison:** primary weighted recall; guards wrong claims at +0.05 and
   precision at −0.05; tie-breakers cost, then time. Slice 1 added, for the user to confirm: a
   tie-breaker decides only by more than a margin ($0.05, 30 s a case), and only when weighted
   recall is shown within ±0.05; "better" is claimed at 8 and 16 cases and at the dataset's end.
   The user confirmed these on 2026-09-30.
3. **Match first's voters are codex for now:** sol in codex and terra in pi, luna to break ties.
   Claude voters ([[judge-opus-voter]]) wait, as experiments run on codex.
4. **One review scorer: match first. The panel retires.** The panel is story 008's scorer: two
   voters each read the change, the key and the code for every finding. Match first is the better
   design, not a second one: Jev settles the findings the key already answers, and the same kind of
   voters label only the rest. Measured as accurate, at a fifth of the time and list price. So:
   - the panel's voting becomes match first's `voting.ts`: the panel is match first with nothing
     settled, and one code path votes, with the per-turn bound and the fresh-session retry;
   - `match` is the built-in scorer and the workspace default; `panel.scorer.ts` is no longer
     built in, and its stored scores stay readable as a stored version (`panel@1.0`), so earlier
     reports can still be shown;
   - a project that wants every finding voted on runs match first with `--sure 1`, which settles
     nothing.
5. **A sure Jev settles `noise` on its own; `wrong` still needs a code read.** Match first asks
   Jev, per finding, which known issue in the key it is. When Jev answers `noise` (a nit, a style
   remark, or praise) at p ≥ 0.9, that is the label, with no voter turn. When it answers a refuted
   claim, the finding still goes to the voters, who must cite code they read: `wrong` is a guard,
   so a variant is penalised for it only on evidence. `noise` is reported but decides nothing.
   So `settleMatches` settles a sure `noise`, and the judge's label check (`check.ts`) stops
   requiring lines read for `noise`; `wrong` and `new` still need them.

## Ideas and where they go

Everything raised while planning this story, so none is lost. [011] is this story, with its task;
[loop] is [[autoresearch-loop]]; [later] needs a todo when it is wanted.

| Idea | Source | Where |
| --- | --- | --- |
| The project defines its scorer and its comparison; awf-lab ships standard ones | the user, research §7 | [011] 2, 3 |
| Paired t interval on per-case means; counts only below 5 cases (built); marked indicative below 10 (not yet) | research §1 | [011] 2, 6 |
| Trials averaged per case before pairing; never pooled across cases | research §1, Miller | [011] 2 |
| Between- and within-case variance reported, to choose cases vs trials | research §2, experiment 1 | [011] 2, 6 |
| Default `--trials 2`; more cases before more trials | research §2, experiment 1 | [011] 4 |
| Stop for "looked worse" at any case; "better" only at planned looks (O'Brien–Fleming) | research §3 | [011] 2, 5 |
| Guards within a margin, then the primary, then tie-breakers; no weighted sum | research §4 | [011] 2 |
| A sign-test floor: "better" needs at least 6 differing cases | research For awf (b) | [011] 2 |
| Betting e-process as the fallback when looks can't be planned | research §3 | [later] |
| Rerun / rescore / recompute, printed with counts and cost before spending | eval-orchestration, Harbor | [011] 4 |
| Environment, scorer and variant failures counted apart | research §5, Inspect, SWE-bench | [011] 6 |
| Headroom warning at 95% | Anthropic `build-eval` | [011] 6 |
| Resolution: the smallest difference the plan can see, before spending | Anthropic, done paired | [011] 6 |
| Scorer self-agreement: re-score a sample with the same scorer | Anthropic `build-eval` | [011] 6 |
| Suspect cases: 0 on every trial of every variant, flagged for audit | Anthropic, experiment 1 | [011] 6 |
| Audit the always-zero cases of the first dataset (F, L, and nearly B) | experiment 1 | data repository, before task 7 |
| Match first as the one review scorer, codex and pi voters; the panel retires | story 008, decision-matching, decision 4 | [011] 1 |
| Jev's known failure: it matches a new problem to the nearest known issue (p 0.97 seen); right symptom, false cause passes | decision-matching | [011] 1, a note in the scorer's docs |
| `tunedOn` cases marked in the report | variant-matrix-runner | [011] 3 |
| Time measured under `--jobs` is not comparable with time measured alone | variant-matrix-runner | [011] 3, a report note |
| A second kind of case (triage) to make the dataset side generic | decision 1 | [[second-case-kind]], the next story |
| Proposer input: per-case metrics, outcome, feedback text, trace pointer, parent comparison, history, metric specs, spend left | research For awf (e), GEPA, AFlow | [loop] |
| One hypothesis per try as a patch; a scope file of what may change | Anthropic `hillclimb` | [loop] |
| The proposer predicts the effect and names the mechanism; never copies case content | Anthropic `hillclimb` | [loop] |
| Refuse a proposal smaller than the resolution | Anthropic, `check` | [loop] |
| After 2–3 stalled rounds, one round sorts failures by root cause | Anthropic `hillclimb` | [loop] |
| Holdout checked rarely; the headline is fresh trials of the kept variant | Dwork, research §4 | [loop] |
| Acceptance tightens in later rounds; a stricter comparison file per round | autoresearch-practices | [loop] |
| GEPA's per-case Pareto front for choosing parents, never for acceptance | research §4 | [loop] |
| Model × effort staircase per stage | Anthropic `cost-hillclimb` | [loop], later |
| A page showing every case in full, for a person to read before trusting a dataset | Anthropic `build-eval` | [later] |
| A thin agent skill driving `check`, `run` and `report` | this planning | [loop] |
| Rebuild variance, for a variant whose artifacts later trials read | Anthropic | [later] |

## Task details

Built as thin slices, each connected end to end and used by a fresh agent before the next
(the user, 2026-09-30: "build something small end to end, review it, improve, see how it can be
generalized"). Each task below is one such slice.

### Slice 1: a verdict in `report --baseline`, from a comparison the project can replace

Tasks 2 and 3. Done: `bun test` shows `pairedComparison` against table values, a
simulated null, and a synthetic kind of case with no review in it; `review-lab.test.ts` shows
`report --baseline` carrying the built-in verdict, and a workspace's own `*.compare.ts` replacing
it by path; `report` on experiment 1's stored trials calls all three copies of the baseline a tie.

### Task 4: several trials per case

`--trials k` on `run`, `score`, `report` and `show`, and `trials` in `awf-lab.json`. The package's
default stays 1, so records made before keep reporting; a workspace comparing variants sets 2
(experiment 1: a second trial measures the within-case variance, a third buys about 10% more).

- The refusals of more than one trial in `cli.ts` go; `{case}/{trial}` addresses take any trial.
- `currentTrials` in `plan.ts` gives the started trials in the workspace's setting oldest first, so
  trial n keeps its number as more are added; `--trials k` reads the first k, and `run` plans the
  missing ones (trial n with every earlier one missing), and its printed plan counts them.
- `report.ts`'s `caseScores` gives one `CaseScore` per trial, not `trial: 1`.
- **A case is whole when all k of its trials have finished.** Otherwise a look is taken twice at one
  case count as trials arrive (round 4). The lab hands the comparison only whole cases, so
  `ComparisonInput` stays as approved; a case with fewer is reported as incomplete. This keeps
  the published surface unchanged; the other way, `trialsPlanned` in the input, is a change to
  approve.
- `--jobs` still runs every trial, then every score.

Done when `bun test` shows: `run --trials 2` plans the second trial for each case and reuses the
first; `report --trials 2` averages per case, and leaves a case with one trial out of the verdict;
`show {case}/2` shows the second trial. In the data repository, `report one-codex-r2 --baseline
one-codex-r1 --trials 2` counts no case (each has one trial) and says so.

### Task 5: `run --baseline`: per-case scheduling and the comparison's stop

`awf-lab run {challenger} --baseline {baseline} [--cases n] [--trials k]` runs case by case in the
seeded order: for each case, both variants' missing trials, then their scores; after each whole
case, the comparison over the seeded prefix both have, as `report` does.

- `stop: true` ends the run: steps in flight finish, no new one starts, and the run prints the
  verdict, its reason, and what it didn't spend. `--cases n` caps the run; `planned` is still the
  dataset's size, so the looks don't move.
- The baseline's stored trials are reused as always; a baseline already run on the first 12 cases
  costs only the challenger's trials there.
- Under `--jobs`, cases run concurrently but a verdict counts only the seeded prefix, so a stop
  can come after later cases began; they finish and are stored.
- **Costly to change later, to settle before building:** the run's JSON gains the verdict as the
  report carries it, which bumps its format. The alternative, `run` printing only and the loop
  calling `report`, costs a second read of the records but publishes nothing.

Done when `bun test` shows, with a fake variant and a scripted comparison: the run stops at the
first `stop: true` without starting the next case; a comparison file from the workspace replaces
the standard one; the baseline's stored trials are reused. And a fresh agent, given only the
README, runs a challenger against a baseline in a test workspace without help.

### Task 1: match first is the review scorer; the panel retires

What moves, and its snags, are in the code map (`judge/`); decisions 3–5 say what it does.

- `matching.ts`, `voting.ts`, `match.workflow.ts` and the matching test move from the data
  repository's `scorers/` into `review/judge/`; one copy each of `Case`/`readCase`, the answer
  schema and the claimed-issues helper, in `panel.ts`.
- The panel's voting becomes `voting.ts`, keeping the per-turn bound (6 minutes), the fresh-session
  retry and the `workflow.parallel` label.
- `match` is built in and the workspace default; `panel.scorer.ts` leaves the built-ins; stored
  `panel@1.0` scores stay readable in `report` and `show`.
- A sure `noise` (p ≥ 0.9) is settled by Jev; `check.ts` stops requiring lines read for `noise`.
- `scripts/match.ts` stays in the data repository until `check` wants it.

Done when `bun test` covers settling (a sure noise settled, a sure refuted claim sent to the
voters) and a stored `panel@1.0` score reads in `report`; and, live on codex, the built-in `match`
re-scores experiment 1's 32 trials with the same label on at least 90% of findings as the data
repository's `match-sol-pi` 3.0 (about $4.50 at list price).

### Task 6: `awf-lab check`

`awf-lab check {variant} [--cases n] [--trials k] [--rescore n]`, from stored records, as sketched
under "How it works":

- **Headroom**: the primary's mean against its maximum; a warning at 95% or more.
- **Resolution**: between- and within-case variance of the primary, and the smallest difference
  the planned cases and trials resolve, paired, at 80% power. Also printed by `run --baseline`
  before it spends, and replacing experiment 1's `variance.ts`.
- **Scorer self-agreement**: the same scorer on `--rescore n` stored trials again (default 0, so
  `check` spends nothing unless asked, and prints its estimate first); agreement on labels and κ.
- **Failures by kind**: environment, scorer and variant apart. `CaseScore.outcome` gains
  `environment-failed` and `scorer-failed`; a comparison reads unknown outcomes as `missing`, so
  that is additive. A trial whose profile differs from the baseline's is flagged.
- **Suspect cases**: 0 on every trial of every variant stored; flagged, never dropped.

Done when `bun test` shows each line on a test workspace with known variance, and `check
one-codex-r1 --trials 3` in the data repository gives experiment 1's sd 0.19 and 0.13 and flags
F and L.

### Task 7: live check on codex

In the data repository, on codex:

1. Audit the always-zero cases (F, L, nearly B) first: a broken key or an ambiguous task is fixed
   or dropped from the dataset, with a note there.
2. `check one-codex-r1` before spending: headroom and resolution.
3. A real challenger: one change to the baseline's workflow, with its expected effect written
   down, run with `run {challenger} --baseline one-codex-r1 --cases 8 --trials 2`, then `--cases
   16`, then the whole dataset if still undecided.
4. The verdict, stop and spend recorded under Implementation notes.

Cost: about $0.33 and $0.15 to run and score a trial, so about $15 for 16 cases × 2 trials of the
challenger, and up to $30 at 33 cases, at list price; the baseline's second trials add as much
again where missing. Done when the run stops where the comparison says, and a fresh agent reading
only the README and the run's output can say what was decided and why.

## Verification

Automated:

- [x] `pairedComparison` against table values, and a simulated null in which the stop rule and the
  looks keep "better" near its nominal 2.5% (at most 3%).
- [ ] A comparison file from a test workspace replaces the standard one in `run` and `report`.
- [ ] `bun test`, `bunx tsc --noEmit`, `bun run scripts/check-boundaries.ts`

Live, on codex:

- [ ] A challenger against the baseline over the first 8 cases, 2 trials each, then 16.

## Implementation notes

### Experiment 1: trial-to-trial variance (2026-09-29)

The baseline, single-agent-review on `codex/gpt-6-sol`, run as three identical variants
(`one-codex-r1..r3`) on the first 12 cases of the first dataset, in the workspace's srt sandbox, scored by
match first (`match-sol-pi` 3.0). 36 trials, $11.70 at list price, about $0.33 and 2 minutes each;
32 scorings, $4.47 (four trials found nothing, so had nothing to score). No trial or scoring
failed. A first attempt ran before story 010 merged and doesn't count under it.

Weighted recall per case, trial 1 / 2 / 3:

```text
case A  0.60 0.40 0.40    case E  0.00 0.50 0.00    case I  0.25 0.25 0.13
case B  0.00 0.17 0.00    case F  0.00 0.00 0.00    case J  0.38 0.75 0.75
case C  0.17 0.17 0.17    case G  0.31 0.31 0.31    case K  0.50 0.50 0.50
case D  0.38 0.56 0.38    case H  0.17 0.08 0.42    case L  0.00 0.00 0.00
```

- **Between cases** sd 0.19, **within a case** sd 0.13: trial noise is about a third of one
  trial's variance. A case's issues are few, so one issue found or missed moves it by up to 0.5
  (case E).
- **What a comparison can see.** Taking the variance of the true per-case difference between
  0.01 and the between-case variance itself, detecting +0.10 weighted recall at 80% power needs
  34–55 cases with one trial, 21–42 with two, 17–38 with three. The first dataset has 33. So at the full set
  with two trials, differences of about 0.08–0.11 are detectable; at 8 cases, only 0.16–0.23. The
  first look can catch a large regression, not a modest gain.
- **Trials.** A third trial cuts the cases needed by about 10% over a second. Default
  `--trials 2`: enough to estimate the within-case variance, then spend on cases, as the research
  says.
- **Precision is at its ceiling**: 1.0 on 26 of 30 scored trials, no between-case variance. As a
  guard it costs nothing and would catch a variant that starts making wrong claims; as a primary
  it has no headroom.
- **Cases that score 0 on every trial** (F, L, nearly B): 3 of 12. The blog's tell for an ambiguous
  task or an unreachable key; worth an audit before they dilute every comparison.
- Mean weighted recall 0.27: plenty of headroom.

What it left in the data repository, uncommitted (that repository also holds another session's
staged work): `variants/one-codex-r1..r3.variant.ts` and their results, and 11 trials of a
stopped first attempt on claude under `results/{dataset}/one-agent-bare*`, never scored. The analysis
script is `variance.ts` in the planning session's scratchpad; task 6's `check` replaces it.

### Slice 1, as built (2026-09-30)

What exists, in the worktree `awf-compare-variants`:

- `packages/lab/src/compare/` (`@agentswf/lab/compare`): `MetricSpec`, `CaseScore`,
  `ComparedMetric`, `ComparisonInput` (`baseline`, `challenger`, `metrics`, `planned`), `Verdict`,
  `Comparison`, `defineComparison`, `pairedComparison`, `perCase`,
  `compareMetric`; `stats.ts` has the t distribution and O'Brien–Fleming bounds by numerical
  integration, no dependency. Pure, imports nothing; the boundary checker holds it, and review
  folders may import it.
- `review/metrics/named.ts`: `REVIEW_METRICS` and `namedMetrics`, a review's numbers by name.
- `review/lab/default.compare.ts`: the built-in `default` (decision 2).
- `awf-lab.json` `comparisons` and `comparison`; `--comparison {name|path}` on `report`;
  `list comparisons`. `awf.lab-report/4` (the verdict and the rule per challenger),
  `awf.lab-list/3` (comparisons).
- The lab README's "Deciding: better, worse or a tie"; `packages/lab/AGENTS.md`.

Where it departs from the proposed design, and why:

- **Tie-breakers have margins**, `{ metric, margin }` like guards, and decide only when the
  primary is shown within ±`equivalence`. Without a margin, `report` on two copies of the baseline
  called one `worse` on cost (+$0.05 [+0.00, +0.09]); without the equivalence, a cheaper variant
  whose recall might be 0.25 lower would have been `better`. Review's: $0.05 and 30 s a case,
  recall within ±0.05.
- **The plan is the dataset**, `planned` in the input (the first draft's `cases`): looks count
  cases both variants have finished, towards the dataset's size. Taking the reader's `--cases` as
  the plan let every `report` call be an unplanned look. A verdict is given only over the first n
  of the seeded order; `--only`, `--cases` by id, `--where` and `--categories` get none, and say
  why.
- **A comparison is an object**, `{ kind, version, compare }`, made by `defineComparison` or
  `pairedComparison`, with `version` required, not a bare function: the report names the rule and
  version that decided.
- **`Verdict.metrics` is typed** (`ComparedMetric[]`: means, difference, interval, won, tied,
  lost, role), not a free `table`: `report` renders any comparison's the same way, and the loop
  reads it. A comparison of one's own may return `[]`.
- **`MetricSpec` has no `range`** yet: nothing reads it. `check`'s headroom will.
- **The metrics are review's, named in the lab, not declared by the scorer.** Every review scorer
  returns labels, and the numbers come from labels, so for reviews they belong to the case kind.
  Where a scorer declares metrics is decided with the second kind ([[second-case-kind]]): a code
  scorer for triage returns numbers directly.
- **`default` looks at 8 and 16 cases**, and at the dataset's end.
- **"Cases won" counts by weighted recall alone**, for the JSON's lists and `--where lost`; with a
  verdict, the text shows the verdict's counts instead. It was weighted recall, then precision.

Evidence:

- `default` simulated on 33 cases with trial noise as measured (sd 0.19 between cases, 0.13
  within), checking after every case, 2,000 runs each: no true difference, `better` 2.5%, `worse`
  11%, the rest `undecided` or `tie`; +0.10 on every case, `better` 85% with one trial a case and
  99% with two; +0.10 varying by case (sd 0.10), 92% with two; +0.15, 99% with one. The README
  has the table. The quick stop for worse is the price of never waiting on a loser.
- `report` on experiment 1 (the first 12 of 33 cases, `match-sol-pi`), identical variants: r2 vs
  r1 +0.08 [−0.05, +0.20], r3 vs r1 +0.03 [−0.07, +0.12], both `undecided` at 12 of 33, next look
  at 16. An 8-point gain between copies is noise at 12 cases, as experiment 1 predicted. (Before
  the review below, the report took 12 as the plan and called them ties.)

A fresh agent (Sonnet, no context) used it from the README alone on experiment 1's data: the
built-in verdict, a `pairedComparison` of its own on must-fix recall, a `defineComparison` rule of
its own on cost, and a misspelt metric, whose error it could act on without reading code. What it
tripped on, and what changed:

- `defineComparison`'s input was undocumented, and `cases` read as a list of ids: it is a count.
  Renamed (now `planned`, see below); the README's example is a working rule, run as written.
- "Cases won" and `--json`'s won/lost lists count by weighted recall whatever the comparison, so
  they contradicted a comparison with another primary. With a verdict, the text shows only the
  verdict's counts; the JSON lists stay review's, as `--where lost` reads them, and say so.
- Found in review: a report `--where` gives no verdict (cases picked by their results bias it), and
  each challenger's verdict uses its own selection's size.
- Must-fix recall as a primary exists on only the cases with a must-fix issue (4 of 12 here), so it
  rarely reaches an interval; the README says so beside that example.

Reviewed by three fresh agents (statistics, wiring, docs and design), 2026-09-30. Found and fixed:

- A primary null on some cases, a missing score, or a third variant in the report left a verdict
  undecided forever: progress now counts cases both variants finished, per pair.
- At the last look, a gain past the plain interval but short of the sequential bound read "no
  difference shown", or went to the tie-breakers: now `undecided`, stop, saying so.
- Floating-point rounding (trials summed in another order) made "better" of identical data; NaN
  made a clear loss a tie. Differences under 1e-9 are ties; a non-finite value is an error.
- One unproven guard silently disabled every tie-breaker, even one showing the challenger worse:
  a tie-breaker may now always say worse, and the reason names what it skipped.
- The O'Brien–Fleming constant snapped to its 0.02 grid (K = 6: 2.06 against 2.0528): the grid now
  hangs from the bound, matching a multivariate normal to 1e-4.
- A failed trial counted as scored, so its cost and time decided tie-breaks; a cost with an
  unpriced agent counted as complete. Now `variant-failed`, and such a cost is `null`.
- A comparison's version and verdict were never checked, so a bad one printed a report that broke
  its own schema, or crashed the text: both are checked, and errors name the comparison.
- `compareMetric` leaked its internal `gain` into the report's JSON.
- The boundary rule let `compare/` import `typebox`, and `review/format` import `compare/`: both
  refused now, with probes.
- An unknown `--comparison` exited 1, not 2 as an unknown variant does.

Round 2, a fresh agent again, confirmed each fix and found: at the plan's end a primary slightly
better but within the equivalence skipped the tie-breakers, so better-and-cheaper lost to
same-and-cheaper; tie-breakers weren't strictly in order; `tie` didn't mean equivalent; `list`
failed silently on an unknown config comparison; a verdict's check passed an inverted interval and
said "schema is false"; the rates table assumed two trials and one gain everywhere. All fixed: the
last look tries the tie-breakers first, the first past its margin decides, `tie` needs the
equivalence when one is set, and the table has one-trial and varying-gain rows.

Round 3 found the band's edges: a primary rising past +equivalence turned a cheaper challenger's
`better` into `undecided`, and one falling past −equivalence turned a dearer one's `worse` into
`undecided`; a tie-breaker that showed nothing either way was passed over, so a later one could
decide; `looks: [0]` collapsed the bound to 0.5 and gave a false `better`; a primary within the
band but a little better ended `undecided`. Now each tie-breaker is one-sided on the primary
(better needs it no worse than −equivalence, worse no better than +equivalence, and a test shows
the verdict holds as the primary moves through both edges), the next is tried only when this one
is shown equal within its margin, `looks`, `minWon` and `planned` are checked, and a primary
within the band is a `tie`.

Round 4 ran randomised property checks (20,000 inputs each: monotonicity, reasons against
verdicts, edges, false `better` under the null). It found the tie-breaker chain still not monotone
in the tie-breakers themselves (a challenger $0.04 cheaper lost the `better` its minute saved),
and the floor on cases that differ not monotone on coarse scores (worse on every case turned
`undecided` into `better`). Now a later tie-breaker may say better only while every earlier one
is shown no worse than its margin, and worse only while none is shown better; the floor counts
cases won (`minWon`). Also: an unknown outcome counts as unfinished, as the type says; confidence
is capped at 0.999; values too large to compare are an error; and `report` passes only the longest
start of the seeded order both variants have, so cases run by hand out of order never count
towards a look. Its scripts, rerun on the fix: no monotonicity violation in 20,000 inputs.

For task 4, settled by round 4's reading: with several trials a case, a case must count as
finished only when all its planned trials are, or a look is taken twice at one count as trials
arrive. `ComparisonInput` will need the trials planned a case, or the runner must hand over only
whole cases; decide it there, before `run --baseline` publishes the loop's input.

Left as they are: false "worse" is 11% between equals at 33 cases, by design; with many looks
(eleven) false "better" is 2.8%, the t approximation per look, measured and stated; cost and time
print as bare numbers in the report's notes, their units in the README.

How it generalises, and where it sits in the vision:

- **Another kind of case needs two things**: its metrics by name (`MetricSpec[]` and a function from
  one trial to numbers, as `named.ts` is for reviews) and nothing else. `compare/` never sees a
  finding, a key or a label; its tests use a made-up kind with `score`, `errors` and `cost`. What
  is still review's is how a trial is stored and turned into numbers (`report.ts` reads `Counts`),
  which [[second-case-kind]] makes generic.
- **The loop reads `Verdict`**: `verdict` to keep or discard, `stop` to stop spending, `reason`
  for its log, `metrics` for the proposer's next idea ([[autoresearch-loop]]). A stricter rule for
  later rounds is a second `*.compare.ts`, not a flag.
- **The project owns the rule** (the user's model): a comparison is a file in the data repository,
  versioned like a variant, and `report` names which rule and version decided.

Left for later slices: several trials per case (task 4), `run --baseline` and its stop (task 5),
`check` (task 6), the live check (task 7), match first as the one scorer (task 1), and a
`comparison` version in the report's records only once a verdict is stored anywhere (it isn't).

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design: research §1–8, experiment 1.
- [x] Expensive interface, record-format, and stage-gate decisions are settled: "What this
  publishes", approved 2026-09-30.
- [x] Tasks are ordered, coherent, and independently verifiable: task details, 2026-09-30.
- [x] Open questions are resolved or explicitly moved out of scope: decisions 1–5.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
