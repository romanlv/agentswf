---
title: Workflows
description: A workflow file's parts, its arguments, result, report and printed summary, and how it decides what to do next and when to stop.
---

# Workflows

A workflow is one TypeScript file that says which agents do what, in what order, and what comes
back. This page covers the file itself: what it takes from the command line, what it returns,
what it prints and saves, and how it stops when it can't go on. The words it uses (agent, turn,
outcome, run) are defined in [How it works](/guide/how-it-works).

## A workflow file

<<< @/../examples/site/guide/workflows.ts#file

Saved as `check-docs.ts`, it runs with the files to check after `--`:

```sh
awf run check-docs.ts -- README.md docs/setup.md
```

One codex agent checks each file in turn. When every file has an answer, the run completes and
prints one line a file:

```text
README.md: 1
docs/setup.md: ok
```

and saves the problems it found as `report.md` beside the run's record. When a file gets no
answer, the run stops there and says why.

## The parts

`defineWorkflow({ … })` is the file's default export. Two parts are required:

- **`meta`**: `name` and `description`. `name` names the folder the workflow's runs are kept in,
  `.awf/runs/{name}`, so it is up to 128 letters, digits, `.`, `_`, `@` and `-`, starting with a
  letter or digit. An optional `version`, semver, is recorded with each attempt;
  [Runs](/guide/runs) says what it guards.
- **`run(wf, args)`**: an async function. `wf` is the workflow's context, everything it can do;
  `args` is what `prepare` made of the command line. What it returns is the run's result.

The rest are optional: `prepare` for arguments, `present` and `report` for the result, and
`id(args)`, which names the run from its arguments, such as by a ticket's key
([Runs](/guide/runs)).

Arguments and the result are JSON: plain objects, arrays, strings, numbers, booleans and `null`.
They are kept in the run's record, and a type that isn't JSON fails `tsc`.

## Arguments: `prepare`

The sample's `prepare` gets `argv`, the words after `--`, and `cwd`, the directory the run works
in, and returns `args`. Its return type is the type `run` sees, so `args.files` is `string[]` with
no annotation.

It runs before anything starts. A `prepare` that throws refuses the run: awf prints
`awf: prepare: {message}` and opens no agent. Check your arguments there, not halfway through the
run. It runs again on every `--continue`, with the arguments and directory the run was started
with; if the code has changed so that it throws on them, the continue is refused, and you start a
new run.

Everything up to `--` is awf's: its options may go before or after the file. Everything after
belongs to the workflow:

```sh
awf run --timeout 20m check-docs.ts -- README.md
awf run check-docs.ts --cwd ../other-repo -- README.md
```

A workflow without `prepare` takes no arguments: its `args` are `null`, and a run given any is
refused. So a `run` that declares arguments needs a `prepare`, or `tsc` fails it.

## Control flow is plain TypeScript

There is no graph to declare. The sample's `run` opens one agent and gives it a turn a file:
a `for` over the files, an `if` on the outcome, an early `return`. A turn's outcome is a value,
never an exception, so you branch on it with [`isAnswered`](/reference/workflow-api#outcomes) and
decide what an agent that didn't answer means for your workflow.

The same goes for structure: split the work into functions that take `wf`, import helpers from
other files, and run agents side by side with [`wf.parallel`](/guide/parallel-and-loops) or loop until a
reviewer approves ([Loops](/guide/parallel-and-loops#round-after-round)).

## Stopping with a reason

`wf.stop(reason)` ends the run `stopped`: on purpose, with a reason, rather than failed. Use it
when the workflow can't go on as asked and a person should look; let a bug throw, and the run
fails with the error. In the sample, a file with no answer stops the run, and awf's closing block
gives the reason, the command that goes on, and where the report is:

```text
■ stopped: README.md: failed: {reason}
  check-docs {id} · 1 agent · {time} · …
  go on    awf run check-docs.ts --id {id} --continue
  report   .awf/runs/check-docs/{id}/report.md
  records  .awf/runs/check-docs/{id}
```

- **It never returns.** Write `return wf.stop(…)`, so TypeScript knows the code after it isn't
  reached.
- **It works by throwing, so don't catch it.** A `try`/`catch` around it catches the stop, and the
  stage that caught it, or the run, fails instead.
- **A stopped run exits 3.** Every exit code is in
  [How an attempt ends](/guide/runs#how-an-attempt-ends).
- **The go-on command continues it.** `--continue` makes another attempt of the same run. A stop
  inside a stage leaves that stage to be redone; a stop between stages leaves no record, so the
  continue runs the same check again ([Stages](/guide/runs#stages)).

## The result: `present` and `report`

What `run` returns is kept in the run's `output.json`. Two optional functions turn it into
something for a person.

**`present(value, ending)`** is what a completed run prints, on standard output. The sample's
prints a line a file. Without it, or when it returns `undefined`, `awf run` prints the run's
record as JSON. `--json` always prints the record. A run that didn't complete never calls
`present`: awf prints how it ended itself.

**`report(value, ending)`** returns Markdown that awf saves as `report.md` in the run's folder, and
the closing block says where. It is called however the run ended, so a stopped run can still hand
off what it found: `value` is the result only when the run completed. `ending.kind` says how it
ended: `completed`, or `stopped`, `failed`, `timed-out` or `cancelled`, which carry `reason`,
`stage` when it ended in one, and `continue`, the go-on command. (`parked` is only for a workflow
that waits on events.) Each kind also lists its stages and their values. Returning `undefined`
saves none.

## Catches

- **Only the words after `--` reach `prepare`.** A second file name before `--` is refused with
  `put -- before workflow arguments`, and an option awf doesn't know with `unknown option`.
- **`present` and `report` don't fail the run.** One that throws is reported on standard error;
  awf prints the JSON instead, or saves no report, and the result is still in `output.json`.
- **`report.md` is the last attempt's.** A later attempt whose `report` returns `undefined`
  removes the earlier one; a `report` that throws leaves the earlier attempt's file in place.
- **The closing block goes to standard error,** and only what `present` returns, or the JSON, to
  standard output: `awf run check-docs.ts -- README.md > result.txt` keeps the result alone.

## Next

- [A workflow file](/reference/workflow-api#a-workflow-file) in the workflow API: every part and
  its type.
- [Runs](/guide/runs): a run's id, stages, exit codes, and going on after a stop.
- [Testing](/guide/testing): testing a workflow, `prepare` included, on scripted answers.
- [Agents](/guide/agents): opening an agent and what each outcome means.
