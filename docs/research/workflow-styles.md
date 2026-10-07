# One workflow, six styles

Draft. The same long-running process written as a state row with a poller, in Temporal, Inngest
and Restate, in awf as it is today, and in awf with suspension and a scheduled tick (a proposal,
not built). The point is to see which abstractions each style makes easy, which it makes
impossible, and where awf's proposal sits among them.

The SDK calls were checked against current docs (Context7, 2026-10-06): Temporal's TypeScript
SDK, inngest-js and Restate's TypeScript SDK. The awf proposal is a sketch; its names are not
settled.

**Direction so far** (discussion, 2026-10-07; nothing built):

- Inngest's model, not Temporal's or Restate's: rerun from the top, match by name, and let fixed
  code apply to runs in flight, which is what `--continue` already does.
- No server. A run suspends; `awf send` and a scheduled `awf tick` resume it.
- From Restate, a value sent before the run waits for it is kept. `awf resolve`/`send` accepts a
  name the run has not reached yet.
- Every wake-up is a message in a process's inbox: addressed sends, routed events, timers,
  schedules. One wait primitive, `receive`. See [Loops, the inbox and the core](#loops-the-inbox-and-the-core).

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
  checked: Set<"review" | "ci" | "docs">;
  docPath?: string;
};

// cron, every 5 minutes; webhooks write `approvedAt` or add to `checked`, then call advance too
async function advance(c: Case, now: Date): Promise<void> {
  switch (c.stage) {
    case "planning": {
      c.docPath = (await agentTurn({ role: "planner", prompt: `Draft ${c.ticket}` })).path;
      return save({ ...c, stage: "awaiting-approval", dueAt: days(now, 2) });
    }
    case "awaiting-approval": {
      if (await isApproved(c)) return save({ ...c, stage: "implementing" });
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
  A crash between `agentTurn` and `save` repeats the turn. A loop in the process (review until
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
  for (let round = 1; !(await condition(() => approval !== undefined, "2 days")); round++) {
    if (round === 3) return { kind: "abandoned", reason: "doc not approved" };
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
      if (round === 3) return { kind: "abandoned", reason: "doc not approved" };
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
    run: async (ctx: restate.WorkflowContext, req: { ticket: string }) => {
      const ticket = ctx.key;
      ctx.set("stage", "planning");
      const doc = await agentTurn(ctx, "plan", { role: "planner", prompt: `Draft a ticket doc for ${ticket}` });

      ctx.set("stage", "awaiting-approval");
      const approved = ctx.promise<Approval>("doc-approved").get();
      for (let round = 1; ; round++) {
        const next = await RestatePromise.race([
          approved.map(() => "approved"),
          ctx.sleep({ days: 2 }).map(() => "remind"),
        ]);
        if (next === "approved") break;
        if (round === 3) return { kind: "abandoned", reason: "doc not approved" };
        await ctx.run(`remind-${round}`, () => notify(`Reminder: approve ${doc.path}`));
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
async function agentTurn<T>(ctx: restate.WorkflowContext, name: string, turn: Turn) {
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
      ctx.objectSendClient(digest, ctx.key).tick({}, restate.rpc.sendOpts({ delay: untilNextMonday9(await ctx.date.now()) }));
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
attempt has one deadline, 30 minutes by default. There is no sleep, no outside input and no
schedule: `steps` and `signals` are typed and throw `unavailable`.

```ts
run: async (workflow, { ticket }) => {
  const planner = await workflow.agents.open({ key: "planner", runtime: RUNTIMES.planner });
  const doc = await workflow.stage("plan", { result: DOC }, async () => {
    const { outcome } = await planner.run({ prompt: `Draft a ticket doc for ${ticket}`, schema: DOC });
    return isAnswered(outcome) ? outcome.value : workflow.stop(outcome.reason);
  });

  // the only way to wait for a person: stop, and have the operator continue later
  await workflow.stage("approval", { result: APPROVAL }, async () =>
    (await readApproval(doc.path)) ?? workflow.stop(`awaiting approval of ${doc.path}`));

  const implementer = await workflow.agents.open({ key: "implementer", runtime: RUNTIMES.implementer });
  await workflow.stage("implement", { result: WORK }, async () => { /* … */ });
  // checklist: the same stop-until-present trick; reminders, the 14-day follow-up and the
  // weekly digest have no expression at all
}
```

- **Wake-up:** a person types `awf run --continue {id}`.
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
        const next = await workflow.race({ approved, remind: workflow.timer(`remind-${round}`, "2d") });
        if (next.kind === "approved") break;
        if (round === 3) return { kind: "abandoned", reason: "doc not approved" };
        await workflow.stage(`remind-${round}`, () => notify(`Reminder: approve ${doc.path}`));
      }

      const implementer = await workflow.agents.open({ key: "implementer", runtime: RUNTIMES.implementer });
      await workflow.stage("implement", { result: WORK }, () => ask(implementer, WORK, `Implement ${doc.path}`));

      const checklist = workflow.all(ITEMS.map((item) => workflow.promise(`check:${item}`, { schema: CHECK })));
      const next = await workflow.race({ checklist, expired: workflow.timer("checklist-expires", "14d") });
      if (next.kind === "expired") return { kind: "abandoned", reason: "checklist expired" };

      await workflow.stage("release", () => release(ticket));
      await workflow.timer("follow-up", "14d");
      const reviewer = await workflow.agents.open({ key: "reviewer", runtime: RUNTIMES.reviewer });
      await workflow.stage("follow-up", { result: REPORT }, () => ask(reviewer, REPORT, `Check for regressions since ${ticket} shipped`));
      return { kind: "done" };
    },
  },
});
```

```sh
awf run feature-delivery.ts --args '{"ticket":"AWF-42"}'     # plans, then suspends on doc-approved
awf resolve {id} doc-approved '{"by":"roman"}'               # records it; resumes
awf resolve {id} check:ci '{"ok":true}'                      # from a CI webhook
awf tick                                                     # every 5 minutes from launchd
```

The weekly digest is a separate workflow with `schedule: "0 9 * * MON"`; each occurrence is a new
run, so no run's record grows forever.

- **Wake-up:** `awf tick` or `awf resolve`. Latency is the tick interval, which suits waits
  measured in days.
- **On resume, what reruns:** `run` from the top; stages, timers and promises are matched by name.
- **A value sent early** is recorded in the run directory and kept.
- **Code change in flight:** the new code runs, as with `--continue` and Inngest.
- **Where is it:** the run record names the stage and what the run is suspended on.
- **Cost:** a cron entry; no server.

### What the proposal has to settle

1. **Effects outside a stage rerun on every resume.** An agent turn outside a stage would be
   asked again at every wake-up. The engine can refuse to suspend an attempt that ran a turn
   outside a stage, which makes the effect boundary a check rather than a convention (E6).
2. **Names are the identity.** A timer named in a loop (`remind-${round}`) records its due time
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

## Loops, the inbox and the core

A process that loops (a PR shepherd: fix CI, address comments, ping when quiet, merge when green
and approved) breaks the single-run model: the record grows with every round, names need round
numbers, and events repeat where a promise fills once.

**Process and run are split.** A process is a key (`pr-1234`) with an inbox and a state, and lives
until it returns. A run is one bounded round of it, replayable as today. A round ends by
returning (done), suspending on a message, or `workflow.again(state)`: the next round starts with
that state and the same inbox. A straight-line workflow is a process that never calls `again`.
This is Temporal's `continueAsNew` and Restate's Virtual Object, in awf's terms.

**Everything that wakes a process is a message in its inbox**: `awf send {key} {type}` from a
person, script or agent; `awf emit {type}` routed by the workflow's `on` rules, starting the
process if needed; timers and `schedule` from the clock. The one wait is
`receive(name, { types, match, timeout })`: it takes the oldest unconsumed matching message, or a
timeout, and records which by name, so a replay returns the same one. A promise, a sleep, a
checklist and a reminder loop are all built on it.

**Core is what only the engine can guarantee; the rest is library.**

| Layer | Holds |
| --- | --- |
| contract | `receive`, `again`, the process key; the inbox, state and round record formats |
| engine | the inbox (append, dedup by message id), consumption records, one round per key at a time, clock messages, `awf send`, `awf tick`, `awf status {key}` |
| workflow-testing | a virtual clock and a scripted inbox |
| library, pure, over the author surface | `promise`, `sleep`, a checklist collector, reminders, retry, approval, `ask`. Starts in `examples/`; extracted on the second copy |
| integrations, contract only, through the CLI | CI and forge pollers, notifiers, approval UIs |
| boilerplate | the launchd or cron entry for `awf tick`, a webhook relay into `awf emit` |

`race` and `all` cannot be library code: two live receives could each consume a message, and the
loser's is lost. So the core `receive` multiplexes and consumes exactly one message. `emit` and
routing come after addressed `send`, once addressing keys by hand gets tedious.

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
