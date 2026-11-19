# Cases: the reference

The rules of `awf-lab` as built: how a dataset is laid out, what `env.ts` can do, how
trials run and are graded, and what the report and exit code mean. Story
[044](../../../docs/stories/044-cases-for-a-workflow.md) says why it works this way and what is
still to come. A worked example is [`examples/refund-desk`](../../../examples/refund-desk/README.md).

## A dataset

```text
evals/                         in your project, beside your workflows
  awf-lab.json                 marks the folder; names the judge's model
  mail/                        a dataset: a folder of evals/ holding dataset.json
    dataset.json               the sandbox setting, agents' reach, timeouts, graders
    files/                     what every case shares
    env.ts                     each case's world, and what to read off after the run
    graders.ts                 optional: the dataset's own code graders
    graders/                   optional: grader workflows
    capture.ts                 optional: turns a real run into cases
    cases/trip-form/
      input.json               optional: small facts, such as today's date
      files/                   optional: what env.ts reads, such as the email
      key.md                   what a good result looks like
      key/                     optional: files a grader needs
```

A **trial** is one run of the workflow on one case. A **run** is one `awf-lab run`, with all its
trials. A **column** is one folder of code under one set of parameters: your checkout, each
`--against` folder, and each combination of `--vary`'s values. The **reference column** is your
checkout under `--param` and each `--vary`'s first value: the exit code, history and `--failed`
are its.

## Commands

| Command | Does |
| --- | --- |
| `case new {dataset}/{case}` | a case folder and its key's marker; the first time also `awf-lab.json`, `dataset.json` and a stub `env.ts` |
| `run [--dataset] [--cases a,b] [--failed] [--trials n] [--against {folder}] [--tags a,b] [--holdout] [--param k=v] [--vary k=a,b] [--fresh] [--dry-run] [--budget {usd}] [--json] [--yes]` | each case, each trial, in each column, in throwaway folders, graded against its key; a trial kept from before stands in when nothing that shaped it changed |
| `report [{run}] [--case {name}] [--json \| --md]` | the last run again, or the one named; one case in full; Markdown to paste |
| `score [{run}] [--grader {name} \| --judge {harness}/{model} [--voters n]] [--tags a,b] [--dry-run] [--budget {usd}] [--yes] [--json]` | grade kept trials again without running them |
| `capture {run id} (--good \| --needs-work "{note}")` | a new case from a past trial or a real run, its key a draft |
| `label {run id} (--good \| --needs-work "{note}" \| --clear)` | the person's verdict on a trial, by its workflow run's id |
| `loop {name} --budget {usd} [--program {file}] [--proposer h/m] [--rounds n] [--trials n] [--cases a,b] [--param k=v] [--allowance {pct\|off}]` | a proposer changes a copy of the code, kept only when `compare` says better |
| `loop {name} --final [--budget {usd}]`, `loop {name} --patch` | the kept code against the start on the holdout, once; or as a patch |
| `runs` | the runs kept, newest first |

A run is named by its id, the time it began and four random hex digits
(`20261117-142233-a3f9`), or by those last four (`awf-lab report a3f9`).

`run` and `score` print a plan with an estimate and ask at a terminal unless `--yes`. Never pipe
into them: without a terminal they don't ask. `--dry-run` prints the plan alone. `--budget {usd}`
stops `run` starting trials once this run's estimates (its trials and their grading) reach it, and
`score` before a costly grader: the report says how many were not run, and the exit is 3 unless
it was worse already. `run --json` prints the report as `report --json` does.

## `env.ts`

```ts
import { defineEnv } from "@agentswf/lab/cases";
import * as mail from "../../school-mail/mail";

export default defineEnv({
  workflow: () => import("../../school-mail/workflow"),   // lazily, after the mocks exist
  setup(c) {
    const inbox = c.fake<mail.Mailbox>({ read: async () => c.json("email.json"), reply: async () => {} });
    c.mock(mail, { agentmailMailbox: async () => inbox });
    return {
      observe: (result) => ({ relevant: result.items[0]?.relevant ?? null, reply: inbox.reply.mock.calls[0]?.[1]?.text ?? null }),
    };
  },
});
```

- **`workflow(c)`**: the workflow as it ships. It may import a copy `setup` made in `c.scratch`
  (for a workflow that finds its project from its own file's folder); mock that copy's modules,
  not your checkout's.
- **`setup(c)`** builds the case's world and returns `{ observe, argv?, stages?, until? }`. It may
  set `process.env`, which only the trial's process sees.
- **`observe(result, { stages })`** returns the **facts**: a flat object of strings, numbers,
  booleans and `null`. It never asserts; the key does. `undefined` is a wiring mistake
  (`facts-missing`), `null` says the workflow gave nothing. Under `until`, `result` is `null`:
  annotate `observe(result: Result | null)`.
- **`stages`** gives a stage its value instead of running its work (side effects included, so
  `setup` recreates what later code reads); **`until`** stops the workflow once that stage
  returned. A name found nowhere in the workflow's source errors the trial (`stage-missing`); a
  real stage never entered is noted "never reached".

**The one rule**: `env.ts` reaches the workflow only through `workflow: () => import(…)`, and
imports its types with `import type`. A module it imports statically loads before the mocks and
keeps real copies of what it took. A workflow already loaded before `setup` is refused.

### `c`

| Call | Does |
| --- | --- |
| `c.json(name)`, `c.text(name)` | read the case's files over the dataset's shared ones; synchronous |
| `c.input`, `c.dir` | `input.json` (`{}` without it); the built case folder |
| `c.scratch`, `c.root` | the trial's empty working folder; the code folder |
| `c.mock(module, fakes, { real? })` | every function export replaced; the unfaked ones refuse |
| `c.fake<T>(fakes, { name? })` | a strict typed stand-in for an object a factory returns |
| `c.http(routes)`, `c.http.requests` | answers the workflow's `fetch` by `"{METHOD} {URLPattern}"` |
| `c.cleanup(fn)` | teardown, after `observe`, even when the run fails |
| `c.params` | the trial's parameters, `{ name: "value" }`; `{}` without `--param` or `--vary` |

- **`c.mock`** is `spyOn` on each export, typed by the module, so a wrong fake is a type error. A
  call to an export not faked throws "no fake for mail.delete in this case" and errors the trial
  as the dataset's, even if the workflow catches it. Classes stay real unless faked; pure helpers
  stay real when named in `real`; `node:*` and `bun` are refused. It returns plain `bun:test`
  mocks.
- **`c.fake`** refuses a member not given when called; reading `then`, `toJSON` or a symbol gives
  `undefined`, so it can be awaited and logged.
- **Unused**: a fake or route never called is listed on the case's report line, unless `observe`
  read its calls.
- **`c.http`**: the lab's `fetch` replaces `globalThis.fetch` in every trial, from a preload. A
  host a route names is strict; any other host is refused unless it is the engine's own or in
  `realHosts`. Every route names a literal host. A unix-socket `fetch` goes through, recorded. A
  client on Node's `http` or `Bun.fetch` is not seen: mock its module.
- **Not here**: `expect` (return a fact) and `setSystemTime` (it freezes the engine too; fake the
  day through the workflow's own clock function).

### Where a workflow touches the world

| The call is made by | Faked with |
| --- | --- |
| the workflow's own code | `c.mock`, `c.http` |
| a tool the workflow gives its agents | the same: tool handlers run in the trial's process |
| a command the workflow's code starts (`gh`, `git push`) | wrap it in a module of the workflow's and mock that |
| an agent's own commands (`curl`, a CLI) | not faked; their reach is checked against `agentReach` |

The model is never faked: it is what a case measures. Give agents a service as tools, not as a
command, and cases can fake it.

## `key.md`

```markdown
---
kind: awf.case-key/0
marker: lantern-copper-walrus-tangerine
expect:
  relevant: true
  children: "Daniel"
must:
  - the summary gives the deadline for the form and the money, Tuesday November 3
must-not:
  - the summary presents the grade 5 spring trip as something to act on
---

Why this case exists.
```

- **`expect`**: facts and the exact values they must have. Strings are quoted. `error` and names
  starting `_` are reserved: a non-empty `error` fact fails the trial as the workflow's.
- **`must`, `must-not`**: criteria, sentences the judge decides. A criterion is known by its text:
  edit it and it is judged again.
- **Optional**: `known-failing: true`, `pass: 2/3` (this case's bar), `draft: true`, `captured`
  (from `capture`; a draft is never graded), and `tags: [forms, school]`, plain words the report
  groups cases by and `--tags` picks them by. No grader reads tags: editing them grades nothing.
- **`marker`**: random words `case new` writes, a tripwire for a leaked key.
- Read strictly (YAML 1.2 core): an unknown field is refused, and `no` is not a boolean.

## `dataset.json` and `awf-lab.json`

`dataset.json` (`kind: awf.case-dataset/0`):

| Field | Means |
| --- | --- |
| `sandbox` | required; `"workflow"`: trust the sandboxes the workflow opens; `{ "lab": "srt" }`: the lab's box around each whole trial |
| `agentReach` | required; `{ network: [domains], webSearch?, sockets? }`: what agents may reach beyond their model domains |
| `timeout`, `setupTimeout` | the body's limit (`30m`), and `setup`'s and `observe`'s (`10m`) |
| `realHosts` | hosts the workflow's own code may reach for real |
| `pass` | the bar for every case: `"all"` or a fraction |
| `reuseDays` | how many days a kept trial may stand in for a new one; 14, 0 never |
| `holdout` | cases set aside for a final check: `run`, `--failed` and history leave them out; `run --holdout` runs them alone |
| `keep` | paths saved from the scratch folder, for graders |
| `graders` | `"name"` (a `graders.ts` export), `{ grader, onDemand }`, or `{ workflow: "graders/x.ts", readsFacts?, onDemand?, timeout? }` |
| `judgeAgent` | `{ harness, model }` for the criteria judge, over the workspace's |

`awf-lab.json` (`kind: awf.lab-workspace/1`): `judgeAgent`; `store` in place of the default;
`records`, a folder inside `evals/` that each run's records are also written to, to be committed;
`hide`, paths of the code folder, relative to it, that the lab's box hides as it hides keys, for
tracked files that hold or quote one.

## A trial

1. The lab builds a case folder (the shared files, the case's own, `input.json`; never the key)
   and an empty scratch folder, outside the repository, and looks for the marker there.
2. It starts the code folder's own `awf`: `bun --no-env-file --preload {fetch} {awf bin} run
   --json --quiet --cwd {scratch} --run-root {store} --timeout {backstop} evals/{dataset}/env.ts`.
3. In that one process: `setup`, the workflow, `observe`, teardown. The phase, refused calls,
   unused mocks and the facts go to the trial file (`AWF_LAB_TRIAL`), read whatever the ending.
4. The lab checks every agent's sandbox against `agentReach`, looks for the marker again (scratch
   folder, result, saved files, the agents' logs), saves `keep`, grades, and deletes both folders.

- **Before the first trial**, each folder is checked: `env.ts` type-checks with that folder's
  `tsc`, `@agentswf/lab/cases` resolves, its `awf` is at least 0.1.1 and writes records the lab
  reads, and `judgeAgent` is set when keys have criteria. A miss exits 2.
- **Timeouts are per phase**, timed by `defineEnv`; `--timeout` is a backstop. On a timeout or a
  cancel, teardown still runs.
- **The reach check**: an agent with no sandbox, a sandbox domain beyond `agentReach` and the
  agent's model domains, web search or sockets not allowed (cursor always counts as web search):
  the trial errors as `reach`. It checks after the fact; it is not a wall.
- **Order**: trial 1 of every case and column, then trial 2. One `run` or `score` at a time per
  machine, under a lock in `~/.awf/lab/`.

## Outcomes, verdicts, exit codes

A trial's outcome, the first that applies:

| Outcome | When |
| --- | --- |
| leaked | the marker, or a copy of a `key/` file, turned up |
| errored | the **dataset's** (`setup`/`observe`/teardown threw or timed out, a refused call, `reach`, `prepare` refused the argv, `fact-type`, `facts-missing`, `stage-missing`, a given value its schema refused), **grading's**, the **provider's** (a missing login; tried once more), or the **lab's** |
| failed | a grader failed it, or the workflow erred: its body failed, timed out or stopped, or `error` was set |
| undecided | a grader could not tell |
| passed | every grader with a verdict passed it |
| graded by numbers | graders gave numbers only |
| not graded | no grader applies, or the key is a draft |

A case's verdict, with T trials, a bar b, need = ceil(b × T), p passed, f failed: **passed** when
p ≥ need; **failed** when f > T/2; **flaky** when it has both; **unclear** otherwise. History shows
the case's last five verdicts in the reference column, from earlier runs with a column of your
checkout, by its path on this machine, under the same parameters; a run that only reused trials
adds none. Runs from another machine's records show in `runs` and `report {run}`, not in history.
A known-failing case that passes at three trials or more is "now passing". `--failed` runs the
cases whose newest verdict was failed, flaky or unclear again, at that run's trial count, and
always fresh: the trials that failed are never its answer.

Exit codes, from the reference column alone: **0** every case that must pass passed; **1** one
failed; **5** none failed, but a trial errored by the dataset or grading, or leaked; **3** flaky,
unclear, partial, a budget stop, or nothing graded; **2** refused before any trial; **4** the lab
broke. Known-failing cases never change it by their verdict.

## Grading

A grader is given the case (folder, input, key without its marker, `key/`), the result, the saved
files, the scratch folder during the trial, `params`, and with `readsFacts` the facts and stages'
values. It returns `verdict?`, `numbers?` (`{ count, of }` summed per column, or `{ value }`
shown as a median), `reasons`, `parts?` (one per thing judged, with `label`, `why`, `settled`,
`votes`), or `notApplies` alone.

- **Code graders**: `defineGrader({ grade, readsFacts?, version? })` exports of `graders.ts`, run
  in a helper process in your checkout, never in the lab's.
- **Grader workflows**: files in `graders/`, run with your checkout's `awf run`, reading a grade
  folder through `gradeCase()`: `grade.json`, `case/`, `key.json`, `key/`, `result.json`,
  `facts.json`, `kept/`, and `previous.json` (its earlier parts, so it judges only what changed).
  Their cost is grading's.
- **Built in**: `expect`, and `criteria`, the lab's judge: three voters per criterion unless
  `judgeAgent` gives `voters` (odd, up to 9), each given it alone; a majority of them decides, a
  split is counted, fewer agreeing is `unsettled`.
  A criterion judged from saved files is marked "read, not run". It is judged only on changed
  criteria when its version and `judgeAgent` are unchanged.
- **Order, cheap first**: `expect`, code graders, then grader workflows and the judge, which are
  skipped once a trial failed ("not judged").
- **Who decides** is read from the current `dataset.json` and key: `expect` when the key has
  values, each dataset grader not `onDemand`, the judge when there are criteria. Other grades are
  shown as "not in the verdict".
- **Versions**: each grader declares semver (`defineGrader`'s `version`, a workflow's
  `meta.version`, `1.0.0` when absent). A minor bump means it judges differently.

**`score`** grades kept trials again, never running `env.ts`: a grader with no grade, an errored
one, a changed key digest (the part of the key it reads), a changed `{major}.{minor}`, or for the
judge a changed `judgeAgent`. A trial whose case input changed is left, with "run it again".
`--budget` stops before a costly grader once the estimates reach it (exit 3).

**Judges compared, `score --judge {harness}/{model} [--voters n]`**: the kept trials' criteria
judged again by another judge, beside the one `judgeAgent` names. Its grades are kept with its
agent and voters, marked `beside`, and never decide: the verdict stays the configured judge's.
The report gives each beside judge's trials, grading cost and how often its verdict differs, and
with labels each judge's agreement with the person and its cost, the deciding one marked; a judge
asked again grades only what changed. Switching judges is an edit of `judgeAgent`.

## `--against {folder}`

Another checkout of the project, with its own install. Its `env.ts`, code and `awf` run; its
cases, keys, `dataset.json` and graders are never read, so what counts as a pass comes from your
checkout. The report puts columns side by side: verdicts, time and cost, numbers, the cases that
came out differently (largest first), "also fails in {column}". It doesn't say which is better.

## Reuse

A trial kept from an earlier run stands in for a new one, within `reuseDays`, when nothing that
shaped it changed. That is one digest over: the code (every file git would hold in the folder,
less each dataset's cases, keys, `dataset.json`, graders and `capture.ts`, `awf-lab.json` and the
records folder; `env.ts` and what it imports stay in), the parameters, the built case, the trial
settings of `dataset.json` (`sandbox`, `agentReach`, the timeouts, `realHosts`, `keep`), the
folder's `agentswf` version and the lab's own trial code. Outside git, nothing is reused.

- What only grades is left out, so a key, grader or bar edit runs nothing: the run grades the
  reused trials again where their grades are out of date, as `score` would.
- Never an errored, leaked or stopped trial. A copy is never counted twice: asking for more trials
  runs only the difference. `--fresh` runs every trial anew.
- A reused trial is not copied: the new run's folder holds `reused.json`, a pointer to where it
  ran, and its grades stay one list there, whichever run grades it again. One workflow run stands
  for one trial of one column, so two columns that shape trials alike (a clone at the same
  commit) each get their own. The plan counts reused trials and prices grading them again; that
  grading counts towards `--budget`. The report gives their cost apart.
- The model behind a name can change without the lab knowing: that is what the window is for.

## Parameters: `--param` and `--vary`

`--param {name}={value}` sets a parameter for every trial; `--vary {name}={a,b}` makes a column for
each value, and with more than one, every combination, in each folder. `env.ts` reads them as
`c.params` (the lab passes them in `AWF_LAB_PARAMS`) and turns them into argv or a module to load;
graders get them as `params`. A name is a letter then letters, digits, `-` or `_`; a value is a
string. A column is named by the folder and the parameters that differ, such as `model=b` or
`against 1 model=b`. A setting with many named combinations, such as review variants, is one
parameter whose value `env.ts` looks up in its own table: `--vary variant=lenses,fork`.

## Labels

A grade is only as good as its agreement with the person, and that drifts as criteria, prompts
and models change, so it is measured on every report.

- **`awf-lab label {run id} --good`**, or **`--needs-work "{note}"`**: the person's verdict on one
  trial, found by its workflow run's id (`report --case` prints each trial's, with the command).
  The person runs it, or tells a coding agent what was wrong. `--clear` takes it back; a newer
  label replaces an older. `capture` of a trial labels it with its mark.
- Labels are kept in `{store}/labels/{dataset}.jsonl`, one line each (the trial's workflow run
  id as `runId`, not the lab's run id), and in the records folder when it is set, a file each. A label is on the workflow run, so a reused copy keeps it, and a `score` that
  grades again shows at once whether the lab now agrees more.
- **Agreement**, on the run's labeled trials: of those marked good, how many the lab passed; of
  those marked needs-work, how many it failed, given apart, since a lab that passes everything
  agrees with a mostly good set. The same for each deciding grader, the judge by its agent and
  version; each disagreement is listed with its note. `report --json` gives it as `labels`.
- **The judge's mark**: the report says "not checked against a person" until the person labeled
  10 trials of the dataset that the current judge (its agent and `{major}.{minor}`) graded, 3 of
  them needs-work, counted across runs.
- A label is the verdict on the trial, not on each criterion; the note says why.

## `capture`

- **A trial's run**: its case's files and input are copied; with `--good`, `expect` is drafted
  from its facts (strings over 60 characters left commented: prose won't match word for word).
- **A real run** in `.awf/runs/{workflow}/{id}`: the dataset's `capture.ts`, a
  `defineCapture(({ run, root }) => cases)`, rebuilds one or more cases from it in the helper
  process. `--good` needs a run whose last attempt completed.
- The key is a draft: remove `draft: true` once it says what a good result is.

## The report

One line per case that did not pass, with its passes, the first failing check and its reason, and
its history; "passed, with notes" for unused mocks or stages never reached. Then case verdicts,
trial counts (errored by whom, undecided, leaked, splits), median time and cost per trial with
grading's cost apart, each dataset grader's pooled numbers, median time per stage, the judge and
whether it shares a family with the workflow's model, grades out of date, and runs history left
out. `report --case` shows each trial's result, facts, votes and reasons, and the command for its
agents' logs. `--json` output is `awf.case-report/0`; schemas are in `schema/`.

## Rates: how sure

Cases are the independent units: a case's trials share its input and are never pooled as if
independent. Each interval is 95%.

- **Cases passed**, with Wilson's interval: `5/7 cases passed, 95% 36–92%`.
- With more than one trial a case, **the mean of each case's pass fraction**, its interval from
  the spread across cases (Student's t); at k trials a case, **pass^k** (cases whose k trials all
  passed: what a workflow that must work every time is judged on) and **pass@k** (any passed).
- With columns, each column's rates and its **difference from the reference on the same cases**:
  the mean change in pass fraction, an interval from the per-case changes, and "no difference
  shown" unless a sign test on the cases that changed says so (p < 0.05: six cases one way at
  the least). Two columns' own intervals can overlap while the paired difference is clear.
- **By tag**: a line per tag, its cases passed in each column, and its failing cases.
- Which column is better is `compare`'s.

## `compare`: what "better" means

A dataset says it by exporting `compare` from `graders.ts`, built with `@agentswf/lab/cases`:

```ts
import { better } from "@agentswf/lab/cases";

export const compare = better.paired({
  primary: "match.recall",
  guards: [{ metric: "cost", margin: 0.05 }],
  metrics: { "match.recall": { onFailure: 0 } },
});
```

- **`better.paired({ primary, guards?, tiebreak?, … })`**: the review loop's sequential paired
  rule on per-case means: "worse" as soon as it shows, "better" only past an O'Brien–Fleming
  bound at the planned looks, guards that may not get worse by their margin, tie-breakers.
- **`better.mean(fn, { direction?, onFailure? })`**: better on the mean of a number of your own per
  trial, paired by case.
- **`defineComparison({ version, compare })`**: your own rule, given `{ reference, column,
  planned }` and returning `{ verdict, stop, reason, metrics }`.
- A metric is `passed` (1 or 0), `cost`, `seconds`, or a grader's number, `{grader}.{number}` (a
  count as its fraction). `cost` and `seconds` are better lower, the rest higher; `metrics` says
  otherwise, and `onFailure` what a trial whose workflow failed scores (`missing` leaves it out).
  Errored and leaked trials are left out.
- The report gives each column's verdict against the reference, the rule's version, its reason,
  and whether more trials may tell; `report --json` gives it as `compare` on each column. `stop`
  is for a loop's try: `run` still runs every trial it planned. It runs in the helper process in
  your checkout, as code graders do.

## The lab's box: `"sandbox": { "lab": "srt" }`

The whole trial, `awf run --boxed` with `env.ts`, the workflow's code and its agents, runs in one
srt sandbox, so code an agent wrote reads no key. srt does not nest, so `--boxed` sets the
workflow's own sandboxes aside and its agents run in the box as host agents.

- **Reads**: the system, the toolchain (bun, git, each harness's executable and install tree), the
  code folder and what its `node_modules` links lead to, the case and scratch folders.
- **Hidden inside them**: `.git` (history holds committed keys), every case's `key.md` and `key/`,
  what git ignores but `node_modules` (a `.env`), the records folder, `hide`'s paths, the store;
  the home folder whole.
- **Writes**: the scratch folder, and the trial's own run root, home, temp folder and engine
  sockets; the run's records move into the store after.
- **Network**: `agentReach.network`, every harness's model domains and `realHosts`.
- **Logins**: the home is fresh, so an agent logs in from the environment, as claude does with
  `CLAUDE_CODE_OAUTH_TOKEN`; the operator's harness state, which can hold earlier judging's
  transcripts, is never in the box.
- **Reach**: the box is each agent's reach, recorded as the trial's. Web search is a model's own
  tool and is not stopped by the box; `agentReach.webSearch` is not enforced under it.
- Docker is not built yet; macOS's srt is.

## The loop: `awf-lab loop {name}`

A proposer agent changes a copy of your code, the copy runs against the code it changed, and it
is kept only when the dataset's `compare` says better. It needs `"sandbox": { "lab": "srt" }` and
a `compare` in `graders.ts`, and spends until `--budget`.

1. **The first run** names `--program`, the operator's steering, which the proposer reads every
   try, and copies your repository as it stands into the store: what git would hold, less each
   dataset's `cases/` and the records folder, its installs linked. The start is the incumbent.
2. **Each try**: the incumbent runs on the tuning cases, the dataset's cases but the holdout, in
   an order seeded by the loop's name (`--cases` picks some); its trials are reused where nothing
   changed. The proposer, in the lab's box, reads a bundle (the program, each tuning trial's facts,
   outcome and every grader's verdict, numbers, reasons and parts, the earlier tries, the rules)
   and changes a clone of the incumbent's code; it may write the clone but not its `evals/`. The
   change is committed as the try. The graders' reasons and parts may quote a tuning case's key,
   as `expect`'s "the key wants" and a criterion's text do: the tuning cases are what the proposer
   learns from. A held-out case, its key and its trials never reach it, and neither box reads a
   key of the workspace, wherever the code it runs sits.
3. **The scope check**, in code, before anything runs: a try that changed nothing, anything under
   `evals/` or an install, put a tuning key's marker or about fifty characters of its words in a
   changed file (forty-character windows, ten apart), or wrote a file git doesn't see is refused.
4. **The run**: the incumbent and the try, as two columns, case by case in the seeded order, each
   case's trials in both before the next, until `compare` says stop, given only the cases both
   ran. On `better` the try is the incumbent; otherwise it is discarded.
5. **Stops**: the cap (exit 3), checked before each run and before the proposer; three tries in
   a row that kept nothing, which stop the command but not the loop (look at them, then run it
   again and it goes on); the rounds (`--rounds`, 1 unless told). The cap counts the
   proposer's and the trials' estimates, summed from each try's records as it goes: the runs it
   started, read from the store, and each proposer run's estimate, so a cut loses none of it. A
   run that printed no record, as one cut short, is priced from its folder.
   A run stops starting trials once the cap is reached, so its last trial may cross it. A try
   the cap stops is left undecided; a larger `--budget` on `loop {name}` raises the cap and
   resumes it.
   `--allowance` waits before each step while a plan window the proposer, or a `harness/model`
   parameter, draws on is that far used (90% unless told; `off`).

`loop {name}` again resumes: a try cut short after its proposal runs with it; before, it is
proposed again, what it spent before still counted. A loop resumed with another dataset,
holdout, `graders.ts`, `--trials`, `--param` or tuning cases is refused: its tries are judged
alike. A loop takes no `--tags`, `--against`, `--vary`, `--failed`, `--fresh` or `--holdout`.
`--final --budget {usd}` runs the kept code against the start on the held-out cases, under the
loop's `--param`, each check recorded (a second says it was asked again); `--patch` prints the
kept code against the start. Records: `{store}/loops/{name}/loop.json`, `program.md`,
`cap.jsonl` (a cap a resume set), `tries/{n}/` (`code/`, `bundle/`, `runs.json`,
`proposer.jsonl`, `proposal.json`, `change.patch`, the try's change against its parent's code,
`try.json`), `finals/{k}.json`; their schemas are `schema/case-{loop,try,proposal,final}.schema.json`.

With `records` set, each loop command also writes the loop's own files into
`{records}/loops/{name}/`: all of the above but the code, the bundles and the proposer's runs. A
store that lacks them, as on a clone, reads them back, and builds the code again from the start
commit and each change it needs, so the loop goes on, `--patch` and `--final` included, wherever
the project is cloned. A loop started from uncommitted changes can't be built again: it goes on
where it started. A loop of the same name started elsewhere, or a try decided otherwise in the
records, is refused.

## The key stays hidden, and how far

`key.md` and `key/` are never copied into a case or scratch folder, and no trial record holds
them. A grader workflow's run, in the store, does. The marker is searched before and after each
trial, git history included; a trial where it turns up is leaked and not counted. It catches a
copied key, not one read and reworded. A workflow whose agents work inside your repository can
read a committed key from git history: keep its agents' folders outside it.

## What is kept

The store, one per project: `~/.awf/lab/{project}-{first commit}/`, named by the main checkout's
folder and the repository's first commit, so every worktree and clone on a machine shares it
(outside git, one per folder). It holds `runs/{id}/run.json`, each trial's `trial.json`, `kept/`
and `scores.jsonl` (every grade, newest last); each built case once, under `inputs/{digest}/`;
and the workflows' runs under `awf-runs/`. A record the lab can't read leaves its run out of
history, and `runs` names it.

**`records`**: with it set, `run`, `score` and `label` write their run into `{records}/runs/{id}/`,
with the runs it reuses: the run, each trial's record or reuse pointer, `kept/`, and its grades as
a `scores/` folder of one-line files; labels go to `{records}/labels/{dataset}/`, a file each, so
two branches that grade or label never touch the same file. Not the built case, which is built
again from the case folder and checked against the trial's digest, nor the agents' logs, which a
grader's run can fill with a key. Every command first reads the records into the store, adding
what it lacks and writing nothing in `evals/`: a fresh clone sees the runs committed and reuses
their trials, and grades made elsewhere come in. A bare `report` or `score` takes your checkout's
newest run, not another worktree's.
Records hold real inputs and results: keep a dataset of private data in a private repository.

Records and formats are `/0`: an incompatible change makes them `/1`, with no converter for runs
(beta). The code shapes you write against (`defineEnv`, `c`, a grader's result) may change
without one.
