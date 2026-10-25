# One workflow, six styles

Draft. The same long-running process written as a state row with a poller, in Temporal, Inngest
and Restate, in awf as it is today, and in awf with suspension and a scheduled tick (a proposal,
not built). The point is to see which abstractions each style makes easy, which it makes
impossible, and where awf's proposal sits among them.

The SDK calls were checked against current docs (Context7, 2026-10-06): Temporal's TypeScript
SDK, inngest-js and Restate's TypeScript SDK. The awf proposal is a sketch; its names are not
settled. [Effect](#effect-the-process-as-a-typed-value) is a lens on all six rather than a
seventh, and comes after the comparison.

**Direction so far** (discussion, 2026-10-07; nothing built):

- Inngest's model, not Temporal's or Restate's: rerun from the top, match by name, and let fixed
  code apply to runs in flight, which is what `--continue` already does.
- No server. A run suspends; `awf signal` and a scheduled `awf tick` resume it.
- From Restate, a value sent before the run waits for it is kept. `awf resolve`/`signal` accepts a
  name the run has not reached yet.
- Every wake-up is a message in a process's inbox: addressed signals, routed events, timers,
  schedules. One wait primitive, `receive`. See [Loops, the inbox and the core](#loops-the-inbox-and-the-core).
- 2026-10-24: one style for every workflow. Code handles most events, and an agent gets a turn
  only when judgement is needed. The leading candidate is "an event starts a function", with turns
  that aren't awaited. See [Event-driven automations](#event-driven-automations-four-styles-and-two-graph-frameworks).

## The process

Feature delivery with sign-off, for one ticket:

1. **Plan.** An agent drafts a ticket doc.
2. **Approval.** A person approves the doc. Remind them every 2 days; give up after the third
   reminder.
3. **Implement.** An agent implements the approved doc. This turn can take hours.
4. **Release checklist.** `review`, `ci` and `docs` must all be checked, in any order, within 14
   days. Each arrives from outside: a person, a CI webhook, an agent.
5. **Release.** One side effect.
6. **Follow-up.** 14 days after release, an agent checks for regressions.

Beside it, a **weekly digest**: every Monday at 09:00, summarize the open tickets.

Every style also has to answer: *where is ticket {ticket} right now?*

Agent work is the same helper everywhere: `agentTurn({ role, prompt })` returns a typed answer.
Outside awf it would shell out to `awf run` or call the engine; in awf it is `agent.run`.

---

## 0. A state row and a poller

The baseline, without a workflow engine. One row per ticket, and a cron job that advances every
row that is due.

```ts
type Case = {
  ticket: string;
  stage: "planning" | "awaiting-approval" | "implementing" | "checklist" | "follow-up" | "done" | "abandoned";
  dueAt?: Date;
  reminders: number;
  approvedAt?: Date;
  checked: Set<"review" | "ci" | "docs">;
  docPath?: string;
};

// cron, every 5 minutes, on each due row it has leased; webhooks write `approvedAt` or add to
// `checked`, then lease the row and call advance too
async function advance(c: Case, now: Date): Promise<void> {
  switch (c.stage) {
    case "planning": {
      c.docPath = (await agentTurn({ role: "planner", prompt: `Draft ${c.ticket}` })).path;
      return save({ ...c, stage: "awaiting-approval", dueAt: days(now, 2) });
    }
    case "awaiting-approval": {
      if (c.approvedAt) return save({ ...c, stage: "implementing" });
      if (now < c.dueAt!) return;
      if (c.reminders === 3) return save({ ...c, stage: "abandoned" });
      await notify(`Reminder: approve ${c.docPath}`);
      return save({ ...c, reminders: c.reminders + 1, dueAt: days(now, 2) });
    }
    // implementing, checklist, follow-up: the same shape
  }
}
```

- **Easy:** "where is it" is a column. Cron is the runtime. Any code change applies to every
  case at once.
- **Hard:** the process is scattered across `case` arms. Every wait is a `dueAt` plus a column.
  A turn outlives the tick, so each row needs a lease or the next tick starts it again, and a
  crash between `agentTurn` and `save` repeats it anyway. A loop in the process (review until
  approved) becomes a counter column.

The styles below keep this runtime shape (something wakes, checks what is due, moves on) and
let the process be written top to bottom.

---

## 1. Temporal: deterministic replay

The workflow is a function the worker **replays from its event history** after every wake-up.
All I/O is an activity; the workflow code itself must be deterministic, and a sandbox enforces
it. Signals are buffered, queries read live state, and `condition(fn, timeout)` is the checklist
gate.

```ts
// workflows.ts
import { condition, defineQuery, defineSignal, proxyActivities, setHandler, sleep } from "@temporalio/workflow";
import type * as activities from "./activities";

const { agentTurn } = proxyActivities<typeof activities>({ startToCloseTimeout: "3 hours", heartbeatTimeout: "2 minutes" });
const { notify, release } = proxyActivities<typeof activities>({ startToCloseTimeout: "1 minute" });

export const docApproved = defineSignal<[Approval]>("docApproved");
export const checked = defineSignal<[Item]>("checked");
export const stageQuery = defineQuery<Stage>("stage");

export async function featureDelivery(ticket: string): Promise<Result> {
  let stage: Stage = "planning";
  let approval: Approval | undefined;
  const done = new Set<Item>();
  setHandler(docApproved, (a) => { approval = a; });
  setHandler(checked, (item) => { done.add(item); });
  setHandler(stageQuery, () => stage);

  const doc = await agentTurn({ role: "planner", prompt: `Draft a ticket doc for ${ticket}` });

  stage = "awaiting-approval";
  for (let reminders = 0; !(await condition(() => approval !== undefined, "2 days")); reminders++) {
    if (reminders === 3) return { kind: "abandoned", reason: "doc not approved" };
    await notify(`Reminder: approve ${doc.path}`);
  }

  stage = "implementing";
  await agentTurn({ role: "implementer", prompt: `Implement ${doc.path}` });

  stage = "checklist";
  if (!(await condition(() => ITEMS.every((i) => done.has(i)), "14 days"))) {
    return { kind: "abandoned", reason: `unchecked: ${ITEMS.filter((i) => !done.has(i))}` };
  }
  await release(ticket);

  stage = "follow-up";
  await sleep("14 days");
  await agentTurn({ role: "reviewer", prompt: `Check for regressions since ${ticket} shipped` });
  return { kind: "done" };
}
```

From outside:

```ts
await client.workflow.start(featureDelivery, { workflowId: `feature-${ticket}`, taskQueue: "agents", args: [ticket] });
await client.workflow.getHandle(`feature-${ticket}`).signal(checked, "ci");
await client.workflow.getHandle(`feature-${ticket}`).query(stageQuery);

await client.schedule.create({
  scheduleId: "weekly-digest",
  spec: { cronExpressions: ["0 9 * * MON"] },
  action: { type: "startWorkflow", workflowType: weeklyDigest, taskQueue: "agents" },
});
```

- **Wake-up:** the server holds timers and signals; a worker replays the history and continues.
- **On resume, what reruns:** the whole function, with every activity result taken from history.
- **A signal sent early** is buffered, so an approval during `notify` is not lost.
- **Code change in flight:** replay must produce the same commands as the history, or it fails
  with a non-determinism error. Changes go behind `patched()` or a new worker version.
- **Hours-long agent turn:** an activity with a heartbeat, or async completion with a task token.
- **Cost:** a cluster (or Temporal Cloud) and workers; the determinism discipline.

---

## 2. Inngest: steps memoized by id

The function is **re-invoked from the top** for every step. Each `step.*` has an id; a step that
already ran returns its memoized result, and the first step that has not run executes and ends
the invocation. Plain code between steps reruns every time. Triggers, including cron, are part
of the function.

```ts
export const featureDelivery = inngest.createFunction(
  { id: "feature-delivery", triggers: [{ event: "feature/requested" }] },
  async ({ event, step }) => {
    const { ticket } = event.data;
    const doc = await step.run("plan", () => agentTurn({ role: "planner", prompt: `Draft a ticket doc for ${ticket}` }));

    for (let round = 1; ; round++) {
      const approved = await step.waitForEvent(`approval-${round}`, {
        event: "feature/doc-approved", match: "data.ticket", timeout: "2d",
      });
      if (approved) break;
      if (round === 4) return { kind: "abandoned", reason: "doc not approved" };
      await step.run(`remind-${round}`, () => notify(`Reminder: approve ${doc.path}`));
    }

    await step.run("implement", () => agentTurn({ role: "implementer", prompt: `Implement ${doc.path}` }));

    const checks = await Promise.all(ITEMS.map((item) =>
      step.waitForEvent(`check-${item}`, {
        event: "feature/checked",
        if: `event.data.ticket == async.data.ticket && async.data.item == "${item}"`,
        timeout: "14d",
      })));
    if (checks.some((c) => c === null)) return { kind: "abandoned", reason: "checklist expired" };

    await step.run("release", () => release(ticket));
    await step.sleep("follow-up-wait", "14d");
    await step.run("follow-up", () => agentTurn({ role: "reviewer", prompt: `Check for regressions since ${ticket} shipped` }));
    return { kind: "done" };
  },
);

export const weeklyDigest = inngest.createFunction(
  { id: "weekly-digest", triggers: [{ cron: "0 9 * * MON" }] },
  async ({ step }) => { /* … */ },
);
```

From outside: `inngest.send({ name: "feature/checked", data: { ticket, item: "ci" } })`.

- **Wake-up:** Inngest's server holds timers and event waits, then calls the serve endpoint.
- **On resume, what reruns:** the function from the top; memoized steps are skipped by id.
- **An event sent early** is not matched: a wait only sees events that arrive after it starts.
  An approval sent while `remind-1` runs is missed; the code above needs a lookback or a state
  store to be correct.
- **Code change in flight:** the new code runs. Steps are matched by id, so renaming one reruns
  it, and adding one before the current position runs it.
- **Where is it:** no query into a running function; the dashboard's timeline, or your own writes.
- **Hours-long agent turn:** a step runs inside one request to the serve endpoint, so it needs a
  long-running host rather than a serverless one.
- **Cost:** Inngest Cloud, or the self-hosted server; an endpoint it can reach.

---

## 3. Restate: a journal and durable promises

A `restate-server` keeps a journal per invocation. Side effects go through `ctx.run`; awaiting a
timer or a promise **suspends** the handler, and the server re-invokes it and replays the
journal. A workflow has one `run` handler per key and shared handlers callable while it runs.
`ctx.promise(name)` is a named durable promise: a value resolved before anyone awaits it is
kept.

```ts
export const featureDelivery = restate.workflow({
  name: "feature-delivery",
  handlers: {
    run: async (ctx: restate.WorkflowContext) => {
      const ticket = ctx.key;
      ctx.set("stage", "planning");
      const doc = await agentTurn<Doc>(ctx, "plan", { role: "planner", prompt: `Draft a ticket doc for ${ticket}` });

      ctx.set("stage", "awaiting-approval");
      const approved = ctx.promise<Approval>("doc-approved").get();
      for (let reminders = 0; ; reminders++) {
        const next = await RestatePromise.race([
          approved.map(() => "approved"),
          ctx.sleep({ days: 2 }).map(() => "remind"),
        ]);
        if (next === "approved") break;
        if (reminders === 3) return { kind: "abandoned", reason: "doc not approved" };
        await ctx.run(`remind-${reminders + 1}`, () => notify(`Reminder: approve ${doc.path}`));
      }

      ctx.set("stage", "implementing");
      await agentTurn(ctx, "implement", { role: "implementer", prompt: `Implement ${doc.path}` });

      ctx.set("stage", "checklist");
      const all = RestatePromise.all(ITEMS.map((i) => ctx.promise<Check>(i).get())).map(() => "done");
      const expired = ctx.sleep({ days: 14 }).map(() => "expired");
      if ((await RestatePromise.race([all, expired])) === "expired") return { kind: "abandoned", reason: "checklist expired" };

      await ctx.run("release", () => release(ticket));
      ctx.set("stage", "follow-up");
      await ctx.sleep({ days: 14 });
      await agentTurn(ctx, "follow-up", { role: "reviewer", prompt: `Check for regressions since ${ticket} shipped` });
      return { kind: "done" };
    },
    approve: (ctx: restate.WorkflowSharedContext, a: Approval) => ctx.promise<Approval>("doc-approved").resolve(a),
    check: (ctx: restate.WorkflowSharedContext, c: Check) => ctx.promise<Check>(c.item).resolve(c),
    stage: (ctx: restate.WorkflowSharedContext) => ctx.get<Stage>("stage"),
  },
});

// an hours-long turn suspends instead of holding a request: the agent's result resolves the awakeable
async function agentTurn<T = void>(ctx: restate.WorkflowContext, name: string, turn: Turn) {
  const { id, promise } = ctx.awakeable<T>();
  await ctx.run(`dispatch:${name}`, () => dispatchTurn({ ...turn, resultToken: id }));
  return promise;
}
```

Cron has no built-in trigger; a Virtual Object reschedules itself:

```ts
const digest = restate.object({
  name: "weekly-digest",
  handlers: {
    tick: async (ctx: restate.ObjectContext) => {
      await ctx.run("digest", () => summarizeOpenTickets());
      ctx.objectSendClient(digest, ctx.key).tick(restate.rpc.sendOpts({ delay: untilNextMonday9(await ctx.date.now()) }));
    },
  },
});
```

- **Wake-up:** the server holds timers and promises, and re-invokes the handler.
- **On resume, what reruns:** the handler, with every `ctx.run`, timer and promise from the journal.
- **A value sent early** is kept by the durable promise.
- **Code change in flight:** an invocation stays on the deployment it started on. A fix applies
  to new invocations, not to this one.
- **Where is it:** the `stage` shared handler, or the server's UI and SQL over invocations.
- **Cost:** one `restate-server` binary, always on; handlers served over HTTP.

---

## 4. awf today: stages and `--continue`

A stage is a named step whose result the run keeps. `awf run {file} --continue {id}` starts a
new attempt that reruns `run` from the top, returns recorded stage results, and runs the rest. An
attempt has no deadline unless `--timeout` sets one. There is no sleep, no outside input and no
schedule (an agent can ask a coordinator and wait hours for the answer, but only while the attempt
keeps running): `steps` and `signals` are typed and throw `unavailable`.
%% there is also a request to continue with agent session, i don't know how it fits into that, btw, all those design decisions can be reversed if a better one is shown %%

```ts
run: async (workflow, { ticket }) => {
  const planner = await workflow.agents.open({ key: "planner", runtime: RUNTIMES.planner });
  const doc = await workflow.stage("plan", { result: DOC }, async () => {
    const { outcome } = await planner.run({ prompt: `Draft a ticket doc for ${ticket}`, schema: DOC });
    return isAnswered(outcome) ? outcome.value : workflow.stop(outcome.reason);
  });

  // workflow code can't wait for a person: stop, and have the operator continue later
  await workflow.stage("approval", { result: APPROVAL }, async () =>
    (await readApproval(doc.path)) ?? workflow.stop(`awaiting approval of ${doc.path}`));

  const implementer = await workflow.agents.open({ key: "implementer", runtime: RUNTIMES.implementer });
  await workflow.stage("implement", { result: WORK }, async () => {
    const { outcome } = await implementer.run({ prompt: `Implement ${doc.path}`, schema: WORK });
    return isAnswered(outcome) ? outcome.value : workflow.stop(outcome.reason);
  });
  // checklist: the same stop-until-present trick; reminders, the 14-day follow-up and the
  // weekly digest have no expression at all
}
```

- **Wake-up:** a person types `awf run {file} --continue {id}`.
- **On resume, what reruns:** `run` from the top; stages are matched by name and return their
  record; agents are opened afresh.
- **Code change in flight:** the new code runs, which is the point of `--continue`; the
  `meta.version` check guards against an incompatible record.
- **Where is it:** the run record lists stages and the one that stopped.

---

## 5. awf proposed: suspension and a scheduled tick

The runtime shape of style 0, the authoring shape of Inngest, the promise semantics of Restate.
Nothing stays running:

- An attempt that reaches a wait that is not ready ends as **`suspended`**, recording what it
  waits for: a timer's due time, a promise name, or a race of them.
- `awf resolve {id} {name} {json}` records a promise's value, and may start the next attempt at
  once.
- `awf tick`, from cron or launchd, continues every suspended run that is now due, and starts a
  run of every workflow whose `schedule` is due.
- A resume is a `--continue`: stages, timers and promises return what was recorded.

```ts
export default defineExecutableWorkflow({
  definition: {
    meta: { name: "feature-delivery", version: "2.0.0" },
    run: async (workflow, { ticket }) => {
      const planner = await workflow.agents.open({ key: "planner", runtime: RUNTIMES.planner });
      const doc = await workflow.stage("plan", { result: DOC }, () => ask(planner, DOC, `Draft a ticket doc for ${ticket}`));

      const approved = workflow.promise("doc-approved", { schema: APPROVAL });
      for (let round = 1; ; round++) {
        const next = await workflow.race({ approved, remind: workflow.timer(`approval-${round}`, "2d") });
        if (next.kind === "approved") break;
        if (round === 4) return { kind: "abandoned", reason: "doc not approved" };
        await workflow.stage(`remind-${round}`, () => notify(`Reminder: approve ${doc.path}`));
      }

      const implementer = await workflow.agents.open({ key: "implementer", runtime: RUNTIMES.implementer });
      await workflow.stage("implement", { result: WORK }, () => ask(implementer, WORK, `Implement ${doc.path}`));

      const checklist = workflow.all(ITEMS.map((item) => workflow.promise(`check:${item}`, { schema: CHECK })));
      const next = await workflow.race({ checklist, expired: workflow.timer("checklist-expires", "14d") });
      if (next.kind === "expired") return { kind: "abandoned", reason: "checklist expired" };

      await workflow.stage("release", () => release(ticket));
      await workflow.timer("follow-up-due", "14d");
      const reviewer = await workflow.agents.open({ key: "reviewer", runtime: RUNTIMES.reviewer });
      await workflow.stage("follow-up", { result: REPORT }, () => ask(reviewer, REPORT, `Check for regressions since ${ticket} shipped`));
      return { kind: "done" };
    },
  },
  prepare: ({ argv }) => parseArgs(argv),
  id: ({ ticket }) => ticket,
});
```

```sh
awf run feature-delivery.ts -- AWF-42                        # plans, then suspends on doc-approved
awf resolve AWF-42 doc-approved '{"by":"roman"}'             # records it; resumes
awf resolve AWF-42 check:ci '{"ok":true}'                    # from a CI webhook
awf tick                                                     # every 5 minutes from launchd
```

The weekly digest is a separate workflow with `schedule: "0 9 * * MON"`; each occurrence is a new
run, so no run's record grows forever.

- **Wake-up:** `awf tick` or `awf resolve`. Latency is the tick interval, which suits waits
  measured in days.
- **On resume, what reruns:** `run` from the top; stages, timers and promises are matched by name.
- **A value sent early** is recorded in the run directory and kept.
- **Code change in flight:** the new code runs, as with `--continue` and Inngest.
- **Where is it:** the run, whose id is the ticket, names the stage and what it is suspended on.
- **Cost:** a cron entry; no server.

### What the proposal has to settle

1. **Effects outside a stage rerun on every resume.** An agent turn outside a stage would be
   asked again at every wake-up. The engine can refuse to suspend an attempt that ran a turn
   outside a stage, which makes the effect boundary a check rather than a convention (E6).
2. **Names are the identity.** A timer named in a loop (`approval-${round}`) records its due time
   once. Renaming a stage, timer or promise while runs are suspended is the versioning question;
   the `meta.version` check needs a rule for it.
3. **Two clocks.** The attempt keeps its deadline; a timer is calendar time across attempts, and
   suspended time counts against neither. Does "every wait has a deadline" mean a promise must
   always be raced with a timer?
4. **A promise nobody awaits yet.** Decided: `awf resolve` accepts a name the run has not
   reached, and keeps the value, as Restate does; otherwise an approval given while the agent is
   still drafting is lost. The cost is a typo silently parking a value nobody awaits, so the
   run's status lists resolved-but-unclaimed promises, and a run that ends with one says so. A
   workflow may declare its promise names and schemas, which lets `awf resolve` check both at
   once; without a declaration, a value is validated when awaited, and a bad one comes back as
   an outcome, not an exception.
5. **Who is at the keyboard.** A tick at 03:00 may resume a run whose agents open panes.
   Unattended attempts may need headless placement, or an opt-in.
6. **The working tree moves.** Weeks later the repository is elsewhere. Recorded results stay
   true; the next stage may need the commit or worktree the run started from.
7. **One resume at a time.** A tick and `awf resolve` racing on one run need a lock in the run
   directory.

---

## Side by side

| | State row | Temporal | Inngest | Restate | awf today | awf proposed |
| --- | --- | --- | --- | --- | --- | --- |
| Always running | cron | cluster plus workers | Inngest server | `restate-server` | nothing | cron |
| Process written as | `switch` on a stage | one function | one function | one handler | one function | one function |
| Resume replays | — | the history, strictly | from the top, steps by id | the journal | from the top, stages by name | from the top, stages, timers and promises by name |
| Determinism rules | none | enforced by a sandbox | code between steps reruns | effects through `ctx.run` | code between stages reruns | code between stages reruns; turns outside stages refused |
| Durable sleep | `dueAt` column | `sleep` | `step.sleep` | `ctx.sleep` | — | `workflow.timer` |
| Outside input | a column | signal, update | `step.waitForEvent` | `ctx.promise`, awakeable | — | `workflow.promise` and `awf resolve` |
| Input that arrives early | kept | buffered | missed | kept | — | kept |
| Checklist | a set column | `condition(fn, timeout)` | `Promise.all` of waits | `RestatePromise.all` | — | `workflow.all` |
| Cron | is the runtime | Schedules | `cron` trigger | self-scheduling object | — | `schedule` and `awf tick` |
| Where is it | a column | query | dashboard | shared handler, UI | run record | run record |
| Code fixed in flight | applies | needs `patched()` | applies | pinned to old code | applies | applies |
| Time in tests | fake clock | time-skipping environment | mocked steps | testcontainers | not built | would need virtual time |

## Against Temporal and Inngest

**Inngest is the closest relative.** Same authoring model: rerun from the top, skip what is
recorded, match by name, let new code run against old runs. The proposal differs in three
places: a tick replaces Inngest's event-driven server, so wake-ups lag by the tick interval; a
promise keeps a value resolved before the run reached it, where `waitForEvent` misses it; and
agent turns outside stages are refused rather than silently repeated.

**Temporal is the stricter relative.** Strict replay buys exactness (a history that no longer
matches the code fails loudly) at the cost of a sandbox, `patched()` and a cluster. The proposal
takes the opposite trade, as Inngest does: the code may change, and names carry identity. What it
keeps from Temporal is the Update rule for checkpoints and the principle that all
non-determinism goes through a recorded step.

**Restate is the source of the promise semantics** and the counterexample on versioning: it
pins a run to its code, where awf's `--continue` exists to run fixed code.

---

## Effect: the process as a typed value

Effect is a TypeScript effect system: a program is a value, `Effect<A, E, R>`, that succeeds with
`A`, fails with a typed `E`, and needs the services `R`, which a `Layer` provides. Generators make
it read top to bottom. `effect/workflow` adds durability on the same model as Temporal: a
`Workflow` with payload, success and error schemas; an `Activity` whose completed result is
recorded by name; `DurableClock.sleep` and `DurableDeferred` for waits; a `WorkflowEngine` layer
for the store. awf already cites it for scopes, interruption and retry schedules
([[reading]]); Smithers is built on it ([[landscape]]).

Checked against effect 4.0.6 (`effect/workflow`, source and types, type-checked, 2026-10-24):
`Workflow.make`, `Activity.make`, `DurableClock.sleep`, `DurableDeferred.make`, `await`,
`raceAll`, `token` and `succeed`, `Effect.retry` with `Schedule`. v4 is stable since 4.0.0; its
workflow modules are still marked unstable.

```ts
import { Duration, Effect, Schema } from "effect";
import { Activity, DurableClock, DurableDeferred, Workflow } from "effect/workflow";

const FeatureDelivery = Workflow.make("FeatureDelivery", {
  payload: { ticket: Schema.String },
  success: Done,
  error: Abandoned,                       // a tagged error: { _tag: "Abandoned", reason }
  idempotencyKey: ({ ticket }) => ticket,
});

const DocApproved = DurableDeferred.make("doc-approved", { success: Approval });
const Checked = (item: Item) => DurableDeferred.make(`checked-${item}`, { success: Check });

// an agent turn is an activity: once it completes, its result is recorded and never asked again
const agentTurn = (name: string, turn: Turn) =>
  Activity.make({ name, success: TurnResult, execute: dispatchTurn(turn) });

// the race's winner is recorded, so `success` must encode both outcomes
const waitOrExpire = <A, R>(name: string, success: Schema.Codec<A>, wait: Effect.Effect<A, never, R>, duration: Duration.Input) =>
  DurableDeferred.raceAll({
    name,
    success: Schema.Union([Schema.Literal("expired"), success]),
    error: Schema.Never,
    effects: [wait, DurableClock.sleep({ name: `${name}-clock`, duration }).pipe(Effect.as("expired" as const))],
  });

const FeatureDeliveryLive = FeatureDelivery.toLayer(({ ticket }) =>
  Effect.gen(function* () {
    const doc = yield* agentTurn("plan", { role: "planner", prompt: `Draft a ticket doc for ${ticket}` });

    for (let reminders = 0; ; reminders++) {
      const approval = yield* waitOrExpire(`approval-${reminders}`, Approval, DurableDeferred.await(DocApproved), "2 days");
      if (approval !== "expired") break;
      if (reminders === 3) return yield* Effect.fail(new Abandoned({ reason: "doc not approved" }));
      yield* Activity.make({ name: `remind-${reminders + 1}`, execute: notify(`Reminder: approve ${doc.path}`) });
    }

    yield* agentTurn("implement", { role: "implementer", prompt: `Implement ${doc.path}` });

    const all = Effect.all(ITEMS.map((i) => DurableDeferred.await(Checked(i))), { concurrency: "unbounded" });
    if ((yield* waitOrExpire("checklist", Schema.Array(Check), all, "14 days")) === "expired") {
      return yield* Effect.fail(new Abandoned({ reason: "checklist expired" }));
    }

    yield* Activity.make({ name: "release", execute: release(ticket) });
    yield* DurableClock.sleep({ name: "follow-up", duration: "14 days" });
    yield* agentTurn("follow-up", { role: "reviewer", prompt: `Check for regressions since ${ticket} shipped` });
    return { kind: "done" };
  }),
);
// the body is Effect<Done, Abandoned, WorkflowEngine | WorkflowInstance | Agents | Notifier>: the failure and the needs are in the type
```

From outside, a person's approval is `DurableDeferred.succeed(DocApproved, { token, value })`. The
token is derived from the workflow name, the execution id and the deferred's name, so a sender
who knows the ticket can address it. The weekly digest is not a workflow: `Effect.schedule` with
`Schedule.cron` in a process that stays up.

- **Wake-up:** the `WorkflowEngine` behind the layer, in memory or a durable store; it resumes a
  suspended execution when a clock fires or a deferred is completed.
- **On resume, what reruns:** the body, with completed activities, clocks and deferreds from the
  record. Only completed activities are memoized: an activity that suspends runs its body again on
  replay, so effects before the suspension repeat (the docs' own warning).
- **A value sent early:** kept: the engine stores a deferred's completion whether or not the run
  is waiting, and the first one wins (read in the in-memory engine only).
- **Code change in flight:** replay against the record, as in Temporal; no `patched()`.
- **Where is it:** `poll` returns the result once there is one; which step it is on is not built in.
- **Cost:** a dependency the author surface would be written in, plus an engine store.

### Is it more readable?

Line for line it is close to Temporal and to awf today, with `yield*` for `await`. What it adds is
the type: `Effect<Done, Abandoned, ...>` says how the process can end and what it needs, which
plain `async` code cannot. awf has one place that would read better for it. `workflow.stop`
throws, so `docs/workflow-api.md` asks for `return workflow.stop(reason)` to get narrowing; in
Effect a stop is a value in the error channel.

What it costs:

- **A second language at every line.** `function*`, `yield*` and `pipe` for code that already
  reads top to bottom with `await`. The people who write and read awf workflows are coding agents
  and the operator, not Effect specialists.
- **New failure modes.** A missing `yield*` type-checks and does nothing. Effect's type errors run
  to many lines.
- **A published type tied to someone else's majors.** `contract` is pure and depends on nothing;
  an author surface typed in `Effect` follows Effect's versions, and its workflow modules are marked unstable.
- **Smithers is the evidence.** Built on Effect, it went to a static plan of `Planned` proxies
  that throw when computed on, with "trampoline" rounds for lists found at run time.

So: not as the author surface.

### What awf already has

The ideas came over without the library:

| Effect | awf |
| --- | --- |
| `Exit`, tagged errors | the `outcome.kind` union: a turn that goes wrong is a value |
| `Effect.timeout`, interruption | one deadline per run; `parallel` and `agent.run` only narrow it |
| structured concurrency | `parallel` is fail-fast and cancels its siblings |
| `Layer` and `R` | two composition roots, `operator-runtime.ts` and `workflow-testing` (ADR 0006) |
| `Activity.make({ name, success, execute })` | `workflow.stage(name, { result }, work)` |
| "only completed activities are memoized" | "code between stages runs on every attempt" |

### What to borrow

1. **A schedule as a value.** "Every 2 days, at most 3 times" is
   `Schedule.spaced("2 days").pipe(Schedule.take(3))`, not a loop of `remind-${round}` names.
   If the policy is data, the run directory can record it and `awf tick` can resume it, and one
   named timer replaces a name per round, which shrinks question 2 of
   [What the proposal has to settle](#what-the-proposal-has-to-settle). The same value would
   retry a turn that ended `failed` with `retryable`. Library code over `receive`, per the table
   in [Loops, the inbox and the core](#loops-the-inbox-and-the-core); it starts in `examples/`.
2. **`stop` that narrows.** A `never` return type, or a stop returned as a value, removes the
   `return workflow.stop(...)` convention without taking Effect.
3. **An idempotency key per side effect.** `Activity.idempotencyKey(name, { includeAttempt })`
   derives a key from the execution, the name and, optionally, the attempt. A stage that pushes,
   posts or releases, and is redone after `stopped`, needs the same thing; awf has `runId`, the
   stage name and `attempt`, so this is a written rule and perhaps a helper.
4. **Needs in the type, maybe.** `R` makes a missing service a compile error. awf could get part
   of it by letting a workflow declare the runtimes and decision providers it uses, so
   `workflow-testing` refuses to start without a fake for each. Only if that mistake shows up.

Not borrowed: `Layer` as an author-facing idea, `pipe` composition, a static plan.

---

## Loops, the inbox and the core

A process that loops (a PR shepherd: fix CI, address comments, ping when quiet, merge when green
and approved) breaks the single-run model: the record grows with every round, names need round
numbers, and events repeat where a promise fills once.

**Process and run are split.** A process is a key (`pr-1234`) with an inbox and a state, and lives
until it returns. A run is one bounded round of it, replayable as today. A round ends by
returning (done), suspending on a message, or `workflow.again(state)`: the next round starts with
that state and the same inbox. A straight-line workflow is a process that never calls `again`.
This is Temporal's `continueAsNew` and Restate's Virtual Object, in awf's terms.

**Everything that wakes a process is a message in its inbox**: `awf signal {key} {type}` from a
person, script or agent; `awf emit {type}` routed by the workflow's `on` rules, starting the
process if needed; timers and `schedule` from the clock. The one wait is
`receive(name, { types, match, timeout })`: it takes the oldest unconsumed matching message, or a
timeout, and records which by name, so a replay returns the same one. A promise, a sleep, a
checklist and a reminder loop are all built on it.

**Core is what only the engine can guarantee; the rest is library.**

| Layer | Holds |
| --- | --- |
| contract | `receive`, `again`, the process key; the inbox, state and round record formats |
| engine | the inbox (append, dedup by message id), consumption records, one round per key at a time, clock messages, `awf signal`, `awf tick`, `awf status {key}` |
| workflow-testing | a virtual clock and a scripted inbox |
| library, pure, over the author surface | `promise`, `sleep`, a checklist collector, reminders, retry, approval, `ask`. Starts in `examples/`; extracted on the second copy |
| integrations, contract only, through the CLI | CI and forge pollers, notifiers, approval UIs |
| boilerplate | the launchd or cron entry for `awf tick`, a webhook relay into `awf emit` |

`race` and `all` cannot be library code: two live receives could each consume a message, and the
loser's is lost. So the core `receive` multiplexes and consumes exactly one message. `emit` and
routing come after addressed `signal`, once addressing keys by hand gets tedious.

**To decide before building**, since each fixes the author surface or a record:

1. Whether `receive` consumes for good, with anything lasting kept in state. Leaning yes.
2. What `again` carries: JSON state under a schema, and whether agent sessions survive rounds
   (`agents.attach`, not built).
3. Routing rules as functions (`(e) => key`, so `emit` loads every workflow) or declarative
   (`"data.pr"`, indexable).
4. A message to a key with no process: start it, park it, or refuse.
5. How many finished rounds and consumed messages a process keeps.

The existing stubs are the starting point: `signals.receive({ id, name, deadline }, schema)` and
`steps.sleep` in `packages/contract/src/workflow/workflow.ts`. [`messaging.md`](../design/messaging.md)
already has an engine-owned inbox for agents; whether that and a process inbox are one mechanism
is open.
---

## Event-driven automations: four styles, and two graph frameworks

Draft, 2026-10-24, from the datadog-watcher (`agent/workflows/datadog-watcher`). Nothing is decided
or built.

**Where it stands:**
- One style for every workflow, not a family of `defineWorkflow` flavours.
- The leading candidate is C, an event starts a function, with the changes below.
- awf's recovery model is open too, and can change if a better one fits that style.
- Being woken from nothing by an event isn't a requirement. A run that has to be continued
  before it takes events is acceptable.

### Why the inbox sections aren't enough

The [inbox section](#loops-the-inbox-and-the-core) gives a loop one wait, `receive`. The first
signals draft written on it (since rewritten as [[034-event-driven-runs|story 034]]) still routed every event into
an agent turn, one at a time. An event that arrived during a 15-minute turn waited for it, and the
workflow's code decided nothing.

The point of codifying a process is the opposite. Code handles most events (it records, counts,
dedupes and posts), and an agent gets a turn only when judgement is needed. For the watcher's
Datadog case, that means: accept an occurrence, record it in the case file, and engage the
investigator only past a threshold.

### Eight automations as the test

Every style can express every case. What was compared is how long the code is, how easily a
person reads it, and how hard it is to test, debug and get wrong.

| # | Automation | What it exercises |
| --- | --- | --- |
| 1 | Datadog case | months long; batch occurrences; a turn only past a threshold; "noise" closes it; a quiet week posts without a turn |
| 2 | PR shepherd | CI and comments arrive during a fix; merge when approved and green |
| 3 | Feature delivery | a sequence: plan, approval with reminders, implement, a checklist in any order, release, a follow-up |
| 4 | Review on request | started by a Slack message; follow-ups; ends after 2 quiet hours |
| 5 | Weekly digest | a schedule, no state |
| 6 | Ticket intake | code labels by rule; an agent only for what no rule matches |
| 7 | Flaky test watcher | 3 failures in 24 hours makes a draft; the 4th updates it |
| 8 | Implement and review | no outside events; the control, which must not get worse than a plain function |

### Four styles

| | Mental model | Relative |
| --- | --- | --- |
| **A. A script** | one live function per process; synchronous handlers update state; the code waits on `condition(test, timeout)` | Temporal |
| **B. An object per key** | a handler table per event kind; one handler at a time per key; a turn is queued, and its end comes back as an event | Restate virtual objects, actors |
| **C. An event starts a function** | a trigger on the definition; the function waits for later events from its own inbox, taking all that have arrived | Inngest, with an inbox it doesn't have |
| **D. Restate plus awf** | the real Restate SDK owns events, state and durability; awf only runs agent turns | Restate |

Method: each style was written for all eight cases by its own agent, with one API file and honest
notes on where the style strained. A fifth agent, which didn't see anyone's guess, scored them.
Each style had one author, so the author's skill is part of the numbers. The code is in the
session scratchpad, not the repo.

### Results

| | A | B | C | D |
| --- | ---: | ---: | ---: | ---: |
| Non-blank lines, all 8 cases | 367 | 495 | **350** | 391 |
| PR shepherd alone | 57 | 84 | **37** | 78 |
| Cases readable in one pass | 4 | 3 | **7** | 5 |
| Bugs the style invites | 2 | 3 | 2 | 2 |
| Bugs from the recovery model | 3 | 2 | 2 | 3 |

The bug counts are close. Their kinds aren't:
- **A, B and D share one class: a lost update.** State changes while a turn is outstanding, and a
  write after the turn overwrites it. In the PR shepherd, CI passes during the fix, the code then
  resets it to pending, and an approved PR never merges. A loses a flaky test's 4th failure the
  same way.
- **C doesn't have it.** Nothing changes during an await. Events wait in the inbox until the code
  takes them, in order.
- **C's own gaps are both in the Datadog case.** An occurrence during a turn isn't recorded until
  the turn ends, and "noise" can't cancel a turn that's running. Both come from C awaiting every
  turn.
- **B** spreads a sequence over handlers and a hand-kept `phase`. Feature delivery took 9 handlers,
  and the control case got worse.
- **D** needs four long-running processes. A failing `ctx.run` is retried (Restate's default is 70
  attempts) and then paused. That held a PR's later events behind one merge conflict until someone
  resumed it by hand.

### Recovery, as its own axis

| Model | Suits | Costs the author | A code fix mid-flight |
| --- | --- | --- | --- |
| Strict replay, deterministic code | A (needs it: state lives in closures) | no clock or file reads outside steps, unenforced; `continueAsNew` loses agent sessions | weeks-old runs stop as diverged |
| Rerun from the top, stages and waits by name (awf today) | C | effects inside stages; reads between stages rerun | new code applies; a stage or wait that no longer lines up stops there |
| Commit state per handler | B | JSON state the next version must still read; a turn cut by a reboot is a failure each handler must handle | clean, but a renamed field reads `undefined` |
| External durable runtime | D | four processes, re-register on change, at-least-once effects | pin the old deployment, or risk a journal mismatch |

The evaluation paired C with awf's model, adding named waits and `again(state)`. awf's model isn't
fixed, though: this table is what to weigh if a better one turns up.

### The leading candidate: C with three changes

1. **A turn can be started without awaiting it.** `agent.start()` returns a handle, the turn's end
   arrives in the inbox as `turn.ended`, and `handle.cancel()` stops it. This is B's idea. It closes
   the first of C's gaps in the Datadog case, and lets a close from the tick stop a running turn.
   A "noise" reply still waits for the running turn to end.
2. **Waits are named and labelled.** The name comes from `receive`, so a code fix stops at the wait
   that doesn't line up. The label comes from A's `condition`, so `awf runs` shows what the run is
   waiting for.
3. **`again(state)` for processes that live for months,** with the agent kept across rounds
   ([[agent-keep-alive]]). Otherwise every round starts the agent cold.

From the others, it would also keep event schemas declared per workflow and refused at the sender
(A), event ids deduplicated on emit (C, D), and a turn cut by a reboot arriving as `failed`,
retryable (B). It drops C's `batch`, `debounce` and `concurrency` options: a loop that takes every
queued event already batches, and a quiet week is a wait's timeout.

The Datadog case in it:

```ts
export default defineExecutableWorkflow({
  definition: {
    meta: { name: "datadog-case" },
    on: [{ event: "dd.occurrence", key: (e) => e.data.case }],   // starts a run if none is live
    singleton: true,                                             // either way, the event lands in its inbox
    async run(workflow) {
      const kase = openCase(workflow.key);                      // the case's files in dd-cases
      const thread = await workflow.participants.connect({ key: "thread" });
      const investigator = await workflow.agents.open({ key: "investigator", runtime: "claude", tools: { close_case } });
      let turn: TurnHandle | null = null;
      let replies: Reply[] = [];                                 // not yet given to a turn
      let batch: Batch = { occurrences: [], replies: [] };       // what the running turn was given

      for (let round = 1; ; round++) {
        const events = await workflow.receive(`events-${round}`, {
          types: ["dd.occurrence", "dd.closed", "reply", "turn.ended"],
          timeoutMs: WEEK,
          label: () => `${kase.unseen().length} unseen${turn ? ", investigating" : ""}`,
        });

        if (events.length === 0) {
          await workflow.stage(`quiet-${round}`, () => thread.post(quietNote(kase)));
          continue;
        }
        const closed = events.find((e) => e.name === "dd.closed");     // the tick, or close_case
        if (closed) {
          await turn?.cancel();
          await workflow.stage("close", () => kase.close(closed.data));
          return;
        }
        await workflow.stage(`record-${round}`, () => kase.record(events));   // at once, even mid-turn
        replies.push(...events.filter((e) => e.name === "reply"));

        const ended = events.find((e) => e.name === "turn.ended");
        if (ended) {
          turn = null;
          if (!isAnswered(ended.data.outcome)) {
            await workflow.stage(`failed-${round}`, () => thread.post(failedNote(ended.data.outcome)));
            replies.unshift(...batch.replies);
            continue;                                            // the batch is still unseen: retried with the next change
          }
          await workflow.stage(`seen-${round}`, () => kase.markSeen(batch.occurrences));
        }

        if (!turn && (replies.length > 0 || needsLook(kase))) {
          batch = { occurrences: kase.unseen(), replies };
          turn = await investigator.start({ prompt: update(batch) });
          replies = [];
        }
      }
    },
  },
});
```

- **Closing:** "this is noise" reaches the investigator as a reply, and it closes the case with
  the `close_case` tool ([[workflow-tools]]). The tool's handler emits `dd.closed`, so no regex
  matches the engineer's words.
- **Replies:** a reply during a turn waits in `replies` and starts the next turn.
- **Failures:** a failed turn posts to the thread. Its occurrences stay unseen and its replies go
  back in the queue, so the next change retries them. Occurrences are marked seen only when a turn
  succeeds.
- **New API:** `post` on a participant, so code can write to the thread.
- **Not settled:** a stage name per round means thousands of names in a case that lives for months,
  and where `again` goes in this loop. On a rerun, a turn started outside a stage is either
  started again or arrives as `failed`.

### Reducers: worth considering

A reducer declares, once per event name, how that event folds into the run's state. LangGraph has
them per state channel. With reducers, the loop only decides, and the fold can't be done wrong in
one loop and right in another. A wait folds the events it takes into the state, so a CI result or
a comment that arrives during a fix is folded after the reset, and two comments make one turn. The
PR shepherd:

```ts
const pr = reducer(events, {
  green:    { initial: false,                 on: { "pr.ci": (_, e) => e.data.passed } },
  failure:  { initial: null as string | null, on: { "pr.ci": (_, e) => (e.data.passed ? null : e.data.log) } },
  approved: { initial: false,                 on: { "pr.approved": () => true } },
  merged:   { initial: false,                 on: { "pr.merged": () => true } },
  comments: { initial: [] as Comment[],       on: { "pr.comment": (all, e) => [...all, e.data] } },
});

export default defineExecutableWorkflow({
  definition: {
    meta: { name: "pr-shepherd" },
    state: pr,
    async run(workflow) {
      const fixer = await workflow.agents.open({ key: "fixer", runtime: "claude" });
      for (let round = 1; ; round++) {
        const s = await workflow.wait(`events-${round}`,
          { label: (s) => `${s.green ? "green" : "red"}, ${s.approved ? "approved" : "not approved"}` });
        if (s.merged) return { merged: "by someone else" };
        if (s.failure || s.comments.length > 0) {
          const fix = await workflow.stage(`fix-${round}`, { result: Type.Union([PUSHED, Type.Null()]) }, async () => {
            const { outcome } = await fixer.run({ prompt: fill(FIX, s), schema: PUSHED });
            return isAnswered(outcome) ? outcome.value : null;
          });
          if (fix === null) continue;                  // kept: the next event retries the fix
          workflow.state.reset("comments", "failure");
          if (fix.pushed) workflow.state.set("green", false);
          continue;
        }
        if (s.approved && s.green) {
          await workflow.stage("merge", () => gh(`pr merge ${workflow.key} --squash`));
          return { merged: "by the shepherd" };
        }
      }
    },
  },
});
```

```ts
test("the latest CI result wins", () => {
  expect(pr.fold([
    { name: "pr.ci", data: { passed: false, log: "x" } },
    { name: "pr.approved", data: { by: "a" } },
    { name: "pr.ci", data: { passed: true, log: "" } },
  ])).toMatchObject({ green: true, failure: null, approved: true });
});
```

**What reducers give:**
- the state rules are pure functions, tested without a run or an agent;
- a rerun folds the recorded events again, so the state needs no saving of its own;
- `awf runs` can print the state.

**What they cost:**
- one more concept;
- `reset` and `set` are a second place where state changes, and a rerun has to replay them too;
- they don't help when the state lives in the workflow's own files, as the Datadog case's does.

### Graph frameworks: LangGraph and Mastra

Read on Context7, 2026-10-24.

- **LangGraph:** a `StateGraph` of nodes over state with reducers. `interrupt(value)` pauses a node.
  `invoke(new Command({ resume }), { configurable: { thread_id } })` resumes it, and the node reruns from
  its start. A checkpointer keeps state per thread.
- **Mastra:** steps chained with `.then`, `.branch` and `.dountil(step, cond)`. A step calls
  `suspend()`, and `run.resume({ step, resumeData })` resumes it. A step can declare a
  `suspendSchema` and a `resumeSchema`.

The PR shepherd in LangGraph:

```ts
const graph = new StateGraph(State)                        // State: green, approved, merged, comments (append), failure
  .addNode("wait", () => fold(interrupt("waiting for CI, comments, approval") as PrEvent[]))
  .addNode("fix", async (s) => {
    const { pushed } = await agentTurn({ role: "fixer", prompt: fill(FIX, s) });
    return { comments: new Overwrite([]), failure: null, green: pushed ? false : s.green };   // Overwrite bypasses the append reducer
  })
  .addNode("merge", async () => { await gh(`pr merge ${pr} --squash`); return { merged: true }; })
  .addEdge(START, "wait")
  .addConditionalEdges("wait", (s) =>
    s.merged ? END : s.failure || s.comments.length ? "fix" : s.approved && s.green ? "merge" : "wait")
  .addEdge("fix", "wait")
  .addEdge("merge", END)
  .compile({ checkpointer });

// from a poller; the first call on a thread is graph.invoke({}, config), which runs to the first interrupt
await graph.invoke(new Command({ resume: events }), { configurable: { thread_id: `pr-${pr}` } });
```

Against C:
- **No inbox.** Neither framework can be resumed while `fix` runs. The poller has to hold the
  events that arrive during a turn, and holding them is C's inbox, built outside the framework.
- **The flow lives in edges and routers,** so following one event means reading three places.
  C's flow is one loop. A sequence (case 3) reads well as a Mastra chain; a loop (case 2) reads
  awkwardly in both.
- **Recovery is close to awf's.** A resumed node reruns from its start, as a stage does.

Worth taking, recorded in `docs/design/ideas.md`:
- **reducers per event** (above);
- **the run as a picture,** with where it is now marked;
- **typed waits both ways:** a wait shows a label and accepts an event under a schema, as Mastra's
  suspend and resume schemas do.

Neither framework fits event-driven automations better than C.

### To decide

1. **What a wait takes.** Decided in story 034 (Q1): all the matching events by default (C, which
   made cases 1 and 2 short), the oldest one with `take: "oldest"`.
2. **Turns that aren't awaited.** Decided in story 034 (Q2): in the engine, which writes
   `{agent}:ended` and keeps the running turn.
3. **Reducers: parked (2026-10-24) until a workflow needs them.** In the Datadog case's sketch, the
   handing of a batch to a turn, and back on failure, read worse than plain variables. If it comes
   back, that part belongs in a library (`batch`, `take`), not in each workflow.
4. **Names in a long loop.** Settled in [[034-event-driven-runs|story 034]]'s Q9: a wake doesn't
   replay the loop, its wait keeps one name, stages are named by content, and `again(state)` isn't
   needed.
5. **Story 034 follows from these.** [[034-event-driven-runs|Story 034]] (2026-10-25) is drafted
   on C; #1 and #2 are its Q1 and Q2. The old todo's refusal of an event to a run that isn't live
   is replaced: the run's id is its key, and an event for a parked or crashed run continues it. A
   run that returned has ended for good.
