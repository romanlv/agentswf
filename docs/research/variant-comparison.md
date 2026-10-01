# Comparing two variants on a few costly cases

Checked 2026-09-29 for [`variant-matrix-runner`](../stories/011-compare-variants.md) and
[`autoresearch-loop`](../stories/todo/autoresearch-loop.md); taken into [[011-compare-variants]]. We read Miller's error-bars paper,
Hesterberg on the bootstrap, Field & Welsh and Saravanan et al. on hierarchical resampling, Cameron
& Miller on few clusters, Bowyer et al. on small LLM evals, and the papers on confidence sequences,
e-values, mSPRT and group-sequential bounds. We read the source of Inspect AI's `EarlyStopping`,
UK AISI's optstop, confseq, DSPy, GEPA, OpenEvolve, AFlow (in MetaGPT), TextGrad, Karpathy's
autoresearch, Harbor, Braintrust's SDK, promptfoo, lm-evaluation-harness, OpenAI Evals and MLflow,
all on their default branches on that date. We also ran two small simulations of our own, named as
such below. Orchestration, identity and reuse are settled in
[`eval-orchestration`](eval-orchestration.md). The loop's evidence is in
[`autoresearch-practices`](autoresearch-practices.md). This page covers the statistics and the
interfaces between a scorer, a comparison and a proposer.

The short version: with 5–40 cases, use a paired t interval on per-case differences of trial
means, with n−1 degrees of freedom. Don't use a percentile bootstrap. It undercovers below about 20
cases, and resampling trials inside cases as well overcovers. Spend budget on cases before repeats.
Peeking after every case with a fixed-n interval inflates false "better" claims about five times. Stopping
early for "clearly worse" adds no false wins, so allow it at any case; its price is equal variants
now and then dropped as worse. Claim "better" only at a few planned
looks with O'Brien–Fleming bounds. Anytime-valid confidence sequences are correct, but at n ≤ 40
they are two to seven times wider than a t interval. No framework accepts over several metrics with
floors. The nearest is MLflow's `MetricThreshold`, which compares each metric with a baseline in a
declared direction. The optimisers that work all get per-case text feedback, not just a scalar. So a
scorer, of any case kind, should produce per case a vector of named metrics, each with a direction
and a range. It should also produce a failure kind and feedback text.

## 1. The interval for a paired difference

- **What Miller settles.** Compare models on "question-level paired differences". Pairing subtracts
  `2 Cov(x_A, x_B)/n` from the variance, "a 'free' reduction". With several answers per question,
  take the standard error across per-question means: "computing a pooled standard error across all
  KN answers will be inconsistent". His intervals are ±1.96·SE throughout. He calls the bootstrap
  "unnecessary unless a complicated sampling scheme or estimator is being used". He says nothing
  about small n ([arXiv 2411.00640](https://arxiv.org/html/2411.00640), §2–4).
- **The percentile bootstrap undercovers at small n.** Hesterberg: "the common bootstrap percentile
  interval badly under-covers in small samples". "For symmetric data it is like using z σ̂/√n in
  place of t s/√n." The t interval "is more accurate than the percentile interval for n ≤ 34, for
  exponential populations". His Table 5 puts one-sided non-coverage at a nominal 0.025 at 0.077
  for n=5, 0.048 for n=10 and 0.030 for n=40. Also: "Bootstrapping does not overcome the weakness
  of small samples" ([arXiv 1411.5279](https://arxiv.org/pdf/1411.5279), §3.2, §5.2). BCa is not in
  his simulations. He notes it "has no adjustment for narrowness". We read only the abstract of
  DiCiccio & Efron 1996
  ([Stat. Sci.](https://projecteuclid.org/journals/statistical-science/volume-11/issue-3/Bootstrap-confidence-intervals/10.1214/ss/1032280214.full)),
  so we have no small-n BCa numbers from a source.
- **Resample cases, not trials within cases.** Field & Welsh: "the cluster bootstrap gives
  consistent estimates". The two-stage bootstrap generates "excess variation" and does not give
  consistent variance estimates "unless both m and g tend to ∞"
  ([JRSS-B 2007](https://bemlar.ism.ac.jp/zhuang/Refs/Refs/field2007jrssb.pdf), §3.4). Ren et al.
  find sampling "on the highest level" better than on lower levels
  ([J. Appl. Stat. 2010](https://pure.johnshopkins.edu/en/publications/nonparametric-bootstrapping-for-hierarchical-data-4/),
  abstract only). Saravanan et al. resample both levels and report error bars "roughly 1.4 times
  larger" on independent data ([arXiv 2007.07797](https://arxiv.org/pdf/2007.07797)). The mechanism:
  the case mean already carries the within-case variance σ²_w/K, and redrawing trials adds it again.
- **Few clusters.** A paired difference per case is a cluster-robust mean with G = n clusters.
  Cameron & Miller: "at a minimum use T(G − 1) critical values". With 1.96, a nominal 5% test
  rejects ".068, .081, .118, and .208 for G equal to … 30, 20, 10 and 5". Also, "there is no
  specific point at which we need to worry about few clusters … 'more is better'"
  ([JHR 2015](https://cameron.econ.ucdavis.edu/research/Cameron_Miller_JHR_2015_February.pdf)). T(n−1)
  on per-case differences is the paired t.
- **LLM evals with few items.** Bowyer et al. find CLT intervals "dramatically underestimating
  uncertainty" at N = 3–100. For paired binary items they recommend a Bayesian paired model, and
  they note t intervals "can have better properties than z-based ones"
  ([arXiv 2503.01747](https://arxiv.org/abs/2503.01747)). Their model is one binary outcome per
  question, not a mean of repeats, so it does not transfer directly.
- **Rank tests.** The sign test and the Wilcoxon signed-rank test have a smallest two-sided p of
  2·(1/2)ⁿ. That is 0.0625 at n=5, so they need at least 6 cases, all differing in one direction.
  Tables print a dash for n=5: "too small to reject H₀"
  ([LibreTexts](https://stats.libretexts.org/Bookshelves/Introductory_Statistics/Mostly_Harmless_Statistics_(Webb)/13:_Nonparametric_Tests/13.04:_Wilcoxon_Signed-Rank_Test)).
  Ties are dropped ([scipy](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.wilcoxon.html)),
  which lowers the effective n.
- **Our simulation.** We drew per-case recall from 2–8 issues, with a per-case true difference that
  was either a shifted normal or sparse (80% of cases unchanged). We took 1,500 datasets per cell and
  1,000 resamples each. The table gives the coverage of the population mean difference by a nominal
  95% interval, for K = 3 trials per case:

  | Cases | paired t | percentile, cases | BCa, cases | two-level (cases, then trials) |
  | --- | --- | --- | --- | --- |
  | 5 | 0.95 / 0.95 | 0.85 / 0.81 | 0.84 / 0.81 | 0.96 / 0.93 |
  | 10 | 0.96 / 0.95 | 0.91 / 0.89 | 0.90 / 0.88 | 0.98 / 0.95 |
  | 20 | 0.95 / 0.95 | 0.92 / 0.93 | 0.91 / 0.93 | 0.97 / 0.96 |
  | 40 | 0.94 / 0.95 | 0.93 / 0.94 | 0.92 / 0.94 | 0.98 / 0.98 |

  Each cell is shifted / sparse. With K = 1 the two bootstraps coincide and undercover the same way.
  The mean width at n=5 was 0.49 for t against 0.30 for the percentile interval, on a recall scale.
  The t interval is honest, and at five cases it is wide.

## 2. More cases or more repeats

- Miller splits the variance into between questions and within a question:
  `Var(μ̂) = (Var(x) + E[σ²_i]/K)/n`. The first term "is a property of the super-population and
  therefore immutable". "Once E[σ_i²]/K ≪ Var(x), increasing K further will have little effect."
  In his example the gain tops out at a 2/3 cut, and K = 4–6 gets most of it. His power formula
  carries both terms: `n = (z_{α/2} + z_β)² (ω² + σ²_A/K_A + σ²_B/K_B)/δ²`. There ω² is the variance
  of the true per-question difference. At ω² = 1/9 and δ = 0.03 it needs ≈ 969 questions
  ([arXiv 2411.00640](https://arxiv.org/html/2411.00640), §3, §5).
- With a fixed budget of B = nK trials per variant, the variance is `ω²/n + (σ²_A + σ²_B)/B`. The
  within-case term depends only on B, so any ω² > 0 favours cases over repeats. This follows from
  Miller's formula; he does not state it this way. Repeats pay only when new cases can't be had,
  which is our situation, and only until σ²_w/K is well under ω².
- Repeats have a second use. With K ≥ 2 both components can be estimated, and the next run's power
  calculation needs both. With K = 1 they can't be separated.
- Miller advises against lowering temperature to cut variance. It "may simply shift the conditional
  variance … into the variance of the conditional means (which cannot)" be reduced (§3.3).
- For a sense of scale: to detect δ = 0.1 in recall at 80% power, with ω ≈ 0.15 and σ²_w/K small,
  n ≈ (2.8 · 0.15 / 0.1)² ≈ 18 cases. Forty cases detect about 0.07. Differences of a few points,
  like those between the top SWE-PRBench models, are out of reach at this size
  ([`autoresearch-practices`](autoresearch-practices.md)).

## 3. Stopping early without invalidating the result

- **Inspect's seam.** The `EarlyStopping` protocol has four async methods: `start_task(task,
  samples, epochs)`, `schedule_sample(id, epoch) -> EarlyStop | None` ("called prior to scheduling
  a sample"), `complete_sample(id, epoch, scores)` and `complete_task() -> dict`. A skipped sample is
  terminal and completed, not an error. The summary, `{manager, early_stops[{id, epoch, reason,
  metadata}], metadata}`, is stored as `log.results.early_stopping`
  ([`util/_early_stopping.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/util/_early_stopping.py),
  [`_eval/task/run.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/_eval/task/run.py)).
  The protocol only skips work. The statistics belong to the manager.
- **optstop.** It fits a hierarchical Bayesian model with PyMC: logit-normal for binary scores,
  Beta for bounded ones. It stops a grouping (model × task) when the 97% credible interval on the
  group mean is narrower than `delta_cap` = 0.05. It also stops when the width has stopped moving:
  the slope over the last 15 widths is at most 1e-5
  ([`optstop/rule.py`](https://github.com/UKGovernmentBEIS/optstop/blob/main/optstop/rule.py)). It
  claims no frequentist control. The README says intervals are "well-calibrated when groupings
  contain 50+ items" and to "treat CIs as rough guides". The paper reports "empirical coverage of
  approximately 80% at 94% nominal"
  ([README](https://github.com/UKGovernmentBEIS/optstop/blob/main/README.md),
  [paper](https://github.com/UKGovernmentBEIS/optstop/tree/main/paper)). It measures one variant's
  precision. It does not compare two.
- **Peeking with a fixed-n interval.** A one-sided test at α = 0.05, run after every case from 3 to
  40, rejects a true null 25% of the time. A two-sided 95% t test run after every case from 5 to 40
  rejects 25% of the time (our simulations). Peeking at 5, 10, 20 and 40 cases gives 14%.
- **Group-sequential bounds.** For K equally spaced looks at two-sided α = 0.05, "the Pocock critical
  value for all interim analyses is 2.41" at K = 5. O'Brien–Fleming uses "2.04 √(5/k)", which is
  4.56, 3.23, 2.63, 2.28 and 2.04. Lan–DeMets spending functions give the same for unequal looks:
  `α(t) = 2 − 2Φ(z_{α/2}/√t)` for OBF and `α ln(1 + (e − 1)t)` for Pocock
  ([DeMets & Lan 1994](https://eclass.uoa.gr/modules/document/file.php/MATH301/PracticalSession3/LanDeMets.pdf)).
  For K = 3 the constants are Pocock 2.29, and OBF 3.47, 2.45 and 2.00. For K = 4 they are Pocock
  2.36, and OBF 4.05, 2.86, 2.34 and 2.02. These are normal-theory constants. With a t statistic at
  n = 10 they run hot: a Pocock constant over 10/20/30/40 gave 0.069, not 0.05, in the
  sequential-test simulation. Convert each bound to a t quantile at the same tail probability, or
  use OBF, which spends almost nothing early. Planned looks cost little power: at a true mean of
  0.1 with sd 0.2, four Pocock looks rejected 0.90 and a single test at 40 rejected 0.93. OBF,
  with its fixed-n final bound, loses less.
- **Stopping for futility adds no false wins.** It costs power instead: equal variants are now and
  then stopped as worse (story 011 measured 12% at 33 cases). FDA: "the addition of such nonbinding futility guidelines to a
  fixed sample trial … does not increase the Type I error probability"
  ([Adaptive designs guidance](https://www.fda.gov/media/78495/download)). In our simulation, a
  "better" claim at 40 cases had a type I error of 0.0234. Stopping whenever the paired interval sat
  below zero gave 0.0233. The early stop is a decision to spend no more. It is not a finding that the
  challenger is worse, and it should not be reported with that interval's confidence.
- **Anytime-valid confidence sequences.** Howard et al. give time-uniform, nonasymptotic bounds
  ([arXiv 1810.08240](https://arxiv.org/abs/1810.08240)). For a mean in [0, 1], Waudby-Smith &
  Ramdas's predictable plug-in empirical Bernstein sequence is
  `Σλ_iX_i/Σλ_i ± (log(2/α) + Σ v_i ψ_E(λ_i))/Σλ_i`. Here
  `λ_t = min(√(2 log(2/α)/(σ̂²_{t−1} t log(1+t))), c)`, and the betting ("hedged capital") version is
  tighter ([arXiv 2010.09686](https://arxiv.org/abs/2010.09686), Thms 2–3;
  [confseq](https://github.com/gostevehoward/confseq)). Our simulation mapped a paired difference
  with sd 0.2 into [0, 1]. The mean 95% width on the difference scale was:

  | Cases | t interval | empirical Bernstein (c = 0.75) | betting (c = 0.75) |
  | --- | --- | --- | --- |
  | 10 | 0.28 | 1.95 (vacuous) | 0.76 |
  | 20 | 0.19 | 1.02 | 0.45 |
  | 40 | 0.13 | 0.53 | 0.25 |

  The sequence pays for the full [−1, 1] range and for validity at every n.
- **E-values.** An e-process lets you "reject the null (and stop) the first time the process
  reaches or exceeds 1/α", by Ville's inequality
  ([arXiv 2210.01948](https://arxiv.org/abs/2210.01948)). For d ∈ [−1, 1] and H₀: E[d] ≤ 0, use
  `K_t = Π(1 + λ_i d_i)` with λ_i ∈ [0, c], chosen from earlier cases only. It is about 15 lines. At
  n ≤ 40 it detects only large effects: a true mean of 0.2 was found 99.5% of the time at c = 0.9
  (median stop at 24 cases), and a mean of 0.1 only 29% of the time (our simulation).
- **mSPRT.** It has a closed form for normal data,
  `Λ_n = √(σ²/(σ²+nτ²)) · exp(n²τ²(X̄_n−θ₀)²/(2σ²(σ²+nτ²)))`, and rejects at Λ_n ≥ 1/α. It assumes
  a known variance, and "since the approximations hold only at large n, exact always validity is not
  achieved" ([arXiv 1512.04922](https://arxiv.org/abs/1512.04922);
  [KDD 2017](https://doi.org/10.1145/3097983.3097992)). That does not fit n ≤ 40.

## 4. Several metrics: how optimisers keep and discard

- **Karpathy's autoresearch.** One metric: "get the lowest val_bpb". VRAM "is a soft constraint".
  Simplicity is a judgement call for the agent: "A 0.001 val_bpb improvement that adds 20 lines of
  hacky code? Probably not worth it … An improvement of ~0 but much simpler code? Keep."
  `results.tsv` has `commit val_bpb memory_gb status description`, where status is `keep`,
  `discard` or `crash`, and a crash logs 0
  ([program.md](https://github.com/karpathy/autoresearch/blob/master/program.md)).
- **GEPA.** Acceptance is `StrictImprovementAcceptance`: the child's minibatch sum must beat the
  parent's, with no interval. It is pluggable through `AcceptanceCriterion.should_accept`
  ([`strategies/acceptance.py`](https://github.com/gepa-ai/gepa/blob/main/src/gepa/strategies/acceptance.py)).
  Parents are sampled from a per-instance Pareto front. Dominated candidates are removed, and the
  rest are weighted by how many validation instances each one leads
  ([`gepa_utils.py`](https://github.com/gepa-ai/gepa/blob/main/src/gepa/gepa_utils.py)). In the
  paper's ablation this gave +12.44% against +6.05% for always taking the best average
  ([arXiv 2507.19457](https://arxiv.org/abs/2507.19457), §3.1, Table 3; quoted through a summariser).
  `frontier_type` can be `instance`, `objective`, `hybrid` or `cartesian`, but the per-objective
  front keeps only the best value on each axis. It is not vector dominance, and every objective must
  be higher-is-better
  ([`core/state.py`](https://github.com/gepa-ai/gepa/blob/main/src/gepa/core/state.py)). The final
  pick is the best average ([`core/result.py`](https://github.com/gepa-ai/gepa/blob/main/src/gepa/core/result.py)).
- **OpenEvolve.** Fitness is `combined_score` if present, else the "average of non-feature metrics".
  Flags are skipped because "a flag is not a score"
  ([`utils/metrics_utils.py`](https://github.com/algorithmicsuperintelligence/openevolve/blob/main/openevolve/utils/metrics_utils.py)).
  MAP-Elites `feature_dimensions` are "for diversity, NOT fitness"
  ([`database.py`](https://github.com/algorithmicsuperintelligence/openevolve/blob/main/openevolve/database.py)).
  The cascade runs `evaluate_stage1..3` against `cascade_thresholds` of 0.5, 0.75 and 0.9 on that
  scalar ([`evaluator.py`](https://github.com/algorithmicsuperintelligence/openevolve/blob/main/openevolve/evaluator.py)).
- **AlphaEvolve.** `evaluate` returns "a dictionary of scalars". Simplicity-like properties "can be
  graded using separate LLM calls and added to the dictionary … or … used to discard solutions when
  a criterion is not fulfilled". That is a soft score or a hard gate. "Optimizing for multiple metrics
  often improves results for the single target metric", through diversity. The selection rule is not
  given ([arXiv 2506.13131](https://arxiv.org/abs/2506.13131), §2.4).
- **AFlow.** It validates each workflow 5 times and averages
  ([arXiv 2410.10762](https://arxiv.org/abs/2410.10762); `validation_rounds: int = 5` in
  [`aflow/scripts/optimizer.py`](https://github.com/FoundationAgents/MetaGPT/blob/main/metagpt/ext/aflow/scripts/optimizer.py)).
  Parents come from the top k by a mixed uniform and softmax draw. Cost is recorded but only
  plotted afterwards. Nothing is discarded; selection does the filtering.
- **TextGrad.** Greedy on one validation scalar:
  `if val_performance < previous_performance: system_prompt.set_value(previous_prompt)`
  ([`evaluation/prompt_optimization.py`](https://github.com/zou-group/textgrad/blob/main/evaluation/prompt_optimization.py)).
  With several objectives, a model reads the scores and scalarises them in its head
  ([arXiv 2406.07496](https://arxiv.org/abs/2406.07496)).
- **The one baseline gate with direction.** MLflow's `MetricThreshold(threshold,
  min_absolute_change, min_relative_change, greater_is_better)`. A candidate passes if its metric
  "has to be >= baseline model metric value + min_absolute_change", or the mirror when lower is
  better. The direction is required ("`greater_is_better` parameter must be defined")
  ([`models/evaluation/validation.py`](https://github.com/mlflow/mlflow/blob/master/mlflow/models/evaluation/validation.py)).
  It compares point values, with no interval.

The pattern: no optimiser has floors, ceilings or an interval in its acceptance rule. They scalarise
(OpenEvolve, TextGrad), keep the best per axis for diversity (GEPA, AlphaEvolve), or leave it to the
agent (autoresearch). Pareto fronts are used to pick parents, never to accept. Every optimiser
assumes higher is better, and cost has to be inverted to fit.

## 5. Several metrics: what eval frameworks let a task declare

| Framework | Per-case score | Aggregation declared | Direction declared | Missing or failed |
| --- | --- | --- | --- | --- |
| Inspect AI | `Score.value`: scalar, list or `Mapping[str, scalar \| None]` | per key, with globs: `metrics={"a": [mean(), stderr()], "*": [mean()]}` | no | `Score.unscored()` is NaN, left out and counted in `unscored_samples`; an error is recorded in `sample.error`, apart |
| Harbor | `rewards: dict[str, float \| int] \| None` | one function for every key: mean (default), sum, min, max or a script | no | counted as 0 |
| Braintrust | `{name, score: number \| null}`, several per scorer | always the mean | only implied by the 0–1 range | `null` left out; the default error handler logs 0 |
| promptfoo | `namedScores: Record<string, number>` via `metric:` | sums, plus `derivedMetrics` formulas over the sums and `__count` | no | ERROR counted apart from FAIL; an errored row scores 0 and adds no named scores |
| lm-eval-harness | `process_results` → dict | `metric_list: {metric, aggregation, higher_is_better}` | yes, per metric | a key a document omits is left out of that metric only |
| OpenAI Evals | free events, `record_metrics(**kw)` | written by hand in `run()` | `higher_is_better` on the eval spec; no code reads it | NaN on empty input |
| MLflow | `MetricValue.scores` per row | mean, variance and p90 by default | yes: `make_metric(greater_is_better=…)` is required | `None` left out |

Sources: Inspect [`scorer/_metric.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/scorer/_metric.py),
[multiple scorers](https://inspect.aisi.org.uk/multiple-scorers.html),
[scoring policy](https://inspect.aisi.org.uk/scoring-policy.html),
[`_eval/task/results.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/_eval/task/results.py);
Harbor [`metrics/base.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/metrics/base.py),
[`job.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/job.py);
Braintrust [`js/util/score.ts`](https://github.com/braintrustdata/braintrust-sdk/blob/main/js/util/score.ts),
[`framework.ts`](https://github.com/braintrustdata/braintrust-sdk/blob/main/js/src/framework.ts),
[LLM as a judge](https://www.braintrust.dev/docs/evaluate/llm-as-a-judge);
promptfoo [`util/namedMetrics.ts`](https://github.com/promptfoo/promptfoo/blob/main/src/util/namedMetrics.ts),
[`evaluator.ts`](https://github.com/promptfoo/promptfoo/blob/main/src/evaluator.ts),
[expected outputs](https://www.promptfoo.dev/docs/configuration/expected-outputs/);
lm-eval [`new_task_guide.md`](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/new_task_guide.md),
[`api/metrics.py`](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/lm_eval/api/metrics.py),
[`evaluator_utils.py`](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/lm_eval/evaluator_utils.py);
OpenAI [`evals/base.py`](https://github.com/openai/evals/blob/main/evals/base.py),
[`evals/record.py`](https://github.com/openai/evals/blob/main/evals/record.py);
MLflow [`models/evaluation/base.py`](https://github.com/mlflow/mlflow/blob/master/mlflow/models/evaluation/base.py),
[`metrics/genai/genai_metric.py`](https://github.com/mlflow/mlflow/blob/master/mlflow/metrics/genai/genai_metric.py).

- **A named map of numbers per case is the common shape.** Five of the seven have it.
- **Direction is rare.** lm-eval uses it only to print ↑ and ↓. Its groups drop the direction to
  `None` when their children disagree. Only MLflow gates on it, and it asks for the direction again
  on the threshold.
- **Missing and failed split the field into two camps.** Inspect, lm-eval and Braintrust's `null`
  leave a case out and count it. Harbor, promptfoo's overall score and Braintrust's error handler
  count it as 0. Inspect alone keeps three states apart: scored, unscored, and errored.
- **Braintrust computes improvements and regressions on its server**, so we could not see how
  they use direction.

## 6. What an optimiser needs beyond a scalar

- **DSPy.** `metric(example, pred, trace=None)` returns a float when scoring, or a bool when `trace`
  is set and it gates a bootstrapped demonstration. So one metric has two jobs: a graded score and a
  stricter pass
  ([metrics docs](https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/evaluation/metrics.md),
  [`teleprompt/bootstrap.py`](https://github.com/stanfordnlp/dspy/blob/main/dspy/teleprompt/bootstrap.py)).
  `Evaluate` replaces a failed example with `failure_score` (default 0.0), which stays in the
  denominator. It cancels the run after `max_errors` (default 10)
  ([`evaluate/evaluate.py`](https://github.com/stanfordnlp/dspy/blob/main/dspy/evaluate/evaluate.py)).
  GEPA's metric in DSPy takes `(gold, pred, trace, pred_name, pred_trace)` and returns
  `score` with `feedback`, plus optional `objective_scores`. Without feedback it falls back to "This
  trajectory got a score of {score}."
  ([`teleprompt/gepa/gepa.py`](https://github.com/stanfordnlp/dspy/blob/main/dspy/teleprompt/gepa/gepa.py)).
- **GEPA's adapter.** `evaluate(batch, candidate, capture_traces)` returns an `EvaluationBatch` with
  `outputs`, `scores`, `trajectories`, `objective_scores` and `num_metric_calls`.
  `make_reflective_dataset` turns it into records of `Inputs`, `Generated Outputs` and `Feedback`
  ("including correct answer, error messages"). The contract says: "Never raise for individual
  example failures. Instead: Return a valid `EvaluationBatch` with per-example failure scores … Even
  better if the trajectories are also populated with the failed example, including the error
  message." Exceptions are reserved "for unrecoverable, systemic failures"
  ([`core/adapter.py`](https://github.com/gepa-ai/gepa/blob/main/src/gepa/core/adapter.py)).
  `optimize_anything` takes an evaluator returning `(score, info)`, with `info` "surfaced to the
  engine as feedback", a `test_set` that "never enters the eval server", and a budget
  ([`optimize_anything.py`](https://github.com/gepa-ai/gepa/blob/main/src/gepa/optimize_anything.py)).
- **OpenEvolve.** `evaluate(program_path)` returns metrics, or
  `EvaluationResult(metrics, artifacts)`, where artifacts are an "optional side-channel" of text
  such as stderr and tracebacks. With `include_artifacts` they are rendered into the next prompt
  ([`evaluation_result.py`](https://github.com/algorithmicsuperintelligence/openevolve/blob/main/openevolve/evaluation_result.py),
  [`prompt/sampler.py`](https://github.com/algorithmicsuperintelligence/openevolve/blob/main/openevolve/prompt/sampler.py)).
- **AFlow** gives its optimiser the parent's score and an experience log of which changes beat
  their parent. It also gives three random failed cases, each with question, right answer and
  output, and it refuses a change already tried
  ([`aflow/`](https://github.com/FoundationAgents/MetaGPT/tree/main/metagpt/ext/aflow)).
- **TextGrad's** loss is text. `TextLoss(eval_system_prompt)` returns a critique, and a code check
  is wrapped in `StringBasedFunction`
  ([`textgrad/loss.py`](https://github.com/zou-group/textgrad/blob/main/textgrad/loss.py)).

The pattern: every optimiser that works gets per-case text beside the number. That text is the
reason, the error, or the expected answer. They also get the trace or a pointer to it, and the
history of earlier tries with their outcomes. Cost appears only as a budget (GEPA) or a record
(AFlow), never in acceptance. A per-case failure is a floor score plus its error text. A systemic
failure stops the run.

## 7. Who defines the scorer and the comparison

Sections 4–6 say what a score holds. This section asks who writes each of three functions: the
per-case scorer, the aggregation over cases, and the comparison of two variants. We read the same
repositories again on 2026-09-29, and added LangSmith's SDK, Weave and OpenAI Evals' graders.

| Project | Per-case scorer | Aggregation | Compare step | Where it lives |
| --- | --- | --- | --- | --- |
| GEPA | project: adapter `evaluate(batch, candidate, capture_traces) -> EvaluationBatch`, or `evaluator` returning `(score, info)` | framework: the minibatch sum to accept; the validation mean to pick the best, replaceable through `EvaluationPolicy.get_valset_score(program_idx, state) -> float` | **pluggable**: `should_accept(proposal, state) -> bool`. It gets both candidates' per-example scores on the same minibatch. Ships `strict_improvement` (default) and `improvement_or_equal` | scorer in the project; the criterion is an argument to `optimize(acceptance_criterion=…)` |
| DSPy | project: `metric(example, pred, trace=None) -> float \| bool` | framework: `Evaluate` returns `round(100 * sum / n, 2)` | hardcoded `score > best_score` (MIPROv2, random search). `dspy.GEPA` passes GEPA's criterion through `gepa_kwargs` | metric in project code |
| OpenEvolve | project: `evaluate(program_path) -> dict \| EvaluationResult` | project may return `combined_score`; else the framework's mean of non-feature metrics | hardcoded `_is_better`: fitness greater. **Pluggable**: `replace_cell(snapshot, candidate, incumbent, island) -> bool` and `admit(snapshot, candidate, island) -> bool`, on metrics already aggregated. A child is never judged against its parent, only against its cell's incumbent | evaluator file in the project; `run_evolution(population_strategy=…)` |
| autoresearch | project: `evaluate_bpb` in `prepare.py`, which the agent may not edit | one number, no cases | prose: "If val_bpb improved (lower), you 'advance' the branch", plus the simplicity rule. The agent decides | all in the project's `program.md` |
| LangSmith | project: `(run, example) -> EvaluationResult \| dict` | project: summary evaluator `(runs, examples) -> EvaluationResult` | **pluggable, per case**: `evaluate_comparative((exp_a, exp_b), evaluators=[…])`, each `(runs, example) -> ComparisonEvaluationResult` with `scores: {run_id: score}`. No verdict over the set, and no standard comparator in the SDK | project code |
| Braintrust | project: `(args: {input, output, expected, metadata}) -> Score \| Score[] \| null` | framework: mean per score name | framework, on its server: `ScoreSummary {score, diff, improvements, regressions}` against `baseExperimentName` or `baseExperimentId`. The pluggable part is a reporter's `reportRun(reports) -> boolean`, which sets the exit code | scorers and base in the `Eval(…)` call |
| Inspect AI | project: `(state, target) -> Score` | project: `@metric` `(scores: list[SampleScore]) -> Value`; epochs through a `ScoreReducer` `(scores: list[Score]) -> Score` | none; the log dataframes are left to the user | task file |
| MLflow | project: `make_metric(eval_fn, greater_is_better)`; genai `@scorer` | project: `eval_fn(predictions, targets, metrics) -> float \| MetricValue`; genai `aggregations` of `"mean"`, `"p90"`… or `Callable[[list[float]], float]` | a fixed rule with project parameters: `validate_evaluation_results(validation_thresholds: dict[str, MetricThreshold], candidate_result, baseline_result)` raises on failure. No custom function | thresholds in project code |
| promptfoo | project: assertions; `javascript` and `python` return a bool, a number or a `GradingResult` | framework sums named scores; project `derivedMetrics: {name, value: string \| (namedScores, context) => number}` | inside one eval, per test case across prompts or providers: `select-best` (a model picks one output) and `max-score` (`{method, weights, threshold}`). Between two evals, only a side-by-side view. The CI gate `PROMPTFOO_PASS_RATE_THRESHOLD` is absolute | config file |
| lm-eval | project: `process_results(doc, results) -> dict` | project: an `aggregation` by name or `@register_aggregation`, `(list) -> float`, with `higher_is_better` | none in the library. `scripts/model_comparator.py` runs an unpaired z-test on `acc` and its stderr, for HF against vLLM | task YAML and `utils.py` |
| Harbor | project: the task's `tests/test.sh` writes `reward.txt` or `reward.json` | dataset or job `metrics`: mean, sum, min, max, or a uv script, `compute(rewards) -> dict` | none between agents. `job regrade` prints a hardcoded old-against-new delta of one trial's reward: ups, downs, means | task directory; metrics in the dataset or job config |
| Weave | project: `Scorer.score(*, output, **kwargs)` | project may override `Scorer.summarize(score_rows) -> dict`; the default `auto_summarize` averages numbers and counts booleans | none in the SDK | project code |
| OpenAI Evals | project: an `Eval`'s `eval_sample(sample, rng)` records metrics | project: `run(recorder) -> dict` | the `battle` graded template: a judge answers "Is the first response better than the second?" per sample, Yes 1.0, No 0.0 | registry YAML |

Sources: GEPA [`strategies/acceptance.py`](https://github.com/gepa-ai/gepa/blob/main/src/gepa/strategies/acceptance.py),
[`api.py`](https://github.com/gepa-ai/gepa/blob/main/src/gepa/api.py),
[`strategies/eval_policy.py`](https://github.com/gepa-ai/gepa/blob/main/src/gepa/strategies/eval_policy.py);
DSPy [`evaluate/evaluate.py`](https://github.com/stanfordnlp/dspy/blob/main/dspy/evaluate/evaluate.py),
[`teleprompt/mipro_optimizer_v2.py`](https://github.com/stanfordnlp/dspy/blob/main/dspy/teleprompt/mipro_optimizer_v2.py),
[`teleprompt/random_search.py`](https://github.com/stanfordnlp/dspy/blob/main/dspy/teleprompt/random_search.py),
[`teleprompt/gepa/gepa.py`](https://github.com/stanfordnlp/dspy/blob/main/dspy/teleprompt/gepa/gepa.py);
OpenEvolve [`database.py`](https://github.com/algorithmicsuperintelligence/openevolve/blob/main/openevolve/database.py),
[`population.py`](https://github.com/algorithmicsuperintelligence/openevolve/blob/main/openevolve/population.py),
[`api.py`](https://github.com/algorithmicsuperintelligence/openevolve/blob/main/openevolve/api.py);
autoresearch [`program.md`](https://github.com/karpathy/autoresearch/blob/master/program.md);
LangSmith [`evaluation/_runner.py`](https://github.com/langchain-ai/langsmith-sdk/blob/main/python/langsmith/evaluation/_runner.py),
[`evaluation/evaluator.py`](https://github.com/langchain-ai/langsmith-sdk/blob/main/python/langsmith/evaluation/evaluator.py);
Braintrust [`js/src/framework.ts`](https://github.com/braintrustdata/braintrust-sdk/blob/main/js/src/framework.ts),
[`js/src/logger.ts`](https://github.com/braintrustdata/braintrust-sdk/blob/main/js/src/logger.ts),
[`js/src/reporters/types.ts`](https://github.com/braintrustdata/braintrust-sdk/blob/main/js/src/reporters/types.ts);
Inspect [`scorer/_scorer.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/scorer/_scorer.py),
[`scorer/_metric.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/scorer/_metric.py),
[`scorer/_reducer/types.py`](https://github.com/UKGovernmentBEIS/inspect_ai/blob/main/src/inspect_ai/scorer/_reducer/types.py);
MLflow [`models/evaluation/validation.py`](https://github.com/mlflow/mlflow/blob/master/mlflow/models/evaluation/validation.py),
[`models/evaluation/base.py`](https://github.com/mlflow/mlflow/blob/master/mlflow/models/evaluation/base.py),
[`genai/scorers/base.py`](https://github.com/mlflow/mlflow/blob/master/mlflow/genai/scorers/base.py);
promptfoo [`matchers/comparison.ts`](https://github.com/promptfoo/promptfoo/blob/main/src/matchers/comparison.ts),
[`types/index.ts`](https://github.com/promptfoo/promptfoo/blob/main/src/types/index.ts),
[`node/doEval.ts`](https://github.com/promptfoo/promptfoo/blob/main/src/node/doEval.ts);
lm-eval [`api/task.py`](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/lm_eval/api/task.py),
[`api/registry.py`](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/lm_eval/api/registry.py),
[`scripts/model_comparator.py`](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/scripts/model_comparator.py);
Harbor [`verifier/verifier.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/verifier/verifier.py),
[`metrics/base.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/metrics/base.py),
[`models/registry.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/models/registry.py),
[`cli/jobs.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/cli/jobs.py);
Weave [`flow/scorer.py`](https://github.com/wandb/weave/blob/master/weave/flow/scorer.py);
OpenAI Evals [`registry/modelgraded/battle.yaml`](https://github.com/openai/evals/blob/main/evals/registry/modelgraded/battle.yaml),
[`evals/eval.py`](https://github.com/openai/evals/blob/main/evals/eval.py).

- **The project always writes the scorer.** No framework scores a case without a function or a
  script the project supplies, even when it ships ready-made ones to pick from.
- **Aggregation splits.** Eval frameworks let the task choose it (Inspect, lm-eval, MLflow,
  LangSmith, Weave, Harbor). Optimisers and Braintrust fix it: a sum, a mean, or a mean times 100.
- **Only two take a compare function that returns keep or discard.** GEPA's `should_accept` gets
  the per-example scores of both candidates on the same cases: the paired shape. OpenEvolve's
  `replace_cell` gets two programs with aggregated metrics, so it cannot pair. MLflow takes
  parameters for a fixed rule. LangSmith's comparator is pluggable but per case, and returns scores,
  not a verdict. Braintrust's `reportRun` decides pass or fail, but the comparison it reads is
  computed on the server.
- **The standard comparisons are all point comparisons.** GEPA compares two sums, OpenEvolve two
  fitness values, MLflow a value against a baseline plus a margin, Braintrust counts ups and downs,
  and lm-eval's script runs an unpaired z-test. None pairs cases with an interval (section 4).
- **The comparison lives with whoever runs the loop, not in the task.** GEPA and OpenEvolve take it
  as an argument to the optimise call, which the project's own script makes. autoresearch writes it
  in the project's `program.md`. Eval frameworks keep scorer and aggregation in the task file, and
  do comparison outside it, in a UI, on a server, or in a script.

## 8. Anthropic's build-eval and hillclimb

Checked 2026-09-29. We read Lance Martin's post
[Automating eval design and hillclimbing](https://claude.dev/blog/automating-eval-design-and-hillclimbing/)
(2026-09-28), and in full the guides behind it in the `claude-api` skill:
[`build-eval.md`](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/evals/build-eval.md),
[`eval-hillclimb.md`](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/evals/eval-hillclimb.md),
[`cost-hillclimb.md`](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/evals/cost-hillclimb.md),
[`eval-audit.md`](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/evals/eval-audit.md),
[`report/SCHEMA.md`](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/evals/report/SCHEMA.md),
[`runner-scaffold.mjs`](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/evals/report/runner-scaffold.mjs)
and [`build-report-lite.mjs`](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/evals/report/build-report-lite.mjs).
They are written for an agent building an eval of a Claude API app with a user watching, where a
case costs cents and seconds.

The short version: their statistics are weaker than ours, and their checking around the numbers is
richer. Their noise floor counts every repeat as a new case, and their "test" split picks the winner
every round. But a person reads the cases and graded trials, the grader is checked against itself,
headroom is checked before any round, failures are classed, and a stalled loop sorts its failures
by cause.

### What the guides prescribe

- **Cases.** One flow per eval, 15–100 cases: production transcripts first, then bug reports, five
  to ten from the user, then variations of real ones, never synthesised "cold". The user sees every
  input: "Do not proceed until the user has looked and said yes." Inputs and grading are the two
  sign-offs; every other choice is a question with the agent's pick first, "(Recommended)".
- **Graders**, cheapest first: a programmatic check (for agents, the end state in a throwaway
  workspace), a pairwise judge against baseline outputs frozen on disk, a rubric judge, a human.
  The user reads five graded pilot transcripts: "Would you have scored any of these differently?"
  One yes and the rubric isn't ready. The audit adds: "Run the grader on the same output twice. If
  the result changes, there is grader variance"; an oracle near 100% and a null near 0%; a judge
  must fail an empty string, "I don't know" and a confident wrong answer; if more than one in ten
  failures read are the grader's error, fix it first.
- **Before round 1.** Put the noise floor beside the headroom and the smallest improvement worth
  acting on; if the floor exceeds either, stop. A baseline at "~95%+ ... cannot discriminate at the
  top". Every zero is triaged as harness error or grader verdict, and each failed attempt gets a
  class: refusal, harness or serving error, timeout, genuine failure. Where a stochastic build sits
  between change and score, rebuild the baseline two or three times: in one climb, builds spanned
  about 7 points against rescoring noise of ±1.4.
- **Repeats** are the user's pick, "Don't default this silently".
- **Split.** Train and test, "at random, stratified by `tags[0]` - never by baseline score", fixed
  once, redrawn if the means differ at baseline. Small sets go unsplit and are labelled
  "directional".
- **A round.** A fresh analyser reads only train traces; the orchestrator reads none. It proposes
  "one hypothesis ... in one patch", saved as `change.patch` with its reason in `change.md`, after
  a de-fluff pass. "Generalize, don't memorize": describe the failure, never paste its content.
  Spend a round only on a change that could clear the noise floor. Every round runs the full set.
- **Keep or revert.** "If train went up and test didn't ... revert"; a train regression reverts.
  `best` is the round with the highest test score, and the code ends at "the version that won on
  test". If the final delta is within noise, "recommend not merging".
- **Stopping.** A plateau is K ≥ 3 rounds under a delta above the noise floor ("two flat rounds is
  too few"). After two or three rounds inside the noise band, one round sorts every train failure
  into artifact gap, grader disagreement, harness, structural or variance.
- **Cost.** Cache health, a prompt audit, then a model × effort staircase: enter at the top tier's
  lowest effort, step down a tier on a pass and right on a fail, prune cells projected above the
  incumbent's cost. Then a prompt climb on the frozen model and a joint confirm at n ≥ 3. The
  quality floor is pre-registered; a cell near it needs n ≥ 2. Three gates: quality band, cost
  margin, and the predicted mechanism visible in the records. This guide alone says "The split
  whose score picks winners each round is a selection set, even if the guide calls it 'test'", and
  makes the confirm the headline.
- **Audit.** Two experts would agree on the grade; the reference passes the grader ("A 0% pass rate
  across all variants is more often a broken case than a hard one"); a case that fails every round
  is the grader's until shown otherwise (re-grading once cut +9 points to +3).
- **Records and runner.** `results.jsonl` per case and repeat, with `status` (truncated answers
  kept out of means) and `model` from the response; `errors.jsonl` for attempts with no scorable
  output; a trace per repeat. The runner: four workers, jittered backoff over five tries, a
  1,800-second ceiling per case, resume at (case, repeat), a served-model assertion, and a harness
  hash that blocks an unapproved edit. It computes no statistic, and the lite report prints means
  with no interval. The noise floor is `1/sqrt(n·reps)`, "25 cases × 2 reps is about ±14 points";
  SCHEMA's `PairedDelta` is a "Wald CI over per-case deltas".

### Compared

| Rule | The skill | awf's draft (011, this page) | Better, and why |
| --- | --- | --- | --- |
| Interval | `1/sqrt(n·reps)`, one proportion's width; Wald in the full viewer | paired t on per-case means, n−1 df | Ours: theirs counts repeats as cases (Miller: inconsistent), and z undercovers at small n (§1) |
| Held-out set | "test" picks `best` every round | select on tuning cases; holdout once, at the end | Ours: a test set read every round is a dev set (Dwork); their cost guide agrees |
| Keep or revert | two point comparisons per round | interval, planned looks, guard margins | Ours; theirs peeks every round uncorrected, and the max over rounds is biased up |
| Early stop | none; full set every round | futility at any case | Ours, when a trial costs dollars |
| Confirm | cost guide only: joint confirm is the headline | fresh trials before a keep | Ours, plus their rule that the confirm is the headline |
| Cases read by a person | a sign-off on every input | agents vote | Theirs, as a page, not a gate |
| Grader checks | pilots read; same output graded twice; oracle, null, negatives | oracle, `nop`, κ with the panel; match first's self-agreement unmeasured | Theirs adds self-agreement |
| Headroom | ≥ 95% warns; floor vs smallest effect | power arithmetic (§2), no check | Theirs: refuse a loop that can't see its target |
| Failure classes | refusal, harness, timeout, genuine; void a round whose errors differ | `scored`, `variant-failed`, `missing` | Theirs: each class needs a different fix |
| Stalls | failures sorted by root cause | nothing | Theirs |
| Proposer | train traces; no pasting; one hypothesis as a patch; scope table | one variable, why issues were missed | Theirs: a patch reverts cleanly, and no-paste guards overfitting |
| Cost | staircase, pre-registered floor, mechanism gate | tie-breakers | Theirs, for model-per-stage searches |

### Take into story 011 / autoresearch-loop

- [011] Before `run`, print headroom and the smallest difference the planned cases can resolve.
- [011] Score a sample of stored trials twice with one scorer; report self-agreement beside κ.
- [011] Split `missing` into scorer-failed, environment-failed and timeout; flag a run whose profile differs from the baseline's.
- [011] Flag a case every variant fails on every trial as a suspected key or scorer fault.
- [loop] Each try is a patch with a one-line hypothesis, kept or reverted whole.
- [loop] The proposer describes failure behaviour and never copies case content into the variant.
- [loop] The proposer states a predicted effect and the mechanism that must show in the records.
- [loop] Refuse a proposal whose best case sits inside the resolvable difference.
- [loop] After two or three rounds without a verdict, one round sorts tuning failures by cause.
- [loop] A scope file of what the proposer may and may not change.
- [loop] The confirm on fresh trials is the headline, never the selecting round's score.
- [later] A page with every case in full, for a person to read before trusting a dataset.
- [later] The model × effort staircase for choosing a model per stage.
- [later] Rebuild variance, if a variant builds an artifact that later trials read.

## For awf

The design has to hold for any case kind. So the review's labels stay inside the review scorer, and
everything below speaks only of cases, trials, metrics and variants
([`eval-terminology`](eval-terminology.md)).

**(a) The per-case record a scorer produces.** Take Inspect's value map with its three states, and
lm-eval's and MLflow's declared direction. Declare the metrics once per scorer, not per record:

```ts
type MetricSpec = {
  name: string;               // "recall.must-fix", "wrong", "cost-usd"
  direction: "higher" | "lower";
  range: [number, number];    // [0, 1] for a rate; needed for the interval's sanity checks and any e-process
  onVariantFailure: number | "missing"; // recall: 0; cost: "missing" (the spend is recorded anyway)
};

type CaseScore = {
  case: string; trial: number;
  outcome: "scored" | "variant-failed" | "scorer-failed" | "environment-failed";
  metrics: Record<string, number | null>;   // null only when outcome is not "scored"
  feedback?: string;                        // why, in words: for people and for a proposer
};
```

- A failed variant is a result. Its metrics take `onVariantFailure`, and it stays in the
  denominator, as story 008 already counts a failed trial as finding nothing. This is also DSPy's
  `failure_score`, GEPA's contract, and Harbor's zero.
- A failed scorer or environment is missing. It is left out, counted, and retried (Inspect's
  unscored). Never zero it.
- Direction lives on the metric, once. MLflow's second declaration on the threshold is a place to
  disagree with itself.
- Cost and time are metrics like any other, with `direction: "lower"`. They come from the
  accounting, not from the scorer. Then the acceptance rule treats them uniformly.
- Keep every trial as its own record and reduce in the comparison, as
  [`eval-orchestration`](eval-orchestration.md) settled. A per-case metric must be a per-case
  number. A pooled ratio across cases, such as all hits over all issues, cannot be paired. If the
  report wants one, it is computed separately and gets no paired interval.

**(b) The interval and its minimum n.** Per case, take the mean over the trials of each variant and
the difference, challenger minus baseline, signed so that positive is better. Report the mean
difference with a paired t interval on n−1 degrees of freedom. This changes the settled "bootstrap
interval over fixtures" in `variant-matrix-runner`. At these sizes the percentile bootstrap
undercovers, and resampling trials as well overcovers (section 1). Alongside it, report the
per-case wins, ties and losses (Braintrust's view). Report the estimated between-case and
within-case variance, so the next run can choose n and K by Miller's formula.

- Below 5 paired cases: counts only, no interval, and no verdict.
- From 5: the interval, marked indicative below 10. Hesterberg shows t intervals also undercover on
  skewed data at small n.
- A "better" verdict also needs at least 6 cases that differ, all or mostly in one direction. That
  is the smallest n at which the sign test can reach p < 0.05. It guards against an interval
  carried by one case with a large difference.
- Budget: more cases before more trials. Keep 2–3 trials so the variance components can be
  estimated. Go beyond that only when the case set is exhausted and the within-case term still
  dominates. The story's "at least three" should be restated as "two to three, then more cases".

**(c) The stopping rule.**

- "Clearly worse" may stop the run at any case, for example when the upper bound of the 95%
  interval is below zero. It is non-binding futility and costs nothing in error rate. Log it as
  "stopped: looked worse", not as a significant loss. This keeps the story's rule, with that label.
- "Better" is claimed only at looks planned before the run: for example the seeded subset, twice
  it, and the full set. At each look the bound is an O'Brien–Fleming boundary turned into a t
  quantile. With three looks the z bounds are 3.47, 2.45 and 2.00.
- Never compare the fixed-n interval with zero after every case to claim a win. That gives about
  25% false wins.
- Take Inspect's seam: asked before each case and trial, told each result, and a summary with a
  reason written into the report.
- Don't take optstop. It gives Bayesian precision for one variant, with no error control.
- Keep a betting e-process (`Π(1 + λ_i d_i)`, about 15 lines) as the fallback if looks can't be
  planned. Expect it to find only differences of 0.2 or more at 40 cases.

**(d) The acceptance rule over several metrics.** Declare it before the first run, as
`autoresearch-loop` already requires. Make it lexicographic, with one primary metric and guards:

1. Every guard metric is non-inferior. The interval's bound in the bad direction lies within a
   declared margin, for example wrong claims no more than 0.05 worse. This is MLflow's
   `min_absolute_change`, applied to an interval rather than a point.
2. The primary metric is better, by the stopping rule in (c).
3. On a tie, keep the simpler or the cheaper variant (autoresearch's simplicity rule), with cost and
   time as the declared tie-breakers.

- Don't scalarise across metrics (OpenEvolve's `combined_score`). A weighted sum trades a missed
  `must-fix` for dollars, which the loop story rejects.
- Use GEPA's per-case Pareto front only for choosing parents, never for acceptance.
- Several guard checks are several tests. Keep the guards few, and give each a margin people chose.
- Across many proposals in a loop, a 5% false-keep rate means about one false keep in twenty tries.
  So a kept variant should be confirmed by fresh trials before it becomes the incumbent. Tighten in
  later rounds, as `autoresearch-loop` says.

**(e) What a proposer needs.** Take GEPA's `EvaluationBatch` and reflective records, and AFlow's
experience log, from tuning cases only:

- per case and trial: the metric vector, the outcome, the feedback text, and a pointer to the run
  directory (the trace);
- for the variant: its cost and time totals, the comparison with its parent (difference, interval,
  wins and losses), and the decision with its reason;
- the history of tries, as the tree `autoresearch-loop` specifies: parent, change, result, decision;
- the metric specs and the acceptance rule, so the proposer knows what counts;
- the spend left, enforced by the loop.

The proposer never sees holdout cases, their scores or feedback, or the key. GEPA's `test_set`
"never enters the eval server". A failed trial reaches the proposer as its floor score plus the
error text, not as a gap.

**(f) Who owns what** (section 7).

- The project owns the scorer and its metric specs. The comparison is a function the loop takes as
  an argument, `compare(baseline: CaseScore[], challenger: CaseScore[], specs: MetricSpec[])`,
  returning better, worse, tie or undecided with a reason. It gets per-case records of both, as
  GEPA's `should_accept` does, not aggregates as OpenEvolve's `replace_cell` does, so it can pair
  and reduce. awf ships one standard implementation, the rule in (b)–(d), and a project may pass
  its own.

**(g) From Anthropic's guides** ([section 8](#8.%20Anthropic's%20build-eval%20and%20hillclimb)): headroom, scorer self-agreement, finer failure classes and a stall round, listed there by story.

**Not taken.**

- Percentile and BCa bootstrap as the headline interval below 20 cases. A two-level bootstrap at
  any size.
- A pooled standard error across all trials (Miller: inconsistent).
- Anytime-valid confidence sequences and mSPRT as the default rule at n ≤ 40.
- Counting a scorer's failure as a zero (Harbor, Braintrust's error handler).
- An unweighted mean of all metrics as fitness (OpenEvolve's fallback).
- Lowering temperature to cut variance (Miller).
