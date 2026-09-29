# What eval tools call things, and how their command lines select and show

Checked 2026-09-28 for [story 008](../stories/008-review-scorer.md), sections "Terms and where
things are" and "The command line, revised". We read the docs of Inspect AI, Braintrust, LangSmith,
promptfoo, Harbor and MLflow, and reused the source reading in
[`eval-orchestration`](eval-orchestration.md) and [`eval-cli-config`](eval-cli-config.md) (both
2026-09-26). This page covers the words and the command-line surface: selecting, re-scoring,
viewing, and output for programs.

The short version: the tools agree on **dataset**, **scorer**, **score**, **metric** and
**experiment**. They disagree on the unit of data (sample, example, test case, task, instance), on
the thing being evaluated (solver, task, target, provider, agent), on the known answer (target,
expected, reference outputs) and on repeats (epochs, trials, repetitions, attempts). "Judge" is
everyone's word for a scorer that uses a model, and MLflow says so outright. "Fixture" and
"judging" appear in none of them. On the command line, every tool re-scores stored output with its
own verb or flag, selects by id and by stored result, and shows results in a local viewer that reads
the same files the command line writes.

## 1. The words

| Concept | Inspect AI | Braintrust | LangSmith | promptfoo | Harbor | MLflow |
| --- | --- | --- | --- | --- | --- | --- |
| a collection of cases | dataset | dataset | dataset | tests | dataset | dataset |
| one case | sample | (dataset) record, "test case" | example | test case | task | record |
| what it is given | input | input | inputs | vars | instruction + environment | inputs |
| the known answer | target | expected | reference outputs | assertion values | tests (the verifier's) | expectations |
| what is evaluated | solver / agent, with a model | task | target | provider × prompt | agent, with a model | predict function |
| one attempt on one case | sample in the log | span, trial | run | result | trial | trace |
| repeats | epochs | trials (`trialCount`) | repetitions | `--repeat` | attempts (`-k`) | — |
| what grades it | scorer | scorer | evaluator | assertion, grader | verifier | scorer |
| a model-based grader | model-graded scorer, `grader` role | LLM-as-a-judge scorer | LLM-as-judge evaluator | `llm-rubric` | agent judge (Rewardkit) | judge |
| its result | score | score | feedback | grading result | reward | feedback, assessment |
| aggregates | metrics | summary scores | aggregate | stats | metrics | metrics |
| one run over a dataset | eval (a log) | experiment | experiment | eval | job | evaluation run |
| its comparison point | — | baseline experiment | baseline | — | — | — |

Sources: Inspect [tasks](https://inspect.aisi.org.uk/tasks.html),
[datasets](https://inspect.aisi.org.uk/datasets.html),
[scorers](https://inspect.aisi.org.uk/scorers.html),
[model graded](https://inspect.aisi.org.uk/model-graded.html); Braintrust
[evaluate](https://www.braintrust.dev/docs/evaluate) ("the examples you evaluate, including inputs
and optional expected outputs"; a task is "the behavior you evaluate"; an experiment is "the
immutable, comparable record of your eval runs") and `trialCount` in
[`framework.ts`](https://github.com/braintrustdata/braintrust-sdk/blob/main/js/src/framework.ts);
LangSmith [evaluation concepts](https://docs.langchain.com/langsmith/evaluation-concepts); promptfoo
[configuration](https://www.promptfoo.dev/docs/configuration/guide/); Harbor
[core concepts](https://docs.harborframework.com/core-concepts/index) (a trial is "one agent's
single attempt at completing one task"; a job is "a collection of trials"; a verifier "evaluates
the agent's work and produces the task's reward"); MLflow
[scorers](https://mlflow.org/docs/latest/genai/eval-monitor/scorers/) ("both LLM judges and
code-based scorers are classified as types of scorers").

Also worth noting:

- **`oracle` and `nop`** are Harbor's built-in agents, selected with `-a`
  ([run a job](https://docs.harborframework.com/core-concepts/jobs/run-a-job)). Terminal-Bench,
  its predecessor, had the same pair. Ours have the same names and the same jobs. Experimental
  design calls them a positive and a negative control.
- **"Target"** means the known answer in Inspect, but the system under test in LangSmith, and a
  provider in promptfoo's `--filter-targets`. It can't be used without a definition.
- **"Fixture"** in pytest and Playwright is setup code that a test requests, not a case with
  answers. Readers from either will read it that way.
- **Checking a grader against known labels** is "alignment" in LangSmith and MLflow, and
  "meta-evaluation" in the literature. Braintrust runs its own scorers as ordinary evals over
  labelled data ([`autoevals/evals`](https://github.com/braintrustdata/autoevals/tree/main/evals)).

## 2. Selecting a subset and re-scoring

| Need | Inspect | promptfoo | Harbor |
| --- | --- | --- | --- |
| the first n, or a range | `--limit 10`, `--limit 10-20` | `--filter-first-n`, `--filter-range` | `-l` |
| a seeded sample | — | `--filter-sample {n}` `--filter-sample-seed` | — |
| by id or pattern | `--sample-id 22,23`, `--sample-id '*_advanced'` | `--filter-pattern`, `--filter-metadata k=v` | `-i {glob}`, `-x {name}` |
| by an earlier result | `inspect eval-retry {log}` | `--filter-failing`, `--filter-errors-only`, `--retry-errors`, `--resume` | `harbor job resume` |
| run without scoring | `--no-score` | — | — |
| score stored output again | `inspect score {log} --scorer {s}` | `--model-outputs` with `--assertions` | `harbor trial regrade`, `harbor job regrade` |
| repeats | `--epochs` | `--repeat` | `-k` |
| what would run | — | — | `--dry-run`, `--diff {job}`, `--print-config` |

Sources: Inspect [options](https://inspect.aisi.org.uk/options.html) (`--limit`: "a maximum (e.g.
`10`) or range (e.g. `10-20`)"; `--no-score`: "use the `inspect score` command to score output
later"), [handling errors](https://inspect.aisi.org.uk/handling-errors.html); promptfoo
[command line](https://www.promptfoo.dev/docs/usage/command-line/); Harbor
[run a job](https://docs.harborframework.com/core-concepts/jobs/run-a-job) and
[regrade](https://harborframework.com/docs/core-concepts/jobs/regrade).

What they share:

- **Re-scoring is its own command**, not a mode of the run command: `inspect score`, `harbor
  regrade`. promptfoo, which has no such command, is the awkward one.
- **Selection by an earlier result is common**: failing, errored, unfinished. promptfoo spends
  twelve `--filter-*` flags on it, one per kind of predicate.
- **Re-running a command finishes what is missing.** Inspect's eval sets: "simply re-execute the
  same command and any work not yet completed will be scheduled"
  ([eval sets](https://inspect.aisi.org.uk/eval-sets.html)).
- None selects below the case, as story 008's `--only {fixture}#{n}` does. A score is per sample
  in all of them.

## 3. Showing results, to people and to programs

- **Viewers read the files the command line writes.** `inspect view` serves the log directory,
  `promptfoo view` its local store, and `harbor view {jobs dir}` a job list that opens into trials
  with "reward, cost, tokens, timing, and trajectory"
  ([view job results](https://docs.harborframework.com/core-concepts/results/view-job-results)).
  None of the viewers has state that the command line can't reach.
- **Every result has a stable id.** A promptfoo eval id, an Inspect log path and sample id, a
  Harbor job and trial directory. `promptfoo show {id}` and `inspect log dump {log}` print one;
  the viewers' pages are addressed by the same ids.
- **Programs get JSON and the schema of it.** `inspect log list --json` (filter with `--status`),
  `inspect log dump`, and `inspect log schema` exist so that "external languages" can read logs
  ([eval logs](https://inspect.aisi.org.uk/eval-logs.html)). Harbor prints its job config schema
  with `harbor job schema`. promptfoo exports with `-o {file}.json` and `promptfoo export eval
  {id}`.
- **Display modes.** Inspect's `--display` takes `full`, `conversation`, `rich`, `plain`, `log`
  or `none`. That is progress for a person, a log or a program chosen with one flag.
- **Listing what exists.** `promptfoo list evals|prompts|datasets`, `inspect list tasks`,
  `inspect log list`.

## For awf

Recommendations, argued in story 008:

- **Take the words the tools agree on:** dataset, scorer (a judge is a scorer that uses agents),
  score, metric, baseline.
- **Pick the plainest word where they disagree:**
  - **case**, not sample, since a sample also means one draw of several;
  - **trial** for one attempt and **`--trials`** for repeats (Harbor and Braintrust);
  - **key**, which is the most exact: an answer key, graded, with exclusions, revised as it grows.
    "Target" is ambiguous and "expected" suggests an exact output.
- **Keep our words for our things:** variant (the thing evaluated), finding, issue, the label
  values, key revision.
- **Drop "fixture" and "judging".**
- **Re-scoring is its own verb, `score`.** Take selection by stored result as one predicate flag,
  not promptfoo's twelve.
- **Keep one address syntax** for every command, every JSON document and every page of a future
  viewer. JSON goes on every command, with a command that prints its schema.
