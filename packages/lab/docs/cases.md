# Cases: the reference

The rules of `awf-lab`'s case kind as built: how a dataset is laid out, what `env.ts` can do, how
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
trials. A **column** is one folder of code: your checkout, and each `--against` folder.

## Commands

| Command | Does |
| --- | --- |
| `case new {dataset}/{case}` | a case folder and its key's marker; the first time also `awf-lab.json`, `dataset.json` and a stub `env.ts` |
| `run [--dataset] [--cases a,b] [--failed] [--trials n] [--against {folder}] [--yes]` | each case, each trial, in throwaway folders, graded against its key |
| `report [{n}] [--case {name}] [--json]` | the last run again, or run n; one case in full |
| `score [{n}] [--grader {name}] [--dry-run] [--budget {usd}] [--yes] [--json]` | grade kept trials again without running them |
| `capture {run id} (--good \| --needs-work "{note}")` | a new case from a past trial or a real run, its key a draft |
| `runs` | the runs kept, newest first |

`run` and `score` print a plan with an estimate and ask at a terminal unless `--yes`. Never pipe
into them: without a terminal they don't ask.

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
- **Optional**: `known-failing: true`, `pass: 2/3` (this case's bar), `draft: true` and `captured`
  (from `capture`; a draft is never graded).
- **`marker`**: random words `case new` writes, a tripwire for a leaked key.
- Read strictly (YAML 1.2 core): an unknown field is refused, and `no` is not a boolean.

## `dataset.json` and `awf-lab.json`

`dataset.json` (`kind: awf.case-dataset/0`):

| Field | Means |
| --- | --- |
| `sandbox` | required; `"workflow"`: trust the sandboxes the workflow opens (task 10 adds `"lab"`) |
| `agentReach` | required; `{ network: [domains], webSearch?, sockets? }`: what agents may reach beyond their model domains |
| `timeout`, `setupTimeout` | the body's limit (`30m`), and `setup`'s and `observe`'s (`10m`) |
| `realHosts` | hosts the workflow's own code may reach for real |
| `pass` | the bar for every case: `"all"` or a fraction |
| `keep` | paths saved from the scratch folder, for graders |
| `graders` | `"name"` (a `graders.ts` export), `{ grader, onDemand }`, or `{ workflow: "graders/x.ts", readsFacts?, onDemand?, timeout? }` |
| `judgeAgent` | `{ harness, model }` for the criteria judge, over the workspace's |

`awf-lab.json` (`kind: awf.lab-workspace/0`): `judgeAgent`, and `store` in place of the default.

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
the case's last five verdicts in your checkout's column. A known-failing case that passes at three
trials or more is "now passing". `--failed` reruns the cases whose newest verdict was failed,
flaky or unclear, at that run's trial count.

Exit codes, from your checkout's column alone: **0** every case that must pass passed; **1** one
failed; **5** none failed, but a trial errored by the dataset or grading, or leaked; **3** flaky,
unclear, partial, a budget stop, or nothing graded; **2** refused before any trial; **4** the lab
broke. Known-failing cases never change it by their verdict.

## Grading

A grader is given the case (folder, input, key without its marker, `key/`), the result, the saved
files, the scratch folder during the trial, `params` (`{}` until task 9's parameters), and with `readsFacts` the facts and stages'
values. It returns `verdict?`, `numbers?` (`{ count, of }` summed per column, or `{ value }`
shown as a median), `reasons`, `parts?` (one per thing judged, with `label`, `why`, `settled`,
`votes`), or `notApplies` alone.

- **Code graders**: `defineGrader({ grade, readsFacts?, version? })` exports of `graders.ts`, run
  in a helper process in your checkout, never in the lab's.
- **Grader workflows**: files in `graders/`, run with your checkout's `awf run`, reading a grade
  folder through `gradeCase()`: `grade.json`, `case/`, `key.json`, `key/`, `result.json`,
  `facts.json`, `kept/`, and `previous.json` (its earlier parts, so it judges only what changed).
  Their cost is grading's.
- **Built in**: `expect`, and `criteria`, the lab's judge: three voters per criterion, each given
  it alone; the majority decides, a 2–1 split is counted, fewer than two agreeing is `unsettled`.
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

## `--against {folder}`

Another checkout of the project, with its own install. Its `env.ts`, code and `awf` run; its
cases, keys, `dataset.json` and graders are never read, so what counts as a pass comes from your
checkout. The report puts columns side by side: verdicts, time and cost, numbers, the cases that
came out differently (largest first), "also fails in {column}". It doesn't say which is better.

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

## The key stays hidden, and how far

`key.md` and `key/` are never copied into a case or scratch folder, and no trial record holds
them. A grader workflow's run, in the store, does. The marker is searched before and after each
trial, git history included; a trial where it turns up is leaked and not counted. It catches a
copied key, not one read and reworded. A workflow whose agents work inside your repository can
read a committed key from git history: keep its agents' folders outside it.

## What is kept

The store, `~/.awf/lab/{folder}-{hash}/` (one per checkout today; task 9 makes it one per
project): `runs/{n}/run.json`, each trial's `trial.json`, its built case, `kept/`, and
`scores.jsonl` (every grade, newest last), and the workflows' runs under `awf-runs/`. Records
hold real inputs and results: keep a dataset of private data in a private repository. A record
the lab can't read leaves its run out of history, and `runs` names it.

Records and formats are `/0`: an incompatible change makes them `/1`, with no converter for runs
(beta). The code shapes you write against (`defineEnv`, `c`, a grader's result) may change
without one.
