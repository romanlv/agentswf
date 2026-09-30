# @agentswf/lab

`awf-lab` measures how good a workflow is. It runs the workflow against **cases with known
answers**, has a **scorer** label what the workflow returned, and reports numbers you can compare
across versions and across different workflows.

Code review is the first kind of case. Each case is a real merge request frozen at the moment
review started. Its **key** lists the problems that turned out to be real, drafted from the review
comments and the fixes pushed after them. A review workflow is scored on how many of those it finds
and how much of what it says is wrong or noise.

```text
one-agent-bare vs catalogue-review    dataset first, 5 cases, key r1, scorer panel 1.0
                     one-agent-bare    catalogue-review
must-fix             2/5               3/5
should-fix           0/9               5/9
weighted recall      0.19              0.49
precision            1.00              0.93
wrong                0/7 (0%)          0/27 (0%)
trial                36m  $5.79        1h 18m  $13.38
scorer               10m  $2.15        24m  $4.51
voters' κ            0.75              0.76
cases won            1                 4
costs are list-price estimates, also for runs on a subscription
```

That report is from a real comparison of two review workflows on five cases. Both runs and scores
cost money; `report` only reads what was stored and costs nothing.

## How it works

```text
awf-lab run {variant}
  case: frozen code + request.md                               key.json
     │                                                             │
  1. restore the frozen code into a temp checkout                  │
  2. awf run --sandbox {spec} {variant} ─▶ findings.json           │    ← a trial
  3. awf run {scorer} in a fresh checkout ◀── findings + key ──────┘
  4. awf-lab checks the labels ─▶ score.….json                          ← a score
awf-lab report: metrics from the stored trials and scores; spends nothing
```

- **Every run is an ordinary `awf run`.** A variant is just a workflow, and so is a scorer. The
  lab starts both through `awf run` and reads the record it prints. It never links the engine.
- **A trial can't see the answer.** Every agent a variant opens runs in one sandbox the lab gives
  the run (`awf run --sandbox`). It works in the checkout, reads the request, writes nothing, and
  reaches only its model's API: not `~`, where the dataset and its keys live, not other trials,
  not GitLab. A variant says nothing about sandboxes, and one that opens its own is refused. A
  scorer reads the key by design and runs without one.
- **Records are written once and never overwritten.** Running again only does what's missing: a
  trial for a case this version hasn't tried, and a score where no passing score exists for the
  current key. A second `run` of the same thing costs nothing.
- **A failed score is retried, never counted as zero.** Code checks every score, whoever wrote it:
  each finding is labelled once, every issue id exists, and no issue is hit twice.

## The words

The generic words apply to any kind of dataset. The words in the review section belong to reviews.
Each term is followed by what other eval tools call it.

| Term | Means | Elsewhere |
| --- | --- | --- |
| **workspace** | the directory with `awf-lab.json`: datasets, variants, scorers, results | project (Braintrust, LangSmith) |
| **dataset** | a sealed collection of cases; a case that changes after sealing is refused | dataset |
| **case** | one input with its key | sample (Inspect), example (LangSmith), test case (promptfoo), task (Harbor) |
| **key** | a case's known answers, with a revision number that grows as it is redrafted | target (Inspect), expected (Braintrust), reference outputs (LangSmith) |
| **variant** | what is evaluated: a workflow, plus how to give it a case and read its result | solver (Inspect), task (Braintrust), agent (Harbor) |
| **baseline** | the variant a report compares against | baseline |
| **control** | a variant with a known score, run to check the scorer: `oracle` (1.00), `nop` (0.00), `comments` | Harbor's `oracle` and `nop` agents |
| **trial** | one attempt by a variant at one case: a run and its output | trial (Harbor), a sample in the log (Inspect) |
| **scorer** | a workflow that grades a trial's output by returning labels | scorer (Inspect, Braintrust), evaluator (LangSmith), verifier (Harbor) |
| **judge**, **voter** | a scorer made of agents, and one agent of it | LLM judge |
| **score** | one scorer's labels for one trial, on one key revision | score |
| **metric** | a number computed from scores: recall, precision, the wrong share | metric |
| **report** | metrics for variants side by side, computed from stored records | experiment comparison (Braintrust) |
| **agreement** | how alike two scorers, or two voters, label the same findings (Cohen's κ) | alignment (LangSmith) |

### Reviews

A trial's output is a **review** made of **findings**: `{ path?, line?, text, severity? }`. A key
holds **issues**. Each issue has:

- a mechanism: what goes wrong, never the fix
- a severity: `must-fix`, `should-fix`, `could-fix` or `nit`
- a category
- a scope: `change` if the merge request caused it, `context` if it was already there

The key also holds claims that were **refuted**, and comments **excluded** as unconfirmed or as
preference.

A score gives every finding one **label**:

| Label | Meaning |
| --- | --- |
| `hit` | gives a key issue's mechanism; each issue is hit once |
| `duplicate` | the same as an earlier finding |
| `new` | real, not in the key; carries severity, category, scope and mechanism |
| `wrong` | a concrete claim the code refutes, including the right symptom with a false cause |
| `noise` | no concrete claim: vague, taste, praise, a question |
| `unsettled` | the key excluded it as unconfirmed, or the scorer's voters split and the tiebreak didn't settle it |

The metrics:

- **Recall** per severity: key issues the change caused that some finding hit.
- **Weighted recall**: the same, with must-fix issues weighted 3, should-fix 2 and could-fix 1.
  Nits aren't counted.
- **Precision**: `hit` plus `new`, over findings that aren't duplicate or unsettled.
- **Wrong and noise shares**, words written, and time and list-price cost for the trial and the
  scorer, each counted separately.
- **Missed must-fix**: named case by case.

Counts are summed across cases before dividing.

**The panel** is the default scorer. Two voters from different model families (codex `gpt-6-sol`
and claude `claude-sonnet-5`) label every finding. Findings they label differently go to a third
model (`gpt-6-luna`), which sees the review but not their votes. The κ between the two voters is
kept with every score.

## Writing a variant

A variant is the workflow you already run, unchanged, plus a small file saying how to hand it a
case and how to read what it returns:

```ts
// variants/single-agent.variant.ts
import { defineReviewVariant } from "@agentswf/lab/review";
// The workflow under test; here, this repository's examples/single-agent-review.
import singleAgentReview from "../../agentswf/examples/single-agent-review/workflow.ts";

export default defineReviewVariant({
  workflow: singleAgentReview,
  argv: ["--range", "{base}...HEAD", "--request", "{request}"],
  timeout: "30m",
  read: (result) =>
    result.findings.map((f) => ({
      path: f.file,
      line: f.line,
      text: `${f.claim}\n${f.evidence}`,
      severity: f.severity,
    })),
});
```

- **`argv`** is what follows `--` on `awf run`. `awf-lab` fills in `{base}`, `{head}` and
  `{request}` from the case, and `{dataset}` with the dataset's folder (only a control that reads
  the key needs it). Write `{{` or `}}` for a literal brace.
- **`read`** turns the workflow's result into findings. `tsc` checks it against the workflow's
  result type, so if the workflow's output changes shape, the variant fails to compile.
- **`timeout`** is the same as `awf run --timeout`. A run that fails or times out is kept as a
  failed trial and counts as finding nothing.
- **The name is the file stem** (`single-agent`). The default export *is* the workflow, so
  `awf run variants/single-agent.variant.ts -- …` runs it directly too.

**Versions.** A variant can set `version` (semver; the default is `1.0.0`). Results belong to
`{name}@{major}.{minor}`:

- **A patch bump** says the behaviour is unchanged (a refactor, a comment), so earlier trials still
  count.
- **A minor or major bump** starts with no trials.
- **An earlier version** can be named as `{name}@{version}`, and a prefix is enough:
  `report single-agent --baseline single-agent@1.2`.

Nothing checks versions; bump when an edit changes what the variant measures.

## Writing a scorer

A scorer is also a workflow, named by `{name}.scorer.ts`. It's run in a fresh checkout of the
frozen code with `--fixture {case dir} --findings {file}` after its `argv`, and returns a
`ScorerResult` of one label per finding. The package's own panel is the whole example:

```ts
// src/review/lab/panel.scorer.ts
import { defineReviewScorer } from "../format/variant";
import judge from "../judge/judge.workflow";

export default defineReviewScorer({ workflow: judge, argv: [], timeout: "20m" });
```

A scorer can be agents (a judge) or plain code, such as a test run. `awf-lab report --scorer panel
--scorer {yours}` shows how alike the two label the same findings.

## Deciding: better, worse or a tie

With `--baseline`, `report` also gives each variant a **verdict** against the baseline: `better`,
`worse`, `tie` or `undecided`, with the reason and whether more cases could change it (`stop`). A
**comparison** decides it. It gets both variants' numbers case by case, never a finding or a key,
so one comparison works for any kind of case:

```text
vs one-codex-r1
  verdict          undecided              –

undecided  one-codex-r2 by default 1.0.0: recall.weighted +0.079 [−0.046, +0.20] at 12 of 33 cases, next look at 16 (run more cases to decide)
  recall.weighted (primary)  0.23 → 0.31, +0.08 [−0.05, +0.20] over 12 cases; won 4, tied 6, lost 2
  precision (guard)          0.97 → 0.98, +0.01 [−0.07, +0.08] over 10 cases; won 1, tied 8, lost 1
  wrong (guard)              0.03 → 0.02, 0.00 [−0.08, +0.07] over 10 cases; won 1, tied 8, lost 1
  cost (tiebreak)            0.32 → 0.31, −0.01 [−0.06, +0.04] over 12 cases; won 7, tied 0, lost 5
  time (tiebreak)            130.42 → 132.27, +1.85 [−16.13, +19.83] over 12 cases; won 6, tied 0, lost 6
```

That is two copies of the same variant on the first 12 of a dataset's 33 cases. An 8-point gain in
recall is inside the noise, and 12 isn't a planned look. Each line compares per-case means over the
cases both variants have a value for, so its means can differ from the table's pooled ones above.
The package's own comparison, `default`, is `pairedComparison` with review's settings:

```ts
// src/review/lab/default.compare.ts
import { pairedComparison } from "../../compare";

export default pairedComparison({
  version: "1.0.0",
  primary: "recall.weighted",                 // the metric that decides
  guards: [                                   // may not get worse by more than the margin
    { metric: "wrong", margin: 0.05 },
    { metric: "precision", margin: 0.05 },
  ],
  looks: [8, 16],                             // "better" only at these case counts, and the last
  equivalence: 0.05,                          // tie-breakers only if recall is shown within ±0.05
  tiebreak: [                                 // then only by more than the margin
    { metric: "cost", margin: 0.05 },         // USD a case
    { metric: "time", margin: 30 },           // seconds a case
  ],
});
```

How `pairedComparison` decides:

- **Cases** come in the dataset's seeded order, and the **plan** is all of them. A verdict is given
  only over the first n of that order: `--cases {n}`, or no selection. `--only`, `--cases` by id,
  `--where` and `--categories` get no verdict, and the report says why: cases picked by hand or by
  their results would bias it.
- Each variant's trials are averaged per case. Each metric's difference is taken per case, over the
  cases both variants have, with a paired t interval (95%). Below 5 cases there's no interval, only
  cases won, tied and lost, and the verdict is always `undecided`.
- **worse** as soon as the primary's interval is wholly below 0, or a guard's is wholly past its
  margin. It can stop at any case count.
- **better** only at a **look**, a count of cases both variants have finished that is planned in
  advance (`looks`, and always the plan's end), past an O'Brien–Fleming bound. That way, checking
  as cases arrive can't manufacture a win. It also needs every guard's interval within its margin
  and at least 6 cases won (`minWon`).
- At the plan's end, the **tie-breakers** decide, in order. One whose whole interval is past its
  margin says `better` if the primary is shown no worse than −`equivalence` and the guards are
  within their margins, or `worse` if the primary is shown no better than +`equivalence`. A later
  one may say `better` only while every earlier one is shown no worse than its margin, and `worse`
  only while every earlier one is shown no better, so improving on any metric never costs a
  challenger its verdict.
- Otherwise a primary shown within ±`equivalence` is a `tie`, even a little better.
- `undecided` with `stop` means the plan ran out without an answer: too few cases are won, a gain
  falls short of the bound, or no difference is shown but neither is one within ±`equivalence`.
  There's never a weighted sum of metrics.

The rates for `default`, simulated on 33 cases with trial noise as measured on reviews (sd 0.19
between cases, 0.13 between trials of one), checking after every case, 2,000 runs each:

| True gain in weighted recall | Trials a case | better | worse | tie or undecided | cases, on average |
| --- | --- | --- | --- | --- | --- |
| none | 1 or 2 | 2.5% | 11% | 86% | 31 |
| +0.10 on every case | 1 | 85% | 0.4% | 15% | 30 |
| +0.10 on every case | 2 | 99% | 0.1% | 1% | 26 |
| +0.10 on average, sd 0.10 by case | 2 | 92% | 0.5% | 7% | 29 |
| +0.15 on every case | 1 | 99% | – | 1% | 25 |

Between equals, 33 cases seldom show recall within ±0.05: with one trial a case nearly all end
`undecided`, with two about a sixth end `tie`. The
stop for worse is quick, not careful: about one comparison in nine between equals stops as
`worse`, the price of never waiting on a loser. A discarded idea costs less than a false win. Time
measured under `--jobs` is not comparable with time measured alone, so compare variants run the
same way.

**Your own comparison** is a `*.compare.ts` whose default export is `pairedComparison({ … })` with
other settings, or anything made with `defineComparison`. Either takes a `version`: bump it when
the rule changes, since the report names it beside each verdict.

```ts
// comparisons/strict.compare.ts: at most 2 points more wrong claims, and looks at 8 and 16
import { pairedComparison } from "@agentswf/lab/compare";

export default pairedComparison({
  version: "1.0.0",
  primary: "recall.weighted",
  guards: [{ metric: "wrong", margin: 0.02 }],
  looks: [8, 16],
});
```

A tie-breaker's margin of 0 makes it a test of its own, adding up to 2.5% of false `better`
between equals; `default`'s margins make that about nothing. A guard's margin of 0 asks for a
whole interval at or above 0, which almost never happens once any
case differs, so such a rule can seldom say `better`. A primary that is `null` on some cases, such as `recall.must-fix` on cases with no must-fix issue,
counts only the cases that have it, and may never reach the 5 an interval needs.

Or a rule entirely your own. `compare` gets both variants' trials, the metrics' definitions and the
plan's size, and returns the verdict:

```ts
// comparisons/cheaper.compare.ts: better when cheaper on at least 9 cases
import { defineComparison, perCase } from "@agentswf/lab/compare";

export default defineComparison({
  version: "1.0.0",
  // baseline, challenger: one { case, trial, outcome, metrics: { [name]: number | null } } per trial
  // metrics: each metric's { name, direction, onVariantFailure }; planned: a count of cases
  compare({ baseline, challenger, metrics, planned }) {
    const cost = metrics.find((m) => m.name === "cost")!;
    const theirs = perCase(baseline, cost); // case → mean over its trials
    const ours = [...perCase(challenger, cost)].filter(([id]) => theirs.has(id));
    const cheaper = ours.filter(([id, usd]) => usd < theirs.get(id)!).length;
    return {
      verdict: cheaper >= 9 ? "better" : "undecided",
      stop: cheaper >= 9 || ours.length === planned,
      reason: `cheaper on ${cheaper} of ${ours.length} cases`,
      metrics: [], // or compareMetric(…) per metric, for report to print
    };
  },
});
```

`compare` takes a `ComparisonInput` and returns a `Verdict`; both types, and the `CaseScore`,
`MetricSpec` and `ComparedMetric` they're built from, are exported from `@agentswf/lab/compare`
with the fields documented on each. `report` checks the verdict it gets back and names the
comparison when it's out of shape or throws.

List it in `awf-lab.json` under `"comparisons": ["comparisons/*.compare.ts"]`, then pick it with
`"comparison": "strict"` or `--comparison strict`. A path works too:
`--comparison comparisons/strict.compare.ts`. `default` is the package's, and no workspace file may
take the name. `awf-lab list comparisons` shows what the workspace sees. `perCase` and
`compareMetric` from `@agentswf/lab/compare` are the building blocks `pairedComparison` uses.

**The numbers a review gives**, by name: `recall.weighted`, `recall.must-fix`,
`recall.should-fix`, `recall.could-fix`, `precision`, `wrong`, `noise` (each 0 to 1, per trial;
`null` where it doesn't apply, such as must-fix recall on a case with none), and `cost` (USD at
list price, `null` when an agent wasn't priced) and `time` (seconds) of the trial. A trial whose
variant failed scores 0 recall and leaves the rest out. A comparison naming another metric fails
with the list.

With a verdict, the text report shows its counts, by the comparison's primary. `--json`'s `won`,
`lost` and `tied` stay review's, by weighted recall, which is what `--where lost` reads.

**Several trials a case.** `--trials {n}`, or `"trials"` in the config, asks for n trials of each
case: `run` adds the missing ones and reuses the rest, and `report` counts a case only once all n
are run and scored, so a look never counts a case twice as its trials arrive. A case with fewer is
listed as not counted, with how many it has. Trials are numbered by age, so trial 1 stays trial 1
as more are added, and `--trials 1` reads the first alone. Two trials a case let a comparison see
how much a case varies from trial to trial. On reviews, two a case need about a third fewer cases
than one to see the same difference, and a third trial about a tenth fewer again. A `run` that stops when the verdict says so is story 011's
next step.

## The workspace

A workspace is a directory with an `awf-lab.json`. `awf-lab` finds it by walking up from the
current directory, and `--config {file}` overrides that. Datasets are private data, so a workspace
usually lives in its own repository, not this one.

```json
{
  "$schema": "…/packages/lab/schema/awf-lab.schema.json",
  "clone": "../project",
  "datasets": "datasets",
  "dataset": "first",
  "results": "results",
  "runs": "runs",
  "variants": ["variants/*.variant.ts"],
  "scorers": ["scorers/*.scorer.ts"],
  "scorer": "panel",
  "comparisons": ["comparisons/*.compare.ts"],
  "comparison": "default",
  "trials": 2,
  "budget": { "usd": 20 },
  "sandbox": { "srt": {} }
}
```

`sandbox` names the provider of every trial's sandbox: `{ "srt": {} }`, the default, or
`{ "docker": { "image": "…" } }`. What goes in it is fixed: the checkout and the request. It's the
workspace's, not a flag, because it is part of what a trial measures: each trial records the
sandbox it ran in, and only trials in the workspace's current one count, so changing it, or a trial
from before trials had one, runs again. A sandbox that can't open (srt missing, docker down, no such
image) stops the run before it starts, and `run` tries that trial again next time. A claude agent
in a sandbox needs `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in awf-lab's environment.

`clone` is a checkout of the reviewed project; each case's frozen code is restored against it.
`panel` is always available as a scorer. Everything else is where things live:

| What | Where |
| --- | --- |
| dataset | `{datasets}/{dataset}/set.json`, which pins every case by digest |
| case | `{datasets}/{dataset}/{case}/`: `fixture.json`, `request.md`, `snapshot.bundle` |
| key | `{case}/key/key.json`, with `evidence/` and `fixes.bundle`. A reviewer never sees it |
| trial | `{results}/{dataset}/{variant}@{major}.{minor}/{case}/{trial-id}/findings.json` |
| score | `score.{scorer}@{major}.{minor}.k{key-revision}.{n}.json` beside its trial, where `n` counts retries |
| run | `{runs}/invocation-{id}/{run-id}/`: `output.json` and transcripts, not needed by any record |

To use `@agentswf/lab/review` from a workspace outside this repository, run `bun link` in
`packages/lab`, then `bun link @agentswf/lab` in the workspace.

## Building a dataset

A dataset is built by a workflow, not by an `awf-lab` command. For each merge request, it:

1. **Collects** it: freezes the code at the push where review began, the title and description as
   the reviewer read them, and the raw comments. GitLab is reached read-only, through `glab api`.
2. **Drafts a key** with one agent. Code checks the draft against the comments, the frozen code and
   the later pushes, and sends it back if it's wrong.
3. **Has graders vote.** Three graders from two model families vote on what code can't check.
   The key keeps what a majority agrees on.
4. **Seals** the set.

```sh
awf run packages/lab/src/review/build/fixtures.workflow.ts -- \
  --project group/name --mrs 12,34 --clone ~/code/name --out ~/data/datasets/first
```

This costs money: the drafter and the graders are live agents. A case is kept only if it was merged
and its key has at least two must-fix or should-fix issues the change caused.

## Commands

```text
awf-lab [--config {file}] {command} … [--json]

  list [datasets|cases|variants|scorers|comparisons]
                                              what the workspace sees, with stored versions
  run {variant…} [selection]                  the missing trials, then their scores
  score {variant…} [selection]                scores stored trials; never runs a variant
  report {variant…} [selection]               metrics side by side, and with --baseline a
                                              verdict for each; --md for Markdown
  show {variant} {address}                    one case, trial or finding in full
  schema [{format}]                           the JSON Schema of a record or a --json output
```

| Command | Costs money |
| --- | --- |
| `run` | yes: the variant's agents and the scorer's |
| `score` | yes: the scorer's agents |
| `list`, `report`, `show`, `schema` | no; they read stored records |

`run` and `score` print their plan and an estimate first. On a terminal they ask before spending,
unless you pass `--yes`. `--dry-run` stops after the plan, `--budget {usd}` stops once the estimate
would pass it (the config can set a default), and `--jobs {n}` runs n steps at a time.

**Selection** works the same on every command:

| Flag | Selects |
| --- | --- |
| `--dataset {name}` | the dataset; the config gives the default |
| `--cases {n}` or `--cases {id},…` | n cases in a seeded order (the same n every time), or cases by id or glob |
| `--only {address},…` | cases, trials or findings by address |
| `--trials {n}` | trials a case; the config gives the default, else 1 |
| `--where {predicate}` | by stored results; repeat it and all must hold |
| `--scorer {name}` | the scorer; `report` and `show` take two, to compare them |
| `--baseline {variant}` | what `report` compares against |
| `--comparison {name}` | what gives `report`'s verdict against the baseline; the config gives the default, else `default` |

**Addresses** are `{case}`, `{case}/{trial}`, `{case}#{finding}` and `{case}/{trial}#{finding}`,
with `{variant}:` in front when several variants are in play. A trial is its 1-based position, by
age, among the case's trials, and a finding its index. Past one trial a case, a finding names its
trial: `{case}/2#0`.

**Predicates** for `--where`:

| Predicate | Selects |
| --- | --- |
| `failed` | failed trials, and trials with no passing score |
| `split` | findings the scorer's voters labelled differently |
| `label={label}` | findings with that label, such as `label=new` |
| `differs={scorer}` | findings another scorer labels differently |
| `lost` | cases where the baseline did better on weighted recall, averaged over the trials |

On `score`, `--where` selects findings, and the labels for the rest come from `--rest-from
{scorer}`. The result is a partial score, which is never counted.

**Exit codes:** 0 done, 1 a failure, 2 a usage error, 3 stopped by the budget, 4 the plan was
declined.

**`--json`** prints a versioned record instead of text. `awf-lab schema` lists every format, and
`awf-lab schema {format}` prints its JSON Schema. The same schemas are in [`schema/`](schema/),
generated from `src/review/format/`.

## Three jobs

```sh
# Evaluate: see the plan and its cost, run it, then compare
awf-lab run single-agent --cases 10 --dry-run
awf-lab run single-agent --cases 10 --jobs 5
awf-lab report single-agent --baseline catalogue --cases 10

# Improve a variant: find where it lost, edit and bump its version, rerun those cases, compare
awf-lab report single-agent --baseline catalogue --where lost --json
awf-lab run single-agent --only app-1,app-2
awf-lab report single-agent --baseline single-agent@1.0 --only app-1,app-2

# Improve a scorer: score where the panel's voters split, compare the two, read one finding
awf-lab score catalogue --scorer strict --where split
awf-lab report catalogue --scorer panel --scorer strict
awf-lab show catalogue app-2#3 --scorer panel --scorer strict
```

Before trusting a new scorer, run the controls: `oracle` must score 1.00 and `nop` 0.00.

## Inside this package

`src/review/` is laid out in layers, each importing only the ones above it:

- `format/`: the record formats, as TypeBox schemas
- `fixtures/`: reading sealed datasets
- `build/`: making datasets (`collect`, `draft-key`)
- `judge/`: the panel
- `metrics/`: the numbers
- `lab/`: the command line

The package imports `@agentswf/contract` and nothing else from this repository. Every file format it
owns is checked against its schema before it's written. [`AGENTS.md`](AGENTS.md) has the rules for
changing it, and [story 008](../../docs/stories/008-review-scorer.md) has the reasoning behind the
terms and the command line.
