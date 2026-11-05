---
title: Testing
description: Testing a workflow with awf test, its agents replaced by scripted answers, so no agent starts and a test takes milliseconds.
---

# Testing

A workflow is code that branches on what agents say: an answer, a refusal, silence. A test gives
it each of those on purpose. `awf test` runs your workflow through the real engine with every
agent replaced by a script of answers, so no agent starts, nothing is metered, and a test takes
milliseconds. It checks your workflow's logic: its branches, its loops, what it does with each
[outcome](/guide/how-it-works#the-words). How well a real agent answers is a different question,
and a test doesn't ask it.

## A workflow and its test

The workflow asks a writer for release notes and, when the writer says the change is breaking,
asks a checker on another harness to confirm:

<<< @/../examples/site/guide/testing/release-notes.ts [release-notes.ts]

Its test sits beside it:

<<< @/../examples/site/guide/testing/release-notes.test.ts#first [release-notes.test.ts]

```sh
awf test
```

- **`testWorkflow(workflow, options)`** runs the workflow and returns what it did. Its
  `args` are an option, which a workflow that takes them must be given.
- **`agents`** maps each agent's key to its script. **`answer(NOTES, value)`** answers a turn
  that asks for `NOTES` with `value`, checked against the schema as a real answer is. The script
  names the same schema the workflow asks with; a different one fails the test with
  `it asks for … its script answers …`.
- **`run.value`** is what the workflow returned; **`run.agents`** the agents it opened;
  **`run.turnsOf(key)`** one agent's turns, each with the `prompt` it was given.

The tests are [Bun](https://bun.sh/docs/cli/test)'s: `test` and `expect` come from `bun:test`.

## Scripting answers

An answer can be computed from the turn. The checker here reads its prompt, and answers
differently by what it says:

<<< @/../examples/site/guide/testing/release-notes.test.ts#checker

The function gets the turn: `turn.prompt`, `turn.n`, `turn.agent`, `turn.nudge` and more, and it
may be `async`. `answer("text")` answers a turn that asks for no schema.

A script is one entry, which meets every turn of that agent, or a list, one entry per turn:
`reviewer: [answer(VERDICT, revise), answer(VERDICT, approve)]` answers the first review with
`revise` and the second with `approve`. A list is strict: a turn past its end, or an entry never
reached, fails the test. A key can be a pattern, `"reviewer-*"`, for agents a workflow opens in a
loop; an exact key wins over a pattern.

## Scripting outcomes

A test earns its keep on the turns that don't go to plan. `noAnswer` ends a turn without an
answer, the way a real agent can:

<<< @/../examples/site/guide/testing/release-notes.test.ts#outcomes

- **`noAnswer.silent()`** ends the turn with no answer. awf sends one
  [nudge](/guide/how-it-works#the-words), as it would on a real run, and the same script entry
  meets the nudge with `turn.nudge` true; still silent, the turn ends `unanswered`.
- **`noAnswer.blocked()`**, **`noAnswer.failed()`** and **`noAnswer.timedOut()`** end it
  `blocked`, `failed` and `timed-out`, each with a reason you can pass. **`noAnswer.hang()`** holds it until
  the engine cancels it, to test a deadline or a sibling's failure cancelling it under
  `wf.parallel`.
- **`run.ending`** is how the attempt ended, the `Ending` a workflow's `report` gets: `kind`
  `stopped` with the `reason` and `stage` when the workflow stopped with
  [`wf.stop`](/guide/workflows), and reading **`run.value`** then throws, as it does when the
  workflow threw.

`noAnswer.needsLogin()` and every other script are in [Scripts](/reference/testing-api#scripts).

## Asserting what the run did

`run` holds more than the value. The ones you reach for first:

- **`run.turnsOf(key)`**: each turn's `prompt`, `schema`, `nudge`, `model`, `outcome` and `stage`,
  nudges included. `run.turns` has every agent's.
- **`run.agentOf(key)`**: what the agent was opened with, such as `execution.alias`, its
  `instructions`, `skills` and `sandbox`. `run.agents` lists them all.
- **`run.stages`**, **`run.logs`** and **`run.decisions`**: the stage records, log lines and
  decision calls.

Under `wf.parallel`, read agents by key, not by index. The full list is [What the run did](/reference/testing-api#what-the-run-did).

## Arguments

`testWorkflow` passes its `args` option to `run` as given; it doesn't call `prepare` for them.
Test `prepare` by calling it with the argv it would get:

<<< @/../examples/site/guide/testing/release-notes.test.ts#prepare

## Running tests

```sh
awf test                                # every *.test.ts and *.spec.ts under here
awf test release-notes.test.ts          # one file
awf test -t "breaking"                  # the tests whose names match
awf test --watch                        # rerun on a change
```

```text
<!--@include: @/../packages/engine/src/help/test.txt-->
```

`awf test` serves `agentswf/workflow`, `agentswf/client`, `agentswf/testing` and `typebox` itself,
so a folder of workflows that declares no `agentswf` needs no `bun install` to be tested; one that declares
`agentswf` runs on the one it installs. The runtime aliases `claude` and `codex` resolve
as they do on `awf run`; `runtimes` in the options adds or replaces others.

## Catches

- **A missing script fails the test, not the workflow.** An agent with no script, an answer its
  turn's schema refuses, or a script that throws is the test's mistake, and the test fails saying
  so.
- **A stuck run fails rather than hangs.** Nothing starting or ending for 2 s fails the test;
  `stall` in `testWorkflow`'s options, a duration such as `"5s"`, changes it. A loop whose turns
  keep answering never stalls, so more than 20 turns started fails the test; `maxTurns` changes
  that.
- **A misspelled option fails the test.** An option `testWorkflow` doesn't take is refused,
  named, rather than ignored.
- **Deadlines are real time.** A turn's `timeout` runs on the clock, so keep them short in a
  test, or end the turn at once with `noAnswer.timedOut()`.
- **Sandboxes are fakes.** They confine nothing; a test checks what each agent was given, not what
  a real sandbox enforces.
- **Messages, decisions, events and stages have scripts too.** An agent messaging another, a
  decision model's answers, a workflow parked on an event, a continue over what an earlier
  attempt left: each has its own option, on the reference page.

## Next

- [The testing API](/reference/testing-api): every script, option and field of `run`, with
  [messages](/reference/testing-api#messages), [decisions](/reference/testing-api#decisions),
  [events](/reference/testing-api#a-workflow-with-events) and
  [an earlier attempt](/reference/testing-api#continuing-an-earlier-attempt).
- [What fails the test](/reference/testing-api#what-fails-the-test-not-the-workflow), in full.
- [Outcomes](/reference/workflow-api#outcomes): what each way a turn can end means for a real run.
