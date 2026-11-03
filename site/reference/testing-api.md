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

- **Run a test:** [`testWorkflow(workflow, args, options?)`](#testworkflow), or
  [`testWorkflow(eventWorkflow, options)`](#a-workflow-with-events) for a workflow with events;
  [`awf test`](#awf-test) runs the files.
- **Script a turn:** [`answer(SCHEMA, value | (turn) => …)`](#answer), [`answer("text")`](#answer),
  [`reply.silent()`, `blocked()`, `failed()`, `timedOut()`, `hang()`, `interrupted()`,
  `needsLogin()`, `waiting()`](#reply); a script is [one entry or a list](#scripts), and a
  function gets [the turn](#the-turn).
- **Options:** [`agents`](#scripts), [`compactions`](#compactions), [`messages`](#messages),
  [`awaitReply`](#awaitreply), [`participants`](#participants), [`decisions`](#decisions),
  [`allowance`](#allowance), [`runtimes`](#runtimes), [`caller`](#caller),
  [`timeoutMs`](#time), [`stallMs`](#time), [`maxTimers`](#time), [`files`](#files),
  [`cwd`](#files), [`recorded`, `fromStage`, `values`](#continuing-over-recorded-stages); with
  events, [`id`, `args`, `event`, `events`, `maxTurns`, `mailbox`](#a-workflow-with-events).
  [Options](#options) has them in one table, with defaults.
- **Read the result:** [`run.value`, `run.turnsOf(key)`, `run.agentOf(key)`, `run.messagesOf(key)`
  and the rest](#what-the-run-did).
- **Know what fails:** [what fails the test, not the workflow](#what-fails-the-test-not-the-workflow).

## `testWorkflow` {#testworkflow}

```ts
// summarize.test.ts
import { expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "agentswf/testing";
import summarize, { SUMMARY } from "./summarize";

test("returns the reader's summary", async () => {
  const run = await testWorkflow(summarize, { file: "README.md" }, {
    agents: { reader: answer(SUMMARY, { summary: "Two sentences." }) },
  });
  expect(run.value).toEqual({ summary: "Two sentences." });
  expect(run.turnsOf("reader")[0].prompt).toContain("Read README.md");
});

test("a reader that never answers is nudged once, then the summary says why", async () => {
  const run = await testWorkflow(summarize, { file: "README.md" }, {
    agents: { reader: reply.silent() },
  });
  expect(run.value.summary).toStartWith("no answer:");
  expect(run.turnsOf("reader").map((turn) => turn.nudge)).toEqual([false, true]);
});
```

`summarize` is the workflow on [the workflow API page](/reference/workflow-api#a-workflow-file).

- **`testWorkflow(workflow, args, options?)`** resolves to [the run](#what-the-run-did) once the
  workflow returns, throws, stops or parks.
- **`args`** go to `run` as given: `prepare` isn't called. Test `prepare` by calling it, as
  [Testing](/guide/testing#arguments) shows.
- It rejects, failing the test, on [the test's own mistakes](#what-fails-the-test-not-the-workflow).
  What the workflow does, throwing included, is in the run.

## Options

| Option | Default | What it gives |
| --- | --- | --- |
| [`agents`](#scripts) | none | each agent's script, by key or pattern |
| [`compactions`](#compactions) | each compaction answers `""` | each agent's compactions |
| [`messages`](#messages) | none | each agent's script for a message that wakes it |
| [`awaitReply`](#awaitreply) | `"listed"` | where an agent may await a reply |
| [`participants`](#participants) | none | each participant's script, by key |
| [`decisions`](#decisions) | none | each decision's answers, by key or pattern |
| [`allowance`](#allowance) | every harness reads `none` | what `wf.allowance` reads |
| [`runtimes`](#runtimes) | `claude` and `codex` | runtime aliases added or replaced |
| [`caller`](#caller) | none | the session the run is started from |
| [`timeoutMs`](#time) | none | the run's deadline |
| [`stallMs`](#time) | 2 s | real time with nothing starting or ending before the test fails |
| [`maxTimers`](#time) | 20 | timers the virtual clock skips to before the run parks |
| [`files`](#files) | none | files laid out under the run's directory first |
| [`cwd`](#files) | a temporary directory, removed after | where the agents work |
| [`recorded`](#continuing-over-recorded-stages) | none | stages an earlier attempt recorded |
| [`fromStage`, `values`](#continuing-over-recorded-stages) | none | where the attempt starts, and the values before it |

A [workflow with events](#a-workflow-with-events) takes these too, but not `recorded`, `fromStage`
or `values`, and adds `id`, `args`, `event`, `events`, `maxTurns` and `mailbox`.

## Scripts

`agents` maps an agent's key, or a pattern such as `"verifier:*"`, to its script. An exact key
wins over a pattern; two patterns matching one key fail the test.

A script is one entry, which meets every turn of that agent, or a list, one entry per turn. A list
is strict: a turn past its end, or an entry never reached, fails the test. So a test can spread a
shared happy path and override, with lists, the agents its case is about:

```ts
// examples/feature-delivery/workflow.test.ts
const run = await testWorkflow(featureDelivery, args, {
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
  return a `reply.…()` instead of a value; then it is called again for the nudge, with
  `turn.nudge` true.
- **`answer("text")`** and **`answer((turn) => "…")`** answer a turn that asks for text.

The entry's schema must be the turn's, compared as JSON Schema, or the test fails.

### `reply` {#reply}

A `reply` ends a turn without an answer. It takes no schema.

| Call | The turn |
| --- | --- |
| `reply.silent()` | ends with no answer; awf nudges it once, as in a real run, and the same entry meets the nudge |
| `reply.blocked(reason?)` | ends `blocked`; the reason defaults to a permission prompt |
| `reply.failed(reason?)` | ends `failed`, as a crashed harness does |
| `reply.timedOut(reason?)` | ends `timed-out` at once |
| `reply.hang()` | holds until the engine cancels it, for a deadline or a sibling's failure |
| `reply.interrupted()` | ends `cancelled`, as when the operator stops the calling session's turn in its pane; never nudged. On any other agent the test fails |
| `reply.needsLogin(provider?)` | fails with `login` set, as a missing login does, naming the agent's harness |
| `reply.waiting(reason, timeoutMs?)` | reports `wfa waiting`, which only a claude TUI agent the run opened may; elsewhere, the calling session included, the test fails |

### The turn {#the-turn}

A function entry gets the turn as the workflow asked it:

- **`agent`**, **`n`** (1-based in the session; a nudge keeps its turn's number), **`nudge`**,
  **`prompt`**, **`schema`** (absent for text), **`label`**, **`stage`**, **`cwd`**, and
  **`model`** and **`effort`**, as opened or as its last `set` left them.
- **`messages`**, the messages shown to the agent in the turn, and **`cause`**, which message woke
  it, absent for the workflow's own `run`.
- **`send`**, **`reply`** and **`tool`**, the agent's [`wfa` calls](#messages).
- **`signal`**, aborted when the engine cancels the turn.

### `compactions` {#compactions}

`compactions` scripts an agent's compactions apart from its turns, as `agents` does: `answer("…")`
or a `reply`, or a list, one per compaction. An agent with none here has every compaction answer
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

- **`turn.send(peer, text, { awaitReply?, timeoutMs? })`**, as `wfa send`, resolves to `sent`,
  `replied` with `text`, `failed` with a `reason`, or `refused` with a `code`: values to test,
  not throws. While a reply is awaited, the script awaits only these calls.
- **`turn.reply(peer, text, { awaitReply?, timeoutMs? })`**, as `wfa reply`, answers a question among `turn.messages`. A
  result while the agent owes a reply fails the test.
- **`turn.tool(name, input?)`**, as `wfa tool` with JSON, calls the agent's
  [tool](/guide/tools) through the run's own checks and handler, and resolves to `result` with
  its `output`, `failed` with its `outcome` and `error`, or `refused` with a `code` and the `error`
  the agent is told.
- **`messages`** maps an agent's key, or a pattern, to the script for each message that wakes it:
  `(message) => …`, or a list, one per message. `message` has `from`, `text`, `asks`, `answers`
  and `turn`, and `reply`, `send`, `tool`, `silent()` and `fail(reason?)`; returning ends the turn
  as `silent()` does. An agent a message wakes with no script here fails the test.
- **[`run.messagesOf(key)`](#what-the-run-did)** is the messages an agent got and how each ended;
  a turn's `cause` says which message started it.

### `awaitReply` {#awaitreply}

`"listed"`, the default, lets an agent await a reply where a real run would, by its harness and
placement. `"anywhere"` lets a test await one on a harness the engine doesn't list yet.

## Participants

`participants` maps a participant's key, such as a coordinator's, to a function called with what
whoever answers for it would act on: each route to it as it opens, and each message an agent sends
it. It answers as they would, or leaves a question open by returning:

```ts
// examples/site/reference/testing-api.test.ts
const run = await testWorkflow(investigate, null, {
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
  `{ code: "delivered", id }` or a refusal's `code`.
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
  "triage:1": {
    team: { payments: 0.95, accounts: 0.03, frontend: 0.02 },
    bug: 0.97,
    urgency: [0.1, 0.3, 0.6],
  },
  "triage:2": { team: "frontend", bug: 0.05, urgency: [0.92, 0.08, 0] },
  "triage:3": {
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

- **`timeoutMs`** is the run's deadline, none unless given, as `awf run` has none without
  `--timeout`. Deadlines are real time: a turn's `timeoutMs` runs on the clock, and
  `reply.timedOut()` ends a turn as timed out at once.
- **`stallMs`**, 2 s by default: nothing starting or ending for that long fails the test, so a
  stuck test fails rather than hangs. A wait for a participant question's `until` doesn't count.
- **The clock is virtual.** Where the run would park with a timer to come, the test moves its
  clock to the timer, which fires: a two-day reminder takes no time, and `wf.now()`, timers and
  the events a test sends read that clock. After **`maxTimers`**, 20 by default, the run parks
  instead, and `run.value` says so; `maxTimers: 0` parks at the first, to test the parking.
  [`run.timers`](#what-the-run-did) lists each. A turn's `timeoutMs` and `keepAlive` windows stay
  on real time.

## Files

- **`files`** are laid out under the run's directory before it starts, by path: a string is a
  file's contents, an object a directory of them. A path outside the directory is refused, so a
  workflow under test finds its files from `wf.cwd`. The test removes the directory.
- **`cwd`** sets where the agents work instead, a directory of your own, left as it is. `files`
  and `cwd` together are refused.

Sandboxes in a test are fakes that confine nothing, so a test checks what each agent was given;
the sandbox evals check what a real provider enforces.

## What the run did

- **`run.value`** is what the workflow returned. If it threw, reading `value` throws, with the
  workflow's error as the cause: `expect(() => run.value).toThrow("lens ids must be unique")`.
  So does a run that parked.
- **`run.turnsOf(key)`** is one agent's turns in order, nudges included: `agent`, `prompt`,
  `schema`, `label`, `n`, `nudge`, `cwd`, `model`, `effort`, `stage`, `cause`, `messages` and `outcome`.
  **`run.turns`** has everyone's, in the order they started.
- **`run.compactionsOf(key)`** and **`run.setsOf(key)`** are its compactions and model or effort
  switches; **`run.compactions`** and **`run.sets`** have everyone's.
- **`run.agentOf(key)`** is what an agent was opened with: `key`, `execution`, `instructions`,
  `labels` (deprecated), `skills`, `sandbox`, pane `layout` and `keepPane`, `layoutFallback` when its `layout`
  couldn't be used, `keptPane` when its pane was kept, and `forkedFrom` for a fork. It throws for a
  key never opened. **`run.agents`** lists them all.
- **`run.messagesOf(key)`** is the messages an agent or participant was sent: `from`,
  `awaitReply`, and `end`, one of `replied`, `failed`, `delivered`, `undelivered` or `pending`,
  with a `reason`.
- **`run.decisions`**, **`run.logs`** and **`run.stages`** are the decision calls, log lines and
  stage records.
- **`run.stopped`** is `{ reason, stage?, needs? }` when the attempt stopped, as `wf.stop` stops
  it.
- **`run.timers`** is each timer, its `due` time, and `state`: `fired`, `cancelled` or `pending`.
- **`run.emits`**, **`run.parked`** and **`run.mailbox`** are for
  [a workflow with events](#a-workflow-with-events).

Under `parallel`, read agents by key, not by index. To prove two agents work at once, make one's
answer wait for the other's: run one after the other, the test stalls and fails.

## A workflow with events

A workflow with `events` is tested from its options alone, its args among them:

```ts
// examples/site/reference/testing-api.test.ts
const run = await testWorkflow(caseRun, {
  id: "checkout-timeouts", // the run, as a sender names it
  event: { name: "case.changed", data: { case: "checkout-timeouts" } }, // starts it
  files: { cases: { "checkout-timeouts": { "case.md": "# checkout\n" } } }, // laid out first
  agents: { investigator: answer("case.md updated") },
  events: [
    {
      during: "investigator#1",
      name: "participant:reply",
      from: "thread",
      data: { text: "is it the index?" },
    },
  ],
});
expect(run.parked?.label).toBe("waiting on the thread about checkout-timeouts");
expect(run.turnsOf("investigator")[1]?.prompt).toContain("is it the index?");
expect(run.emits).toEqual([]);
```

`caseRun` and the other workflows these samples test are in
[`examples/site/reference/testing-api.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/reference/testing-api.ts).

- **`id`** names the run, as `awf run --id` or a sender does.
- **`event`** starts it, as `awf emit` would, its data checked against its schema and its name
  against `starts`; without one, it starts with no event.
- **`args`** are the run's, as `awf run --id {id} -- {args}` would prepare them; without them,
  `prepare` is called with no argv, as for a run an event starts.
- **`events`** are sent in the order given, each while an agent's `n`th turn runs
  (`during: "{agent}#{n}"`), before its script answers, or once it has ended
  (`after: "{agent}#{n}"`) and the run waits live in a `keepAlive` window. A reply's `author`
  defaults to `engineer`. An event whose turn never runs, or an `after` event the run parked before
  sending, fails the test.
- **`id`**, optional on `event` and on each of `events`, is the event's id in the run's mailbox,
  `awf.start` and `awf.test.{n}` by default; one given twice fails the test. Each is stamped with
  the test's clock as it is sent.
- `n` counts the turns the workflow started: a nudge or a wake for a message keeps the turn's
  number, so with one, `#2` is not `turnsOf(agent)[1]`.
- A `keepAlive` window with no `timeoutMs` lasts 100 ms in a test rather than the hour, so a
  kept-alive workflow's test doesn't stall in it. A compaction `onTimeout` asks for is in
  `run.compactionsOf(key)`.
- **`maxTurns`**, 20 by default, counts the turns the workflow started, not nudges or wakes: a
  run that starts more fails the test, so a loop that never parks doesn't hang it.
- **`mailbox`** lays out what an earlier attempt left, and the test is its continue.
- The test returns when the run parks or returns; `run.value` throws for a parked run.
- **`run.parked`** is `{ label?, until? }` of the wait it parked at; **`run.mailbox`** is its
  mailbox as it left it.
- **`run.emits`** is every event it sent another workflow, `{ ref, name, data, eventId? }`, the
  `eventId` its `wf.emit` gave; a test starts no other run, so none is delivered.

[Events](/reference/workflow-api#events) on the workflow API page covers the calls these test.

## Continuing over recorded stages

`recorded` runs the workflow as a continue over stages an earlier attempt recorded, keyed by
name: each value, or `undefined` for a stage that returns nothing. `fromStage` and `values` start
at a stage, as `--from-stage` and `--values` do; `values` without `fromStage` is refused. This is
how a test catches code that only works on a first attempt:

```ts
// examples/site/reference/testing-api.test.ts
const run = await testWorkflow(flow, null, {
  recorded: { "doc-review": { path: "docs/a.md" }, implement: { branch: "feat/a" } },
  agents: { worker: answer(QA, { preview: "ok" }) },
});
expect(run.compactions).toEqual([]); // a compaction inside implement isn't repeated
```

## What fails the test, not the workflow

- an agent, decision, message or participant with no script;
- a turn past a list's end, or a list entry never reached;
- an answer the turn's schema refuses, or a result while the agent owes a reply;
- a script that throws;
- `reply.interrupted()` on an agent other than the calling session, or `reply.waiting()` where
  `wfa waiting` isn't offered;
- a stall: nothing starting or ending for `stallMs`, so a stuck test fails rather than hangs;
- with events, more than `maxTurns` turns, or a scripted event never sent.

## `awf test` {#awf-test}

```sh
awf test                               # every *.test.ts and *.spec.ts under here
awf test summarize.test.ts -t nudged   # one file, the tests whose names match
```

`awf test` serves `agentswf/workflow`, `agentswf/testing` and `typebox` itself, so nothing needs
installing, and takes paths, `-t`, `--watch` and `--timeout` (5 s a test by default). Its help is
on [the `awf` reference](/reference/awf#test).
