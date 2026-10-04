---
id: "012"
title: Test a workflow's own logic next to it, with no agents
summary: A workflow's author writes `workflow.test.ts` beside it, scripts what each agent and decision model answers, typed by the schema each turn asks for, and checks what the workflow did with those answers, in milliseconds and for free, through the real engine; `awf test` runs it for a workflow in any folder.
type: story
status: done
discovered_in: "docs/design/tofix.md, 2026-09-30"
depends_on: []
---

# Test a workflow's own logic next to it, with no agents

## Outcome

Someone who writes a workflow can check its logic without starting an agent: the branches, the
loops, what it does with each kind of outcome, what it asks each agent, and what it returns. The
test sits next to the workflow, says what each agent answers, typed by the schema the turn asks
for, and runs the workflow through the real engine in milliseconds, for free. `awf test` runs it
for a workflow in any folder, with nothing installed there, as `awf run` runs the workflow.

Why now:

- **Workflows are getting long.** `feature-delivery` has 348 lines, two review loops and a fan-out,
  and has never run. Only the typechecker checks it.
- **The tests that exist don't show authors how.** Four examples are tested offline, from `tests/`,
  through engine and harness internals, with 20–40 lines of wiring before the first assertion. An
  author outside the repository can't write one.
- **The autoresearch loop will edit workflows** ([[013-autoresearch-loop]]). A variant that breaks a
  workflow's logic should fail in milliseconds, before it costs a trial.

```ts
// examples/feature-delivery/workflow.test.ts
import { expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "agentswf/testing";
import { REVIEW_VERDICT_SCHEMA as VERDICT, WORK_UPDATE_SCHEMA as WORK } from "./schema";
import { featureDelivery } from "./workflow";

const args = {
  ticket: "ABC-1",
  runtimes: { planner: "claude", implementer: "codex", reviewer: "codex", additionalReviewers: [] },
};
const doc = "docs/ABC-1.md";

test("the reviewer asks for one change, the planner makes it, and the feature ships", async () => {
  const run = await testWorkflow(featureDelivery, args, {
    agents: {
      // A list answers turn by turn: the planner writes the doc, then revises it.
      planner: [
        answer(WORK, { docPath: doc, summary: "plan", decisions: [] }),
        answer(WORK, { docPath: doc, summary: "plan v2", decisions: ["name the cache"] }),
      ],
      // The reviewer reviews the doc twice, then the code once.
      reviewer: [
        answer(VERDICT, { kind: "changes-requested", feedback: ["name the cache"] }),
        answer(VERDICT, { kind: "ready", summary: "doc ok" }),
        answer(VERDICT, { kind: "ready", summary: "code ok" }),
      ],
      // A single answer answers every turn the agent is asked.
      implementer: answer(WORK, { docPath: doc, summary: "built", decisions: ["LRU"] }),
    },
  });
  expect(run.value).toMatchObject({ kind: "ready-for-user-review", handoff: { summary: "built" } });
  expect(run.turnsOf("planner")[1].prompt).toContain("name the cache");
});

test("a reviewer that never approves hits the revision limit", async () => {
  const run = await testWorkflow(featureDelivery, { ...args, maxRevisionRounds: 2 }, {
    agents: {
      // A function of the turn, when the answer depends on it.
      planner: answer(WORK, (turn) => ({ docPath: doc, summary: `plan v${turn.n}`, decisions: [] })),
      reviewer: answer(VERDICT, { kind: "changes-requested", feedback: ["more detail"] }),
    },
  });
  expect(run.value).toMatchObject({ kind: "deferred", stage: "doc-review" });
});

test("a planner that goes quiet is nudged once, then the delivery defers", async () => {
  const run = await testWorkflow(featureDelivery, args, {
    agents: { planner: reply.silent() },
  });
  expect(run.value).toMatchObject({ kind: "deferred", stage: "ticket-doc" });
  expect(run.turnsOf("planner").map((turn) => turn.nudge)).toEqual([false, true]);
});
```

### The surface, one line each

- **`testWorkflow(workflow, args, { agents, decisions })`** runs the workflow through the real
  engine, answering each agent from its script, and resolves to what happened (`TestRun`).
- **`answer(SCHEMA, …)`** answers a turn that asks for `SCHEMA`: a value of the schema's type, or a
  function of the turn that returns one or a `reply`.
- **`answer(…)`**, with no schema, answers a turn that asks for none, with text. It mirrors the
  workflow's call: `agent.run({ prompt, schema })` is answered by `answer(SCHEMA, …)`, and
  `agent.run({ prompt })` by `answer("…")`.
- **`reply.silent()`, `blocked()`, `failed()`, `timedOut()`, `hang()`** end a turn without an
  answer, in that way. A reply answers no question, so it takes no schema: `planner:
  reply.silent()`.

An agent's script is one of two things:

- **One answer or reply**, which meets every turn that agent is asked, however many. Most agents
  need no more.
- **A list of them**, one per turn, in order: `[answer(WORK, …), reply.failed()]`. A turn past the
  end of the list fails the test, and so does an entry never reached.

### Every answer is typed by the schema it answers

- **The compiler checks every answer as it is written.** `answer(SCHEMA, …)` takes TypeBox's
  `Static`, or the `OutputSchema` carrier the author surface uses for other schema libraries, with
  `NoInfer` on the second parameter so a function's `kind: "ready"` doesn't widen to `string`. A
  missing field, a kind the union doesn't have, an extra field, raw JSON where a script expects
  `answer(…)`, and a reply passed to `answer` are all compile errors.
- **At run time, an answer's schema must be the turn's.** A turn asking for `STATUS` and a script
  answering `PLAN` fails the test, naming both. Schemas are compared in a canonical form (the
  engine's parsed JSON Schema, keys sorted), so equal schemas built in a different order match.
- **The engine checks the value** against the schema, as it would a real agent's. That catches
  what TypeScript can't express, such as `minItems`, and a value built with a cast.

So a workflow exports the schemas it asks with, including one built per call, such as
`minimum-review`'s `reviewSchema(lens)`.

One agent asked for several schemas in one session is a list, each entry naming its own:

```ts
builder: [
  answer(PLAN, { steps: ["add cache", "invalidate"] }),
  answer(STATUS, { step: 0, state: "done" }),
  answer(STATUS, { step: 1, state: "done" }),
  answer("Added an LRU cache with invalidation."),
],
```

### What a fake remembers

`turn.n` is the turn's number in the agent's session, so a function can answer turn 3 differently
from turns 1–2. Fakes share the working directory, as real agents do, so a review loop can run on
what was written:

```ts
planner: answer(WORK, (turn) => {
  const docPath = join(turn.cwd, "ABC-1.md");
  writeFileSync(docPath, turn.n === 1 ? "draft\n" : "draft\nwith detail\n");
  return { docPath, summary: `revision ${turn.n}`, decisions: [] };
}),
reviewer: answer(VERDICT, (turn) =>
  readFileSync(docIn(turn.prompt), "utf8").includes("detail") // docIn: the test's own helper
    ? { kind: "ready", summary: "detailed" }
    : { kind: "changes-requested", feedback: ["add detail"] }),
```

Anything else is a variable in the test. One script serves every agent a pattern matches, so
state per agent is a `Map` keyed by `turn.agent`.

### Realistic data

```ts
const migrationLock = {
  source: "catalogue", rule: "DB-3", severity: "issue",
  file: "db/migrate/2026_add_index.rb", line: 4,
  claim: "The index is built without CONCURRENTLY and locks writes on orders.",
  evidence: "add_index :orders, :customer_id",
} satisfies RawFinding;

// From the schema's defaults, with only the fields this case is about. `satisfies` keeps
// "observation" a literal; without it, it widens to `string` and `answer` refuses it.
const nit = {
  ...Value.Create(RAW_FINDING_SCHEMA), severity: "observation", file: "README.md", claim: "Typo",
} satisfies RawFinding;

const run = await testWorkflow(catalogueReview, args, {
  agents: {
    "lens:database": answer(FINDINGS_SCHEMA, { findings: [nit, migrationLock] }),
    "lens:deploys": reply.failed("harness crashed"),
    "verifier:*": answer(VERDICT_SCHEMA, (turn) =>
      turn.prompt.includes("CONCURRENTLY")
        ? { refuted: false, reason: "Runs in a transaction on a hot table.", attribution: "valid" }
        : { refuted: true, reason: "Cosmetic, outside the rules.", attribution: "not-applicable" }),
  },
});
expect(run.value).toMatchObject({
  failures: [{ stage: "lens", subject: "deploys", reason: "harness crashed" }],
});
```

## How it works

```
 workflow.test.ts                     the real engine                       scripted host
┌────────────────────┐  testWorkflow ┌──────────────────────────┐ openAgent ┌──────────────────┐
│ agents: {          │──────────────▶│ run(workflow, args)      │──────────▶│ per turn:        │
│   planner: [ … ],  │               │  agents.open / run       │  start    │  find the script │
│   "review:*": … }  │               │  parallel, deadlines     │◀─────────▶│  by agent key    │
│ decisions: {…}     │               │  result slots: schema    │  answer   │  answer over the │
│                    │◀──────────────│  check, one nudge        │  (socket) │  result socket   │
│ run.value          │   TestRun     │  decisions → scripted    │           │  or end the turn │
│ run.turns …        │               │  sandboxes → fake        │           │  blocked, failed…│
└────────────────────┘               └──────────────────────────┘           └──────────────────┘
```

- **The engine is real; only the edges are fake.** `testWorkflow` calls `runWorkflow` with a
  scripted run host in place of Herdr and the harnesses, a scripted decision provider in place of
  OpenRouter, and a fake sandbox provider. Key reuse, schema checks, the nudge, `parallel`,
  deadlines and cleanup are the production engine. The scripted host refuses what the real ones
  refuse: a pane runs claude and codex, headless claude needs `metered`, cursor can't be sandboxed.
- **A script is found by agent key.** `agents` maps a key, or a pattern like `"review:*"`, to a
  script. Agents under a `parallel` start in no fixed order, but each one's turns are in order, so
  keying by agent keeps a fan-out deterministic. An exact key wins over a pattern; two patterns
  matching one key is an error. A shared happy path is a plain object, spread:
  `agents: { ...happyPath, reviewer: … }`.
- **An answer goes through the same check a real one does**, submitted over the turn's result
  socket as `wf result` would. An answer the schema refuses fails the test with the schema error.
- **Anything unscripted fails the test, never the workflow**: an agent with no script, a turn past
  the end of a list, an entry never reached, a schema the script doesn't answer, a decision nobody
  scripted. The message names the agent, the turn and the first line of its prompt, and each
  scripted key with why it missed.
- **Nudges are turns too.** A nudge shares its turn's number and is met by the same entry, so it
  never uses up a place in a list. A function that returned a reply is asked again, with
  `turn.nudge` set; a reply ends the nudge as it ended the turn.
- **A stuck test fails, it doesn't hang.** If no turn starts or ends for `stallMs` (2 s, under
  `bun test`'s 5 s per-test timeout), `testWorkflow` rejects with the turns still in flight.
- **What the run did is data.** `TestRun` has `value` or `error` (the workflow's own failure), every
  turn as the author wrote it, with `turnsOf(key)`, the agents opened, the decisions asked, and the
  log lines.

**Time.** Deadlines are real timers. `reply.timedOut()` ends a turn at once, which is enough to
test what a workflow does with a timed-out turn. `reply.hang()` holds a turn until the engine
cancels it, which tests cancellation (`turn.signal`); something must cancel it within `stallMs`,
such as `parallel`'s fail-fast or a short `timeoutMs`. Testing deadlines themselves needs virtual
time: [[workflow-test-virtual-time]].

## Scope

In scope:

- `testWorkflow`, `answer` and `reply`, in the engine, over its host, decision and sandbox seams.
- The engine handing a host the author's prompt, label and nudge prompt.
- The boundary change that lets a test composition root in the engine install the fakes, and ADR
  0006 for it and for `agentswf/testing`.
- Tests next to seven examples, and the boundary rule for them.
- `agentswf/testing`, served as `agentswf/workflow` is, and `awf test`.
- The docs: how to test a workflow, and where tests go.

Out of scope:

- Virtual time: [[workflow-test-virtual-time]].
- Generated answers and property-based tests: [[workflow-test-generated-answers]].
- Faking a turn's cost and duration, for workflows that give up when a turn runs long or spending
  gets high. A workflow can't read spend mid-run yet (foundation §8), and a faked duration needs
  virtual time. Both fit on later without changing existing tests, for example as
  `answer(WORK, value).took("12m").spent({ usd: 0.4 })` and `reply.failed().spent(…)`, with the
  fake host reporting spend where a harness does.
- Typed decision scripts. Decision scripts are checked at run time against the questions asked.
- Assertions on timing and concurrency, and a snapshot of the run record: both would publish a
  record format. A script proves concurrency with a barrier.
- `reply.invalid`: after the engine's retry the workflow only sees `unanswered`, so it tests the
  engine.
- `bySchema` (an agent asked two schemas an unknown number of times; no example has one), and
  `fakeAgent` and `turn.history` (a variable in the test covers them). Each can be added when a
  test needs it; none can be removed once published.
- Replaying a recorded live run as a script, which would be built from `output.json` and
  `calls/`, not HTTP cassettes ([[workflow-testing#3. Record and replay|research §3]]).
- A report of which outcome kinds each agent never got across a workflow's tests (Camunda's path
  coverage), and checking fakes against recorded real answers (Pact). Todos once tests exist.
- Nested workflows (`call`) and the rest of the unbuilt surface, which throws `unavailable` in a
  test as in a run.
- The quality of an agent's answer: awf-lab and live evals.
- The engine's own tests in `tests/` that check the engine through an example.

## Context and evidence

- Fact: `triage`, `minimum-review`, `single-agent-review` and `catalogue-review` have offline
  tests in `tests/`, wiring the runtime by hand (`createFakeAdapter`,
  `createSingleSessionHostFactory`, `submit`, `createTempRunDirs`). `feature-delivery`,
  `sandboxes`, `skills-probe` and `sandbox-probe` have no run test.
- Fact: a host already receives a turn's schema (`executeOperation` in `workflow-runner.ts`). It
  doesn't receive the author's prompt (it gets the one `operationPrompt` wraps), the turn's `label`
  or the nudge's prompt.
- Fact: deadlines are real timers (`deadlines.ts`), and the engine reads `Date.now()` throughout.
- Fact: `awf run` serves `agentswf/workflow`, `typebox` and `typebox/value` as virtual modules
  (`workflow-loader.ts`, story 009); under a plain `bun test` outside the repository none
  resolves.
- Fact: boundary 4 lets only `operator-runtime.ts` install a sandbox or decision provider, and only
  tests import the fakes. The `examples` rule is `pure: true` and allows only
  `@agentswf/contract/workflow`, so an example's test can't import the testing surface or
  `node:fs`.
- Fact: the host receives the schema as a structured clone, and serialised JSON depends on key
  order; hence the canonical comparison.
- Experiment, 2026-09-30: a throwaway prototype of `testWorkflow` over `createFakeAdapter`, against
  the real examples.
  - The surface above: 7 tests (`feature-delivery`'s revision, revision limit and quiet planner, a
    list never finished, three schemas in a list, an answer for the wrong schema, and
    `catalogue-review`'s fan-out under `"verifier:*"`) in under 100 ms. `tsc`, with no annotations
    in the test, refused every planted mistake and passed every valid line.
  - Earlier versions of the prototype also ran `feature-delivery`'s blocked, failed and timed-out
    planners and its extra reviewers; `triage` with scripted decisions; `sandboxes` with a fake
    provider, which had to accept panes, skills and sandboxes; a fake planner and reviewer running
    the doc-review loop on a real file; and a workflow outside the repository under
    `bun test --preload`, with nothing installed.
  - A hung agent whose turn deadline equals the run's is a race: of six runs, four deferred and
    two failed the run. Hence virtual time as its own story.
  - Every agent in the examples is asked one schema.
- Research: [[workflow-testing]] surveys durable engines (Temporal, Inngest, Restate, Cloudflare,
  Durable Functions, Step Functions), classic engines (Camunda, Airflow, Dagster, Conductor and
  others), agent frameworks (pydantic-ai, the AI SDK, the OpenAI Agents SDK, LangGraph) and HTTP
  mocking (nock, MSW, WireMock, Pact). What it settled:
  - Closest design: the OpenAI Agents SDK's `agents.testing`. A script of results, errors or
    responders; an unscripted call fails; leftovers fail (`assert_complete()`). It has nothing for
    concurrency.
  - A single queue in call order breaks under fan-out (Step Functions Local tells users to set a
    Map's concurrency to 1). Systems that stay deterministic address a fake by name and index
    (Cloudflare's `{name, index}`, Step Functions' state and invocation): here, agent key and turn.
  - Strict by default, as nock's `disableNetConnect` and MSW's `onUnhandledRequest: "error"`; never
    falling through to something live, as Step Functions' "HybridPath" and Polly do.
  - Time as Temporal does it, later: the clock skips while every fake is idle. What users
    complain about is a test server's startup and CI flakiness, so tests here stay in-process.
- Constraint: `agentswf/testing` is a published author surface. Adding a name is cheap; removing
  one breaks tests. It starts small and grows from what the examples' tests need.

## Code map

### packages/engine

- `src/workflow-runner.ts` — `executeOperation` builds the turn a host gets; task 1 adds the
  author's prompt, the label and the nudge prompt.
- `src/workflow-testing/` — new: `testWorkflow` and the scripts, a second composition root beside
  `operator-runtime.ts` that installs the scripted host, the scripted decision provider and the
  fake sandbox provider. Exported as `@agentswf/engine/workflow-testing`.
- `src/workflow-loader.ts` — `AUTHOR_SURFACE`; task 4 shares its module table with the `awf test`
  preload.
- `src/operator-cli.ts` — task 4 adds `awf test`.
- `src/testing.ts` — the engine's internal test helpers; stays internal.
- `src/decisions/fake.ts` — takes provider-shaped responses; the scripted provider takes answers
  in the author's terms, keyed by decision key.

### packages/harness

- `src/adapter.ts` — `HarnessSession.start(turn, binding)`. The author's prompt reaches a host in a
  harness-owned shape, not in `AgentTextTurnSpec`, a contract type `enqueue` also takes. `label`
  rides on the existing turn spec.
- `src/session-core.ts` — hands a backend the turn as the author wrote it (`authored`), so
  `createFakeAdapter` under the real session rules can answer as the agent.
- `src/single-session-host.ts` — forwards what task 1 adds.

### packages/sandbox

- `src/testing/fake.ts` — `createFakeSandboxProvider({ panes })`, now also used by the engine's
  test composition root.

### scripts, examples and tests

- `scripts/check-boundaries.ts` — rule 4: `workflow-testing` may import the fakes. A new rule for
  `examples/**/*.test.ts`: the author surface, `@agentswf/engine/workflow-testing`, `typebox` and
  Node built-ins; not pure. `examples/package.json` declares the engine.
- `examples/*/workflow.test.ts` — new, for seven examples; each workflow exports its schemas.
- `tests/{minimum-review,triage,single-agent-review,catalogue-review}.test.ts` — what they check
  about the workflow moves; what they check about the engine stays.

### docs

- `docs/adr/` — ADR 0006.
- `docs/workflow-api.md`, `docs/testing.md`, `examples/README.md`, `docs/status.md`.
- `AGENTS.md` (boundaries 4 and 6), `docs/foundation.md` §6, `packages/engine/AGENTS.md`.

Not changing: `packages/contract`, `packages/wf`, `packages/lab`.

## Proposed design

### The surface

```ts
import { answer, reply, testWorkflow } from "agentswf/testing";

answer(SCHEMA, value | (turn) => value | reply)    // an Answer to a turn that asks for SCHEMA
answer(text | (turn) => text | reply)              // an Answer to a turn with no schema
reply.silent() | blocked() | failed() | …          // a Reply: ends any turn, no schema
type Script = Answer | Reply | (Answer | Reply)[]; // every turn alike, or one per turn in order

const run = await testWorkflow(workflow, args, {
  agents?: { [keyOrPattern: string]: Script },
  decisions?: { [decisionKeyOrPattern: string]: (request) => Answers | Error },
  runtimes?: RuntimeAliases,  // beside awf run's, claude and codex
  timeoutMs?: number,         // the run's deadline; 30 minutes, as `awf run`
  stallMs?: number,           // real time with no turn starting or ending; 2 s
  cwd?: string,               // default: a temporary directory, removed afterwards
});
run.value; run.turns; run.turnsOf("reviewer"); run.agents; run.agentOf("reviewer"); run.decisions; run.logs;
```

- **`workflow`** is a definition or an executable. `prepare` is a plain function; a test calls it
  directly.
- **`Turn`**: `agent`, `n` (1-based in that agent's session; a nudge shares its turn's number),
  `nudge`, `prompt` and `schema` as the author wrote them, `label`, `cwd`, and `signal`, which fires
  when the engine cancels the turn. What the agent was opened with is on `run.agents`.
- **`decisions`** are keyed like agents, and answer in the author's terms per question: an option
  name or probabilities, a boolean or a probability of yes, a level or probabilities. An `Error`
  makes `decide` reject, as a provider failure does.
- No `bun:test` import, so the helper stays out of the test runner's lifecycle.

### Where it lives

- `packages/engine/src/workflow-testing/`, since it runs the engine: a second composition root that
  installs fakes where `operator-runtime.ts` installs providers. ADR 0006 records it and the
  boundary change.
- Exported as `@agentswf/engine/workflow-testing` in the workspace; served elsewhere as
  `agentswf/testing`.
- `awf test [paths…]` runs `bun test` with a preload serving `agentswf/workflow`,
  `agentswf/testing`, `typebox` and `typebox/value`. It passes on only `-t`, `--watch` and
  `--timeout`, so the published command isn't Bun's CLI.

### The host sees the author's turn

Task 1 gives a host the author's prompt and the nudge's prompt beside the wrapped ones, in a
harness-owned shape rather than on `AgentTextTurnSpec`, and puts `label` on the turn spec.
Production adapters ignore them.

### Alternatives rejected

- **More helpers.** A first design had `answering(SCHEMA)`, `sequence`, `bySchema`, `text`,
  `fakeAgent` and `turn.history`. A list replaces `sequence`; a single answer covers what the
  examples needed of `bySchema`; `answer` types as well as `answering` and folds in `text`; a
  variable in the test replaces `fakeAgent` and `history`.
- **Other shapes for a script**, prototyped and run on the same cases: an agent as a function of
  its turn (order becomes `turn.n` arithmetic; kept as `answer(SCHEMA, (turn) => …)`); an agent as
  a generator of its session (powerful, but many authors don't read generators fluently); and the
  test driving each turn, as Angular's `HttpTestingController` (reads as a story, but a missing
  turn fails only after a wait, and agents the test doesn't drive still need scripts).
- **A fake `WorkflowContext` with no engine**, as Durable Functions' mocked context. It
  re-implements `parallel`, deadlines, nudges and schema checks and drifts from the engine; tests
  through the real engine take 5–20 ms.
- **Scripting by global turn order.** Any fan-out makes it depend on scheduling.
- **Untyped scripts and lenient defaults.** A test would pass without exercising the path it
  names.
- **A test server or container**, as Temporal's TypeScript SDK and Restate use: users report its
  startup and CI flakiness as the main cost.
- **Exposing the harness fakes** to authors: sockets, bindings and nudge kinds to say "the
  reviewer approves".
- **`agentswf/*` through `node_modules`** in an author's folder: an install per workflow folder,
  which story 009 decided against.

## Tasks at a glance

- [x] 1. The host sees the author's prompt, label and nudge prompt
- [x] 2. `testWorkflow` and typed scripts through the real engine
- [x] 3. Every example's logic tested next to it
- [x] 4. `agentswf/testing` and `awf test` for a workflow in any folder
- [x] 5. The docs say how to test a workflow

Examples come before publishing: seven workflows' tests prove the surface before an outside folder
depends on it.

## Open questions

None.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. The host sees the author's prompt, label and nudge prompt

Outcome: a host's `start` and a turn's `nudge` receive what the workflow wrote (prompt, label,
nudge prompt) beside the prompts the engine wraps. Adapters are unchanged, and no contract type
changes.

Execution:

- [x] Plan: inspect the relevant code and tests, settle the cleanest module, interface, seam,
  invariants, failure behavior, and focused proof, and record material alternatives before coding.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: have two read-only subagents review this task's actual diff and test output—one for
  architecture and scope, one for correctness and proof.
- [x] Resolve: fix or explicitly disposition every material finding; request targeted re-review
  when a fix changes the selected architecture.
- [x] Verify: run this task's focused checks and satisfy every `Done when` item before checking the
  task in `Tasks at a glance` or starting the next task.

Work:

- Choose the harness-owned shape: a second argument to `start` and `nudge`, or a harness type
  that wraps the turn spec.
- `label` on the turn spec the engine builds in `executeOperation`.

Done when:

- An engine test with a recording host sees the author's prompt, schema and label for a turn, the
  author's nudge prompt for a nudge, and the wrapped prompts unchanged.
- `bun test`, `bun run check`.

### 2. `testWorkflow` and typed scripts through the real engine

Outcome: `@agentswf/engine/workflow-testing` exports the surface above, tested against small
workflows written for its own tests; ADR 0006 and the boundary change are in.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- ADR 0006, and rule 4 in `check-boundaries.ts`: `workflow-testing` may import the sandbox and
  decision fakes. `AGENTS.md` boundary 4, `docs/foundation.md` §6 and `packages/engine/AGENTS.md`
  change with it.
- A scripted `AgentRunHostFactory` that applies the real hosts' harness and placement refusals,
  records skills and sandboxes, and answers each turn over its result socket.
- A scripted decision provider keyed by decision key; the fake sandbox provider with panes.
- `answer`, `reply`, and a script as one entry or a list; canonical schema comparison.
- Strictness errors with near misses; the stall limit; `timeoutMs`.

Done when:

- Tests cover each reply kind and the outcome it produces; exact keys, patterns and two patterns
  matching one key; a list running out, a list never finished, and a list for an agent never
  opened; a single answer never used, which passes; an unscripted agent, schema and decision; an
  answer whose schema isn't the turn's, and equal schemas in a different key order, which match;
  an answer the schema refuses; a nudge answered by a function and left silent by a value; a
  fake's file in `turn.cwd` read by the workflow; cancellation under `parallel`'s fail-fast, seen
  through `turn.signal`; a harness in a placement no host runs; a script that never settles,
  caught by the stall limit; and a workflow's own throw as `error`.
- A `*.typecheck.ts` file, as `contract` has for deadlines and decisions, holds each wrong answer
  under `@ts-expect-error`, and valid, conditional and `async` functions without it.
- A test file runs in under a second.
- `bun test`, `bun run check`.

### 3. Every example's logic tested next to it

Outcome: seven examples have `workflow.test.ts` beside them, written only against the testing
surface, and `bun test` runs them.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- The `examples/**/*.test.ts` boundary rule and `examples/package.json`; `AGENTS.md` boundary 6
  and `docs/foundation.md` §6 change with it.
- First tests for `feature-delivery` (both review loops, the revision limit, the doc-path checks,
  the extra reviewers), `sandboxes` and `skills-probe`.
- The workflow-logic cases of `triage`, `minimum-review`, `single-agent-review` and
  `catalogue-review` move from `tests/`.
- Each workflow exports the schemas its test answers, such as `minimum-review`'s `reviewSchema`
  and `catalogue-review`'s `RAW_FINDING_SCHEMA`.
- Not `quick-check` or `sandbox-probe`: they are live probes of real agents and sandboxes.
- Whatever an example needs that the surface can't express goes back to task 2, not into a
  workaround.

Done when:

- `bun test examples` passes, and each of the seven has a test file.
- `bun run scripts/check-boundaries.ts` refuses an example test that imports the engine's
  internals, shown by a boundary test.
- `bun test`, `bun run check`.

### 4. `agentswf/testing` and `awf test` for a workflow in any folder

Outcome: in a folder outside the repository, `awf test` runs `summarize.test.ts` next to
`summarize.ts`, both importing `agentswf/*` and `typebox` with nothing installed, and reports as
`bun test` does, exit code included.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- The preload, sharing its module table with `workflow-loader.ts`; `agentswf/testing` only under
  `awf test`.
- `awf test` in `operator-cli.ts`, with `-t`, `--watch` and `--timeout`, and its help.
- The typings a workflow folder's `tsconfig.json` maps, as story 009 did for `agentswf/workflow`.

Done when:

- An operator-CLI test runs `awf test` in a temporary folder outside the repository: one passing
  and one failing test, the right exit codes, and no `node_modules` created there.
- `bun test`, `bun run check`.

### 5. The docs say how to test a workflow

Outcome: an author who reads `docs/workflow-api.md` can write and run a test for their workflow,
and the rest of the docs agree with what shipped.

Execution:

- [x] Plan: inspect the relevant docs and record what each must say.
- [x] Implement: make only this task's coherent change.
- [x] Review: obtain an accuracy review against the shipped code, and a reader's review for
  someone who has written a workflow but not a test.
- [x] Resolve: disposition findings.
- [x] Verify: every code sample in the new section runs as a test.

Work:

- `docs/workflow-api.md`: a "Testing a workflow" section (a first test, typed answers, lists,
  replies, what a fake remembers, decisions, `TestRun`, strictness, time, `awf test`); "At a
  glance" gains the testing calls.
- `docs/testing.md`: level 1 counts the workflow tests, where they live, and when to write one.
- `examples/README.md`: which examples have tests, and how to run one.
- `docs/status.md`: what runs today, and this story's state.
- `docs/design/tofix.md`: the note this story came from, pointed at the story.

Done when:

- The section's samples live in an example's test and are quoted from it, or are extracted into
  a test that passes.
- `bun run check`.

## Verification

Automated:

- [x] `bun test examples`: every example's workflow tests. 7 files, 48 tests, ~0.3 s.
- [x] `awf test` in a folder outside the repository: task 4's CLI tests (a pass and a fail, exit
  codes, `-t`, paths, `--help`, the real command's exit code, SIGINT) and the API page's samples.
- [x] The typecheck file of task 2, under `bunx tsc --noEmit`: every planted mistake refused.
- [x] `bun test`: 978 tests, 976 pass, 2 skip (as before the story), 0 fail, 2026-09-30.
- [x] `bun run scripts/check-boundaries.ts`: ok, with the two new rules and their tests.

Manual or live evaluation: none. Nothing here starts an agent.

## Review record

### Refinement

- Design review, 2026-09-30, a read-only agent against the code and the prototype. Taken: the
  boundary conflicts (a test composition root, ADR 0006, a rule for example tests); a smaller
  first surface; canonical schema comparison; task 1 narrowed to what hosts lack; the real hosts'
  refusals in the scripted host; decisions keyed by decision key; `stallMs` under Bun's timeout;
  examples before publishing; virtual time as a todo; `awf test` with named flags only.
- Second review, 2026-09-30, of the story against the code: an example that didn't typecheck
  (`satisfies` added), `run.value` read without a check, the nudge rule, `hang()` and the stall
  limit, which examples get tests, and boundary docs changing with their rules. All fixed.
- Surface, 2026-09-30, with the user: other script shapes prototyped and rejected for
  readability; each helper checked against the examples' tests and cut to `answer` and `reply`; a
  reply is a script entry of its own, and stays a standalone helper rather than a method on the
  turn.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

Worktree `../worktrees/awf-workflow-tests`, branch `workflow-tests`, from main `5fdc19e`; the
story docs are its first commit (`6c2981b`). `bun install` is needed in a new worktree before
`bun test`; after it the baseline was 887 pass, 0 fail.

### Task 1

Plan, recorded before coding:

- Shape: `HarnessAuthored { authoredPrompt?: string }` in `harness/src/adapter.ts`, intersected
  with the contract's turn specs in `HarnessSession.start`, and extended by `HarnessNudgeSpec`.
  Optional so the ~90 test call sites of `start` stay as they are; the engine always sets it.
  Rejected: a field on `HarnessOperationBinding` (that type is the result authority, and a nudge
  takes none), and a required field (churn with no reader but the test host).
- `label` rides on the contract spec, which `AgentTurnBase` already declares; the engine now
  copies it from the author's spec.
- A nudge's `authoredPrompt` is the text before wrapping: the author's nudge prompt, or the
  engine's default recovery prompt.

Review:

- Architecture (important, fixed): `session-core` built `NativeTurnRequest` from the spec's `id`,
  `prompt` and `deadline` only, so a backend under `createSessionAdapter`, which is where the real
  harness and placement refusals, the one-nudge rule and the finishing grace live, never saw what
  the author wrote. Task 2's scripted host would have had to re-implement `HarnessSession` or match
  turn ids across layers. Now `NativeTurnRequest.authored` is an `AuthoredTurn` (`prompt`, `label`,
  `schema`); a nudge carries its own prompt and its turn's label and schema, and
  `createFakeAdapter` hands it to its script. Production backends don't read it.
- Architecture (minor, fixed): the doc comment says `label` and `schema` are on the spec already.
- Architecture (minor, kept): `authoredPrompt` optional though always set, as planned.
- Correctness (minor, fixed): the test now pins the recorded turns exactly (a turn, then its
  nudge), checks the wrapped prompt still names the operation, and covers a text turn.
- Correctness: every production path was checked; the engine has one `start` and one `nudge`
  call, and nothing downstream reads `label` from a turn spec.

Proof: `an adapter sees the turn as the workflow wrote it…` (author and default nudge prompt) and
`an adapter sees a text turn…` in `workflow-runner.test.ts` read `adapter.turns[].authored`; all
three fail against the old engine. `bun run check` clean; `bun test` 888 pass, 0 fail.

### Task 2

Plan, recorded before coding:

- `packages/engine/src/workflow-testing/`: `script.ts` (`answer`, `reply`, finding a script by key
  or pattern, lists, canonical schema comparison; no I/O), `host.ts` (the scripted host),
  `decisions.ts` (the scripted decision provider), `index.ts` (`testWorkflow`, `TestRun`).
  Exported as `@agentswf/engine/workflow-testing`. Nothing in it imports `bun:test`.
- The scripted host is the harness's own pieces: `createPlacementHostFactory` over a pane side and
  a headless side, each `createSingleSessionHostFactory(createFakeAdapter(…))`. So the one-nudge
  rule, deadlines, release and status are the production session core's; the script sees
  `authored` (task 1). `createFakeAdapter` gains `placement`, `launchesInSandbox`, `givesSkills`
  and a `refuse` hook.
- The real refusals move into one harness module both real adapters and the fake use, so they
  can't drift: a pane runs claude and codex; headless claude needs `metered`; cursor can't be
  sandboxed. (The story said "cursor only in a pane, pi only headless"; the code says otherwise.)
- Default runtime aliases are the ones `awf run` installs, moved from `operator-runtime.ts` to a
  module both import, so an alias `awf run` doesn't know fails the test as it would the run.
- Decisions: the directory adds the call's `key` to `ProviderRequest`, which OpenRouter ignores;
  the scripted provider is installed as `jev`, as `awf run` installs it.
- An answer goes over the result socket through the engine's `submit`, moved out of `testing.ts`
  (which imports `bun:test`) into its own module.
- Turns are counted per agent key by the host, not by the adapter's counter, which counts nudges
  and restarts on reactivation. A turn without `authored` is a bug and fails the test.
- A script error (no script, wrong schema, list run out, answer refused) or a stall aborts the run
  through `RunWorkflowOptions.signal` and rejects `testWorkflow` with it; the workflow's own
  failure is `run.error`.
- Proof: `workflow-testing.test.ts` against small workflows written for it, covering each item
  of task 2's `Done when`, and `workflow-testing.typecheck.ts` for the typing.

Deviations found while building it:

- **"A value leaves a nudge silent" is gone.** The engine nudges only a turn that went unanswered,
  and a value always answers, so the rule could never apply. A function that returns a reply is
  asked again for the nudge; a reply ends the nudge as it ended the turn.
- **A script still deciding when its turn is cancelled is let go**, as `hang` is. Without it, a
  script that never settles held its turn, and the run could not end after a stall.
- **`run.agents[].sandbox`** is the sandbox's key, read from the run's record (`agent:{key}` for
  a private one), rather than a flag.
- The boundary checker let `bun:test` through before any `forbid`; it now checks `forbid` first,
  so the rule for `workflow-testing/` can refuse it.

Review, architecture and scope (all taken but where said):

- Important: `@agentswf/sandbox/testing` re-exports the conformance suite, which imports
  `bun:test`, so the "no test runner" rule held only for direct imports. The fake now has its own
  path, `@agentswf/sandbox/testing/fake`, and the rule allows only that.
- Important: shipped code depends on `@agentswf/harness/testing`; ADR 0006, `AGENTS.md` and
  foundation §6 now name both fakes.
- Important: a decision script that threw became a provider failure; it now fails the test, and
  only a returned `Error` is the provider's.
- Important: the surface exported `AnswerOf`, `TurnReply`, `AskedDecision`, `DecisionAnswer`,
  `OpenedAgent` and `TurnRecord`. It now exports `testWorkflow`, `answer`, `reply`, `Script`,
  `Turn`, `TestOptions`, `TestRun`, `DecisionScript` and `DecisionRequest`.
- Important: a turn record's `reply` held `"answer"` and a script error as `"failed"`. It is now
  `outcome`: `answered`, a reply's kind, or `cancelled` (after the hand-off; see below).
- Important: the story's default aliases; now `awf run`'s, which `runtimes` replaces.
- Minor, taken: one key-or-pattern lookup for agents and decisions; agents recorded where they
  open, not in the `refuse` hook; `perform` without the identity-with-a-side-effect; the pane
  refusal claim narrowed (the fake provider hosts panes); what a bare number means in a decision
  answer documented; `OPERATOR_ALIASES` frozen. Kept: the abort listener `whenAborted` leaves on a
  turn's own signal, which ends with the turn.

Review, correctness and proof (all taken):

- `Type.Object` with its properties in another order has `required` in another order; `required`
  is now compared as a set, with a test of two TypeBox schemas.
- Decision probabilities are checked (each in [0, 1], one per option or level, summing to 1)
  before the engine sees them, so a bad script fails the test, not the workflow.
- A function returning nothing, an empty list, and a pattern's list no agent matched each fail
  the test with their own message; an unfinished list's message keeps what the workflow threw; a
  script still deciding when its turn is cancelled is recorded `cancelled`.
- Tests added for what had none: `timeoutMs`, `cwd`, `logs`, skills and instructions on
  `run.agents`, and cursor refused a sandbox.
- Two new tests first cancelled a turn by the run's deadline, and flaked: a turn whose deadline
  equals the run's is the race recorded under Context. They cancel through `parallel`'s fail-fast
  instead, and `timeoutMs` is checked by the deadline the workflow sees.

Targeted re-review of the fixes: each resolution holds; nothing under `workflow-testing/` reaches
`bun:test` through its imports. Fixed after it: an answer whose submit throws now still ends its
turn (`cancelled` when the turn was cancelled first), and a stale line in foundation §6. Kept on
purpose: `TestRun`'s turn and agent records and `DecisionAnswer` are reachable through
`TestRun<R>["turns"][number]` and `DecisionScript` rather than exported by name, since a name
published can't be taken back; the examples' tests will show whether one is needed.

Verify: `workflow-testing.test.ts` 43 pass in ~0.35 s, stable over 10 runs; the typecheck file
refuses each planted mistake.

### Task 3

Plan, recorded before coding:

- The `examples` rule stops covering `*.test.ts`. A second rule covers them: they may import
  `@agentswf/contract/workflow`, `@agentswf/engine/workflow-testing` (served as `agentswf/testing`
  outside the repository, task 4), `typebox` and runtime built-ins such as `node:fs`, and never the
  rest of the engine or a harness. `examples/package.json` declares the engine.
- One example at a time, each test written against the surface only; whatever the surface can't
  say goes back to task 2's code, not into a workaround.
- What `tests/{minimum-review,triage,single-agent-review,catalogue-review}.test.ts` check about the
  workflow moves beside it; what they check about the engine or `awf run` (a first turn's own
  deadline against the nudge's, a result for the other lens refused, `prepare` and `present`
  through the CLI) stays.

Done so far: `workflow.test.ts` beside `feature-delivery` (11), `triage` (3), `minimum-review`
(7), `single-agent-review` (4), `catalogue-review` (13), `sandboxes` (5) and `skills-probe` (3):
46 tests in ~0.25 s, stable over 10 runs. `tests/single-agent-review.test.ts` and
`tests/catalogue-review.test.ts` moved whole; `tests/minimum-review.test.ts` keeps its two engine
cases; `tests/triage.test.ts` stays as the check that `awf run` installs decision models and
prints `present`. Workflows now export `reviewSchema` (minimum-review), `FINDINGS_SCHEMA`
(single-agent-review) and `REPORT` (sandboxes, skills-probe).

What the examples changed in the surface:

- **`runtimes` adds to `awf run`'s aliases** instead of replacing them. `catalogue-review`'s test
  had to repeat `claude` to add a `judge`; adding is the common case, and a name given replaces
  the default one.
- **Under `parallel`, `run.turns` and `run.agents` are in the order things started**, which is
  scheduling. Two first drafts indexed them and flaked one run in three; a test reads an agent's
  turns with `turnsOf(key)`, and an agent with `run.agents.find`. The docs (task 5) say so.
- Nothing needed a type the surface doesn't export: `Script` typed a shared happy path, and
  `satisfies RawFinding` typed realistic data.
- Not tested, and why: a public skill from a git repository (fetching it needs the network), so
  `single-agent-review`'s pinned skill is tested as far as `prepare`.

Review, API as used (taken but where said):

- `run.value!` 21 times, and a workflow's unexpected throw read as "received undefined". `value`
  is now typed as the result and, when the workflow threw, reading it throws with the workflow's
  error as the cause; `error` is undefined when it returned.
- `run.agents.find(…)!` and sorts by key under `parallel`: `run.agentOf(key)`, which throws
  naming the keys opened, beside `turnsOf(key)`. One name more, and the ordering trap mostly gone.
- Kept: `turnsOf(x)[n]!` (the `!` is this repository's `noUncheckedIndexedAccess`), `present!`
  (the contract's), `String(run.error)`, the happy-path spread, args from `prepare()`.
- Kept: `runtimes` merging. An alias only a test knows (`judge`) describes an operator's
  configuration `awf run` can't install yet; task 5's docs say so.
- `tests/triage.test.ts` now checks only what `awf run` does (one ticket through the operator's
  decision model, and `present`); the three-ticket logic lives beside the example.
- The boundary test also refuses a harness import, a path out of `examples/`, and the testing
  surface from a workflow itself.

Review, correctness (all taken):

- `sandboxes`' "the auditor runs only once the team has reported" passed a workflow that started
  the auditor once the team had only started. It now has a barrier: each of the team reports
  after a moment, and the auditor's script fails the test if asked before all three have.
- Swapping docker and srt between the team and the auditor passed every test: the surface gave
  a sandbox's key only. `run.agents[].sandbox` is now `{ key, provider }`, from the run's record.
- Also: triage's decisions read by key, and a 0.89 answer pinning the threshold; minimum-review's
  `failed` outcome; single-agent-review's `--runtime` reaching the agent; skills-probe's runtimes.
  (`cancelled` can't be scripted: only the engine cancels a turn.)

Verify: `bun test examples` 7 files, 48 tests; with the helper's own, 92 pass over 10 runs;
`bun run check` clean; `bun test` 0 fail.

### Task 4

Plan, recorded before coding:

- `workflow-loader.ts` exports `serveAuthorSurface(more)`, the one table `awf run` serves; a
  preload, `workflow-test-preload.ts`, serves it with `agentswf/testing` beside it. Only `awf
  test` loads the preload, so `agentswf/testing` exists only under `awf test`.
- `test-command.ts`: `awf test [paths…] [-t pattern] [--watch] [--timeout duration]` runs
  `bun --no-env-file test --preload …` in the current directory and exits with its code. Any other
  flag is refused, so the published command is awf's, not Bun's. Output is inherited; a caller
  that gives `stdout`/`stderr` (the CLI's tests) gets it captured.
- The README's editor-types section maps `agentswf/testing` and `bun:test`'s types into the clone.
- Rejected: installing `agentswf` in a workflow's folder (story 009 decided against it); passing
  every `bun test` flag through (the command would be Bun's forever).

Done so far: a first run in a folder under the scratchpad, outside the repository, passed and
failed as `bun test` does and created nothing there. `tests/operator-cli.test.ts` → `awf test`: a
passing and a failing test, exit 1, `-t` narrowing to exit 0, no `node_modules`, and a refused
flag exiting 2 with the usage. `tsc` in that folder with the README's `tsconfig.json` checks a
test against `agentswf/testing` and `bun:test`. `bun test` 0 fail; `bun run check` clean.

Kept as they are: the examples import `@agentswf/engine/workflow-testing`, as they import
`@agentswf/contract/workflow` for `agentswf/workflow`; the docs show the published names. Serving
`agentswf/testing` inside the repository through a root preload was weighed in review and
rejected: a global plugin in every test process, `paths` for `tsc`, a boundary change, and two
names for one thing in the examples.

Deviation: the command lives in `test-command.ts`, and `operator-cli.ts` only dispatches to it.

Review, architecture and scope (taken but where said):

- High: positional "paths" were Bun's substring filters (`awf test a` also ran `ab/`). A path is
  now resolved against the current directory, must exist, and reaches Bun absolute.
- The help promised Bun's output and exit codes, and only `*.test.ts`. It now promises exit 0, 1
  (a failure, or no tests) and 2 (usage), says the output is for reading, and names `*.spec.ts`.
- `-h`/`--help`; the top-level usage's `options:` is `run options:`.
- `serveAuthorSurface` called again with more modules throws rather than dropping them.
- `parseDuration` moved to `duration.ts`, which both commands import, instead of being passed in.
- Noted, not changed: a compiled `awf` would need something other than `process.execPath` to run
  `bun test`; nothing is compiled today (ADR 0005, "Not decided"). A workflow that imports
  `agentswf/testing` passes `awf test` and then fails at load under `awf run`, clearly and early;
  telling a workflow's imports from its test's is not worth the loader's complexity.
- For task 5: a folder's `bunfig.toml` still applies under `awf test`; the README's `types`
  replaces automatic `@types` discovery, so an author adding `@types/node` lists it too.

Review, correctness (taken but where said):

- Medium: a signal to awf alone (`kill -INT`, `kill -TERM`) wasn't passed on, so `bun test
  --watch` was left running with no parent. `runWorkflowTests` now takes the run's signal and
  stops the tests with it; a test ended by a signal exits 128 and its number.
- Tests added: a path is not a filter, a missing one exits 2, `--help`, the real command as a
  subprocess (exit 1, output left to the terminal), and SIGINT to awf alone leaving no test
  process behind.
- Not changed: under `awf run`, a workflow importing `agentswf/testing` fails with Bun's "Cannot
  find package 'agentswf'"; naming `awf test` there would be kinder, and is left for the loader's
  own errors to improve together.

Verify: the `awf test` block 6 pass, stable over 5 runs; `bun test` 0 fail; `bun run check` clean.

### Task 5

Plan, recorded before writing:

- `docs/workflow-api.md` gains "Testing a workflow" after "Logging and usage", and "At a glance"
  the testing calls. The page's own `summarize` workflow exports its schema and gets a test.
- Every code block in the section is checked by `tests/workflow-api-samples.test.ts`. A block
  whose first line names a bare file (`// summarize.test.ts`) is written, with the page's
  `summarize.ts`, to a folder outside the repository, and `awf test` runs it there, so the samples
  run as an author would run them, published names and all. A block naming an example
  (`// examples/triage/workflow.test.ts`) must appear in that file, `agentswf/testing` read as
  `@agentswf/engine/workflow-testing`.
- `docs/testing.md` level 1, `examples/README.md` and `docs/status.md` say where the tests are
  and how to run one.
- Deviation: `docs/design/tofix.md`, which this story came from, has the user's own uncommitted
  edits on main, so the branch doesn't touch it; pointing its note at the story is left to them.

Review, accuracy (all taken): "every example has its tests" (not `quick-check` or
`sandbox-probe`); a failure's message names the prompt "usually", not always; `awf test` finds
`*.spec.ts` too; `runtimes` can replace an alias; `hang` is ended by a cancellation, not in
practice by the deadline, since the stall comes first; the `sh` block's `-t` example now runs in
the samples test too.

Review, a reader who has written a workflow but no test (taken but where said): "script" is said
before it is defined; a nudge's second turn record was unexplained; `timeoutMs` and `stallMs` read
as `agent.run`'s; `args` skip `prepare`; the feature-delivery snippet didn't stand alone (its happy
path is now quoted too); the triage fragment stopped mid-object; decisions had no heading; how to
prove overlap and how to check an agent was never asked were missing. Kept: the examples import
`@agentswf/engine/workflow-testing`, and the quoted samples use the published name, which the
samples test maps.

Verify: `tests/workflow-api-samples.test.ts` writes the page's `summarize.ts` and
`summarize.test.ts` to a folder outside the repository and runs them with `awf test`, the page's
`-t nudged` command included, and checks each quoted block is still in its example. A changed
sample fails it (tried with one of each kind). `bun run check` clean; `bun test` 0 fail.

### After the hand-off

- The user asked whether a test can verify that an agent is inside a sandbox, with the sandbox's
  settings to inspect. It could check the key and provider only. `run.agentOf(key).sandbox` is now
  `{ key, provider, spec, domains }` from the run's record: the resolved `read`, `write`,
  `network`, `cwd` and provider settings, and every domain reachable in the end, the harness's
  model included. The directory, homes and call paths stay out. `sandboxes`' test checks the team
  writes the working directory and reaches the npm registry, and the auditor writes nothing and
  reaches only its model; the API page quotes it. The sandbox is still the fake provider, which
  confines nothing: enforcement stays with the sandbox evals.
- The user asked for a review of the branch for slop, parallel features and duplicated or wrong
  abstractions, repeated until none is found. Round 1, three reviewers (helper, plumbing,
  examples); fixed:
  - Answers were submitted by a copy of `wf`'s client that checked nothing it got back; the host
    now calls `wf`'s own `submitResult` (`@agentswf/wf/client`), and `result-submit.ts` is gone.
  - The decision checks copied `answersOf` with a tighter sum (1e-6 against Jev's 0.99–1.00), so a
    real Jev answer failed a test. The provider now turns the shorthand into distributions and
    `answersOf` judges them; a test of a 0.99 sum passes.
  - The authored turn travelled as `authoredPrompt`, a `label` copied onto the turn spec, and a
    record `session-core` rebuilt; it is now one `authored` field the engine builds, for the turn
    and for its nudge, and the harness forwards.
  - `serveAuthorSurface(more)` knew about testing and guarded a call that cannot happen; the
    preload registers `agentswf/testing` itself.
  - Dead: the `script-error` outcome (such a run never returns) and `TurnRecord.answer` (never
    read). A stalled run named every turn in flight as `(hang)`, a placeholder; it names the turns.
  - `messageOf` was a second copy; `DecisionRequest` restated `ProviderRequest`, and is now it
    without `model`; `PLACEMENT_HARNESSES` moved beside `HARNESS_NAMES`; the fake adapter takes
    the session adapter's own options by `Pick`.
  - `run.error` and a throwing `run.value` were two reads of one failure, and five examples wrote
    `String(run.error)`; `error` is gone, and a failure is `expect(() => run.value).toThrow(…)`.
  - Examples pinned the operator's model names (`sonnet`, `gpt-5.6-sol`); they check the alias the
    workflow chose. `skills-probe` pins one agent literally, as its expectations came from the
    table the workflow reads. Comments that restated a line and a sample count went.
  - Kept, on purpose: each workflow exports the schemas its test answers (Decisions above);
    `reply.failed("harness crashed")` where a test asserts the reason; `present!`, an author
    surface change outside this story.
- Round 2, two reviewers (code; tests and docs); fixed: `sameSchema` had a third key-sorting
  helper, so the engine's `canonical` moved to `canonical-json.ts` for both; a decision's end now
  counts as activity, as `stallMs` says; `HarnessAuthored` no longer claims a field its type leaves
  optional; the single-answer test now meets two turns of one agent; the API page gives `awf
  test`'s exit 2, says what fails a decision's script, and states the default aliases once.

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [x] Record the human's explicit approval or requested changes here: after the review rounds, the
  user asked to commit and squash-merge to main, 2026-09-30.
- [x] If changes are requested, return to the affected task and repeat its review and verification.
- [x] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
