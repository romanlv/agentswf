---
title: Testing API
description: "Every call, script and option of agentswf/testing, with its defaults, and what a test's run records."
outline: [2, 3]
---

# The testing API

`agentswf/testing` runs a workflow through the real engine with each agent replaced by a script
of answers. No agent starts, so a test takes milliseconds and nothing is metered. This page lists
every call, option and default; [Testing](/guide/testing) teaches it from a first test up, and
[`packages/engine/src/workflow-testing`](https://github.com/romanlv/agentswf/tree/main/packages/engine/src/workflow-testing)
has the types, with every field documented.

## At a glance

- **Run a test:** [`testWorkflow(workflow, options?)`](#testworkflow), for every workflow;
  [`awf test`](#awf-test) runs the files.
- **Script a turn:** [`answer(SCHEMA, value | (turn) => …)`](#answer), [`answer("text")`](#answer),
  [`noAnswer.silent()`, `blocked()`, `failed()`, `timedOut()`, `hang()`, `interrupted()`,
  `needsLogin()`](#noanswer); a script is [one entry or a list](#scripts), and a function gets
  [the turn](#the-turn).
- **Options:** [`args`, `id`](#testworkflow), [`agents`](#scripts),
  [`compactions`](#compactions), [`messages`](#messages), [`participants`](#participants),
  [`decisions`](#decisions), [`allowance`](#allowance), [`runtimes`](#runtimes),
  [`caller`](#caller), [`timeout`](#time), [`stall`](#time), [`maxTimers`](#time),
  [`maxTurns`](#time), [`files`](#files), [`cwd`](#files), [`panes`](#panes),
  [`earlier`, `fromStage`, `values`](#continuing-an-earlier-attempt); with events,
  [`event`, `events`](#a-workflow-with-events). [Options](#options) has them in one table, with
  defaults.
- **Read the result:** [`run.value`, `run.ending`, `run.turnsOf(key)`, `run.agentOf(key)`,
  `run.messagesOf(key)` and the rest](#what-the-run-did).
- **Know what fails:** [what fails the test, not the workflow](#what-fails-the-test-not-the-workflow).

## `testWorkflow` {#testworkflow}

```ts
// summarize.test.ts
import { expect, test } from "bun:test";
import { answer, noAnswer, testWorkflow } from "agentswf/testing";
import summarize, { SUMMARY } from "./summarize";

test("returns the reader's summary", async () => {
  const run = await testWorkflow(summarize, {
    args: { file: "README.md" },
    agents: { reader: answer(SUMMARY, { summary: "Two sentences." }) },
  });
  expect(run.value).toEqual({ summary: "Two sentences." });
  expect(run.turnsOf("reader")[0].prompt).toContain("Read README.md");
});

test("a reader that never answers is nudged once, then the summary says why", async () => {
  const run = await testWorkflow(summarize, {
    args: { file: "README.md" },
    agents: { reader: noAnswer.silent() },
  });
  expect(run.value.summary).toStartWith("no answer:");
  expect(run.turnsOf("reader").map((turn) => turn.nudge)).toEqual([false, true]);
});
```

`summarize` is the workflow on [the workflow API page](/reference/workflow-api#a-workflow-file).

- **`testWorkflow(workflow, options?)`** resolves to [the run](#what-the-run-did) once the
  workflow returns, throws, stops or parks. `workflow` is what `defineWorkflow` made.
- **`args`** go to `run` as given: `prepare` isn't called for them. Test `prepare` by calling it,
  as [Testing](/guide/testing#arguments) shows. A workflow that takes args must be given them,
  which `tsc` checks; one whose args may be `null`, or one with events, may leave them out, and
  its run gets what `prepare` makes of no argv, as `awf run` with none would.
- **`id`** is the run's id, `"test"` unless given.
- **An option it doesn't take is refused**, named, so a misspelling fails the test rather than
  being ignored. A workflow's args are always the `args` option: an object given second is read
  as the options.
- It rejects, failing the test, on [the test's own mistakes](#what-fails-the-test-not-the-workflow).
  What the workflow does, throwing included, is in the run.

## Options

Their type is `TestOptions<Args, Events>`. Bare, `TestOptions` is what any test may share, with no
args or events: a helper spreads it into each test's own.

| Option | Default | What it gives |
| --- | --- | --- |
| [`args`](#testworkflow) | what `prepare` makes of no argv; required where the workflow takes args | the args `run` is given |
| [`id`](#testworkflow) | `"test"` | the run's id |
| [`agents`](#scripts) | none | each agent's script, by key or pattern |
| [`compactions`](#compactions) | each compaction answers `""` | each agent's compactions |
| [`messages`](#messages) | none | each agent's script for a message that wakes it |
| [`participants`](#participants) | none | each participant's script, by key |
| [`decisions`](#decisions) | none | each decision's answers, by key or pattern |
| [`allowance`](#allowance) | every harness reads `none` | what `wf.allowance` reads |
| [`runtimes`](#runtimes) | `claude` and `codex` | runtime aliases added or replaced |
| [`caller`](#caller) | none | the session the run is started from |
| [`timeout`](#time) | none | the run's deadline, a duration |
| [`stall`](#time) | `"2s"` | real time with nothing starting or ending before the test fails |
| [`maxTimers`](#time) | 20 | timers the virtual clock skips to before the run parks |
| [`maxTurns`](#time) | 20 | turns started before the test fails |
| [`files`](#files) | none | files laid out under the run's directory first |
| [`cwd`](#files) | a temporary directory, removed after | where the agents work |
| [`panes`](#panes) | the run's workspace, no pane kept | `awf run --workspace` and `--keep-panes` |
| [`earlier`](#continuing-an-earlier-attempt) | none | the `stages`, `events` and `run` lines an earlier attempt left |
| [`fromStage`, `values`](#continuing-an-earlier-attempt) | none | where the attempt starts, and the values before it |

A [workflow with events](#a-workflow-with-events) takes these too, but not `values`, and adds
`event` and `events`.

## Scripts

`agents` maps an agent's key, or a pattern such as `"verifier-*"`, to its script. An exact key
wins over a pattern; two patterns matching one key fail the test. A script built apart from the
test is typed `Script`.

A script is one entry, which meets every turn of that agent, or a list, one entry per turn. A list
is strict: a turn past its end, or an entry never reached, fails the test. So a test can spread a
shared happy path and override, with lists, the agents its case is about:

```ts
// examples/feature-delivery/workflow.test.ts
const run = await testWorkflow(featureDelivery, {
  args,
  agents: {
    ...happyPath,
    planner: [
      answer(WORK, planned),
      answer(WORK, { docPath: doc, summary: "plan v2", decisions: ["name the cache"] }),
    ],
    reviewer: [asking("name the cache", "doc ok"), ready("code ok")],
  },
  messages: { planner: (message) => message.reply("Named it in the doc.") },
});
```

### `answer` {#answer}

- **`answer(SCHEMA, value)`** answers a turn that asks for `SCHEMA`, with a value typed by it and
  checked against it as a real answer is.
- **`answer(SCHEMA, (turn) => …)`** answers from [the turn](#the-turn). It may be `async`, and may
  return a `noAnswer.…()` instead of a value; then it is called again for the nudge, with
  `turn.nudge` true.
- **`answer("text")`** and **`answer((turn) => "…")`** answer a turn that asks for text.

The entry's schema must be the turn's, compared as JSON Schema, or the test fails.

### `noAnswer` {#noanswer}

A `noAnswer` ends a turn without an answer, so it takes no schema. The turn's `outcome` in
[`run.turns`](#what-the-run-did) is the one the engine recorded.

| Call | The turn | Its `outcome` |
| --- | --- | --- |
| `noAnswer.silent()` | ends with no answer; awf nudges it once, as in a real run, and the same entry meets the nudge | `unanswered` |
| `noAnswer.blocked(reason?)` | ends `blocked`; the reason defaults to a permission prompt | `blocked` |
| `noAnswer.failed(reason?)` | ends `failed`, as a crashed harness does | `failed` |
| `noAnswer.timedOut(reason?)` | ends `timed-out` at once | `timed-out` |
| `noAnswer.hang()` | holds until the engine cancels it, for a deadline or a sibling's failure | `timed-out` past a deadline, else `cancelled` |
| `noAnswer.interrupted()` | ends `cancelled`, as when the operator stops the calling session's turn in its pane; never nudged. On any other agent the test fails | `cancelled` |
| `noAnswer.needsLogin(provider?)` | fails with `login` set, as a missing login does, naming the agent's harness | `failed` |

### The turn {#the-turn}

A function entry gets the turn as the workflow asked it, a `Turn`:

- **`agent`**, **`n`** (1-based in the session; a nudge keeps its turn's number), **`nudge`**,
  **`prompt`**, **`schema`** (absent for text), **`label`**, **`stage`**, **`cwd`**, and
  **`model`** and **`effort`**, as opened or as its last `set` left them.
- **`messages`**, the messages shown to the agent in the turn, and **`cause`**, which message woke
  it, absent for the workflow's own `run`.
- **`send`**, **`reply`** and **`tool`**, the agent's [`wfa` calls](#messages).
- **`signal`**, aborted when the engine cancels the turn.

### `compactions` {#compactions}

`compactions` scripts an agent's compactions apart from its turns, as `agents` does: `answer("…")`
or a `noAnswer`, or a list, one per compaction. A silent one fails, as the engine fails a
compaction its harness never confirms. An agent with none here has every compaction answer
`""`. [`run.compactionsOf(key)`](#what-the-run-did) lists them.

## Messages

A script messages as its agent would, and `turn.send` resolves with the reply:

```ts
// examples/feature-delivery/workflow.test.ts
const asking = (change: string, summary: string) =>
  answer(VERDICT, async (turn) => {
    const author = turn.label === "Review ticket doc" ? "planner" : "implementer";
    const revised = await turn.send(author, change, { awaitReply: true });
    return revised.kind === "replied"
      ? { kind: "ready", summary: `${summary}: ${revised.text}` }
      : { kind: "inconclusive", reason: `no revision: ${revised.kind}` };
  });
```

- **`turn.send(peer, text, { awaitReply?, timeout? })`**, as `wfa send`, resolves to `sent`,
  `replied` with `text`, `failed` with a `reason`, or `refused` with a `code`: values to test,
  not throws. While a reply is awaited, the script awaits only these calls.
- **`turn.reply(peer, text, { awaitReply?, timeout? })`**, as `wfa reply`, answers a question among `turn.messages`. A
  result while the agent owes a reply fails the test.
- **`turn.tool(name, input?)`**, as `wfa tool` with JSON, calls the agent's
  [tool](/guide/tools) through the run's own checks and handler, and resolves to `result` with
  its `output`, `failed` with its `outcome` and `error`, or `refused` with a `code` and the `error`
  the agent is told.
- **`messages`** maps an agent's key, or a pattern, to the script for each message that wakes it:
  `(message) => …`, or a list, one per message. `message` has `from`, `text`, `asks`, `answers`
  and `turn`, and `reply`, `send` and `tool`. Returning nothing ends the turn without a reply,
  and one owed is reminded once; returning a [`noAnswer`](#noanswer), such as
  `noAnswer.failed(reason)`, ends it that way. An agent a message wakes with no script here fails
  the test, and so does a script that throws.
- **[`run.messagesOf(key)`](#what-the-run-did)** is the messages an agent got and how each ended;
  a turn's `cause` says which message started it.
- An agent awaits a reply where a real run would let it, by its harness and placement.

## Participants

`participants` maps a participant's key, such as a coordinator's, to a function called with what
whoever answers for it would act on: each route to it as it opens, and each message an agent sends
it. It answers as they would, or leaves a question open by returning:

```ts
// examples/site/reference/testing-api.test.ts
const run = await testWorkflow(investigate, {
  agents: {
    investigator: answer(async (turn) => {
      const asked = await turn.send("coordinator", "One incident or two?", { awaitReply: true });
      return asked.kind === "replied" ? asked.text : asked.kind;
    }),
  },
  participants: {
    coordinator: (event) =>
      event.kind === "message" && event.asks
        ? event.reply("Keep two, and link them.")
        : undefined,
  },
});
expect(run.value).toBe("Keep two, and link them.");
```

- **A `message` event** has `id`, `from`, `text` and `asks`; **`reply(text)`** answers it, as
  `awf reply --to` would, and **`send(agent, text)`** messages an agent, as `awf send` would.
- **A `route` event** has `agent`, `direction` (`both`, `to-participant` or `from-participant`)
  and `purpose`; **`send(text)`** messages that agent first. Each call resolves to
  `{ id }` once delivered, or `{ code }` refused, as `awf reply --json` prints them without the `v`.
- **When no turn runs, no script is still working, and everything left waits on a participant
  question with no `until`,** the attempt ends and its open questions expire `attempt-ended`, so
  the test ends rather than hangs; `run.value` throws if the workflow hadn't returned. While a
  question has an `until`, the test waits for the earliest, so it can expire `timeout`.
- A route or message reaching a participant with no script fails the test, and so does a script
  that throws.
- **`run.messagesOf("coordinator")`** is what it was sent and how each ended; a message to it is
  `delivered` once recorded.

[People](/guide/people) covers participants in a real run.

## Decisions

`decisions` maps a decision's key, or a pattern, to its answers by question id: a choice's option
or a probability per option, a score's level index or a probability per level, lowest first, a
yes-no's `true`, `false` or probability of yes. A script may also be an `Error`, or a function of
the request that returns either. An `Error` given or returned makes `decide` reject, as a provider
failure would; one the function throws fails the test.

```ts
// examples/triage/workflow.test.ts
decisions: {
  "triage-1": {
    team: { payments: 0.95, accounts: 0.03, frontend: 0.02 },
    bug: 0.97,
    urgency: [0.1, 0.3, 0.6],
  },
  "triage-2": { team: "frontend", bug: 0.05, urgency: [0.92, 0.08, 0] },
  "triage-3": {
    team: { payments: 0.4, accounts: 0.5, frontend: 0.1 },
    bug: 0.6,
    urgency: [0.05, 0.9, 0.05],
  },
},
```

An answer to a question it wasn't asked, or of the wrong kind, fails the test.
[`run.decisions`](#what-the-run-did) lists each call as the workflow made it.

## Allowance

`allowance` lists what [`wf.allowance`](/reference/workflow-api#allowance) reads, a
`HarnessAllowance` per harness; a harness with none here reads `none`.

## Runtimes

A test starts from the runtime aliases `awf run` installs, `claude` and `codex`, so an alias a
run wouldn't know fails the test too. `runtimes` adds others, and a name it repeats replaces that
one.

## The calling session {#caller}

`caller: { harness, model?, here? }` gives the session the run is started from, for a workflow
that uses [`wf.agents.caller` or `forkCaller`](/reference/workflow-api#agents-caller).
Without it, both answer `null`.

- Its turns are answered from the script under the key the workflow gives it, as `awf run --here`
  hands it over.
- **`here: false`** leaves it waiting on the run: `caller` answers `null`.
- **`model`** is the model its files show, which a fork runs on; without one, `forkCaller`
  answers `null`.

## Time

- **`maxTurns`**, 20 by default, counts the turns the workflow started, not nudges or wakes for a
  message: a run that starts more fails the test, so a loop that never ends doesn't hang it.
- **`timeout`**, a [duration](/reference/workflow-api#waiting-on-time) such as `"5s"`, is the
  run's deadline, none unless given, as `awf run` has none without `--timeout`. Deadlines are
  real time: a turn's `timeout` runs on the clock, and
  `noAnswer.timedOut()` ends a turn as timed out at once.
- **`stall`**, a duration, `"2s"` by default: nothing starting or ending for that long fails the test, so a
  stuck test fails rather than hangs. A wait for a participant question's `until` doesn't count.
- **The clock is virtual.** Where the run would park with a timer to come, the test moves its
  clock to the timer, which fires: a two-day reminder takes no time, and `wf.now()`, timers and
  the events a test sends read that clock. After **`maxTimers`**, 20 by default, the run parks
  instead, and `run.value` says so; `maxTimers: 0` parks at the first, to test the parking.
  [`run.timers`](#what-the-run-did) lists each. A turn's `timeout` and `keepAlive` windows stay
  on real time.

## Files

- **`files`** are laid out under the run's directory before it starts, by path: a string is a
  file's contents, an object a directory of them. A path outside the directory is refused, so a
  workflow under test finds its files from `wf.cwd`. The test removes the directory.
- **`cwd`** sets where the agents work instead, a directory of your own, left as it is. `files`
  and `cwd` together are refused.

Sandboxes in a test are fakes that confine nothing, so a test checks what each agent was given;
the sandbox evals check what a real provider enforces.

## Panes {#panes}

- **`panes`** gives a run what [`awf run --workspace` and `--keep-panes`](/reference/awf#run)
  give one, as `run.json` keeps them: `{ workspace?: "run" | "origin" | { name }, keep?: "never"
  | "on-failure" | "always" }`. A test has no screen, so
  [`run.agentOf(key)`](#what-the-run-did) shows what each TUI agent's host was asked, and
  `keptPane` when its pane was kept.

## What the run did

`testWorkflow` resolves to a `TestRun`, the type for a helper that checks one.

- **`run.value`** is what the workflow returned. If it threw, reading `value` throws, with the
  workflow's error as the cause: `expect(() => run.value).toThrow("lens ids must be unique")`.
  So does a run that parked.
- **`run.ending`** is how the attempt ended, the `Ending` a workflow's
  [`present` and `report`](/reference/workflow-api#ending) get: `completed` with its
  `value`, `parked` with its last wait's `label` and `until`, or `stopped`, `failed`, `timed-out`
  or `cancelled` with the `stage` it ended in, the `reason`, and the command that goes on; each
  with its `stages`. `expect(run.ending).toMatchObject({ kind: "stopped", stage: "plan" })`.
- **`run.turnsOf(key)`** is one agent's turns, `TestTurn`s, in order, nudges included: `agent`,
  `prompt`, `schema`, `label`, `n`, `nudge`, `cwd`, `model`, `effort`, `stage`, `cause`,
  `messages` and `outcome`. A call's last turn has the outcome the engine recorded for it:
  `answered`, `unanswered`, `blocked`, `failed`, `timed-out` or `cancelled`. A turn before it
  is `unanswered` when a nudge followed, `waiting` for a check-in, and `awaiting-reply` for a
  script that awaits one. **`run.turns`** has everyone's, in
  the order they started.
- **`run.compactionsOf(key)`** and **`run.setsOf(key)`** are its compactions and model or effort
  switches; **`run.compactions`** and **`run.sets`** have everyone's.
- **`run.agentOf(key)`** is what an agent was opened with: `key`, `execution`, `instructions`,
  `skills`, `sandbox`, `pane` (`tab` or `beside`, and `front`, read back from what the host was
  given), `panes` as the host was asked to apply [`panes`](#panes) to it (the `workspace` its tab
  opens in, and `keep`), `paneFallback` when its pane couldn't go where it asked, `keptPane` when
  its pane was kept, and `forkedFrom` for a fork. It throws for a key never opened. **`run.agents`** lists them all.
- **`run.messagesOf(key)`** is the messages an agent or participant was sent: `from`,
  `awaitReply`, and `end`, one of `replied`, `failed`, `delivered`, `undelivered` or `pending`,
  with a `reason`.
- **`run.decisions`** and **`run.logs`** are the decision calls and log lines.
- **`run.stages`** is each stage the attempt entered, in order: its `name`, `outcome`, `attempt`,
  `started`, `at` (when it ended), `summary`, `reason` and `value`, and `provided` for a value
  given. A stage it reused gives the earlier attempt's, and a stage the plan stopped as it was
  entered, which ran nothing, is absent.
- **`run.timers`** is each timer, its `due` time, and `state`: `fired`, `cancelled` or `pending`.
- **`run.run`** is the run's `run.jsonl` as it left it ([Data](/reference/data#run-jsonl)): its
  stages, timers, sessions, and what its waits took.
- **`run.emits`** and **`run.events`** are for
  [a workflow with events](#a-workflow-with-events).

Under `parallel`, read agents by key, not by index. To prove two agents work at once, make one's
answer wait for the other's: run one after the other, the test stalls and fails.

## A workflow with events

A workflow with `events` takes the same options, and two of its own, `event` and `events`:

```ts
// examples/site/reference/testing-api.test.ts
const run = await testWorkflow(caseRun, {
  id: "checkout-timeouts", // the run, as a sender names it
  event: { name: "case.changed", data: { case: "checkout-timeouts" } }, // starts it
  files: { cases: { "checkout-timeouts": { "case.md": "# checkout\n" } } }, // laid out first
  agents: { investigator: answer("case.md updated") },
  events: [
    { during: "investigator#1", name: "thread:reply", data: { text: "is it the index?" } },
  ],
});
expect(run.ending).toMatchObject({
  kind: "parked",
  label: "waiting on the thread about checkout-timeouts",
});
expect(run.turnsOf("investigator")[1]?.prompt).toContain("is it the index?");
expect(run.emits).toEqual([]);
```

`caseRun` and the other workflows these samples test are in
[`examples/site/reference/testing-api.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/reference/testing-api.ts).

- **`id`** names the run, as `awf run --id` or a sender does; `"test"` unless given.
- **`event`** starts it, as `awf emit` would, its data checked against its schema and its name
  against `starts`; without one, it starts with no event.
- **`args`** are the run's, as `awf run --id {id} -- {args}` would prepare them; without them,
  `prepare` is called with no argv, as for a run an event starts.
- **`events`** are sent in the order given, each while an agent's `n`th turn runs
  (`during: "{agent}#{n}"`), before its script answers, or once it has ended
  (`after: "{agent}#{n}"`) and the run waits live in a `keepAlive` window. `n` counts the agent's
  turns in the test, a nudge's included and its compactions not, so it isn't the `n` of an
  operation's folder, `ops/{agent}.{n}/` ([Data](/reference/data#ops)). Each is one the workflow declares, a participant's
  `{key}:reply` included, from its key, with its data checked as `awf emit` checks it; an agent's
  `{key}:ended` is awf's to send. An event whose turn never runs, or an `after` event the run
  parked before sending, fails the test.
- **`eventId`**, optional on `event` and on each of `events`, is the event's id in the run's
  `in.jsonl`, as `awf emit --event-id` gives it, `awf.start` and `awf.test.{n}` by default; one given
  twice fails the test. Each is stamped with
  the test's clock as it is sent.
- `n` counts the turns the workflow started: a nudge or a wake for a message keeps the turn's
  number, so with one, `#2` is not `turnsOf(agent)[1]`.
- A `keepAlive` with no `window` lasts 100 ms in a test rather than the hour, so a
  kept-alive workflow's test doesn't stall in it. A compaction `onTimeout` asks for is in
  `run.compactionsOf(key)`.
- **`earlier: { events, run }`** lays out the events an earlier attempt was sent and what its
  waits did with them, and the test is its continue:
  [Continuing an earlier attempt](#continuing-an-earlier-attempt).
- The test returns when the run parks or returns; `run.value` throws for a parked run.
- **`run.ending`** is `parked`, with the `label` and `until` of the wait it parked at;
  **`run.events`** is the events the run was sent, its `in.jsonl` as it left it.
- **`run.emits`** is every event it sent another workflow, `{ ref, name, data, eventId? }`, the
  `eventId` its `wf.emit` gave; a test starts no other run, so none is delivered.

[Events](/reference/workflow-api#events) on the workflow API page covers the calls these test.

## Continuing an earlier attempt

`earlier` runs the workflow as a continue over what an earlier attempt left, attempt 2, or the
attempt after the latest its `run` lines name:

- **`stages`**, the stages it recorded, keyed by name: each value, or `undefined` for a stage
  that returns nothing. A continue reuses them without calling their work.
- **`events`**, the events it was sent, in order, as `in.jsonl` lines. A starting `event` is
  appended after them, as the event that woke it.
- **`run`**, what it settled, in order, as `run.jsonl` lines: its timers, what its waits and races
  took, and the turns it began. A turn begun and never ended gets its failed end as the test's
  attempt begins, as a continue after a crash does. A parked test's `run.run` and `run.events`,
  given here, continue it.

`fromStage` and `values` start at a stage, as `--from-stage` and `--values` do; `values` without
`fromStage` is refused. A workflow with events takes `fromStage` only with `earlier`, as `awf run`
takes it only with `--continue`, and no `values`. This is how a test catches code that only works
on a first attempt:

```ts
// examples/site/reference/testing-api.test.ts
const run = await testWorkflow(flow, {
  earlier: { stages: { "doc-review": { path: "docs/a.md" }, implement: { branch: "feat/a" } } },
  agents: { worker: answer(QA, { preview: "ok" }) },
});
expect(run.compactions).toEqual([]); // a compaction inside implement isn't repeated
```

## What fails the test, not the workflow

- an agent, decision, message or participant with no script;
- a turn past a list's end, or a list entry never reached;
- an answer the turn's schema refuses, or a result while the agent owes a reply;
- a script that throws;
- `noAnswer.interrupted()` on an agent other than the calling session;
- a stall: nothing starting or ending for `stall`, so a stuck test fails rather than hangs;
- more than `maxTurns` turns started;
- an option `testWorkflow` doesn't take, or no `args` for a workflow whose `prepare` refuses none;
- with events, a scripted event never sent.

## `fakeClient` {#fakeclient}

```ts
const runs = fakeClient({
  emit: (call) => (call.eventId === "d-1" ? { did: "none", why: "launch-failed" } : undefined),
  start: (call) => undefined, // { did, error } for this start
  rests: { "release/v1": [{ state: "completed", final: true }] }, // what its waits come to, in order
  inbox: (call) => [], // the items for this read
});
```

A [program](/guide/programs)'s handler takes a `Client`; its test passes `fakeClient(script?)`,
which runs the real client's checks that need no files, throws the same `ClientError`, and keeps `calls`, every call
in order, refused ones included. Unscripted, it answers as the real rules do: a run is started by
an event that may start one, kept after a launch that failed and started by its next event or
by the same event resent, a `duplicate` that wakes it; `nudged` while running, `continued` once
parked, failed or crashed (where the real one says `none`, `nothing-due`, for a wait that doesn't
take the event, script it), left alone once stopped, cancelled or stuck, `refused` once returned (and `none`, `returned`, if
resent); a reply to no run throws `no-run`; a second `start` with the same args is `exists`, with
others `other-args`. A run moves to its next scripted rest at a `wait`, to `running` when it is
launched, and after a launch that fails stays at its last rest, or is `interrupted` (`stuck` after
three) if it has none; its `final` is the real client's, from its state and whether the workflow
takes events. A `start` with no id and no `id(args)` names its run `fake-1`, `fake-2`, and so on,
which `rests` can name. The first `start` or event to reach a run `rests` names, before a wait
takes one of its rests, is the one that makes it. A script overrides what it names, and the fake then knows what it said: a
refused event leaves no run, `why` alone is `did: "none"`. A result's `ok` follows from what it
says, as the real client's does; a script never gives it.

## `awf test` {#awf-test}

```sh
awf test                               # every *.test.ts and *.spec.ts under here
awf test summarize.test.ts -t nudged   # one file, the tests whose names match
```

`awf test` serves `agentswf/workflow`, `agentswf/client`, `agentswf/testing` and `typebox` itself,
so a folder that declares none of them needs nothing installed, and takes paths, `-t`, `--watch` and `--timeout` (5 s a test by default). Its help is
on [the `awf` reference](/reference/awf#test).
