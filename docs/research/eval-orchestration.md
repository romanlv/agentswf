# How eval frameworks run a system, then judge it

Checked 2026-09-26 for [story 008](../stories/008-review-scorer.md) and
[`variant-matrix-runner`](../stories/011-compare-variants.md). We read the docs and the source
of Inspect AI, Braintrust (SDK and autoevals), LangSmith, promptfoo, OpenAI Evals, Harbor and the
SWE-bench harness, as of their main branches on that date, plus a few pages of Weave and
lm-evaluation-harness. Benchmarks and their judges are in
[`review-eval-prior-art`](review-eval-prior-art.md); statistics and the loop are in
[`autoresearch-practices`](autoresearch-practices.md). This page is about orchestration and records.

The short version: everyone separates stored output from scoring, even when both run in one
process, because re-scoring without re-running is the feature people use most. Harbor is closest to
story 008. Its verifier runs in its own environment on recorded artifacts, a trial can be regraded
without its agent, and a job can be diffed against an earlier one into reuse, regrade or rerun. Nobody
identifies a variant by a content hash of everything it runs. Nobody ships a paired comparison with
an interval either: Braintrust counts per-case improvements and regressions, and Inspect gives
clustered errors per run. Judges that read the code exist (Harbor, promptfoo, Inspect), but they
read it only when configured to, which matches our pilot. So story 008's two-process design stands.
The runner has to build identity, pairing and the reuse decision itself.

## 1. Run and judge: one process or two, and re-scoring

- **Inspect AI.** One process by default: the solver runs a sample, then the scorer scores it. The
  split is in the log, not the process. `--no-score` writes a log with no scores, and `inspect score
  {log}` scores it later, with the task's scorer or another one (`--scorer`). It appends new scores
  beside the old ones or overwrites them (`--action`), and by default writes a new `-scored` file
  ([scoring workflow](https://inspect.aisi.org.uk/scoring-workflow.html),
  [`_eval/score.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/_eval/score.py)).
  A hand edit goes through `edit_score` with an author and reason, and keeps the old value in a
  history ([eval logs](https://inspect.aisi.org.uk/eval-logs.html)). Re-scoring rebuilds the task
  state from the log. We found no sandbox start in `score.py`, so a scorer that reads the container
  probably cannot re-score (inferred, not tested).
- **Harbor.** A trial is agent phase, then verifier phase. By default the verifier runs in the
  agent's container, and `tests/` is uploaded "at the start of the verifier phase". With
  `environment_mode = "separate"` it runs in a fresh environment, and only declared artifacts are
  copied in ([separate verifier](https://harborframework.com/docs/core-concepts/tasks/separate-verifier)).
  `harbor trial regrade` and `harbor job regrade` copy a finished trial's recorded outputs into a
  new trial and run the new verifier: "No agent environment is started … and incurs no new agent
  cost" ([regrade](https://harborframework.com/docs/core-concepts/jobs/regrade)). The source trial is
  never modified, and a trial can be regraded only if its artifact manifest holds every input the
  new verifier declares
  ([`trial/regrade.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/trial/regrade.py)).
- **SWE-bench.** Always two steps. Inference writes a predictions file (`instance_id`,
  `model_name_or_path`, `model_patch`). `run_evaluation` then applies each patch in a fresh
  container and writes `logs/run_evaluation/{run_id}/{model}/{instance}/report.json`. A second run
  with the same `run_id` skips instances whose report exists, and `rewrite_reports` re-grades from
  the stored test output
  ([`harness/run_evaluation.py`](https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/run_evaluation.py)).
- **LangSmith.** `evaluate(target, data, evaluators)` runs target and evaluators in one call.
  `evaluate_existing(experiment, evaluators)` scores an experiment's stored runs again, and
  `evaluate_comparative` judges two stored experiments against each other
  ([`evaluation/_runner.py`](https://github.com/langchain-ai/langsmith-sdk/blob/main/python/langsmith/evaluation/_runner.py)).
- **Braintrust.** `Eval(name, { data, task, scores })` runs task and scorers in one process, each as a
  span under one trace per case
  ([`js/src/framework.ts`](https://github.com/braintrustdata/braintrust-sdk/blob/main/js/src/framework.ts)).
  Re-scoring is in the UI: select rows and apply scorers
  ([interpret results](https://www.braintrust.dev/docs/evaluate/interpret-results)).
- **promptfoo.** One process. There are two ways to re-score. You can pass stored outputs
  (`--model-outputs` with `--assertions`), or use the `echo` provider on outputs from production
  ([command line](https://www.promptfoo.dev/docs/usage/command-line/),
  [echo](https://www.promptfoo.dev/docs/providers/echo/)). Otherwise you rerun, and the response
  cache serves the provider calls again.
- **OpenAI Evals.** One process. A `Recorder` writes every sampling and match event to
  `/tmp/evallogs/{run_id}_{completion_fn}_{eval}.jsonl`
  ([`evals/record.py`](https://github.com/openai/evals/blob/main/evals/record.py),
  [`cli/oaieval.py`](https://github.com/openai/evals/blob/main/evals/cli/oaieval.py)). A model-graded
  eval asks the grader inside the same run
  ([eval templates](https://github.com/openai/evals/blob/main/docs/eval-templates.md)). There is no
  re-score command. The README now points to the hosted dashboard.
- **lm-evaluation-harness.** `--predict_only` saves predictions and skips metrics, and
  `--log_samples` keeps every input and output for later analysis
  ([interface](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/interface.md)).

The pattern: in-process is the fast default, and the stored output is what re-scoring reads. Only
Harbor (separate verifier) and SWE-bench also split the environment.

## 2. Identity: what names an experiment, and reuse

- **Inspect** keys a task in an eval set as `{task_file}@{task_name}#{args_hash}/{model}/{additional_hash}`.
  The extra hash covers the solver plan, generate config, model args and roles, the task's
  `version`, and limits. It leaves out options that don't change output, like `max_retries`. The
  scheme has its own version (`TASK_IDENTIFIER_VERSION = 3`), so stored ids can be recomputed
  ([`_eval/evalset.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/_eval/evalset.py)).
  It hashes names and arguments, not code: editing a prompt inside a solver changes nothing unless
  the author bumps `version`. The log also records the git origin, commit and a `dirty` flag, plus
  package versions (`EvalRevision` in
  [`log/_log.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/log/_log.py)).
  Re-running an eval set skips tasks whose identity already has a finished log
  ([eval sets](https://inspect.aisi.org.uk/eval-sets.html)).
- **Harbor** writes a lock per trial. It holds the task's `sha256` digest and semantic version, a
  digest for each extra instruction, prompt template and skill, the agent config, environment and
  verifier
  ([`models/job/lock.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/models/job/lock.py)).
  `harbor run --diff {old-job}` compares a planned job with an earlier one and labels each trial
  ([`job_diff.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/job_diff.py)):
  - every input other than the task must be equal, or the trial is `rerun`;
  - same task version: `reuse`; patch bump: `reuse`; minor bump: `regrade`; major bump: `rerun`;
  - the same version with a different digest is an error, not a guess;
  - a failed or incomplete source trial is always `rerun`, since "a verifier failure is not
    evidence that its agent artifacts are sufficient";
  - a `regrade` falls back to `rerun` when the new verifier's inputs were not recorded.
- **Weave** versions a model "when you change the parameters or the code"
  ([models](https://docs.wandb.ai/weave/guides/core-types/models)). It is the only one we found that
  versions on code.
- **Braintrust, LangSmith, promptfoo, OpenAI Evals, SWE-bench** use a name or a random id: an
  experiment name, a prefix plus a suffix, `eval-{random}-{timestamp}`
  ([`models/eval.ts`](https://github.com/promptfoo/promptfoo/blob/main/src/models/eval.ts)), a
  timestamp `run_id`, or a free `model_name_or_path`. Braintrust and LangSmith attach git metadata,
  and LangSmith also attaches the dataset version (`_runner.py`). Braintrust can append to an
  existing experiment (`update: true`).

## 3. Repeats and comparison

- **Repeats.** Inspect has `epochs` with reducers (`mean`, `mode`, `majority`, `pass_at_k`,
  `at_least_k`, `collect`). Metrics normally see one reduced score per sample, and some metrics can
  ask for the raw epochs ([metrics](https://inspect.aisi.org.uk/metrics.html#reducing-epochs)).
  Braintrust has `trialCount` and a `trialIndex` per case. promptfoo has `--repeat`, and LangSmith
  has `num_repetitions`. Harbor has `n_attempts` per job, and its metrics are `mean`, `min`, `max`,
  `sum` or a script
  ([`metrics/`](https://github.com/laude-institute/harbor/tree/main/src/harbor/metrics)).
- **Spread.** Only Inspect reports it out of the box. It has `stderr(cluster=…)` for clustered
  standard errors, and `ci()` or `ci_wilson()` with a t, bootstrap or Wilson interval. Its docs
  suggest checking "whether two models' accuracy intervals overlap"
  ([metrics](https://inspect.aisi.org.uk/metrics.html)). That compares two separate intervals. It is
  not a paired test.
- **Comparing two experiments.** Braintrust matches cases by `input`, or by a custom comparison
  key, and reports per score a `diff`, `improvements` and `regressions` against a base experiment
  ([compare experiments](https://www.braintrust.dev/docs/evaluate/compare-experiments);
  `ScoreSummary` in
  [`logger.ts`](https://github.com/braintrustdata/braintrust-sdk/blob/main/js/src/logger.ts)). Trials
  of one input collapse into one group. It reports no interval or significance. LangSmith compares
  two experiments by asking a judge which output is better, with `randomize_order` against position
  bias. OpenAI Evals' `battle` template does the same. None of the frameworks ships a paired test
  over per-case differences.

## 4. LLM judges

- **Several judges.** Inspect's model graders take a list of models and decide by `majority`. A
  judge whose answer can't be parsed "withholds its vote", so a thin panel yields an unscored
  sample, not a grade picked by list order. Each vote is kept under `panel` in the score metadata
  ([model graded](https://inspect.aisi.org.uk/model-graded.html#multiple-models)). The `collect`
  reducer keeps every judge's value, so `krippendorff_alpha()` can measure agreement
  ([metrics](https://inspect.aisi.org.uk/metrics.html#multi-judge-reliability)).
- **Judge failure is its own outcome.** In Inspect, a scorer returns a score, raises an error, or
  returns `Score.unscored()`, which is left out of the metric and counted apart. Its reason field
  says whose output failed: `invalid_response_format` is the model under test,
  `grader_failed` is the judge ([scoring policy](https://inspect.aisi.org.uk/scoring-policy.html)).
  Its built-in graders don't re-ask. promptfoo keeps "judge transport or parse failures" as
  failures, so "a broken judge cannot silently turn into a passing" result
  ([model graded](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/)).
- **Cheap first.** Inspect's `cascade` scorer runs scorers in order and stops at the first that
  settles the sample, so the grader model only sees what exact match couldn't settle
  ([`scorer/_cascade.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/scorer/_cascade.py)).
- **Versioning the judge.** Nobody versions a judge as a first-class object. In Inspect the grader
  is a model role (`grader`) recorded in the log, and its scorer name keys the score
  ([models](https://inspect.aisi.org.uk/models.html)). Harbor versions it with the task: a changed
  verifier is a minor bump, which means regrade. SWE-PRBench stores a prompt version by hand (see
  prior art). Inspect's docs say a grader left at provider defaults "can change from run to run".
  They advise temperature 0, a seed, and epochs to measure the variance
  ([reproducible grading](https://inspect.aisi.org.uk/model-graded.html#reproducible-grading)).
- **Checking a judge against people.** LangSmith has an alignment workflow: people label examples,
  the judge prompt is run on them, and "the alignment score is the percentage of examples where the
  evaluator's judgment matches" ([improve judge](https://docs.langchain.com/langsmith/improve-judge-evaluator-feedback)).
  Braintrust evaluates its own autoevals scorers as ordinary evals over labelled datasets
  ([`autoevals/evals`](https://github.com/braintrustdata/autoevals/tree/main/evals)).
- **Caching.** Inspect caches model calls, keyed by model, messages, epoch, generate config and
  tools. It warns that an alias like `gpt-4-turbo` can move under the cache
  ([caching](https://inspect.aisi.org.uk/caching.html)). promptfoo caches every provider call by
  provider, request digest and config, grader calls included, with "a separate cache namespace"
  per repeat index so repeats stay distinct
  ([caching](https://www.promptfoo.dev/docs/configuration/caching/)). LangSmith caches API calls to
  disk under `LANGSMITH_TEST_CACHE`. autoevals' `run_cached_request` only retries on rate limits;
  it caches nothing
  ([`py/autoevals/oai.py`](https://github.com/braintrustdata/autoevals/blob/main/py/autoevals/oai.py)).
- **Does the judge see the environment?** Three frameworks let it, and each makes it an explicit
  setting:
  - Inspect: a scorer may call `sandbox().read_file()` or `exec()` on the sample's container
    ([multiple scorers](https://inspect.aisi.org.uk/multiple-scorers.html#sandbox-access)).
  - Harbor's Rewardkit: an LLM judge gets only the `files` listed. An agent judge (`claude-code`,
    `codex`) "can explore the filesystem and run commands". `isolated = true` mounts the workspace
    read-only through overlayfs. `mode = "batched"`, the default, grades all criteria in one call
    ([judge criteria](https://harborframework.com/docs/core-concepts/rewardkit/judge-criteria)).
  - promptfoo: `agent-rubric` is `llm-rubric` with a coding agent. By default it runs in "an
    isolated temporary working directory with read-only sandboxing". It "does not expose your
    project files" until `working_dir` is set, and text-only providers are refused
    ([agent rubric](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/agent-rubric/)).

  Everything else judges text only.

## 5. Cost and time of the task against the judge

- **Braintrust** tags every scorer span `purpose: "scorer"` (`framework.ts`), and autoevals tags its
  judge calls the same way (`set_span_purpose` in `oai.py`). Search snippets of Braintrust's docs say
  task metrics are averaged over spans not marked as scorers. We could not find that sentence on the
  live page (unverified).
- **Inspect** keeps `model_usage` and `role_usage` per sample and per eval, so a `grader` role's
  tokens show up apart from the model under test's (`log/_log.py`).
- **promptfoo** keeps a separate `assertions` block inside token usage
  ([`util/tokenUsageUtils.ts`](https://github.com/promptfoo/promptfoo/blob/main/src/util/tokenUsageUtils.ts)).
- **LangSmith** traces evaluator calls into a separate `evaluators` project (`_runner.py`).
- **Harbor** records the agent's tokens and `cost_usd`, plus timing for each phase: environment
  setup, agent setup, agent execution, verifier. `VerifierResult` holds only `rewards`, so what a
  judge spent is not in the trial result
  ([`models/trial/result.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/models/trial/result.py),
  [`models/verifier/result.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/models/verifier/result.py)).

## 6. Keeping the answer away from the system under test

- **Harbor.** `tests/` enters the environment only when the verifier phase starts. In separate
  mode the verifier gets a fresh copy of the environment, and "the agent's filesystem changes are
  not inherited" except declared artifacts. A dedicated verifier image can bake the tests in, so they
  never touch the agent's image
  ([separate verifier](https://harborframework.com/docs/core-concepts/tasks/separate-verifier)).
- **SWE-bench.** The evaluation container is new for each instance. The model's patch is copied
  in, then `eval.sh` applies the test patch. Binary test assets are fetched at that point and are
  not baked into the image, because "test data in the image would be visible to anything with a
  shell in it" (`run_evaluation.py`). Environment failures are sorted after the fact by log
  signatures. The sort is "advisory", and "the scoring denominator is unchanged"
  ([`harness/infra_failure.py`](https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/infra_failure.py)).
- **Inspect.** The `target` goes to the scorer and never into the sandbox. The isolation is only
  that the author doesn't copy it there.
- **Rewardkit, promptfoo.** Agent judges are read-only by default or on request, which protects the
  evidence from the judge rather than the answer from the agent.

## 7. Early stopping and subsets

- **Inspect** has an `EarlyStopping` protocol. It is asked before each sample and epoch
  (`schedule_sample`), told each result, and its summary goes into the log
  ([early stopping](https://inspect.aisi.org.uk/early-stopping.html)). UK AISI's
  [optstop](https://github.com/UKGovernmentBEIS/optstop) implements it. It stops extra epochs once
  an estimate's credible interval is narrow and stable. It works within one model and task, not
  between two.
- **promptfoo** picks subsets: `--filter-sample {n}` with `--filter-sample-seed` for the same subset
  every time, `--filter-first-n`, `--filter-failing {eval}`, `--retry-errors` and `--resume`
  ([command line](https://www.promptfoo.dev/docs/usage/command-line/)).
- **Cascades.** Inspect's `cascade` (section 4) stops early within one sample.
- We found no framework with a sequential test that stops a two-variant comparison once the
  difference is settled.

## Build or borrow?

Could awf hand the machinery to a framework (the variants × fixtures matrix, the output store,
judge orchestration, repeats, comparison and a viewer) and keep only what is its own? We checked
each serious candidate's integration point in its source.

What any host framework would have to carry, whichever we pick:

- A sample takes minutes and dollars, and runs in awf's own sandboxes.
- Cost comes from each agent's record in `output.json`, not from model calls the framework sees.
- Findings are judged against a graded key, and the labels mean something specific: `hit`, `new`,
  `wrong`, `duplicate`, `unsettled`.
- The key grows, so stored findings are judged again.
- Each variant has a holdout (`tunedOn`).
- Fixtures and findings name private projects and must stay local.

**Inspect AI** (MIT, Python 3.10+).

- Integration: an `@agent` or `@solver` that runs `awf run` through `inspect_ai.util.subprocess`
  and puts the findings in `state.output`, with `--model none`
  ([models](https://inspect.aisi.org.uk/models.html)). The judge becomes a custom scorer that runs
  `judge.workflow.ts` the same way.
- Free: the log store, `inspect view`, epochs and reducers, clustered errors, `inspect score`,
  eval-set reuse, `EarlyStopping`, and a majority panel. All of it is local. Telemetry is off
  unless `INSPECT_TELEMETRY` names a package
  ([`hooks/_legacy.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/hooks/_legacy.py)).
- Doesn't fit:
  - Spend. `model_usage` counts only calls through Inspect's own providers. `record_model_usage`
    only feeds token limits
    ([`util/_limit.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/util/_limit.py)),
    so awf's costs would sit in metadata, outside its metrics.
  - Identity. It hashes names and arguments, not our workflow code (section 2).
  - Labels. A scorer returns one value per sample, but ours are many labels per fixture, so they
    would sit in `Score.value` as a dict or in metadata, and every metric would be custom anyway.
  - The judge's workspace. A re-score gets no sandbox (section 1), so a judge that reads the code
    would have to restore the checkout itself.
  - The language: a Python process beside a Bun one.

**Harbor** (Apache-2.0, Python 3.12+).

- Integration: a `BaseInstalledAgent` that runs awf inside the task environment, or a `BaseAgent`
  whose loop runs outside it ([custom agents](https://harborframework.com/docs/core-concepts/agents/custom-agents)).
  `populate_context_post_run` can copy the cost from `output.json` into `cost_usd`. The fixture
  becomes a Harbor task: `instruction.md` is the request, `tests/` holds the key and a Rewardkit
  agent judge.
- Free: jobs and attempts, a separate verifier, `regrade`, `--diff`, per-phase timing, and a viewer.
- Doesn't fit:
  - Every trial needs one of Harbor's environments (Docker, Modal and others). So awf would run
    inside a container with its agents' CLIs and credentials, or drive a container it doesn't need.
    Either way it doubles awf's sandboxing.
  - `VerifierResult` is a dict of numbers, so labels, reasons and the judge's spend would live in
    files beside it.
  - Reuse is decided by hand-set versions.
  - Telemetry is on by default. The `job_finished` event sends agents and models, token usage,
    cost and reward to PostHog until `HARBOR_TELEMETRY` is off
    ([usage stats](https://harborframework.com/docs/telemetry/telemetry),
    [`telemetry.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/telemetry.py)).

**promptfoo** (MIT, Node).

- Integration: a JavaScript or TypeScript provider file that runs `awf run` and returns
  `{ output, cost }` ([custom provider](https://www.promptfoo.dev/docs/providers/custom-api/)). The
  judge becomes a custom assertion.
- Free: the prompts × providers × tests matrix, `--repeat`, seeded subsets, a local SQLite store,
  and `promptfoo view`.
- Doesn't fit:
  - The model is one output per test, then assertions on it. Rejudging stored findings means
    replaying through the cache or `--model-outputs`, not a record we own.
  - A long run needs `PROMPTFOO_EVAL_TIMEOUT_MS` raised.
  - Telemetry is on by default. It sends commands and assertion types, plus user ID and email when
    logged in ([telemetry](https://www.promptfoo.dev/docs/configuration/telemetry/)).
  - It would be a large third-party npm dependency.

**Braintrust** (SDK MIT per its `package.json`, repository Apache-2.0).

- Integration: `Eval(name, { data: fixtures, task: runs awf, scores: [judge] })`, in TypeScript,
  our language.
- Doesn't fit: experiments, comparisons and re-scoring live in the Braintrust service. With
  `noSendLogs` the run "builds a local summary instead of creating an experiment" (`framework.ts`).
  Using it means sending private findings to a hosted service, or self-hosting it. That rules it
  out for now.

**LangSmith** is the same shape as Braintrust, with a hosted store. **OpenAI Evals** is dormant:
its README points to the hosted dashboard.

Measured against these, the parts that are ours are most of the work: the fixture and key format,
the labels and their rules, the judge workflow, the score record, metrics over it, variant
identity, and the reuse decision. What a framework would add is a store, a matrix loop, a viewer
and a few statistics. For us the store is files named by hash, and the loop is a few nested loops
over `awf run`. A bootstrap interval is a few dozen lines. Any of the four also means a new
runtime: a Python process or a large npm package. That runtime would be the first third-party
dependency in `packages/lab`, which today imports only contract and the engine's public
entry. It would also bring a second sandbox layer or a hosted store.

So: **build the machinery, borrow the designs.** Keep the awf surface to four things:

1. `evaluate.ts`: run the variant, then run the judge, both with `awf run`.
2. The score record and its schema.
3. Pure metrics and comparison over records.
4. The reuse table in the next section.

If a viewer is ever worth more than a generated report, export score records one way into
Inspect's log format and use `inspect view` locally. Keep the export outside the packages, as a
tool that reads records, never as the store.

## For awf

What story 008 and `variant-matrix-runner` should take, and what not.

**Run the judge in its own `awf run`: keep it.** Harbor's separate verifier is the same design,
chosen for the same two reasons: a cleaner boundary, and regrading without the agent. In-process
(Inspect, Braintrust, promptfoo) saves start-up time, but each of them then needs a second path to
re-score from stored output. Story 008 gets `--rejudge` from the same path. Take Harbor's rule for
it: a run can be judged again only if everything the judge reads is recorded. That means the
findings verbatim, the fixture digest (which restores the code) and the key revision. `--rejudge`
should check those first and refuse, not guess.

**Keep raw output and scores apart, and never edit a score in place.** The reviewer's run
directory, with its `output.json`, is the raw log. The score record copies the findings verbatim and
names that run. A rejudge writes a new record and leaves the old one alone, as a Harbor regrade
writes a new trial and `inspect score` writes a `-scored` file by default. The reader picks the
record whose key revision and judge version are current. This needs one change to the settled path.
A `{run-id}.json` key allows one judgement per run. Either name the file by run and judgement (for
example `{run-id}.{judge-version}.json`), or decide in the format that a rejudge replaces the file
and the old one survives only in git. Settle it before task 2, because the path is part of the
record format. Don't take Inspect's hand edit (`edit_score`): the key grows through
`key-growth-from-runs`, not through patched labels.

**Identify a variant by a content hash: keep it, and hash code, not names.** Inspect hashes task
names and arguments and trusts a hand-bumped `version`. That is exactly the gap a person editing a
prompt falls into. Hash what the run executes: the workflow source and what it imports from the
variant's repository, the arguments, the prompts, the skills, and the model aliases with their
resolved models. Take from Inspect a version number on the hashing scheme itself, and leave out
options that don't change output (concurrency). Keep the run's deadline in, as Inspect keeps its
limits. Record the git commit and a dirty flag beside the hash as provenance, not as identity.

**Make reuse an explicit decision per fixture.** Harbor's reuse, regrade and rerun map onto our
records without its hand-set semantic versions:

| Changed since the stored record | Action |
| --- | --- |
| variant hash or fixture digest | rerun the reviewer, then judge |
| key revision or judge version | rejudge the stored findings |
| metric code only | recompute from the record |
| stored run failed for the environment | rerun, as Harbor does |
| nothing | reuse |

Print the counts and an estimated cost before spending, like `harbor run --diff`. A reviewer that
failed on its own stays a zero-finding record, as story 008 says, and is reused.

**Compare per fixture, paired, and build it ourselves.** No framework has it. Take Braintrust's
per-case improvement and regression counts as the readable half. Also report the mean per-fixture
difference with a bootstrap interval over fixtures, computed from the repeats of both variants, and
call it a tie when the interval spans zero. Pair on fixture id and fixture digest, not on the input
text (Braintrust's default). Store every repeat as its own record and reduce in the metrics, as
Inspect's unreduced epochs allow, so a new reducer never needs a rerun. Don't take LangSmith's
pairwise judge ("which review is better") for the headline: our key already gives an absolute
label per finding, and a preference judge would add its own bias.

**Judges.** Take these:

- Inspect's majority panel, where a judge that can't answer withholds its vote. After story 008's
  re-ask, a judge that still fails leaves the finding `unsettled` or unscored, counted apart, never
  a label chosen by order.
- Inspect's split of whose output failed. A reviewer run that failed is zero findings. A judge that
  failed is a missing judgement to retry, and never a zero for the reviewer.
- Every judge's labels kept, and agreement computed from the records (κ, or Krippendorff's α with
  three judges).
- A version for the judge from the same content hash as a variant. The judge is an awf workflow
  too, so one function covers its prompt, models and label rules.
- Repeat agreement for each judge, measured as Inspect advises. Our pilot's judge B agreed with
  itself at κ 0.59.

Don't add a model-call cache. Inspect's and promptfoo's caches key on the exact prompt and
messages. Our judges are agents that open files, so their prompts are not stable keys, and caching
the reviewer would make repeats identical, the problem promptfoo's per-repeat namespaces exist for.
The score record keyed by findings, key revision and judge version already is the cache at the
level that matters.

**Judges should see the code, read-only, and be required to open it.** Harbor's agent judge and
promptfoo's `agent-rubric` confirm the shape: a coding agent, a read-only workspace, and reading
the code only when it is set up and asked to. promptfoo's default workspace is empty for this
reason. That is what our pilot found: sonnet made no tool calls in 12 of 13 calls unless told to.
Keep story 008's rule that a `new`, `wrong` or `noise` label must cite lines the judge read, and
reject it otherwise. Restore the frozen code fresh for the judge, never the reviewer's working
directory: Harbor's separate verifier does not inherit the agent's filesystem changes, and a
reviewer could have edited files. Judge in one call per fixture, like Rewardkit's `batched` mode,
so a known issue is claimed once.

**Cost and time: already right.** Two runs give two records, which is what Braintrust, Inspect and
promptfoo each rebuild with tags and roles. Also keep time per phase, as Harbor does: restore,
reviewer, judge.

**Isolation: follow Harbor and SWE-bench.** The key enters only the judge's run, as `tests/`
enters only the verifier. Don't put answers in anything the reviewer's image or checkout is built
from. Count environment failures apart from the reviewer's, after the fact and without changing
the denominator (SWE-bench's `infra_failure.py`).

**Subset first and early stop: build it on seeded subsets.** Take promptfoo's seeded sample, so
"the first 8 fixtures" is the same 8 for the incumbent and the challenger. Take Inspect's stopping
hook, asked before each fixture and repeat with the results so far and logged with its reason, as
the seam for `variant-matrix-runner`'s "stop if clearly worse". The rule itself we write: stop when
the paired interval's upper bound is below zero. Story 006's decision-model pre-match is Inspect's
`cascade`: settle the sure hits cheaply, and send only the rest to the judges.

**Not taken.**

- Any of these frameworks as the runtime. They are Python and built around one model answering,
  as [`review-eval-prior-art`](review-eval-prior-art.md) already concluded.
- Free experiment names and random run ids as identity (Braintrust, LangSmith, promptfoo, OpenAI
  Evals, SWE-bench).
- Overwriting scores inside the run log (Inspect's `--overwrite`).
- Hand-bumped versions as the only signal of change (Inspect's task `version`, Harbor's semantic
  version). Digests decide, and a person decides nothing.
- A verifier result without the judge's spend (Harbor).
