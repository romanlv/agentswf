---
id: "008"
title: Score a review variant against a case's answer key
summary: awf-lab runs a review variant and a scorer workflow per case, keeps each trial's findings and the scorer's labels as records, and derives recall by severity, precision, wrong claims, noise, cost and time from them; a run that ran out of time says so in output.json first.
type: story
status: awaiting-human-review
discovered_in: "review-recall-scorer and deadline-outcome todos, 2026-09-26"
depends_on: ["005"]
---

# Score a review variant against a case's answer key

## Outcome

Given a review variant and cases from a sealed dataset, `awf-lab` runs the variant, has a scorer
label what it found, and reports numbers that compare across trials and variants. From the data
repository, which holds `awf-lab.json`:

```sh
awf-lab run one-agent-bare --cases 5 --jobs 5 --dry-run            # what it would run, and the estimate
awf-lab run one-agent-bare --cases 5 --jobs 5                      # trials, then their scores, kept as records
awf-lab report one-agent-bare --baseline catalogue-review          # the numbers, from records, no spend
```

`awf-lab` uses the terms in [[#Terms and where things are]] and the command line in
[[#The command line, revised]], since [[#7. The code in these terms and this command line|Task 7]].
The flags it had before are in [[#From the first command line]].

```text
one-agent-bare vs catalogue-review    dataset first, 5 cases, key r1, scorer panel v1-187c…
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
failed trial         catalogue-review:F2
costs are list-price estimates, also for runs on a subscription
```

Built and run for real on five cases ([[#The first experiment (2026-09-27)|the first
experiment]]). What is left is scoring speed and checking what the scorer calls `new`:
[[#Where it stands]].

`output.json` also gained `outcome: "timed-out"` (v4), so a run its own deadline ended counts
apart from a crash.

## How it works

```text
awf-lab run {variant}: every trial, then every score, --jobs steps at a time
  case: snapshot.bundle + request.md                             key.json
     │                                                               │
  1. restore the frozen code into a temp checkout (2–3 s)            │
  2. awf run {variant's workflow} ─▶ output.json ─▶ read() ─▶ findings.json   (the trial)
                                                                     │
  3. awf run {scorer} in a fresh checkout ◀── findings + case (key) ──┘
       panel: sol ─┐ one call each, answers checked by code, re-asked once
           sonnet ─┼─▶ agree ─▶ label        split ─▶ luna tiebreak on those findings only
                   ▼
  4. awf-lab checks the labels ─▶ score.{scorer}@{version}.k{key-revision}.{n}.json    (the score)
                   ▼
  awf-lab report: pure metrics over findings, scores and the key; spends nothing
```

**A variant** is the workflow a team already runs, unchanged, plus a small file saying how to
hand it a case and how to read its result:

```ts
import singleAgentReview from "@agentswf/examples/single-agent-review/workflow.ts";

export default defineReviewVariant({
  workflow: singleAgentReview,
  file: new URL(import.meta.resolve("@agentswf/examples/single-agent-review/workflow.ts")),
  argv: ["--range", "{base}...HEAD", "--request", "{request}"],
  timeout: "30m",
  read: (result) =>
    result.findings.map((f) => ({ path: f.file, line: f.line, text: `${f.claim}\n${f.evidence}`, severity: f.severity })),
});
```

`awf-lab` fills `{base}`, `{head}` and `{request}` from the snapshot, and `{dataset}` with the
dataset's folder, which only a control that reads the key needs. It runs `awf run` in the
restored checkout, and turns the result into `ReviewFinding[]` (`{ path?, line?, text,
severity? }`) with `read`, which `tsc` checks against the type of `workflow`. `file` is what
`awf run` loads, and `awf-lab` refuses a file whose default export is not `workflow`. A run that
fails or times out is kept as a failed trial with no findings; it counts as finding nothing.

**A scorer** is a workflow too, named by a scorer file (`{name}.scorer.ts`, made with
`defineReviewScorer`, whose `workflow` must return a `ScorerResult`). It gets `--fixture {dir}` (the case's request and key) and `--findings
{file}`, works in a fresh checkout of the frozen code, and returns labels, one per finding
(format `awf.review-judgement/1`):

| Label | Meaning |
| --- | --- |
| `hit` | gives a key issue's mechanism; each issue is hit once |
| `duplicate` | the same as an earlier finding |
| `new` | real, not in the key; carries severity, category, scope and mechanism |
| `wrong` | a concrete claim the code refutes, including the right symptom with a false cause |
| `noise` | no concrete claim: vague, taste, praise, a question |
| `unsettled` | the key excluded it as unconfirmed, or the panel split and the tiebreak did not settle it |

`new`, `wrong` and `noise` need the code the scorer read (`read`). Code checks every score,
whoever wrote it: each finding labelled once, issue ids exist, no issue hit twice, `read`
where required. Labels that fail the check are a failed score, retried by the next `run`, never a
zero for the variant.

**The panel**, the default scorer, is a judge: agents that vote. It runs codex `gpt-6-sol` and
claude `claude-sonnet-5` side by side on the same prompt. Each answer is checked and handed back
once with its problems; a voter that fails twice withholds its vote and the score fails. Findings
they label differently go to `gpt-6-luna`, which sees the review but not the two votes. κ between
the two is kept with the score.

**Records** live in the data repository and are written once:

- `results/{dataset}/{variant}@{major}.{minor}/{case}/{trial-id}/findings.json`: the trial: its
  run, outcome, models, time and list price, and the findings verbatim.
- `score.{scorer}@{major}.{minor}.k{key-revision}.{n}.json` beside it: one score, `n` counting
  retries.

**Versions.** A variant or scorer file says its `version`, in semver; absent, it is `1.0.0`.
Results belong to `{name}@{major}.{minor}`: a patch bump says the behaviour is the same, as for a
refactor, a comment or a path moved into a placeholder, so every earlier trial and score still
counts; a minor or major bump starts with none. Major is for a change the numbers should be grouped
apart by later: another approach, another result shape. Versioning is the researcher's call, as a
library's is its developer's; nothing checks it. Each record also keeps the file's commit, as provenance. `{name}@{version}` names an earlier version, a prefix is enough. The plan
(`--dry-run` prints it) decides per case from the records: a trial when this version has none of
this case's digest, a score when this scorer has no passing score on this key revision, otherwise
reuse. So a second `run` spends nothing, a failed score is retried alone, and a new scorer scores
stored trials without running the variant: `score {variant} --scorer {name}` does only that.

**Chosen findings:** `score {variant} --only {case}#{n},…` scores only those findings of stored
trials. The scorer is handed another score's labels for the rest (`--rest-from`), and the result
is kept as a partial score, which is never counted ([[#6. Score chosen findings]]). `score
{variant} --where split` picks the findings the voters split on.

**The report** computes from records only: recall by severity (hits over the key's issues,
weighted 3/2/1 for must, should and could), precision (`hit` and `new` over distinct findings),
the `wrong` and `noise` shares, words, time and list price per phase, κ, and per-case wins for
two variants. Costs are list-price estimates from awf's price table.

**Controls** check a scorer, not a variant: `oracle` returns the key's own issues (must score
1.00), `nop` nothing (0.00), and `comments` the merge request's review comments the key cites,
with the labels the key gives them.

## Terms and where things are

This story was first written in words of its own: fixture, set, judge, judging, review, sanity
input. Other eval tools use other words ([`eval-terminology`](../research/eval-terminology.md)),
and `awf-lab` is meant for more than reviews, so the story now uses the vocabulary below. Task 7
renamed the command line, the config, the paths and the fields of new records. Names a scorer
imports keep their old names until later, since those renames cost a re-run
([[#What a rename costs]]). So do sealed case files and records written before the rename. Where
the story quotes one, it quotes it as it is.

The rule: where the tools agree, use their word. Where they disagree, use the plainest one. Keep a
word of our own only for something that is ours.

### The words

| Term | Means | Was | Elsewhere |
| --- | --- | --- | --- |
| **workspace** | the directory with `awf-lab.json`: datasets, variants, scorers, results | workspace | project (Braintrust, LangSmith) |
| **dataset** | a sealed collection of cases | set | dataset (all of them) |
| **case** | one input with its key | fixture | sample (Inspect), example (LangSmith), test case (promptfoo), task (Harbor) |
| **input** | what a variant is given; for a review, the request and the frozen code | request, snapshot | input |
| **key** | a case's known answers, revised as they grow; for a review, its issues and exclusions | key | target (Inspect), expected (Braintrust), reference outputs (LangSmith) |
| **variant** | what is evaluated: a workflow, with a file saying how to give it a case and read its result | variant | solver (Inspect), task (Braintrust), agent (Harbor) |
| **baseline** | the variant a report compares against | incumbent | baseline (Braintrust, LangSmith) |
| **control** | a variant with a known score, run to check the scorer: `oracle` (1.00), `nop` (0.00), `comments` | sanity input | the `oracle` and `nop` agents (Harbor) |
| **run** | one `awf run` of a workflow; its directory holds `output.json` and the transcripts | run | — |
| **trial** | one attempt by a variant at one case: a run and its output | review | trial (Harbor), a sample in the log (Inspect) |
| **trials** | attempts per case | repeats | epochs (Inspect), `trialCount` (Braintrust), attempts (Harbor) |
| **scorer** | what grades a trial's output: a workflow that returns labels | judge | scorer (Inspect, Braintrust, MLflow), evaluator (LangSmith), verifier (Harbor) |
| **judge** | a scorer made of agents, such as the panel or match first; a scorer can also be code, such as a test run | judge | judge (MLflow: "LLM judges and code-based scorers are … scorers") |
| **voter** | one agent of a judge | judge, voter | — |
| **score** | one scorer's labels for one trial, on one key revision | judging, judgement | score (Inspect, Braintrust) |
| **partial score** | a scorer's labels for chosen findings, with the other labels taken from another score; never counted | partial judging | — |
| **metric** | a number computed from scores: recall, precision, the wrong share | metric | metric |
| **report** | metrics for variants side by side, computed from stored records only | report | experiment comparison (Braintrust) |
| **agreement** | how alike two scorers, or two voters, label the same findings (κ) | κ | alignment (LangSmith, MLflow) |

The review keeps its own words. A trial's output is a **review** made of **findings**. A key holds
**issues**. A score gives each finding a **label**: `hit`, `duplicate`, `new`, `wrong`, `noise` or
`unsettled`. A dataset of another kind has its own output and labels and shares every other term.
"Experiment" stays plain English for a batch of `awf-lab` commands with a question behind it, not a
stored object.

Not taken:

- **sample** (Inspect, Ragas, OpenAI Evals): the closest runner-up. It also means one draw among
  several, which is awkward beside trials and a seeded subset ("5 samples, sampled").
- **example** (LangSmith, DSPy): this repository's `examples/` holds workflows, one of them a
  variant, and prompts hold few-shot examples. It also undersells sealed cases with answer keys.
- **target**: in LangSmith it is the system under test.
- **expected**: it reads as an exact output.
- **epochs**: a training word.
- **experiment as a stored object**: a report over records is the comparison. A record per
  `awf-lab run` would give a viewer its history, and can be added when one needs it.

### Where things are

The paths, by the term each holds:

| Term | Where |
| --- | --- |
| workspace | `awf-lab.json`, found by walking up from the current directory; `--config {file}` overrides it |
| dataset | `{datasets}/{dataset}/set.json`; `datasets` in the config |
| case | `{datasets}/{dataset}/{case}/`: `fixture.json`, `request.md`, `snapshot.bundle` |
| key | `{case}/key/key.json` with `evidence/` and `fixes.bundle`; the revision is inside |
| variant | the files the config's `variants` globs match, `{name}.variant.ts`, each naming a workflow |
| control | `packages/lab/src/review/lab/{oracle,nop,comments}.workflow.ts`, named by variant files |
| scorer | the files the config's `scorers` globs match, `{name}.scorer.ts`; the package's `panel` is `lab/panel.scorer.ts` over `judge/judge.workflow.ts` |
| trial | `{results}/{dataset}/{variant}@{major}.{minor}/{case}/{trial-id}/findings.json` (`awf.review-findings/2`) |
| score | `score.{scorer}@{major}.{minor}.k{key-revision}.{n}.json` beside its trial (`awf.review-score/2`) |
| partial score | `partial.{scorer}@{major}.{minor}.k{key-revision}.{n}.json` beside its trial (`awf.review-partial/2`) |
| run | `{runs}/invocation-{id}/{run-id}/`: `output.json`, `calls/`, `decisions/` |
| report | not stored; `report --json` prints `awf.lab-report/2` |
| schemas | `packages/lab/schema/*.schema.json`, generated from `format/`; `awf-lab schema` prints them |
| code | `packages/lab/src/review/`: `format/` the records, `fixtures/` reading sealed datasets, `build/` making them, `judge/` the panel, `metrics/`, `lab/` the command line |

Records written before Task 7 keep their formats (`/1`) and file names (`judged.*.json`); the
store reads both. The data repository's dataset folder is `datasets/`, named by the `datasets`
key. The oracle and comments variants name it with `{dataset}`, so their hashes cover no path.
The public docs are
[`lab-public-docs`](todo/lab-public-docs.md).

### What a rename costs

| What | Cost | When |
| --- | --- | --- |
| docs, help text, the command line's verbs and flags, report text | nothing | Task 7 |
| `--json` output and the workspace config | a format version; an old key fails with a message naming the new one | the same |
| directories and record file names in the data repository | a one-off move, and a store that reads the old names for one version; paths are in no hash | the same |
| field names in new records (`judge` to `scorer`, `review` to `trial`, `fixture` to `case`) | a new format version beside the old; the reader takes both | the same |
| names in files a scorer imports (`defineReviewJudge`, `Judgement`) | nothing since versions: the hashes move, the results stay with the version | done after Task 7: `defineReviewScorer`, `ScorerResult`; `judge/` stays, as the panel is a judge |
| sealed case files (`awf.review-fixture/1`, `awf.fixture-set/1`) | never renamed: the case digest covers `fixture.json`, so a new digest orphans every trial of that case | new datasets may use new names; the old ones are read as they are |

`defineReviewVariant` isn't renamed: "variant" stays.

## The command line, revised

Built in Task 7. `awf-lab` does three jobs, and each should be as easy for a coding agent and
a future viewer as for a person:

- **Evaluate:** trials of variants over a dataset, scored and compared with a baseline.
- **Develop:** edit a variant or a scorer, then re-run or re-score only what the edit affects.
- **View:** metrics first, then any one case, trial or finding in full.

Five rules:

1. **Few verbs, one selection.** Every command takes the same selection flags, and they mean the
   same thing everywhere.
2. **Everything has an address, printed wherever it's shown.**
   - A report row, a `show` heading, a JSON `id` and a viewer's URL all carry the same address,
     and `--only` takes it back.
   - An agent copies from one command's output into the next command.
   - A viewer's button can be the command it would run, shown on screen.
3. **Re-running is safe.** Running the same command again does only what is missing, as Inspect's
   eval sets do, and `--dry-run` says what that is and what it would cost.
4. **Output suits people and programs.**
   - The result goes to stdout, progress to stderr.
   - Every command takes `--json`: versioned, with its schema from `awf-lab schema`.
   - With no terminal attached, nothing prompts.
   - Exit codes stay as today: 0 done, 1 a failure, 2 a usage error, 3 stopped by the budget,
     4 the plan was declined.
5. **The records are the interface.** A viewer reads the same files and the same JSON, and holds
   no state the command line can't reach, as the viewers of Inspect, promptfoo and Harbor do.

### Commands

| Command | Does | Was |
| --- | --- | --- |
| `list [datasets\|cases\|variants\|scorers]` | what the workspace sees: names, files, versions, and stored versions with their trials and scores | `config` |
| `run {variant…}` | the missing trials for the selection, then their scores | `run` |
| `score {variant…}` | scores stored trials, whole or only chosen findings; never runs the variant | `run --judge-only`, `run --only` |
| `report {variant…}` | metrics side by side against `--baseline`; with two `--scorer`s, their agreement and the findings they differ on | `report`, the data repository's `scripts/judges.ts` |
| `show {variant} {address}` | one case, trial or finding in full: input, output, each scorer's label with its votes and reasons, the key's issue, the run directories | ad hoc scripts |
| `schema [{format}]` | the JSON Schema of a record or of a command's `--json` | the files in `schema/` |
| `view` | later, not in Task 7: a local viewer over the records | — |

`run` makes trials and scores them; `score` only scores. So every command below that re-scores
stored trials, with a new scorer, a new key revision or chosen findings, is `score`.

`plan` becomes `--dry-run` on `run` and `score`. A plan is what that same command would do, so the
two can't drift apart, and `run` already prints its plan before asking.

A stored version is named `{name}@{version}`, and a prefix is enough, so a version can be compared
with the one before it: `report one-agent-bare --baseline one-agent-bare@1.2`. `list variants`
prints the stored versions, each with its trials.

### Selection, the same on every command

| Flag | Selects | Like |
| --- | --- | --- |
| `--dataset {name}` | the dataset; the config gives the default | — |
| `--cases {n}`, `--cases {id},…`, `--cases {glob}` | n cases, seeded from the whole dataset so the same n every time, or cases by id | Inspect `--limit`, `--sample-id`; promptfoo `--filter-sample` |
| `--only {address},…` | cases, trials or findings, by address | Inspect `--sample-id`, one level deeper |
| `--where {predicate}` | by stored result, for `--scorer`; repeated, all must hold | promptfoo's twelve `--filter-*` flags, as one |
| `--trials {n}` | at least n trials per case; with [`variant-matrix-runner`](todo/variant-matrix-runner.md), which brings several trials | Braintrust `trialCount`, Inspect `--epochs` |
| `--scorer {name}` | the scorer; the config gives the default; `report` and `show` take two | Inspect `score --scorer` |
| `--baseline {variant}` | what `report` compares against, and `--where lost` reads; the config can give it | Braintrust's baseline experiment |

**Addresses.**

- The forms are `{case}`, `{case}/{trial}`, `{case}#{finding}` and `{case}/{trial}#{finding}`.
- A trial is numbered by its 1-based position among the variant's current trials of that case.
  `{case}#{finding}` works only while the case has one trial.
- A document that covers several variants prefixes each address with `{variant}:`.

**Predicates:**

| `--where` | Selects |
| --- | --- |
| `failed` | trials that failed, and trials with no passing score |
| `split` | findings the scorer's voters labelled differently |
| `label={label}` | findings with that label, such as `label=new` |
| `differs={scorer}` | findings another scorer labels differently |
| `lost` | cases where `--baseline` did better |

- **On `run`,** a predicate about findings selects their cases.
- **On `score`,** it selects the findings. A partial score takes the other labels from `--rest-from
  {scorer}`, the config's scorer by default; this was `--base`, renamed so it isn't confused with
  "baseline". The predicates read the `--rest-from` scorer's records, since `--scorer` is the one
  being run.
- **On `report`,** they select the cases each variant is counted on; the baseline is counted on
  every case another variant was chosen on.
- **Predicates read the command's own variants' records.** A new version has none, so you choose
  its cases from the old version's report, by address.

### The three jobs

```sh
# evaluate: what it would do and cost, then do it, then compare
awf-lab run one-agent-bare --cases 10 --trials 3 --jobs 5 --dry-run
awf-lab run one-agent-bare --cases 10 --trials 3 --jobs 5
awf-lab report one-agent-bare --baseline catalogue-review --cases 10

# develop a variant: find where it lost, edit its file (a new hash), try those cases, compare
awf-lab report one-agent-bare --baseline catalogue-review --where lost --json
awf-lab run one-agent-bare --only F2,F4
awf-lab report one-agent-bare --baseline one-agent-bare@v1-e355 --only F2,F4

# develop a scorer: score where the default's voters split, compare the two, read one finding
awf-lab score catalogue-review --scorer match --where split
awf-lab report catalogue-review --scorer panel --scorer match
awf-lab show catalogue-review F4#3 --scorer panel --scorer match

# a new scorer or key revision: score every stored trial again, no variant runs
awf-lab score catalogue-review one-agent-bare --scorer match --jobs 5
```

### From the first command line

What the code had before Task 7, and what each became. `config` becomes `list`. `plan` becomes `--dry-run`. `--set` becomes `--dataset`, `--fixtures`
becomes `--cases`, and `--judge` becomes `--scorer`. `run --judge-only` and `run --only` become
the `score` command. `--only` moves to every command and gains trial addresses. `--base` becomes
`--rest-from`, and the planned `--repeats` becomes `--trials`. `report`'s second variant becomes
`--baseline`, which the config can also set. `--categories`, `--jobs`, `--budget`, `--yes`,
`--json` and `--config` stay. An old flag fails with a message naming the new one, and there are
no aliases, since this repository and the data repository are the only users. The old config keys
(`sets`, `set`, `scores`, `judges`, `judge`) fail the same way.

Not taken:

- An env twin for every flag, or `-S`-style overrides; see [`eval-cli-config`](../research/eval-cli-config.md).
- promptfoo's family of `--filter-*` flags; `--where` covers it with one flag.
- A stored experiment object.
- A server or database behind the viewer.
- Progress as JSON lines on stderr (`--progress jsonl`), for a viewer following a run live. Build
  it when there is a viewer to use it.

## Where it stands

Done: Tasks 0–7, the first experiment, and the scorer comparison. Verification passes for them.
`--jobs` was added after review, when scoring proved too slow.

### Left

1. **Adopt the fast scorer.** Match first, with sol and terra in pi voting on the rest, scores
   as accurately as the panel in a fifth of the time and list price; five cases take 5 minutes
   ([[#Match first (2026-09-27)]]). It lives in the data repository; moving it into the package as
   the default is [`decision-matching`](todo/decision-matching.md). The second voter is OpenAI's
   until opus 5.5 is tried ([`judge-opus-voter`](todo/judge-opus-voter.md)).
2. **`new` is checked only by a small test.** Holding the hit issues out of the key, the fast
   scorer called 13–15 of 17 findings of them `new` ([[#Match first (2026-09-27)]]); nothing checks
   whether a `new` finding the key never had is real.
3. **Task 7's leftovers:**
   - The review ran in the main session, not as two subagents, to save Claude usage.
   - The names a scorer imports change later, with `decision-matching`; the public docs are
     [`lab-public-docs`](todo/lab-public-docs.md).
4. **Human review** of this story.

### Issues we ran into

| Issue | Effect | Status |
| --- | --- | --- |
| Scorers beside a large trial time out | 4 of 5 scoring timeouts ran beside the 21-agent catalogue or another scorer; each time the claude voter ran to the limit | `run` now runs every trial first, then every score; match first bounds each turn ([[#Match first (2026-09-27)]]) |
| A run ends minutes after its deadline | a panel score ended 14 min late, a catalogue trial 5 | todo [`deadline-overrun`](todo/deadline-overrun.md) |
| "Metered" and "charged" read as a bill | headless claude is labelled metered by a harness rule, and its printed cost was reported as spend | todo [`billing-provenance`](todo/billing-provenance.md); costs here are list-price estimates |
| Haiku can't vote | it wrote the `wf result` command out as text on every case; the cheap panel failed 14 of 14 | a finding; the default stays on smart models |
| Editing a file a variant imports orphans its records | editing `format/sanity.ts` mid-experiment gave the oracle a new hash; moving the dataset path into `{dataset}` emptied both controls' reports | settled by versions: a patch bump keeps the results ([[#Task 7: the terms and the command line (2026-09-28)]]) |
| Controls that read the key keep their findings across key revisions | after a key revision the oracle's and comments' findings would be scored against a key they weren't made from | edit their variant files after a key revision; the Task 5 script matches them by text |
| The catalogue timed out on one case | 50 minutes, recorded as a failed trial; each single agent's one win is that case | kept as a result |
| The per-finding scorer is slow on short reviews | single turns of 15 minutes on 2- and 8-finding reviews | stopped; see [[#Scoring speed]] |
| Agents run at an effort nobody chose, in the operator's environment | claude took the launching session's `CLAUDE_EFFORT` and `CLAUDE_*`; codex and pi their configs' | todos [`runtime-effort`](todo/runtime-effort.md), [`inherited-agent-env`](todo/inherited-agent-env.md) |
| Agents ran unsandboxed | variants could have read the keys, the clone and GitLab; a scan of all 298 transcripts of the first experiment found none that did | todo [`eval-isolation`](todo/eval-isolation.md); match first runs in srt |

## Scoring speed

Seven hours of scoring for the first experiment's findings is not acceptable. The seven hours
were the Task 5 comparison: five scorers each scored every stored trial, one case at a time, and
about 2½ hours of it went to runs that ended in timeouts. Scoring the experiment once with the
panel took about 40 minutes, still one case at a time.

Where a score's time goes:

- The panel took a median of 2½ minutes per case and variant, and up to 10 minutes on a
  20-finding review. Every score reads the same merge request, key and code from scratch, per
  voter, per variant and per scorer.
- The per-finding scorer's first turn took 16 seconds to 9 minutes, reading the change, key and
  code; every later finding took 12 seconds to 2 minutes. On an 8-finding review, 9 of 16 minutes
  was the first turn.
- Every successful panel score finished within 12 minutes; the 20-minute timeout only let stuck
  ones run longer.

**Done now: `--jobs {n}`.** `awf-lab run` runs every trial first, then every score, each phase n
cases at a time, so a phase's wall time is its slowest case rather than the sum, and a scorer
never runs beside a trial. The budget reserves each running step's estimate; a step that doesn't
fit waits for the running ones, and with no estimate yet steps run one at a time. Default 1. Time
measured under `--jobs` above 1 is not comparable with time measured one at a time. Measured:
[[#Parallel scoring (2026-09-27)]].

**Done since: match first.** Jev settles what the key already answers, text against text, and
two voters with the code label only the rest, each turn bounded. It meets the bar below: comments
86–90%, oracle 100%, κ 0.84–0.87 with the panel, five cases in 5 minutes
([[#Match first (2026-09-27)]]). What the earlier plan became:

- **The second voter's speed** (sonnet set the panel's pace): voters now see half the findings,
  and sonnet is out until opus 5.5 is tried ([`judge-opus-voter`](todo/judge-opus-voter.md)).
- **Short timeouts per turn:** done in match first (`--turn`); none fired.
- **Once per case, not per variant; one finding per follow-up; forking from a caught-up
  session:** not needed at 64 seconds a score. They are the next levers if scoring many variants
  makes it slow again. The fork estimate stays below for then: with the per-finding scorer's
  turns, first turn plus slowest follow-up would take 55 minutes where all of them took 95, 33 of
  those in two stalled turns; E7 (prose only) found a warm headless claude fork costs about a
  resume, a codex fork gets 33% of its input cached against a resume's 96%. Both harnesses can
  fork (`claude -p --resume {id} --fork-session`, `codex exec fork {id}`); awf has no fork, and
  foundation §10 keeps it off the surface until a use needs it.

**How to tell what sticks:** score the experiment's stored trials again with each shape (`score
{variant} --scorer {name}`), and compare them with the data repository's `scripts/judges.ts`: 54
fresh findings, 63 comments, 42 oracle findings, plus the held-out-issue test for `new`. The bar:
accuracy no worse than the panel's (comments 87%, oracle 100%, κ ≥ 0.86 with the panel), and five
cases scored in under ten minutes of wall time.

## Scope

In scope: `outcome: "timed-out"` in `OutputRecord` v4; `packages/lab/src/review`
organised by purpose; `ReviewFinding`, variant and scorer files, and the findings, labels, score,
config and report formats with schemas; the panel and the label check; pure metrics; `awf-lab`
`config`, `plan`, `run` and `report` (to be revised as `list`, `run`, `score`, `report`);
`examples/single-agent-review`; the controls; the first experiment; scorers compared.

Out of scope:

- Growing the key from runs: [`key-growth-from-runs`](todo/key-growth-from-runs.md). The records
  keep what it needs.
- Several trials per case, the paired interval, early stopping and gating a merge:
  [`variant-matrix-runner`](todo/variant-matrix-runner.md).
- Isolating the variant from the answers: `eval-isolation`. Until then a variant could read the
  data repository, so scores are for building the scorer and early reads, not decisions.
- Clean MRs and false-alarm rates.

## Context and evidence

- The first dataset holds 33 cases with 2 to 22 issues each (median 7); keys drafted by
  `gpt-6-sol` and voted by sol, sonnet and luna (story 005).
- Constraint: autoresearch imports contract and the engine's public entry only
  ([ADR 0002](../adr/0002-autoresearch-lives-here.md)); scores are data and live in the data
  repository ([ADR 0003](../adr/0003-autoresearch-tools-here-project-data-there.md)).
- Constraint: models favour their own output, so the panel spans two families and every record
  names the models that made it.
- Evidence: [`eval-orchestration`](../research/eval-orchestration.md) (why no eval framework hosts
  this: none counts awf's spend, the hosted ones keep private data, Inspect is a Python process
  beside Bun; the designs taken: a separate verifier, scored copies, a majority panel, seeded
  subsets), [`eval-cli-config`](../research/eval-cli-config.md) (JSON config with a schema,
  files found by glob), [`review-eval-prior-art`](../research/review-eval-prior-art.md) (a true
  finding the key lacks is `new`, never `wrong`), [`eval-terminology`](../research/eval-terminology.md)
  (the words and command lines of other eval tools).

## Code map

- `packages/contract/src/records.ts`: `outcome: "timed-out"`, `OUTPUT_RECORD_VERSION` 4.
- `packages/engine/src/operator-cli.ts`: `runOutcome(error, deadline)` decides `cancelled`,
  `timed-out` or `failed`.
- `packages/lab/src/review/`, imports pointing down only (enforced by
  `scripts/check-boundaries.ts`):
  - `format/`: the formats and schemas. What scorers import: `scoring.ts` (the first record
    versions and the judgement), `variant.ts`, `lab.ts` (the first config and report, now unused),
    the controls' helpers (`sanity.ts`) and the runtime flag parser. What they don't:
    `records.ts` (trial, score and partial score, `/2`, reading `/1` too), `partial.ts` (its
    first version), `workspace.ts` (the config), `output.ts` (each command's `--json`) and
    `schema-files.ts`.
  - `fixtures/`: reading, checking and restoring a sealed dataset.
  - `build/`: making cases from a forge (story 005).
  - `judge/`: the panel: `judge.workflow.ts`, `panel.ts`, `prompt.ts`, `check.ts`.
  - `metrics/`: pure metrics and κ.
  - `lab/`: `awf-lab`: `cli.ts` (the commands), `workspace.ts`, `load.ts`, `identity.ts`,
    `selection.ts` (`--cases`), `address.ts`, `where.ts` (`--where`, and what `--only` and it
    choose), `plan.ts`, `store.ts` (reads both file names), `runner.ts` (the one seam, over `awf
    run`), `execute.ts`, `report.ts`, `show.ts`, the package's `panel.scorer.ts`, and the
    controls' workflows.
- `examples/single-agent-review/`: one agent, one turn, an optional pinned `--skill`.
- `tests/review-lab.test.ts`: `awf-lab` end to end on a synthetic dataset with fake agents, every
  command, each `--json` checked against the schema `awf-lab schema` prints.
- The data repository: `awf-lab.json`, variant and scorer files, `results/`, and `scripts/` for
  ad hoc tables; `report --scorer a --scorer b` now gives the κ and differences part of
  `scripts/judges.ts`.

## Design decisions

- **`awf run` per workflow, not `runWorkflow` in-process.** The run record stays the only
  interface, and every run gets an operator's runtime, sandboxes and accounting. In-process would
  need a new engine export.
- **A JSON config with a generated schema**, found by walking up like git's; variants and scorers
  found by glob and named by file stem. Rejected: a TypeScript config (it would hold no code), a
  list of every variant (each would edit it), path flags on every call.
- **Placeholders in argv, a typed `read` out.** Rejected: fixed variant flags (every real workflow
  would need a wrapper) and a required result shape (it would change workflows for scoring).
- **A scorer is any workflow returning labels (`ScorerResult`).** Rejected: voter models as config
  fields, which would fix every scorer's shape to the panel's.
- **Identity by a declared semver, results by `{major}.{minor}`.** A patch bump keeps the
  results. Records keep the commit as provenance; the content hash that was kept
  beside the version went on 2026-09-29. Rejected, after the hash was the identity for Tasks 4–7: the hash, since moving the dataset
  folder into a placeholder orphaned two controls' scores while it still missed an engine change, a
  prompt read at run time and a model alias; a list of old hashes a file vouches for, which every
  harmless edit would have to extend; and an unchecked counter, which can't say how big a change
  was.
- **Timed out means the run's own deadline.** A `DeadlineExceededError` carrying the run's
  deadline is `timed-out`; a stage deadline the workflow set and let escape is `failed`;
  cancellation wins over both. Rejected: a `timedOut` flag beside `failed`, a new exit code.
- **Predicates on `score` read `--rest-from`'s records**, the scores kept for the rest, since
  `--scorer` is the one being run; everywhere else they read `--scorer`'s.
- **A stored version is known by its records.** `{name}@{version}` needs no file: it can be reported,
  shown and scored, never run. Rejected: keeping old variant files around to run them.
- **The report is columns over common cases.** A column per variant, or per variant and scorer
  with two scorers, each counted on the cases every column counts; with a baseline, each other
  variant's cases won, lost and tied, by address. Rejected: pairs counted on different case sets,
  which made two numbers of one variant disagree.
- **Addresses print short while there is one trial:** `{case}#{finding}`, and `{case}/1` for the
  trial itself; `--only` takes both forms.
- **`--jobs` is a flag, default 1, and phases stay apart.** Parallel cases were first left to
  `variant-matrix-runner` as unmeasured (E4); scoring's wall time made them needed here, on the
  operator's say-so. Trials and scores never overlap, since scorers beside a large trial timed
  out. Rejected: separate `--trial-jobs` and `--score-jobs` (no evidence for either number yet),
  a config key (no measured default to put in it), recording `jobs` in the records (a format
  change, for a comparison the report doesn't make yet).

## Tasks at a glance

- [x] 0. `packages/lab` organised by purpose, behaviour unchanged
- [x] 1. A run that ran out of time says so in `output.json`
- [x] 2. The formats, the label check and the pure metrics, proved with oracle and nop
- [x] 3. The panel: two families, one call per case, checked, re-asked, a third vote
- [x] 4. `awf-lab` end to end
- [x] 5. Scorers tried against each other, and the default chosen from the results
- [x] 6. Score chosen findings of stored trials, the rest kept from a base score
- [x] 7. The code in these terms and this command line

## Open questions

- Is `new` scored right? Unmeasured; [[#Left]] item 2.
- Does the key read some review comments differently from every scorer? Five cited comments were
  labelled the same way by every scorer and against the key; which side is right is unread.

## Task execution rule

One task at a time: plan, implement, review by two read-only subagents (architecture and
correctness), resolve, verify. Then story-level verification and human review.

## Task details

Tasks 0–6 went through the full rule; the notes say what review found. Commands are given in the
revised command line, which Task 7 built; the flags each task was built with are in
[[#From the first command line]].

### 0. `packages/lab` organised by purpose

- [x] Plan, implement, review, resolve, verify

Done when: `bun run check` and `bun test` pass, the diff is renames plus import lines, the entry
exports the same names.

### 1. A run that ran out of time says so in `output.json`

- [x] Plan, implement, review, resolve, verify

Done when: `tests/operator-cli.test.ts` shows `timed-out` for a body past the run's deadline,
`failed` for a stage deadline the workflow let escape, `cancelled` when a signal won.

### 2. The formats, the label check and the pure metrics

- [x] Plan, implement, review, resolve, verify

Done when: oracle scores 1 and nop 0; a hand-built case with every label gives the defined
numbers; `checkJudgement` rejects each rule's violation; a mismatched `read` or scorer fails
`tsc`; schema files are generated.

### 3. The panel

- [x] Plan, implement, review, resolve, verify

Done when: fake-adapter tests cover agreement, a tiebreak on splits only, a re-ask then a withheld
vote, and both voters failing; a live eval on a synthetic case passes the check, its cost in
[`testing.md`](../testing.md).

### 4. `awf-lab` end to end

- [x] Plan, implement, review, resolve, verify

Done when: on a synthetic dataset, `run` then `report` gives the expected numbers, a second `run`
reuses everything, an edit runs new trials, a scorer change only scores, `score` never runs the
variant, a budget stop exits 3 and resumes, oracle and nop score 1 and 0; a two-variant report
lists cases only one has; the first experiment ran live.

### 5. Scorers tried against each other

- [x] Plan, implement, review, resolve, verify

Done when: the table is in the notes with the default chosen from it, and the κ ≥ 0.7 question
answered.

### 6. Score chosen findings

- [x] Plan, implement, review, resolve, verify

Developing a scorer is mostly about the findings it gets wrong or its voters split on, and
re-scoring whole trials per try costs minutes and dollars. `awf-lab score {variant} --only
{case}#{n},… [--rest-from {scorer}]` scores only those findings of the variant's current trials
(built as `run --only … --base {judge}`):

- **An address** is a finding's index in its trial: `findings.json` is written once, and every
  score labels findings by index. Repeated, `--only` adds up.
- **The scorer gets every finding** and, as `--settled {file}`, the base score's labels for the
  others (the workspace's default scorer's, or `--rest-from`'s): a `duplicate` names an earlier
  finding and an issue is hit once, so a subset alone could claim an issue twice. It labels the
  rest and returns the settled labels verbatim; `awf-lab` checks they came back unchanged. A base
  hit after the first named finding, and a base duplicate of an asked one, are asked again with
  it, since their labels may have to change.
- **A partial score is never counted:** `partial.{scorer-hash}.k{rev}.{n}.json`, format
  `awf.review-partial/1` (`format/partial.ts`): the score record's fields, `picked`, `asked`, and
  `base` (its scorer, `at`, and a digest of its record). The plan and `report` read only
  `judged.*`. The same scorer, base digest and asked findings on the same key reuse it.
- **The command prints** each asked finding's base label and votes beside the new one, then how
  often a named finding sided with the base, with one of its voters, or with neither.
- **A scorer must take `--settled`.** A run that fails before any agent is reported and not kept.
  The package panel doesn't take it yet: teaching it changes the panel's hash, and its stored
  scores are every base; it comes with [`decision-matching`](todo/decision-matching.md). The data
  repository's match first takes it and sends the asked findings to its voters, no Jev.
- **No scorer file or scorer hash changed:** the new code is in files no scorer imports.

Done when: `--only` runs end to end with fake agents, the stored scorers keep their hashes, and a
live run re-scores the panel's split findings.

### 7. The code in these terms and this command line

- [x] Plan, implement, resolve, verify
- [x] Review: in the main session, not by two read-only subagents, to save Claude usage
- [x] The data repository moved, run by the operator; its dataset folder is now `datasets/`

The code catches up with this story: [[#Terms and where things are]] and
[[#The command line, revised]]. In it:

- **The commands:** `list`, `run`, `score`, `report`, `show` and `schema`, with `--dry-run` in place
  of `plan`, and `score` in place of `run --judge-only` and `run --only`.
- **One selection on every command:** `--dataset`, `--cases`, `--only`, `--where` (`failed`,
  `split`, `label=`, `differs=`, `lost`) and `--scorer`, with `--rest-from` and `--baseline`.
- **Addresses** in every report row, `show` heading and JSON `id`, accepted back by `--only`;
  `{name}@{hash}` for stored versions.
- **`--json` on every command,** each output with a format and a schema that `schema` prints;
  `report --md`.
- **Help, errors and report text** in the new terms. An old flag fails with a message naming the
  new one.
- **The workspace config** with new keys (`datasets`, `results`, `scorers`, `scorer`, `baseline`),
  a new schema version, and the old keys refused by name.
- **The data repository** moved once: `datasets/`, `results/`, `{name}.scorer.ts`, `score.*.json`.
  New records carry `scorer`, `trial` and
  `case` fields under new format versions, and the reader takes both.

Not in it:

- the names a scorer imports (`defineReviewJudge`, `Judgement`), renamed after it:
  `defineReviewScorer` and `ScorerResult`. `judge/` stays, since the panel is a judge;
- the sealed case files, never rewritten;
- `--trials` and `{case}/{trial}` beyond one trial, which come with
  [`variant-matrix-runner`](todo/variant-matrix-runner.md);
- `view`.

Done when:

- the synthetic dataset's end-to-end tests pass in the new commands;
- each old flag and config key fails with exit 2, naming its replacement;
- every `--json` output validates against the schema `schema` prints for it;
- `--only` accepts an address copied from `report` and from `show`;
- `--where split` over the stored panel scores selects the 22 split findings;
- after the move, `report` over the data repository gives the same numbers as before, and the
  panel's and match first's hashes are unchanged.

## Verification

- [x] `bun test`
- [x] `bun run check`
- [x] Task 3's eval on the synthetic case
- [x] The first experiment: three variants and the controls on five cases, scored by the panel
- [x] `--jobs`, live: the panel on five cases at once
- [x] Chosen findings, live: the panel's 22 split findings re-scored by match first (sol, terra in
  pi, srt) with the panel's scores as the base: 13 more re-asked as dependent, 35 of 159 in all,
  13 partial scores, none failed, $2.04 at list price, 11 minutes with the three variants in turn.
  The new labels sided with the panel's result on 12 and with its other voter on 10, never with
  neither: the splits are two plausible labels, not noise. It cost about what scoring those 13
  trials whole would: a score's cost is mostly its voters reading the change, key and code, not
  the findings, so `--only` buys labels held fixed around the ones asked more than it saves.
- [x] Task 7 over the stored records, read-only: the same numbers, the same 18 hashes, the 22
  splits ([[#Task 7: the terms and the command line (2026-09-28)]])
- [x] Task 7 over the data repository after its move: every report the same, 16 hashes the same
  and the two controls' moved by `{dataset}`, `list`, `show`, `score --where split` and the
  scripts over the moved records

## Review record

Every task's diff was reviewed by two read-only subagents. Must-fix findings and what became of
them:

- **Task 2:** `unsettled` had no form for a panel split; `excluded` became optional, absent
  meaning the panel split.
- **Task 3:** a withheld vote first let the tiebreak stand in, which made the panel one family
  under the same hash; a withheld vote now fails the score.
- **Task 4:** the first identity hash keyed files by path, so a rename or another checkout would
  have scored everything again; it is contents only, with a rename test.
- **Task 5:** the comparison script averaged per-score κ, merged issue ids across cases, hid
  failed scores and counted unpriced runs as free; all fixed, and the panel's comment accuracy
  went from 89% to 86%. A later review found it also scored an `unsettled` naming the key's
  exclusion 0 as a split (`!label.excluded`); fixed, which put every scorer 1–3 points up on the
  comments, the panel at 87%.
- **`--jobs`:** see [[#Parallel scoring (2026-09-27)]].
- **Task 6:** the package panel rejects `--settled`, so a first run with the default scorer wrote
  a failed partial record per case; a run that fails before any agent is now reported, not kept.
  The base was referred to by its `at`, which needn't be unique; it is now a digest of its record.
  A base hit after a named finding, or a base duplicate of one, made a consistent answer
  impossible; both are asked again. A named case with no trial or base score now exits 2;
  selection moved into the plan so a rule (`split`, `label=new`) can be a `pick`; `--json` is
  refused with `--only` until its output has a format.

Left on purpose: flags a command doesn't use are ignored; a scorer's argv takes no placeholders;
`format/sanity.ts` repeats part of the GitLab note type and the comments workflow repeats the
oracle's case lookup, since tidying either changes their hashes and orphans their scores.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

All costs are list-price estimates from awf's price table, not bills: the runs used subscription
logins.

### Before the tasks (2026-09-26)

- **Which deadline ended a run:** against the fake adapter, a `DeadlineExceededError` carries its
  deadline, and it equals the run's exactly when the run's own time ran out. No new error type
  was needed.
- **Scorer pilot**, three cases, sol and sonnet: both scored the oracle 25/25 and agreed on key
  comments (κ 0.97), but not on a fresh haiku review (κ 0.21, 0.57 once told to read the code),
  mostly `wrong` against `noise`. Sonnet read no code in 12 of 13 calls unless told to. The label
  rules and the requirement to cite code came from this.

### The first experiment (2026-09-27)

Five cases of the first dataset in the seeded order, F1 to F5, one trial each, scored by the
panel. The catalogue ran on codex, the single agents on claude with the skill pinned to a commit.

| | catalogue-review | one-agent-bare | one-agent-skill |
| --- | --- | --- | --- |
| must-fix | 3/5 | 2/5 | 1/5 |
| should-fix | 5/9 | 0/9 | 0/9 |
| could-fix | 2/10 | 2/10 | 1/10 |
| weighted recall | 0.49 | 0.19 | 0.09 |
| precision | 0.93 | 1.00 | 1.00 |
| wrong, noise | 0 and 2 of 27 | 0 and 0 of 7 | 0 and 0 of 5 |
| trial time, list price | 1h 18m, $13.38 | 36m, $5.79 | 21m, $4.92 |
| scorer time, list price | 24m, $4.51 | 10m, $2.15 | 5m, $1.74 |
| voters' κ, mean per case | 0.76 | 0.75 | 1.00 |

- **Process:** unattended; the catalogue's timeout on F2 and three scoring timeouts became
  records; the next `run` scored only those three; a second `run` ran nothing; scoring alone
  (then `run --judge-only`, now `score`) never ran a variant.
- **Controls:** oracle 1.00 on 42 of 42 issues, nop 0.00.
- **Signal:** the catalogue won every case it finished; each single agent's one win is F2, where
  the catalogue's trial failed. The skill agent scored below the bare one: 5 findings against 7,
  fewer words. Five cases can't rank that.
- **Scorer:** the panel's voters agreed at κ 0.76 pooled over 54 fresh findings; the catalogue's
  long reviews were lowest, 0.62–0.74 per case.
- **Time:** trials 2h 15m, the panel 1–10 minutes per case, restoring a snapshot 2–3 s.

### Task 5: the scorers against each other (2026-09-27)

Each candidate scored the stored trials with `score --scorer {name}`, no variant running: 63
cited review comments, 42 oracle findings, and the 54 fresh findings.

| Scorer | Comments right | Oracle right | κ with the panel | κ between voters | Failed | List price per score | Time per score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| panel (sol, sonnet; luna tiebreak) | 87% | 100% | — | 0.76 | 2 of 24 | $0.81 | 308s |
| panel, scored again | — | — | 0.89 | 0.80 | 1 of 13 | $0.60 | 298s |
| cheap panel (luna, haiku) | — | — | — | — | 14 of 14 | $0.26 | 169s |
| one agent, one finding per turn (sol) | 87% | 100% | 0.87 | — | 1 of 20 | $0.39 | 442s |
| Jev first, then one agent (sol) | 89% | 100% | 0.86 | — | 0 of 22 | $0.10 | 109s |

κ pools findings across cases with hits named by case and issue. Time and price count failed
scores too.

- The three smart scorers can't be told apart on accuracy: each agrees with the panel about as
  well as the panel agrees with itself (0.89). On the comments they mostly miss the same ones.
- Jev first is eight times cheaper and three times faster, but its agent is one family (codex,
  the catalogue's), Jev can give a hit to a later finding when an earlier one describes the same
  issue less surely, and its self-agreement is unmeasured.
- Per-finding was stopped before the bare agent's last three cases: 16–37 minutes each.
- **Decided:** the panel stays the default, arguments unchanged; nothing new moves into the
  package. κ ≥ 0.7 holds on these findings and stays a target, not a gate; long reviews come out
  lowest.

### Parallel scoring (2026-09-27)

The panel scored the catalogue's stored trials on all five cases at once (`score
catalogue-review --jobs 5`, a fresh scorer file so nothing was reused). F2 had nothing to score.

| Case | Findings | One at a time (first experiment) | All at once |
| --- | --- | --- | --- |
| F5 | 1 | 41s | 43s |
| F3 | 9 | 5m 43s | 3m |
| F1 | 8 | 7m 10s | 8m |
| F4 | 20 | 10m 3s | 15m |
| **Wall time** | | **24m** | **14m 49s** |

List price $4.38 against $4.51. Parallel cases cut the wall time by 40%, not by five: the phase
lasts as long as its slowest score, and the 20-finding case ran 50% slower beside the others.

Where a panel score's time goes, from each voter's time in the 46 panel scores' run records:

- **Sonnet sets the pace.** The panel waits for both voters, and on every score over two findings
  but one, sonnet finished last. It took up to 14 minutes and read up to 3.3M tokens, mostly
  cached re-reads of the code; sol took up to about 5 minutes and read up to 0.5M on the same
  findings. The tiebreak takes 20 to 50 seconds.
- **All four panel timeouts were sonnet** running to the 20-minute limit; in two of them its
  record shows no tokens read at all.
- On F4 above, sonnet took 13m 54s and sol 2m 12s.

So the next cut was the second voter, not more parallelism: [[#Match first (2026-09-27)]].

### Match first (2026-09-27)

The key already answers most findings, so a scorer should match before it reads code. Jev, a
decision model that picks among given options with a probability for each, matches every finding
text against text to the key's issues, its refuted claims, its unsettled claims, noise, and the
earlier findings. A sure match, p 0.9 or above, is settled; a hit goes to the earliest finding that
surely gives the issue, and a later one is its duplicate. Voters with the code and the key label
the rest, told which issues are already hit.

In the data repository, built to move into the package when adopted:

- `judges/matching.ts`: the questions and `settleMatches`, pure, with unit tests.
- `judges/voting.ts`: `voteOnRest`, one voter or two with a tiebreak on the splits, as the panel
  does, each turn bounded and a timed-out one asked again in a fresh session; each agent in a
  private sandbox when named. The package panel is this with nothing settled.
- `judges/match.workflow.ts`: composes them; `--sure`, `--rest`, `--tiebreak`, `--sandbox`,
  `--turn`. The scorer files are argv over it.
- `scripts/match.ts` re-settles Jev's stored answers (each run's `decisions/` keeps every option's
  probability) at any cut with the same `settleMatches`, so a cut is tried without asking Jev
  again; `scripts/judges.ts` compares whole scorers; both read records through `scripts/lib.ts`.

What Jev settles, and how often it is right, against the key's labels (comments, oracle) and the
panel's (fresh findings), over three runs:

| Control or variant | Findings | Settled by Jev at 0.9 | Right of settled |
| --- | --- | --- | --- |
| comments | 63 | 30–33 (48–52%) | 97% |
| oracle | 42 | 42 | 100% |
| fresh | 54 | 22–23 (42%) | 96–100% |

- Fresh findings' ceiling is 34: the panel calls 20 of the 54 `new`, which needs the code. Jev
  settles two thirds of the rest.
- Two runs picked the same top answer for 157 and 158 of 159 findings; those that settled in one
  run and not the other were within 0.03 of the cut.
- The cut: 0.95 settles fewer, all right; 0.85 and below lose accuracy on fresh findings (92%,
  then 87%).
- The one wrong settled match gives K9's symptom with a false cause. A second question per hit,
  whether the finding gives the cause and not only the symptom, caught none and dropped 3 of the
  oracle's 42 hits; it was removed.
- Round one let the earlier-finding question override a weaker known match and called GitLab
  system notes duplicates; round two asks it only of findings that match nothing known, which took
  fresh accuracy from 92% to 96–100%.

Who labels the rest, against the other scorers (`scripts/judges.ts`), one case at a time. The
middle three ran before the review fixes below, the last on the code as it stands:

| Scorer | Comments right | Oracle right | κ with the panel | κ between its voters | Failed | List price | Time per score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| panel | 87% | 100% | — | 0.76 | 2 of 24 | $0.81 | 308s |
| Jev first (Task 5) | 89% | 100% | 0.86 | — | 0 of 22 | $0.10 | 109s |
| match, sol | 83–87% | 100% | 0.82–0.87 | — | 0 of 22 | $0.09 | 44–49s |
| match, sol and terra in codex, luna tiebreak | 87% | 100% | 0.82 | 0.92 | 0 of 22 | $0.19 | 68s |
| match, sol in codex and terra in pi, in srt | 90% | 100% | 0.87 | 0.92 | 0 of 22 | $0.15 | 64s |
| **the same, after the fixes** | 86% | 100% | 0.84 | 0.87 | 0 of 22 | $0.15 | 60s |

- Two runs of one scorer differ by up to 4 points on the comments and 0.05 κ, so the scorers
  above can't be ranked on accuracy: every one is within that of the panel's 87%, and the panel
  agrees with itself at κ 0.89. What separates them is time and list price.
- Every agent of the last scorer ran in its own srt sandbox: the checkout read-only, no other
  path, the network only to its model. It is the first scorer run sandboxed; nothing failed.
- The second voter is OpenAI's too, not a second family: claude opus 5.5 waits on Claude usage
  ([`judge-opus-voter`](todo/judge-opus-voter.md)).
- **Wall time:** the last scorer on the catalogue's five cases at once (`--jobs 5`) took
  **5m 04s**, against the panel's 14m 49s, at $1.01 list price. Five cases in under ten minutes
  was the bar.
- Jev's part costs about $0.00003 a finding as OpenRouter charged it, and a second a score.
- Of sol's misses on the comments, most are merge-request replies ("Fixed in {sha}", "Mergeable
  at {sha}") scored against the frozen head as `wrong` where the key accepts `duplicate`, `hit` or
  `noise`; reviewers don't write those.

**Timeouts.** The first experiment's five scoring timeouts had three causes, each now handled:

| Cause | Handled by |
| --- | --- |
| Scorers beside a large trial or another scorer (4 of 5) | `--jobs` runs every trial first, then every score |
| A voter that stops making progress, sonnet in all four panel timeouts, two with no tokens read | `--turn`: each turn bounded (6 minutes; the slowest agent in 96 took 3.6), a timed-out turn asked again once in a fresh session. None fired. The package panel has no per-turn bound yet |
| A run ending minutes after its deadline | todo [`deadline-overrun`](todo/deadline-overrun.md) |

The zero-token sonnet timeouts may be the environment: an unsandboxed agent inherits all of
`awf`'s, and run from Claude Code that includes `CLAUDE_*`, which the findings say turns off
transcript saving ([`inherited-agent-env`](todo/inherited-agent-env.md)). Effort was never chosen:
claude took `CLAUDE_EFFORT=medium` from the launching session, codex and pi their config files'
medium, none of it in a scorer's hash ([`runtime-effort`](todo/runtime-effort.md)).

**Does the scorer recognise a real problem the key doesn't have?** `scripts/held-out.ts` takes
out of a copy of the key every issue the panel found a fresh review hit, and scores the same
findings against it: a finding of a held-out issue is real and now unknown, so `new` is right, or
a duplicate of another finding of the same issue. Eight scores, 17 such findings, twice:

| Run | Recognised as real | Missed |
| --- | --- | --- |
| before the fixes | 15 of 17 (88%) | a hit on a neighbouring issue; `wrong` |
| after | 13 of 17 (76%) | the same two; a split, sol `new` against terra `wrong`; a duplicate of a finding of another held-out issue |

The neighbouring hit is Jev's: with the finding's own issue gone, it matched the next nearest at
p 0.97. Jev picks among what it is offered, so a new problem that resembles a known one can be
settled as a hit on it; nothing but a voter with the code catches that. The two runs differ by as
much as the misses, so this is a floor to watch, not a rate.

**Reviewed.** A read-only review of the scorer found three bugs that moved numbers, now fixed:

- A sure hit on a later finding took the issue from an earlier one Jev was unsure of, so a voter
  could only call that earlier finding `new` or `wrong`. Such an issue is now contested: its
  findings all go to the voters, unclaimed (`settleMatches`, with a test).
- The scripts scored an `unsettled` naming exclusion 0 as a split, for every scorer; see Task 5.
- A single voter that gave no answer passed as a score of `unsettled`s; it now fails the score,
  as two voters do.

And, from the same review: at most three turns an agent (a check failure handed back once, a
missing answer asked once, a timed-out turn given one more in a fresh session); one or two voters
and a tiebreak only with two; a repeated flag rejected; the voters' `missed` kept; and
`scripts/match.ts` takes stored answers from any run that asked exactly the current questions, so
a rule edit keeps its evidence. Left for the move into the package: the workflow files import the
package by a path into this worktree, so a package edit or the worktree's removal re-hashes every
match scorer, and `voting.ts` still duplicates the panel's case reading and answer schema.

Open: making match first the package's scorer ([`decision-matching`](todo/decision-matching.md));
re-scoring chosen findings by rule, such as the voters' splits (`--where split`, built in Task 7);
and whether `noise` and a
repeat of a refuted claim, which Jev settles surely, should need no code read.

### Task 7: the terms and the command line (2026-09-28)

Built as [[#The command line, revised]] says. The data repository's dataset folder moved from
`fixtures/` to `datasets/` last, and that move changed two hashes.

- **The controls moved once.** The oracle and comments variants passed
  `new URL("../fixtures/{dataset}", import.meta.url).pathname` as argv, and argv was in the identity
  hash, so the dataset's absolute path was too. They now pass `{dataset}`, which `awf-lab` fills
  with the dataset's folder. That changed their hashes and, while the hash was the identity,
  orphaned the scores every scorer had given them: the report of them came back empty. That is
  what versions settled, below.
- **No other hash moved.** The other 16 identity hashes in the data repository, the panel's
  included, are the same before and after. New code went into files no scorer or control imports; the package's
  panel file was renamed to `panel.scorer.ts`, and paths are in no hash. Dead code is left in
  covered files: `format/lab.ts`'s first config and report schemas, and `format/validate.ts`'s
  checks of them. They go with decision-matching, which re-hashes the panel anyway.
- **The same numbers.** Over the stored records, read as `judged.*.json` in their first formats,
  the new `report` gives the old report's numbers for all six inputs under the panel, and for
  catalogue-review and comments under four more scorers: cases, every label count, recall, κ,
  time and list price.
- **`--where split` selects the 22 split findings** over the stored panel scores (catalogue-review
  10, one-agent-bare 1, comments 11). `score … --scorer match-sol-pi --where split --dry-run` plans
  them as the nine partial scores already stored, reused by the digest of their rest-from records
  as stored, not as upgraded.
- **Tests:** the synthetic dataset's end-to-end tests run every command in the new terms. Each old
  flag, command and config key fails with exit 2 and names its replacement. Every `--json` output
  validates against the schema `awf-lab schema` prints for its format. Addresses copied from
  `report` and from `show` go back into `--only`. Records rewritten to the first formats and file
  names report the same.
- **The data repository's move was refused to the agent** as destructive: `scores/` to
  `results/`, `judges/*.judge.ts` to `scorers/*.scorer.ts`, `judged.*` to `score.*`, and the
  config's new keys. The operator ran it, and its `scripts/` run on the moved records. Two draft
  datasets went to the repository's git history, and the dataset folder became `datasets/`.
- **Found running every command on the real records:** a report listed one "not counted" line per
  case and column, 84 for three variants with 28 cases untried; it now gives one line per reason.
  Errors printed the whole usage; they print one line and point to `--help`.
- **Found on the real records:** `show` first showed "no score" for match first, which has only
  partial scores; it now falls back to a scorer's latest partial score, labelling the findings it
  asked.
- **Versions replaced the hash as identity** ([[#How it works]]). Each file declares a semver, and
  results live under `{name}@{major}.{minor}`. The data repository's records moved once, by a
  script that renames and never rewrites: each name's stored hashes became `1.0.0`, `2.0.0`, … in
  the order they first appeared, since nothing said how big each change was. Each file declares
  the version of the records it matched. comments and oracle declare `1.0.1` and `2.0.1`, a patch
  on the versions every scorer scored, so the move to `{dataset}` keeps their results. Scorers
  whose current file had no scores get the next major: match 5.0.0, match-again 4.0.0, match-sol
  3.0.0, match-sol-terra 2.0.0, match-sol-pi-jobs 2.0.0. A record from before versions takes its
  version from its folder or file name. Over the moved records every report gives the numbers it
  gave by hash, the controls' included, and `scripts/judges.ts` and `scripts/match.ts` print the
  same; the scripts' pin of the controls' old hashes is gone. A file loaded again in one process
  is loaded afresh, since Bun caches a module by path and would keep the old version.
- **Review, before merging** (in the main session, not by subagents), found and fixed:
  - A file given by path under a name the workspace knows for another file would have mixed its
    results with that file's, since versions key results by name; it is now refused.
  - A run's cost still said "spent"; it is a list-price estimate, and `lab-run`'s `outcome.spent`
    is `listPrice`.
  - `awf-lab` and the `awf` it spawns now run with `--no-env-file`, as `awf` does since `main`
    learned that a `.env` can change how every agent logs in.
  - `run` and `score` loaded the baseline even with no `--where lost` to read it.
  - The variant format didn't document `{dataset}` or the scorer's `--settled`.

- **The content hash is gone** (2026-09-29, the operator's decision): a variant or scorer is its
  declared version and nothing else. Records no longer write `hash`, and still read one in those
  written before. `list`, `report`, `show` and `--json` drop it and the "several hashes" note. The
  commit stays, as provenance.

- **`dirty` is gone too** (2026-09-29, the operator's decision): with the version as the identity,
  whether a file differed from its commit decided nothing. Records no longer write it and still
  read it in those written before; `list`, `run --json`, `report` and its "uncommitted" note drop
  it, and provenance no longer walks the import graph.

- **A variant or scorer names its workflow twice, and the two are checked** (2026-09-29, from a
  review of the author surface). It gave a URL and, optionally, the workflow's type as a type
  argument. Nothing tied them, and a file without the argument checked `read` against
  `JsonValue`, or a scorer against nothing. Now it imports the workflow and passes it as
  `workflow`, the type inferred from the value, beside `file`, the URL `awf run` loads.
  `awf-lab` imports `file` and refuses the variant unless its default export is that same object,
  so the two can't drift. A name in place of the file would need a catalogue, which section 9 of
  the foundation leaves unbuilt. The lab's own workflows are `{ workflow, file }` pairs to spread
  in: `{ ...ORACLE_WORKFLOW, argv, timeout }`. The same change renamed `defineReviewJudge` to
  `defineReviewScorer` and `Judgement` to `ScorerResult`. The format string
  `awf.review-judgement/1` and the record's `judgement` field stay as stored. Versions, not files,
  are identity, so no stored result moved.

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.

2026-09-27, requested in review: scoring must take minutes, not hours ([[#Scoring speed]]); a
section on how it works; less bloat. Done: this rewrite and `--jobs`. Open: the scorer shapes in
[[#Scoring speed]].

2026-09-28, requested: a scorer that matches first and reads code only for the rest; sonnet out
for now, opus 5.5 a todo; a second voter in pi in srt; per-turn timeouts; the scorer's design
reviewed so it can be built on; todos recorded. Done: [[#Match first (2026-09-27)]].

2026-09-28, requested: terms taken from other eval tools, a section on where things are, a todo
for public docs, and a command line that is simple for evaluating, developing and viewing, for
agents and a viewer alike. Done in the docs: [[#Terms and where things are]],
[[#The command line, revised]], [`lab-public-docs`](todo/lab-public-docs.md), and the story in those
terms and commands. The code followed in Task 7 ([[#Task 7: the terms and the command line (2026-09-28)]]).
