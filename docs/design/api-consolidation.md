# API consolidation: one way to do each thing

What should change so the workflow author API has one way to do each thing, answering
[[039-one-way-author-api|story 039]], which holds its scope and tasks. Nothing here is built. **Structural** marks a change to behaviour, a record
format or the wire protocol, not only to a name or a type.

## 1. One context type

Declaring `events` switches a workflow to a second context type and a second agent type. Only that
context has `timer`, `race`, `select`, `at` and `after`, so a workflow that just wants to wait, or
race an agent against a deadline, has to declare events and a `file` it doesn't need.

```ts
// today: race is missing from a plain workflow's context
defineWorkflow({ meta, async run(wf) {
  await wf.race("approval", { reply: approver, expiry: "14d" });     // type error
}});
// to get it, the workflow declares events, its file and an id
defineWorkflow({ meta, file: import.meta.path, events: { … }, id: (args) => …, async run(wf) { … } });

// after: every workflow has the time calls; events lists only what may wake the run
defineWorkflow({ meta, events: { "approver:reply": ParticipantReply }, async run(wf) {
  const approver = await wf.participants.connect({ key: "approver" });
  await approver.post(`Approve ${doc}?`);
  const first = await wf.race("approval", { reply: approver, expiry: "14d" });
}});
```

- `EventWorkflowContext` and `EventAgentRef` go; one `WorkflowContext<Events = {}>` and one
  `AgentRef`, typed by whatever the workflow declares.
- `signal`, `started` and `receive` accept only declared names, so a misspelled name is a compile
  error. `Events` defaults to `{}`: with today's `never`, every string would count as declared.
- `file` and a run id are required only with `starts`, where a sender starts a run by naming the
  file and an id.
- **`--from-stage` works for every run** (**structural**). It reruns that stage and every stage
  after it. A workflow with events refuses it today, so a bad stage result in such a run can't be
  redone.

  ```sh
  # today, for a workflow with events: refused
  awf run review.ts --id pr-42 --continue --from-stage plan
  # after: accepted, the same as for a workflow without events
  ```

## 2. Agents

### `run` and `start`: names kept

Both send the agent a prompt and take the same spec: an optional `schema` makes the answer a typed
value, and without one the answer is text. The difference is only when the workflow hears the end:

```ts
const { outcome } = await reviewer.run({ prompt, schema: FINDINGS });   // waits here for the end
await reviewer.start({ prompt, schema: FINDINGS });                      // returns at once; needs "reviewer:ended" in events
const e = await wf.race("review-or-close", { done: reviewer, closed: wf.signal("pr.closed") });
```

`run` and `start` say that: run it and wait, or start it and carry on. They stay two calls because
the engine has to know which when the turn begins: a started turn is recorded so it survives a
crash or a park, and an awaited one isn't.

### Changes

- **Wait on the agent, not on its turn.** After `start()`, a wait can name the agent or the
  returned turn today, and an agent has at most one started turn, so both are one thing. Keep the
  agent; the turn keeps only `id` and `cancel()`.

  ```ts
  // today
  const fix = await fixer.start({ prompt });
  const first = await wf.race("fix-or-close", { fixed: fix, closed: wf.signal("pr.closed") });
  if (first.closed) await fix.cancel("the pull request closed");
  // after
  await fixer.start({ prompt });
  const first = await wf.race("fix-or-close", { fixed: fixer, closed: wf.signal("pr.closed") });
  if (first.closed) await fixer.turn?.cancel("the pull request closed");
  ```

- **Deprecate `id` on a single agent call.** This is the optional id on one `run`, `start`,
  `compact` or `set`, not the run's id: `awf run --id` and `--continue` don't change. It is meant
  to keep a call from running twice, but it is forgotten when the run restarts, which is when that
  matters; a stage does that job. No workflow uses it.

  ```ts
  // today
  await reviewer.run({ id: "review-1", prompt });
  // after
  await reviewer.run({ prompt });
  ```

- **Remove `agents.attach`.** It throws for every key but the caller's; `open` with the same key
  already returns the agent opened before.

  ```ts
  // today
  const reviewer = await wf.agents.attach("reviewer");
  // after
  const reviewer = await wf.agents.open({ key: "reviewer", runtime });
  ```

- **The caller's ref is typed `CallerRef`**, without `set` or `compact`, and with no `tools` on its
  fork. The calling session is the operator's, so all three fail; the type should say so.

  ```ts
  const me = await wf.agents.caller({ key: "me" });
  await me?.set({ effort: "high" });
  // today: compiles, then fails when it runs; after: a type error
  ```

- **A fork takes `runtime` as `open` does**, so an agent's runtime is written one way. It can't
  name a harness or model: a fork continues its parent's session on them.

  ```ts
  // today
  await worker.fork({ key, placement: "headless", metered: true });
  // after
  await worker.fork({ key, runtime: { placement: "headless", metered: true } });
  ```

- **`agent.close()` replaces `wf.agents.stop(key)`.** The caller always holds the ref, and `stop`
  is what `wf.stop` calls ending the whole attempt.

  ```ts
  // today
  await wf.agents.stop("reader");
  // after
  await reader.close();
  ```

- **Panes** (**structural**). `layout` and `keepPane` mix the workflow's choices (which agents share
  a tab, which one the operator should see) with the operator's (which terminal workspace, whether
  panes stay after the run). The workflow keeps the first; the operator gets flags for the second,
  recorded in `run.json` so a run that wakes later keeps them. `--keep-panes on-failure` is designed
  with [[stopped-run-recovery]]'s debug mode.

  ```ts
  // today
  await wf.agents.open({ key, runtime, layout: { workspace: "origin", tab: "review" }, keepPane: "on-failure" });
  // after, run with: awf run review.ts --workspace origin --keep-panes on-failure
  await wf.agents.open({ key, runtime, pane: { tab: "review", front: true } });
  ```

## 3. Talking to participants (structural)

Whether a participant's messages go to agents or to the workflow's code is set today by `to` on
`connect`, inside `run`, so a reader of the definition can't tell what wakes a run. After, it is
declared in `events`:

```ts
// today
events: { "dd.changes": Changes },
const thread = await wf.participants.connect({ key: "thread", to: "code" });
if (thread.is(e)) …
// after
events: { "dd.changes": Changes, "thread:reply": ParticipantReply },
const thread = await wf.participants.connect({ key: "thread" });
if (e.name === "thread:reply") …
```

- An answer still goes to the agent that asked, and a message to an agent over a route
  `messages.allow` granted; only a message to the code needs `{key}:reply` declared.
- `connect` returns one `ParticipantRef`, with `post` and `release`. `to: "code"`, the three
  `CodeParticipant*` types and `participants.get`, which nothing uses, go.
- `AgentEnded` and `ParticipantReply` are exported as schemas, not only types, so they can be
  declared as above.
- `is(e)` stays only on a timer, where every timer's event is `timer:due`, and on an agent, where it
  also types the turn's `meta`. Elsewhere `e.name` narrows.
- **No `*:reply` wildcard.** Story 034 planned `"*:reply"` to mean "every participant's messages go
  to the code". A workflow that declared it and also connected a coordinator for its agents to
  report to would silently get that coordinator's messages in its code instead of in its agents.
  Nothing uses the wildcard yet, since it isn't built; without it a workflow names each
  participant it routes to the code, as above.
- A route's bound works on any route, not only one to a participant:

  ```ts
  // today: refused between two agents
  await wf.messages.allow({ from: "author", to: "reviewer", purpose, timeoutMs: 30 * 60_000 });
  // after
  await wf.messages.allow({ from: "author", to: "reviewer", purpose, timeout: "30m" });
  ```

## 4. Time

Time is written five ways today: `timeoutMs` numbers, `{ unixMilliseconds }` deadlines, timer
strings in `d`, `h` and `m`, CLI `--timeout` in `ms`, `s`, `m` and `h`, and `--wait` in bare seconds.
After, one grammar everywhere, a decimal and `s`, `m`, `h` or `d`, and one bound on a call,
`timeout?: Duration | Date`, which can't reach past the stage, `parallel` or run around it.

```ts
// today
await reviewer.run({ prompt, timeoutMs: 10 * 60_000, nudge: { deadline } });
await wf.parallel(items, review, { deadline: { unixMilliseconds: Date.now() + 20 * 60_000 } });
keepAlive: { timeoutMs: 90_000 }
wf.deadline?.unixMilliseconds
const remind = event.data.every as Duration;
// after
await reviewer.run({ prompt, timeout: "10m" });
await wf.parallel(items, review, { timeout: "20m" });
keepAlive: { window: "90s" }
wf.deadline                       // a Date
const remind = duration(event.data.every);   // validated
```

```sh
# today
awf run review.ts --timeout 2h          # 1d refused
awf logs review/pr-42 --wait 90
# after
awf run review.ts --timeout 1d
awf logs review/pr-42 --wait 90s        # a bare number still means seconds until 0.1.0
```

- `timeout` replaces `timeoutMs` and `deadline` on `open`, `fork`, `forkCaller`, `run`, `start`,
  `compact`, `set`, `parallel`, `decide` and tools, where `false` still means no limit.
  `nudge.deadline` goes: it can only shorten the turn, which `timeout` already does.
- `keepAlive`'s field is `window`: it is how long an agent stays warm after each turn, not a bound
  on a call.
- Tests follow: `timeoutMs`, `stallMs` and `SendOptions.timeoutMs` become `timeout`, `stall` and
  `SendOptions.timeout`.
- Records still store milliseconds. The CLI change is **structural**.

## 5. Testing

```ts
// today: two signatures
await testWorkflow(review, null, { agents });                       // without events
await testWorkflow(review, { id: "pr-42", event, agents });         // with events
await testWorkflow(review, args, { agents, recorded: { plan } });   // continuing attempt 1
// after: one
await testWorkflow(review, { agents });
await testWorkflow(review, { id: "pr-42", event, agents });
await testWorkflow(review, { args, agents, earlier: { stages: { plan } } });
```

- `args` is an option, required by type when the workflow takes args; `id` defaults to `"test"`.
  Unknown option keys are refused, so a misspelled option fails instead of being ignored.
- `recorded` and `mailbox` both mean "what attempt 1 left", so they become one option, `earlier`.
- `maxTurns`, which fails a test that starts too many turns, applies to every workflow, not only
  ones with events.
- `awaitReply` and `reply.waiting` leave the published surface; they test the engine, not a
  workflow.
- **`reply.*` becomes `noAnswer.*`**: these end a turn without an answer, while `reply` everywhere
  else answers.

  ```ts
  // today
  agents: { tests: reply.failed("codex exited") }
  messages: { closer: async (m) => { …; return m.silent(); } }
  // after
  agents: { tests: noAnswer.failed("codex exited") }
  messages: { closer: async (m) => { …; } }      // returning nothing already ends it silently
  // and m.fail(reason) is return noAnswer.failed(reason); a throw still fails the test
  ```

- **How the attempt ended is one field**, the `Ending` the workflow's `present` and `report` get:

  ```ts
  // today
  expect(run.stopped).toEqual({ reason, stage: "plan" });
  // after
  expect(run.ending).toMatchObject({ kind: "stopped", reason, stage: "plan" });
  ```

- **An event's id is `eventId`**, as `awf emit --event-id` calls it, apart from the run's `id` beside
  it:

  ```ts
  // today
  { id: "kombo", event: { name: "dd.changes", data, id: "83d34d7" } }
  // after
  { id: "kombo", event: { name: "dd.changes", data, eventId: "83d34d7" } }
  ```

- After §3, a participant's message to the code is scripted under its declared name:
  `{ during, name: "participant:reply", from: "thread", data }` becomes
  `{ during, name: "thread:reply", data }`.
- Testing's own `TurnRecord` and `TurnOutcome` become `TestTurn` and `TestTurnOutcome`, since
  contract exports different types under those names; a test's turn records the engine's outcome
  (`unanswered`), not the script's word (`silent`).
- The error for an unscripted participant names the option, `participants`, not `coordinators`.

## 6. Removals and exports

Remove now, because they are unbuilt or unused:

| Today | After |
| --- | --- |
| `wf.steps.run(…)`, `wf.steps.sleep(…)` | `wf.stage(…)`, `wf.sleep(…)` |
| `wf.call(…)` | nothing; unbuilt, it throws today |
| `wf.receive({ take: "oldest" })` | `wf.select(…)` |
| `wf.timers()` | `wf.timer(name)` for each timer |
| `WorkflowDefinition` | `Workflow` |
| `wf.agents.attach(key)` (§2), `wf.participants.get(key)` (§3) | `wf.agents.open(…)`; nothing |

Deprecate for one beta, then remove:

| Today | After |
| --- | --- |
| `agents.open({ …, labels: { role } })` | drop it; nothing reads agent labels |
| `meta: { …, whenToUse }` | drop it; nothing reads it |
| `wf.stage("batch", () => wf.receive())` | `wf.race(…)` |
| `isAnswered(outcome)` | `outcome.answered` |
| `defineExecutableWorkflow({ definition: { meta, run }, prepare })` | `defineWorkflow({ meta, run, prepare })` |

- **One `WaitOptions`** for `race`, `select` and `receive`: today three option types, and only
  `select` takes a function for its label. After, all three take `label?: string | (() => string)`.
- **`agentswf/workflow` exports an explicit list** of the names an author uses. Today it re-exports
  all of contract, engine internals included (`eventWorkflowProblem`, `placementOf`), and anything
  exported is API to keep. The examples import `agentswf/workflow` instead of
  `@agentswf/contract/workflow`, so the site shows what an author writes.
- **`output.json` gains `ref`**, as every other run document has: today
  `{ "runId": "pr-42", "workflow": { "name": "review" } }`, after also `"ref": "review/pr-42"`.

## 7. The CLI and `wfa`

- **A reply to the code moves from `awf send` to `awf emit`** (with §3). With `--event-id`, `awf
  send` is a second command today: it prints emit's result, two JSON shapes, and exit codes its
  usage contradicts.

  ```sh
  # today
  awf send approval/doc-42 --as approvals --event-id 1730450000.12 --author dana 'approved'
  # after
  awf emit approval/doc-42 approvals:reply '{"text":"approved","author":"dana"}' --event-id 1730450000.12
  ```

- **One word per state** (**structural**: wire version 6, JSON `v` 2). Today `wfa` and `awf` use
  different words for the same state, so a script written against one misreads the other:

  | State | Today | After |
  | --- | --- | --- |
  | sent to an agent that has stopped | `peer-stopped` (`wfa`), `stopped` (`awf send`) | `peer-stopped` |
  | an agent waiting for a reply | `awaiting` (`wfa peers`), `awaiting-reply` (records) | `awaiting-reply` |
  | refused: the sender is itself waiting | `awaiting` | `already-awaiting` |
  | a participant in `wfa peers` | `state: "outside"` | `kind: "participant"` |
  | an agent's state in `awf runs --json` | free text, e.g. `"was working"` | a fixed set of values |

## 8. Order

A deprecated name lives one beta after the one that deprecates it, logs once per attempt with its
replacement, and none survives into 0.1.0.

| Beta | What |
| --- | --- |
| A | §6; the turn keeps only `id` and `cancel()` (§2); testing's `noAnswer`, `run.ending`, `eventId` and the participants error (§5) |
| B | §1; `CallerRef`, fork's `runtime` and `agent.close` (§2); §4 in the API; one `testWorkflow` signature |
| C | §3, built with story 034's remaining work on the definition; `awf emit` by run ref (§7) |
| D | §4 on the CLI; §7's state names |
| E | panes (§2), with stopped-run-recovery |
| F | remove what A–E deprecated |

## Decisions for review

1. No `*:reply` wildcard (§3).
2. Panes (§2): grouping and `front` stay the workflow's; workspace and keeping panes move to the
   operator, recorded in `run.json`.
3. `--from-stage` for every run (§1).
4. Agent keys with a colon (`reviewer:${lens}`). Event names with a colon are awf's own
   (`{key}:ended`, `{key}:reply`), and such a key makes them ambiguous. Decided 2026-11-02: no
   colon in an agent's or participant's key; deprecated for a beta, then refused.
5. Whether the operator can refuse `metered: true`, an author's consent to per-token billing, in a
   workflow installed from npm.

The story's other candidates stay as they are.

