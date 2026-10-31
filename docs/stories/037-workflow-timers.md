---
id: "037"
title: "A workflow waits on time in code that says what it waits for"
summary: "Reminders, expiries, retries, debounces and follow-ups read as what they are, in a loop and in straight-line code alike: named timers, typed sources, a named race that takes only its winner, select as its loop form beside receive, and sleep."
type: story
status: awaiting-human-review
depends_on: ["034"]
---

# A workflow waits on time in code that says what it waits for

## Outcome

A workflow can already wake at a time: `workflow.receive({ until })` returns with no event once
`until` passes, and `awf tick` continues a parked run whose `until` is due
([[034-event-driven-runs|story 034]]). So waiting on time is possible. It isn't obvious:

- **A wake by `until` is anonymous.** It returns `[]`. A run waiting for an approval, with a
  reminder due in two days and an expiry in fourteen, passes the earlier time and then works out
  from the clock and its files which one passed. Nothing in the code says "this is the reminder".
- **A relative time needs a home.** "In two days" can't be `Date.now() + 2 * DAY` at the wait:
  code between waits reruns after a crash or a wake and would move it. Each author writes the due
  time to a file or a stage first.
- **`until` is passed only when the code would act on it**, since a passed one returns at once on
  every call. The sketches compute it with a condition at the wait
  (`!investigator.turn && needsTurn(kase) ? kase.retryAt() : undefined`), which a reader decodes.

The goal is that a person or an agent reading a workflow sees each wait on time as what it is, with
as few new ideas as awf can manage. Two shapes come up again and again, and both should read
well:

- **a loop over `receive`**, where time is one more signal beside replies, turn ends and new
  events: how event runs are mostly written;
- **straight-line code that sleeps**, or waits for one thing with a timeout, and goes on.

This story compares how other engines express them, then proposes one model that gives both,
from a few parts that combine. Implementation is planned once the model is settled.

## The cases to judge by

Each alternative below is written against the same cases:

1. **Approval, with reminders and an expiry.** Wait for an approver's reply; remind every two
   days; give up after fourteen.
2. **Waiting for a reply, then a nudge.** Post a question; nudge after four hours if nothing came.
3. **A retry after a failed turn**, backing off: the dd-case sketch's `retryAt`.
4. **New events, batched.** Thirty occurrences start one turn: ten minutes after the first unseen
   (a delay), or after ten quiet minutes (a debounce, which restarts on each event).
5. **Closed for silence.** Thirty days without activity closes a case; each activity restarts it.
6. **A follow-up in straight-line code.** Release, wait fourteen days, check for regressions.

Not here: the same work every hour or at `0 9 * * MON`, which is a run per occurrence
([[workflow-schedules]]).

## How other engines do it

Every durable engine has a sleep, and most have a wait for one thing with a timeout. They differ
in what a timer *is*: a pause in straight-line code, one side of a race, or a message the code
receives.

| Engine | Durable sleep | Wait for one thing, with a timeout | Several things at once | A timer that restarts |
| --- | --- | --- | --- | --- |
| Temporal | `sleep("14 days")` | `condition(fn, "2d")` → `false` on timeout | Go `Selector` of timers and signals; TS `Promise.race` | cancel a timer, start another |
| Inngest | `step.sleep(id, "14d")`, `sleepUntil` | `step.waitForEvent(id, { event, timeout, if })` → `null`; misses an event sent before the wait | `Promise.race` of steps | — |
| Cloudflare Workflows | `step.sleep(name, "1 day")`, `sleepUntil` | `step.waitForEvent(name, { type, timeout })`, throws on timeout; default 24 h | — | — |
| Trigger.dev | `wait.for({ days })`, `wait.until({ date })`, `idempotencyKey` | `wait.forToken(token)` → `{ ok: false }` on its timeout | — | — |
| Vercel Workflow | `sleep("7d")` | — | `Promise.race([hook, sleep("7d")])` | — |
| DBOS | `DBOS.sleep` | `recv(topic, timeout)` → empty on timeout; messages queue | — | — |
| Hatchet | `SleepCondition` | `wait_for(key, UserEventCondition)` | `or_(SleepCondition, UserEventCondition)`, returns which; `consider_events_since` for early ones | — |
| Restate | `ctx.sleep` | `promise.orTimeout(…)` | `RestatePromise.race/any` | a delayed send to itself |
| Azure Durable Functions | `createTimer(deadline)` | — | `Task.any([timer, waitForExternalEvent])`, then cancel the timer | — |
| Akka / Erlang (actors) | — | Erlang `receive … after 5000 ->` | the mailbox: a timer *is* a message | Akka `startSingleTimer(key, msg, delay)`: the same key replaces |
| Durable Objects | — | — | — | one `setAlarm(at)` per object, replaced on each call |
| Step Functions | `Wait` state | a task token with `TimeoutSeconds` | `Parallel` | — |

Sources: Cloudflare, Trigger.dev, Vercel, DBOS and Hatchet from their current docs (2026-10-28);
Temporal, Inngest and Restate from [`workflow-styles.md`](../research/workflow-styles.md) §§1–3;
the rest from their public APIs, to cite when refined.

What the survey settles:

- **Every engine names the wait and records its due time once**, on the first execution, so a
  relative duration is safe: Inngest's step id, Cloudflare's step name, Trigger.dev's idempotency
  key, Hatchet's signal key, Temporal's history. The rerun objection 034 raised against a relative
  time disappears once the time is recorded under a name.
- **Durations are strings or unit objects** (`"14d"`, `"1 hour"`, `{ days: 2 }`), never
  milliseconds in author code.
- **A timeout is reported three ways**: a value (`null`, `false`, `{ ok: false }`), an exception
  (Cloudflare), or which side of a race won (Hatchet, Vercel). Values read best in a loop;
  exceptions read worst.
- **Straight-line engines** (Inngest, Cloudflare, Trigger.dev, Vercel) assume one wait at a time.
  A case that waits on a reply, a turn's end *and* a reminder at once becomes a race of three.
- **Actor systems** put the timer in the mailbox, and only they have a timer that restarts by key,
  which is what debounce and inactivity need.
- **Events sent before the wait**: Inngest misses them, Hatchet needs a lookback, DBOS and
  Restate keep them. awf's mailbox keeps them already.

awf's event runs are closest to the actors: one mailbox, one loop, and every wake-up a message in
it (034). The straight-line engines are closest to awf's plain workflows. Erlang has both in one
construct: a `receive` that takes only the messages its patterns match, leaves the rest in the
mailbox, and has an `after` for time. That is the shape this story builds on.

## The parts

What the engines above have, taken apart. Each is small; the proposal is how they combine.

| Part | What it is | Engines |
| --- | --- | --- |
| **A timer** | a due time recorded once under a name; firing puts a message in the mailbox | Akka timers, Restate's delayed send, every engine's named sleep record |
| **A selective wait** | a wait that takes only what it names and leaves the rest in the mailbox | Erlang `receive` with patterns, DBOS `recv(topic)`, Inngest `waitForEvent` |
| **Sleep** | a selective wait for one timer | everyone's `sleep` |
| **Race** | a selective wait for the first of several things, saying which | Vercel, Restate, Azure `Task.any`, Hatchet `or_`, Temporal Selector |
| **A restart** | setting a timer's name again moves it | Akka `startSingleTimer`, Durable Objects `setAlarm` |

awf has the mailbox and a wait that takes everything (`receive`). It lacks named timers and a wait
that takes only some things; `race` is that wait, and `sleep` is a race of one timer.

## Proposal: four waits over one mailbox

```ts
// waits
workflow.receive({ label? })                          // → every waiting event, a batch: the loop
workflow.race(name, { branch: source, … }, { label? }) // → the first of these, by branch; the rest stay
workflow.select({ branch: source, … }, { label? })   // → each of these, one at a time, by branch: a loop
workflow.sleep(name, "14d" | date)                    // → a race of one timer

// sources: what a race names
workflow.timer(name, "2d" | date)                     // Source<TimerDue>: a due time, recorded when called
workflow.signal("dd.closed")                          // Source<the declared event>: typed from `events`
thread                                                // a participant: Source<its next reply>
investigator.turn                                     // an agent's started turn: Source<its end>
workflow.timers()                                     // Source<TimerDue>: any of the run's timers
workflow.at(() => date | null)                        // a select's deadline, read from state at each wait

timer.cancel()                                        // it won't fire; a cancelled name stays cancelled
workflow.started                                      // the event that started the run, typed by `starts`
workflow.now()                                        // the run's time: real in a run, virtual in a test
workflow.after("3h")                                  // a Date: now() plus a duration, for state to keep
```

```ts
const next = await workflow.race("approval", {
  due: workflow.timer("doc-expires", "14d"),
  reply: thread,
  closed: workflow.signal("dd.closed"),
});
if (next.closed) return close(next.closed.data);
if (next.reply) return answer(next.reply.text);
if (next.due) return abandon();
```

**Two styles, two rerun rules.** awf code reruns from the top after every wake and crash. Each
style keeps that safe its own way, and the waits split along the same line:

- **Straight-line code names its waits**, as every engine in the survey does (Inngest's step id,
  Cloudflare's step name, Hatchet's key, Temporal's history). A `race` or `sleep` records its
  winner under its name, like a stage, and a rerun gets the recorded answer back. So a reply
  that won `approval` an hour ago still wins it on a rerun, and the code walks past it.
- **A loop over `receive` or `select` isn't replayed** (034's Q9): it keeps its state in files, takes what is
  new, and a rerun of plain code between waits reads today's files.

**`receive` and `race` differ in what they let in.** `receive` is woken by any event and takes
every one waiting, as a batch the code sorts. `race` is woken only by the sources it names, takes
the first that is ready, and answers under its branch. Events it doesn't name stay in the mailbox,
in order, for the next `receive` or a race that names them, and don't wake a run parked at it.

| | `receive()` | `select({ … })` | `race(name, { … })` | `sleep(name, …)` |
| --- | --- | --- | --- | --- |
| Woken by | any event | the sources it names | the sources it names | its timer |
| Takes | every waiting event, a batch | each named event, one at a time | the first ready source, alone | its timer |
| Answers | an array, sorted with `source.is(e)` | `{ key, [key]: what it took }`, per event | `{ key, [key]: what it took }` | when the time has come |
| On a rerun | the unacknowledged batch, then what is new | the unacknowledged event, then what is new | its recorded answer | at once, once recorded |
| Reads like | an actor's loop, Erlang `receive` | Go `for { select {} }`, `for await` | Go `select`, Kotlin `select {}` | every engine's `sleep` |

### Sources

A **source** is a typed thing a wait can take, `Source<T>`, where `T` is what it hands back when it
wins. `race` takes sources only, so `race("x", { done: agent.run(…) })`, a promise, fails `tsc`.

| Source | Wins with | In a `receive` loop |
| --- | --- | --- |
| `workflow.timer(name, when)` | `TimerDue`, `{ name, at }` | `timer.is(e)` |
| `workflow.signal(name)` | the event, `data` typed from the workflow's `events`; an undeclared name fails `tsc` | `closed.is(e)` |
| a participant (`thread`) | its next reply, `{ text, author? }`; one per race | `thread.is(e)`, today `thread.replied(e)` |
| an agent's turn (`investigator.turn`) | its end, `{ outcome, meta }`; `turn` is `null` with no turn running, so a race on it fails `tsc` | `investigator.is(e)`, today `investigator.ended(e)` |

Every source has `is(e)`, a type guard, so a loop tests any of them the same way and `e.data`
narrows. Shorthand properties make the branch the variable's name:
`race("approval", { thread, expiry })`.

### Timers

- **A timer is recorded when it is called.** `workflow.timer()` returns its source at once,
  without `await`, so it sits inline in a race; its record is written before the next stage
  record or wait, so a stage that sets a timer and is then reused never loses it. `"2d"` counts
  from the call, as a timer does in Go and Temporal.
- **The first call names the time.** A later call with the same name, in this attempt or any
  other, returns the recorded timer; one asking for a different time logs that it was ignored,
  so editing `"2d"` to `"3d"` under a parked run isn't silent.
- **A timer fires into the mailbox** as `timer:due`, with `at` its due time, so a loop over
  `receive` gets it beside replies and turn ends. The live wait sleeps to the earliest pending
  timer; a parked run records it, and `awf tick` or an emit wakes it as today.
- **`timer.cancel()`** stops a timer that is no longer wanted, so it doesn't fire into a later
  wait; a `timer:due` already queued for it is withdrawn.
- **A race won by a timer takes its `timer:due`**, so a later loop doesn't handle it twice.
- **A race cancels the timers it made.** A timer made inside the race's call belongs to it and is
  cancelled when another branch wins, so a nudge that lost doesn't fire into a later wait. A timer
  made before the race and passed in, like a shared expiry, is the code's to cancel: it stays
  pending for the next round.

### Rules every wait keeps

- **One wait at a time**, recorded in the mailbox with what it names, so a parked run says what
  it waits for and when its next timer is due.
- **Wake only for what the wait would take.** `wake` continues a parked run only when an
  unacknowledged event matches its recorded wait (for `receive`, any) or its earliest timer, or
  time read from state, is due. Parking uses the same test, so a run sleeping with a reply queued parks, and an event no
  wait names never wakes it in a loop.
- **A race takes only its winner, and acknowledges nothing else.** It doesn't acknowledge a
  `receive` batch still being handled; after a crash, a held batch returns to the next
  `receive`, and a race's winner is in its record.
- **Order is by time.** Of two ready sources the earlier `at` wins: an event's arrival, a timer's
  due time, even when a parked run's `timer:due` is appended later. `receive` returns the same
  order. A time read from state comes after every ready event (A time read from state, below).
- **No exceptions for time.** A timeout is an expected answer, so it is a branch, never a throw.
- **Nothing is lost silently.** A run that parks with events no wait named logs them.

## The cases

### Case 1: approval, with reminders and an expiry

As a race:

```ts
const expiry = workflow.timer("doc-expires", "14d");
for (let round = 1; ; round++) {
  const next = await workflow.race(`approval-${round}`, {
    reply: approvals,
    remind: workflow.timer(`remind-${round}`, "2d"),
    expiry,
  }, { label: "awaiting approval" });
  if (next.expiry) return abandon();
  if (next.reply && isApproval(next.reply.text)) return approve(next.reply);
  if (next.remind) await workflow.stage(`remind-${round}`, () => approvals.post(REMINDER));
}
```

On a wake the loop starts at round 1 again, and each recorded race answers as it did, so the
code walks to the current round without posting twice. A reply that isn't an approval ends the
round; the next round's reminder is two days from then.

As a loop over `receive`, when the run reacts to other events too:

```ts
const expiry = workflow.timer("doc-expires", "14d");
let reminder = workflow.timer(`remind-${doc.reminders() + 1}`, "2d");
for (;;) {
  for (const e of await workflow.receive({ label: "awaiting approval" })) {
    if (approvals.is(e) && isApproval(e.data.text)) return approve(e);
    if (expiry.is(e)) return abandon();
    if (reminder.is(e)) {
      await workflow.stage(`post-${e.id}`, () => approvals.post(REMINDER));
      doc.recordReminder();
      reminder = workflow.timer(`remind-${doc.reminders() + 1}`, "2d");
    }
    if (e.name === "doc.changed") await reviewer.start({ prompt: reread(e) });
  }
}
```

The same timers serve both: in the race they are branches; in the loop they arrive as events.

### Case 2: a reply, or a nudge

```ts
await workflow.stage(`ask-${q.id}`, () => thread.post(q.text));
let next = await workflow.race(`answer-${q.id}`, { reply: thread, nudge: workflow.timer(`nudge-${q.id}`, "4h") });
if (next.nudge) {
  await workflow.stage(`nudge-${q.id}`, () => thread.post("Any thoughts on the above?"));
  next = await workflow.race(`answer-${q.id}-late`, { reply: thread });
}
```

Inngest's `waitForEvent({ timeout })` is this race with two branches. A rerun after the reply
gets the reply from the race's record, and the nudge, which belonged to the race, was cancelled.

### Case 3: a retry after a failed turn, inside dd-case's loop

```ts
if (investigator.is(e) && !isAnswered(e.data.outcome)) {
  const failure = kase.markFailed(e.id);                          // backs off, from the files
  workflow.timer(`retry-${failure.id}`, failure.retryAt);
}
…
if (e.name === "timer:due" && kase.retryDue(e.from)) startTurn();    // a stale retry is ignored
```

The timer is set where the failure is handled, and the wait at the top of the loop loses today's
condition (`until: !investigator.turn && needsTurn(kase) ? kase.retryAt() : undefined`). A timer
made in an earlier attempt is matched by its name, since the source that made it is gone.

### Case 4: a turn that a close cuts short

A race inside the loop, when one stretch of the run cares about two things only:

```ts
const turn = await investigator.start({ prompt, meta });
const next = await workflow.race(`turn-${turn.id}`, { done: turn, closed: workflow.signal("dd.closed") });
if (next.closed) await turn.cancel();
// replies that came meanwhile wait for the loop's next receive
```

### Case 5: batching and silence

A delay after the first event is a timer named by it:

```ts
if (e.name === "dd.changes" && kase.unseen().length === 1) workflow.timer(`batch-${e.id}`, "10m");
```

A debounce, or thirty days of silence, is a timer per event; only the latest one counts. An
earlier timer may be cancelled, or left to fire and be ignored:

```ts
if (isActivity(e)) {
  kase.recordActivity(e.id);
  workflow.timer(`idle-${e.id}`, "30d");
}
if (e.name === "timer:due" && e.data.name === `idle-${kase.lastActivity()}`)
  await workflow.stage(`close-${e.data.name}`, () => kase.close(SILENT, e.at));
```

### Case 6: a follow-up

```ts
await workflow.stage("release", () => release(ticket));
await workflow.sleep("follow-up", "14d");
await workflow.stage("follow-up", () => ask(reviewer, REPORT, `Check for regressions since ${ticket}`));
```

While it sleeps the run parks; an event that comes meanwhile waits for the next `receive`, and
doesn't wake it. To stop sleeping when a reply comes, race them:

```ts
const woke = await workflow.race("cool-down", { reply: thread, rested: workflow.timer("rest", "1h") });
```

## Other shapes considered

- **`until`, as today** — possible for every case, but which time passed is inferred from the
  clock, and two deadlines are arithmetic: hard to read. Removed (Decided).
- **Several named `until`s on `receive`** (`until: { remind, expire }`, answering which passed) —
  names the wake, but the times are still computed at the wait, not where their reason is.
- **`receive` with two forms**, a batch with no sources and a named answer with some — one way
  in, but one name returning two shapes; `receive({ label })` would look like the second form and
  be the first.
- **An unnamed race** (`race({ reply, expiry })`) — shortest, but a rerun can't tell it what it
  answered: a reply already taken is gone, and a timer already due wins in its place. Every
  straight-line engine names its waits for this reason.
- **"A fired timer stays fired"**, instead of a race's record — replays a race's timers but not
  its events, so a rerun answers half of what it answered before.
- **Strings as sources** (`race("x", { closed: "dd.closed" })`) — shorter, but a race could then
  take anything, and a promise would look as valid as a source.
- **A result with only the winner's key**, without `key` — `if (next.closed)` reads well and
  stays, but a `switch (next.key)` gives agents the discriminated union they know, and `tsc` can
  check every branch is handled. Both work on the same result.
- **Callbacks per branch** (Kotlin's `select { onReceive {} }`) — a `return` inside one leaves the
  callback, not the workflow.
- **A deadline scope** (`workflow.within("expiry", "14d", async () => …)`) — cancelling code
  mid-flight fights the rerun-from-top model; a shared `expiry` source in each race does the same
  with nothing new, at the cost of naming it in each.
- **`race(…, { timeout })`** — a timer branch is one line and says what the timeout is for.
- **A delayed event to the run itself** (`workflow.later("doc.remind", data, { in: "2d", id })`,
  as Restate and Akka send) — no timer concept, but a timer becomes a schema in `events` and sits
  among the events outsiders may send. A delayed emit to *another* run, and `awf emit --in`, stay
  worth having as their own follow-up.
- **Promises and races over them** (`workflow-styles.md` §5) — a second mechanism beside the
  mailbox, which 034 decided against. Here a race is a wait over the same mailbox, and its
  branches are sources, not promises.
- **A timeout as an exception** (Cloudflare) — a timeout is an expected answer in every case
  above, so it is a value.

## Decided

2026-10-28:

- **`until` is removed**. Timers do what it did, with a name; the sketches' two retries
  move to a retry timer.
- **A workflow without `events` can use timers and `sleep`**. Its run gets a mailbox and
  parks at a wait as an event run does, so `feature-delivery` can sleep fourteen days without
  declaring events. Where such a run lives and how `awf tick` finds it is the implementation's
  to settle with api-consolidation items 1 and 13.
- **Durations are `"{n}d"`, `"{n}h"` and `"{n}m"`**, typed as a template literal so a
  typo fails `tsc`, and a `Date` for an absolute time; the same strings on the CLI.
- **Virtual time is built in this story**, so a workflow with a two-day reminder is
  tested in milliseconds. See "Testing on a virtual clock" below.
- **`race` is the name**, with what differs from `Promise.race` said where it is
  documented: nothing is started, a race chooses among things arriving, what it doesn't choose
  stays in the mailbox, and the timers it made are cancelled when another branch wins. Timers
  have `cancel()` for the rest.
- **A declared event as a source is `workflow.signal(name)`**, the word agents know from
  Temporal for a message into a running workflow; the docs say a signal is one of the workflow's
  declared `events`. Every source has `is(e)` in place of today's `replied(e)` and `ended(e)`.
- **`workflow.started`** is the event that started the run, typed by `starts` and absent
  for a run started by hand, so straight-line code reads it without a `receive`.
- **No shorthand for a single wait**: `sleep` covers the common one, and a helper in the
  workflow's own code covers the rest.
- **`workflow.now()`** is the run's time, as Temporal's `workflow.Now(ctx)` (Go) and
  `workflow.now()` (Python) and Restate's `ctx.date.now()` are: real in a run, the virtual clock in
  a test. Workflow code doesn't read `Date.now()`; a lint says so (below).
- **Recurring timers are left out**, noted in [[workflow-schedules]]: a reminder per
  round is a timer per round until a workflow needs `every`.

2026-10-29:

- **`select` is added beside `receive`, not in its place.** `select` is the loop form of `race`:
  it yields every event its sources take, one at a time, under its branch name, until the loop
  `return`s or `break`s. An event is acknowledged when the loop asks for the next one, and after
  a crash the unacknowledged one comes back once; it isn't replayed, and state lives in files, as
  in a `receive` loop. Replacing `receive` would have taken extra sources to make up for what a
  batch gives (a `drained()` to act once after everything waiting, an `other()` to take what no
  branch names), so `receive` stays for the loop that wants every event as a batch (dd-case), and
  `select` is for the loop that handles named events one by one (the approval). `is(e)` stays
  with `receive`. One new source comes with it: `workflow.timers()`, any of the run's timers, so a
  timer made inside the loop is caught and told apart by `next.timer.name`.

  ```ts
  const expiry = workflow.timer("doc-expires", "14d");
  workflow.timer(`remind-${doc.reminders() + 1}`, "2d");
  for await (const next of workflow.select({ reply: approvals, expiry, timer: workflow.timers() })) {
    if (next.expiry) return abandon();
    if (next.reply && isApproval(next.reply.text)) return approve(next.reply);
    if (next.timer?.name.startsWith("remind-")) {
      await workflow.stage(`post-${next.timer.name}`, () => approvals.post(REMINDER));
      doc.recordReminder();
      workflow.timer(`remind-${doc.reminders() + 1}`, "2d");
    }
  }
  ```

  A branch earlier in the object takes its event first, so `expiry` is never also yielded as
  `timer`. Whether `timers()` takes a prefix (`remind: workflow.timers("remind-")`) is left until
  a workflow wants it.
- **No timer that moves** (`reset: e`). A debounce or a silence is a timer per event, as case 5
  shows, and an absolute `Date` covers a fixed time; moving a timer is rare enough to wait for a
  workflow that needs it. Reopened as Q1, as review-loop3 is that workflow.

2026-10-31:

- **A time that moves is read from state, not a timer**: `workflow.at(() => Date | null)`, a
  `select` branch read at each wait, with no name and no record of its own; `workflow.after(d)`
  turns a duration into the `Date` the state keeps. `workflow.timer()` takes no function: a timer
  is a time recorded under a name, and this isn't. See "A time read from state" below.
- **Only in `select`.** A race would read it once and answer from its record, which is a `Date`
  branch with a function around it; straight-line code with a time passes a timer.
- **Events first** for a time read from state, against "order is by time": the handler may move
  it, and it is read again.
- **"Once per time" is run-wide, by branch name**: the only key a rerun finds again.
- **The name is `workflow.at`**, from Q1, over `due` and `when`: it matches the answer's `.at`.

## Testing on a virtual clock

A test of case 1 must reach two reminders and the expiry without waiting fourteen days. What the
engines do:

- **Temporal**'s time-skipping test environment jumps the clock to the next timer whenever the
  workflow is blocked on timers alone, and `env.sleep(d)` moves it by hand.
- **Cloudflare Workflows**' test helpers let a test turn a workflow's sleeps off and mock the
  events its `waitForEvent` gets.
- **Inngest**'s test engine replaces steps, `sleep` among them, with mocks by step id.

The proposal follows Temporal, which tests the workflow as written rather than with its waits
replaced:

- **The clock skips when the run would park.** When no turn, script or stage is working and the
  wait has nothing to take, the test moves the clock to the earliest pending timer and fires it.
  A scripted event (`events: [{ during, … }]`) still arrives where it is scripted, before the
  clock skips past it.
- **A limit stops a loop that never ends**: a reminder every two days with no reply is skipped
  to the limit (a number of firings, or a virtual time), and the test fails naming it.
- **The run's time is the clock's.** A timer's `at`, an event's `at`, an agent's `keepAlive`
  window and `workflow.now()` use the virtual time; a workflow that read `Date.now()` would
  disagree with the clock, which the lints below catch. A stage's and a turn's records keep real
  time, which orders nothing.
- **`TestRun` shows the timers**: set, due, cancelled and pending, by name, beside `run.parked`.

What the clock does not cover yet: an agent turn's `timeoutMs`, a `parallel`'s deadline and the
run's `--timeout`, which run on real timers in the engine and harness;
[[workflow-test-virtual-time]] keeps those.

## A time read from state

Decided 2026-10-31, from Q1. A `select` branch can be a time the run's state already holds,
`workflow.at(() => Date | null)`. It is a deadline on the wait, read each time the loop asks for the
next event, not a timer: nothing is set, moved or cancelled.

A time moves when the code changes it while it is pending, or sets it again after it fired: a nudge
put off to the next working hour, a retry backed off further, an idle timeout restarted by each
activity. A timer's first call fixes its time for good, and it fires once, so moving one means a
new name. review-loop3's `flow.ts` does that for its nudge and retry:

```ts
select({ …, timer: workflow.timers(), … })                              // catch-all: nudge-{n}, retry-{n}
workflow.timer(`nudge-${view.nudgeTimers}`, new Date(view.nextNudge));  // at every wait on the engineer
if (next.timer?.name.startsWith("nudge-")) {
  if (next.timer.name !== `nudge-${view.nudgeTimers}`) return;           // an earlier one: stale
  …
}
```

The ledger counts `nudgeTimers` only to make the next name; every earlier timer still fires and is
dropped by name; a branch can't name a timer made after the `select` started, so one catch-all
takes them all. The ledger already holds the time. With `at`, the branch reads it:

```ts
for await (const next of workflow.select({
  changes: workflow.signal("mr.changes"),
  reply: run.engineer,
  nudge: workflow.at(() => run.ledger.nextNudge()),        // Date | null
  retry: workflow.at(() => run.ledger.retryAt()),
})) {
  if (next.nudge) await nudge(run);                        // next.nudge.at: the time it came for
  …
}

run.ledger.handedOver(first);                              // set: the next wait reads it
run.ledger.nudgePutOff(workflow.after("3h"));              // moved: a duration becomes a Date where it's written
run.ledger.approved(…);                                    // nextNudge = null: no nudge
```

It is a method of its own, not a `Date` a branch happens to hold, so a reader sees a time that
follows the state, beside `signal()` and a participant.

**Why it has no name.** A timer is named because code reruns from the top: `timer("2d")` unnamed
would count two days from each rerun and never come due, so its time is recorded once, under a
name, and a rerun finds it. A time read from state needs neither: a rerun reads the same saved
state and gets the same `Date`. Nothing is recorded ahead of time, so nothing has to be found
again.

**At each wait**, the engine calls each `at` and writes the times beside the wait's `takes`:

- with no event ready, a time due is what the wait returns: `{ key: "nudge", nudge: { at } }`. It
  becomes an event, `at:due` from its branch, appended and taken in one step, so a crash and the
  next wait treat it as they treat any event the loop took;
- otherwise the wait sleeps to the earliest time, and a parked run records it as `until`, so
  `wake` and `awf tick` read it as they read a timer's, and report it as `timer`;
- `null` is no deadline.

**The rules.**

- **Only a `Date`.** A duration would count from each read and never come due, so the code turns
  one into a time where it writes the state: `workflow.after("3h")`, the run's `now()` plus it,
  real in a run and virtual in a test.
- **Once per time, run-wide by branch.** A branch's `at:due` has an id from the branch and the
  time, so a time returned once is never returned again, by this loop or a later one with a branch
  of the same name. A time already returned is no deadline: it isn't in `until`, doesn't wake a
  parked run and isn't skipped to in a test, so a handler that leaves the state alone neither
  spins nor wakes on every tick.
- **Taken like an event.** Returned and not yet acknowledged when the run crashed, it comes back
  once to a rerun's first `select`, if the state still says that time; another time, `null`, a
  `select` without the branch or a `receive`, and it is acknowledged instead. Nothing is queued
  ahead, so a moved or dropped time can't fire late.
- **Events first.** A ready event, a timer's `timer:due` among them, is taken before a time read
  from state, whatever their times: the handler may move the time, and a time still due is read
  again at the next wait. Of two times due, the earlier; at the same time, the branch declared
  first.
- **The state has to outlive the process.** A parked run wakes in a new process and a crash
  restarts one, and the function is read again after both, so a plain local reads `null` there
  and the deadline is lost. A local rebuilt from files at the start of the run, as review-loop3's
  ledger is, is fine: 034's Q9 rule, that state lives in files, in a new place.
- **Read at each pass of the wait**, before it takes, sleeps or parks, and after a wake or a
  restart: a pass comes with an event, a timer, a wake, or each second while a turn runs, so a
  time an agent's `onTimeout` moves is seen. Code running beside an idle wait that moves a time
  earlier isn't seen until the next pass. A changed time is
  a new wait record, so a parked run's `until` is the one read last. A file changed while the run
  is parked isn't seen until something wakes it.
- **Cheap, synchronous, and a `Date`.** It reads state and nothing else: `workflow.now()` and
  `workflow.after()` throw inside it, as a time made at the read is never due. Anything but a
  valid `Date` or `null` throws, and so does the function, from the loop's `for await`.
- **It lives as long as its loop.** It isn't a timer: no name, no `cancel()`, no `is(e)`, not in
  `timers()`, not in a `receive`; when the loop ends, it's gone. Cases 3 and 5 are `receive`
  loops and keep a timer per event; one rewritten as a `select` could read its time instead.

**How other engines say it.** Three families, from [[timers-waits-and-state]]:

- **Set by key, setting again replaces**: `gen_statem`'s `{{timeout, Name}, T, Msg}`, Akka's
  `startSingleTimer(key, …)`, Orleans' `RegisterOrUpdateReminder(name, …)`, a Durable Object's one
  alarm. No name per move, but the time lives in the timer, apart from the state, and the code
  keeps the two in step.
- **Derived from state, re-armed when a value changes**: React's `useEffect(…, [nudgeAt])`, Vue's
  `watch`, Svelte's `$effect`, Temporal's `condition(fn, timeout)` in a loop. Nothing to keep in
  step. Every one arms from an absolute time, and Temporal warns that a relative timeout in a loop
  restarts each pass.
- **Tied to a phase, or configuration**: `gen_statem`'s `state_timeout`, XState's `after`,
  Inngest's `debounce: { period, timeout }`. Neat when the timer is the phase; it can't put a nudge
  off to a working hour.

`workflow.at` is the second family, durable because the state it reads is; the answer says which
time it came for, as `gen_statem`'s message and Orleans' status do. A debounce with a cap is code
over two `Date`s: the earlier of `workflow.after("10m")` and an hour after the first event.

**Considered.**

- **A timer that moves, by name** (`workflow.at("nudge", fn)`, or a function as `workflow.timer()`'s
  time): a record per move, a fold that keeps the latest, a queued due withdrawn when the time
  moves, timers dropped when the loop ends, and exceptions to "the first call names the time" and
  "a cancelled name stays cancelled". All of it to record a time the state already keeps.
- **Several named `until`s at the wait** (Other shapes, above): the same deadlines, computed at the
  wait rather than read from where their reason is.
- **`select(() => ({ …, nudge: view.nextNudge }))`**, a function for the whole branch object, a
  bare `Date` a deadline. More general, as any branch could change between passes, but `select`
  changes form and a `Date` changes meaning silently; nothing needs the generality yet.
- **A handle by name** (`const nudge = workflow.timer("nudge"); nudge.at(…)`): the same line makes
  the timer or reaches an existing one, and reads the same either way.
- **Declared timers** (`timers: ["nudge"]`, `workflow.timers.nudge.at(…)`): clear, but the time is
  kept twice, in the ledger and the timer, and they drift when a path moves one.
- **Set by name** (`setTimer("nudge", …)`): two rules for a named timer, told apart by a verb.
- **Owned by the loop** (`loop.timers.nudge.at(…)`): the loop has to be passed to every function
  that moves a timer.
- **A prefix on `timers()`**: keeps the counter and the stale check.
- **A timer restarted by an event** (`reset: e`): can't put a nudge off to a working hour or back a
  retry off.
- **A callback on the timer** (`timer("nudge", { onFire })`): says what happens when it fires, not
  when; it has to be registered again in every process, and a `return` in it leaves the callback.

[[reconciled-runs]] explored a wider model around this question, state, effects and work
reconciled by key; this story takes only the time.

## Open questions

None open.

## Lints to write

The API can't stop every mistake by type. These are the ones the cases and the reviews hit, for a
lint over workflow code once the API lands:

- **Reading the clock directly**: `Date.now()`, `new Date()` with no argument, `performance.now()`
  in a workflow's code. Use `workflow.now()`, or a timer.
- **Randomness in a name**: `Math.random()`, `crypto.randomUUID()` or the clock in the name of a
  stage, timer, race or sleep; a rerun makes a new name and does the work again.
- **A constant name inside a loop**: `workflow.race("approval", …)` or `workflow.timer("remind", …)`
  in a `for` or `while` whose name doesn't change per iteration; the second iteration gets the
  first's record or timer.
- **A timer that can't be cancelled**: `workflow.timer(…)` as a bare statement whose name is never
  matched by `is(e)`, a `timer:due` check, or a race; it fires into a wait nobody reads.
- **A declared event nothing takes**: an event in `events` that no `signal()`, `is(e)` or name
  check in the code ever names, in a workflow without a plain `receive()`; it queues forever.
- **`receive()` to read the starting event** in straight-line code; use `workflow.started`.

## Review

Three reviewers read the draft with `race({ … })` unnamed and a fired timer that "stays fired"
(2026-10-28).

- **An agent writing four workflows from the proposal alone** (a PR babysitter, an on-call
  escalation, a daily digest, a debounce): the straight-line races read like Go `select`. It
  guessed at when a race acknowledges, how a race takes the run's first event, what `in`
  counts from, and whether a timer can be moved; it expected the losers gone under `race`; and a
  shared "ends at any point" source had to be named in every race. Taken: a race's record, a
  timer counted from its call, `reset`'s rules, `workflow.started`, and the losers' semantics stated where `race` is documented.
- **API design**: rename to `select`; a `key` beside the branches; `agent.turn` as the
  source, so a race on no turn fails `tsc`; `is(e)` as a type guard; `"2d" | Date` durations;
  warn on a timer asked again with another time; `every` and `take`.
  Rejected there: callbacks per branch, a deadline scope, a `timeout` option. Taken: all but
  `select`, `every` and `take` (Decided).
- **Semantics**: an unnamed race wasn't rerun-safe, since "stays fired" replays timers and not
  events; a race acknowledged the loop's batch; a timer's event could be handled twice or stray;
  a parked run could wake on every tick for an event its wait doesn't name; a timer set in a
  reused stage was never recorded; a moved timer could match a stale due event; races and `receive`
  ordered differently. Taken: every fix — a named race with a record, acknowledgement per wait,
  a race won by a timer takes its event and owns the timers made in it, one wake predicate for
  parking and waking, recording at the call, reset generations, order by `at`.

## Context and evidence

- Fact: `ReceiveOptions.until` is epoch ms or a `Date`, "computed from the run's files, so a rerun
  computes the same one" (`packages/contract/src/workflow/events.ts:99-104`). 034 rejected a
  relative `timeoutMs` on the wait because a rerun would move it; a time recorded once by name
  doesn't move.
- Fact: 034 lists "waits that take some types only" as later work, without changing today's
  calls; `race` and `sleep` are that work.
- Fact: 034 parks a run only with nothing unacknowledged, and `wake` continues a parked run with
  any unacknowledged event (`packages/engine/src/wake.ts:93-100`); with selective waits both
  test what the recorded wait would take.
- Fact: `wake` continues a parked run whose `until` passed (`packages/engine/src/wake.ts:98`);
  the same path wakes it for a due timer.
- Fact: [[036-agent-keep-alive|036]]'s keep-alive window is an engine-owned timer; the wait
  already sleeps to the earliest of an event, `until` and a window's end.
- Fact: the sketches' two uses of `until` are retries
  (`examples/event-sketches/dd-case.ts:108`, `mr-review.ts:107`).

## Tasks at a glance

- [x] 1. The author surface: sources, timers, `race`, `select`, `sleep`, `started`, `now()`
- [x] 2. Timers and selective waits in the mailbox: fire, take, park and wake
- [x] 3. A virtual clock in `testWorkflow`
- [x] 4. Timers and `sleep` in a workflow without `events`
- [x] 5. The sketches and docs on timers, and a live run
- [x] 6. A time read from state: `workflow.at` and `workflow.after`, in `select`

## Implementation decisions

Where building it met something the model above didn't settle (2026-10-29):

- **A race owns the timers written inline, as a duration.** The code can't tell, at run time, a
  `workflow.timer()` made in the race's call from one made just before it, so "a race cancels
  the timers made in its call" is written as a branch given a duration:
  `race("answer", { reply: thread, nudge: "4h" })`. That timer is named `{race}@{branch}` and
  cancelled when another branch wins. A `workflow.timer()` passed in is the code's: a race never
  cancels it. Case 1 reads `remind: "2d"`.
- **An agent is a source of its turns' ends**, as a participant is of its replies: `ended:
  investigator` in a `select`, where `investigator.turn` is one turn's end. Every source's `is(e)`
  replaces `replied(e)` and `ended(e)`.
- **A test's clock skips where the run would park**, to the next timer or time read from state,
  up to `maxTimers`, 20 by default, which counts both; at it the
  run parks, so `maxTimers: 0` tests the parking itself, and `run.value` says the clock stopped.
  One knob in place of a firing count and a virtual end time.
- **A workflow without `events` sleeps in its process**: `awf run` gives a plain run no parking, so
  its wait sleeps to the timer, and a `--continue` after a crash keeps the recorded due time.
  Parking one waits on api-consolidation item 1, where such a run would live.
- **A wait's record names what it takes** (`takes`), and the parked ending's `until` is the
  earliest timer it takes, so `awf runs` and `awf tick` read the same thing they did; `awf tick`'s
  cause `until` becomes `timer`.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. The author surface

Outcome: the types a workflow writes against, typechecked by examples of every case, with
`until` gone and `is(e)` in place of `replied(e)` and `ended(e)`.

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

- `Source<T>`, `Duration`, `TimerDue`, `timer:due`; `workflow.timer`, `timers`, `signal`, `race`,
  `select`, `sleep`, `started`, `now` on `EventWorkflowContext`; `is(e)` on participants, agents,
  turns, timers and signals;
- the mailbox record formats: `timer`, `timer-cancelled`, a wait's `takes` and `race`, a `took`'s
  `race` and `branch`; `until` gone from `ReceiveOptions` and the wait record;
- `packages/contract/src/workflow/events.typecheck.ts` with each case of this story.

Done when:

- the cases typecheck, and a promise in a race, an undeclared signal, a race on `turn` that may be
  `null` and a mistyped duration fail `tsc`.

### 2. Timers and selective waits in the mailbox

Outcome: a run sets, cancels and takes timers; `race`, `select` and `sleep` take only what they
name; a run parks and wakes on what its wait takes, timers included.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- `mailbox.ts`: the fold with timers, races and a wait's `takes`; one predicate, what a wait
  would take, for taking, parking and `wake`; due timers appended as `timer:due` at their due
  time; ready events in order of `at`;
- `workflow-runner.ts`: the sources, the waits, a race's record and its inline timers, `started`
  and `now()`; `wake.ts` and `awf tick` on the predicate.

Done when:

- tests cover: a race answered from its record on a rerun; a loser's inline timer cancelled; a
  race leaving a `receive` batch held; `select` taking one event at a time and the held one again
  after a crash; a parked run woken by its due timer and not by an event its wait doesn't name;
  a timer asked again with another time logs it.

### 3. A virtual clock in `testWorkflow`

Outcome: a test of a workflow with a two-day reminder runs in milliseconds, and `TestRun` shows
its timers.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- a clock the runner, the mailbox and `workflow.now()` read; at a wait that would park with a
  timer pending, the test moves the clock to it; `maxTimers`; `TestRun.timers`.

Done when:

- case 1 tested to its expiry and to an approval after two reminders; a loop of reminders with
  no reply fails at `maxTimers`, naming it.

### 4. Timers and `sleep` in a workflow without `events`

Outcome: a plain workflow sleeps, and reads `workflow.now()`; a race needs events to take, so it
stays a workflow with `events`'s.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- a plain run's mailbox for its timers; whether it parks, or waits in its process until
  api-consolidation item 1 settles where such a run lives, is this task's plan.

Done when:

- a plain workflow's `sleep` works in a run and in a test.

### 5. The sketches, the docs, and a live run

Outcome: the sketches and `docs/workflow-api.md` use timers; a run with a live agent reminds,
parks and wakes on its timer.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- `dd-case.ts` and `mr-review.ts` off `until`; `docs/workflow-api.md`; an example workflow on
  timers; a live run on a cheap model through `awf run`, `awf tick` and `awf send`.

Done when:

- the live run parks on its reminder, `awf tick` wakes it when due, and a reply ends it.

### 6. A time read from state

Outcome: a `select` branch reads a time from the run's state at each wait, so review-loop3 nudges
and retries without a counter, per-round names or a stale check. Q1 settled first.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- the surface: `workflow.at(() => Date | null)` as a select's branch, answering `{ at }`;
  `workflow.after(duration)`; a race, a `receive` and a duration from the function fail `tsc` or
  throw, naming why;
- the wait record: each `at` branch's take carries the time read, `due`; a changed time appends a
  wait record. A time returned is an `at:due` event from its branch, id from the branch and the
  time, appended with its `took` under the lock. `MAILBOX_RECORD_VERSION` stays (beta, no
  compatibility);
- the wait reads its `at`s at each pass; one predicate still: `hasWork` and `nextTimer` take the
  earliest time read and not yet returned, so taking, parking, `wake`, `awf tick` and the test's
  clock skip agree; ready events first;
- a crash: a rerun's first `select` returns a held `at:due` only if its branch still reads that
  time; otherwise, and in a `receive`, it is acknowledged;
- `now()` and `after()` throw inside a read; a non-`Date`, an invalid one, and a race or sleep given
  an `at`, throw naming why;
- `docs/workflow-api.md`; an example in `examples/` on `at`, run live.

Done when:

- tests cover: a time moved later doesn't fire at the earlier one; `null` doesn't fire; a parked
  run wakes at the time it read and not before; a time returned and left in state neither spins,
  nor parks with an `until`, nor wakes on a tick; a crash after a time was returned returns it once
  if the state still says it, and not if it moved, nor to a `receive`; a ready event comes first;
  two times due at once go in branch order; a time moved while the wait waits is seen; a throwing
  read, an invalid `Date`, `now()` in a read, and `at` in a race are refused; a test's clock skips
  to the time read;
- the example runs live: parks on a time read from state, `awf tick` wakes it, and a reply moves or
  clears the time.

## Verification

Automated:

- [x] `bun test`: 2258 pass, 0 fail (task 6)
- [x] `bunx tsc --noEmit`
- [x] `bun run check`

Manual or live evaluation:

- [x] Task 5's live run, on a cheap model (Implementation notes).
- [x] Task 6's live run, `examples/nudges` (Implementation notes).

## Review record

### Task 1

- Architecture and scope: the formats carry every rule. Taken: task 4's text matched to the surface
  (`sleep` and `now()` on every workflow, the rest with `events`); a `timer:due`'s `at` is its due
  time, said in the format; a race's own timers are `{race}@{branch}` and a sleep's `{name}@sleep`,
  with `@` refused in a `workflow.timer()` name; the duration parser kept out of the author surface;
  a timer's branch carries its event's `id`, as a reply's and a turn's do; one `EventLike` for every
  `is(e)`. Kept: `started` typed by `events`, not `starts`, said in its comment.
- Correctness and proof: every `@ts-expect-error` fails for its stated reason. Taken: a branch named
  `key` and an empty race fail `tsc` (`Checked<B>`); a duration's number is checked where it is
  given, as a template literal can't; proofs of narrowing the whole answer, of `signal.is` and
  `turn.is` with their false branches. Of two branches taking one event, the first declared takes
  it.

### Task 2

- Architecture and scope: one predicate, `hasWork`, for taking, parking and `wake`. Taken: `wake`
  calls it; every source's `is(e)` is the same match its waits use (`source()`), `timers()`
  included; one `branchOf`; the in-memory timers only answer `setTimer` and `cancelTimer` at once,
  the file says what fired; the agent's window, a recovered turn's end and a test's events on the
  run's clock; `awf tick`'s help names the timer.
- Correctness and proof: five found, each fixed with a test. A crash between a race's win and its
  losers' cancels: the rerun, answering from the win, cancels them. A rerun's first `select` that
  doesn't take what a crash held: its wait record says `returns`, and the held events wait again
  rather than being acknowledged. A race or sleep name reused in an attempt answered at once, so a
  loop spun: refused, naming per-round names. A refused or cut-short race left its own timers
  pending: every branch is checked before a timer is set, and a race that throws, not parked,
  cancels its own. A name that returns a cancelled timer is logged.

### Tasks 3 and 4

- Correctness and architecture, together: a skip comes only where the run is idle and would park,
  after a `keepAlive` window and its handler, so it never jumps a turn, a stage or a scripted
  event; a plain run in `awf run` never parks. Taken: `maxTimers` checked as a whole number; the
  parked message blames it only when the clock stopped there; the stall check reads one clock; doc
  comments for plain runs' parking and mailbox; proofs of an event's virtual `at` and of a plain
  run sleeping in its process. Narrowed: stage and turn records keep real time (Testing, above).

### Task 5

- Docs, sketches and example against the code: the docs said a second `timer()` with another time
  is logged, and it is also ignored; they left out that `race`, `sleep` and `select` throw in a
  stage, that a race branch takes a duration and not a `Date`, that races and sleeps share names,
  and that `select` refuses a duration; `docs/design/README.md` still said `ended(event)`. All
  fixed. The sketches set a retry timer but gated the retry on their files' clock, which a test's
  clock never reaches: `retrying(workflow.now())` now, and `mr-review`'s timer is the ledger's own
  backoff. The example's approval check, `/\bapprove/`, matched "not approved": a reply that
  starts "approved" now, said to be a stand-in.

### Task 6

- Architecture and scope: the surface is minimal and the record change fits, since a time returned is
  an event taken at once. Taken: `after` moved to event workflows beside `at`, as a plain workflow's
  `sleep` already takes a duration; `TimeDue` as `Taken<…>`; `due` said not to be part of a take's
  match; the API doc's example made consistent; the read-at-each-pass claim narrowed to what a pass
  is; the example's ledger path said, and `.nudges/` ignored. Kept: the boundary exception for
  `examples/nudges/ledger.ts`, the one example module with `node:fs`, as a time read from state
  needs state that outlives the process ([[workflow-state]] would remove it).
- Correctness and proof: a crash between an `at:due` and its `took` left an event any wait took,
  whatever the state said. The fold now drops an `at:due` no `took` holds, so its time comes again.
  `#takeTime` reads the time again under the lock, so code beside the wait that moved it isn't
  overtaken. `sleep` given an `at`, and `after` given a bad duration, say why. Tests for each. Kept: the
  example's "later" counts from the rerun's `now()` after a crash, as at-least-once handling allows.
  Not proven by a test: a time moved by a real `onTimeout` (the pass is, by a nudge).

## Implementation notes

- Live run of task 6, 2026-10-31, `examples/nudges` on codex `gpt-6-luna`, headless, nudging each
  minute, a "later" putting off two: `awf emit` started it, and it parked with `until` a minute out.
  An early `awf tick` woke nothing, and one after the time continued it, `why: "timer"`. The writer
  drafted nudge 1 and it parked again with the ledger's next time. `awf send --as engineer --event-id`
  "later, in a meeting" moved the time from 14:04:04 to 14:06:03, and the parked `until` followed.
  The earlier time never fired: the mailbox has `at:due` for 14:02:30 and 14:06:03 only. A tick after
  14:06 sent nudge 2, and the answer returned `{ answer, nudges: 2 }` at attempt 5, under $0.01 at
  list prices. Attempts after 14:06 ran with the review's fixes in.

- Live run, 2026-10-29, `examples/approval-reminders` on codex `gpt-6-luna`, headless, reminding
  every minute with a ten-minute expiry: `awf emit` started it and it parked at round 1, `until`
  16:53; `awf tick` before then woke nothing, and after, continued it, `why: "timer"`. The rerun
  answered round 1 from its record, the writer drafted a reminder in 7 s (40k tokens, under $0.01
  at list prices, on the subscription), posted to `awf inbox`, and the run parked at round 2.
  `awf send --as approvals "Approved, thanks."` continued it, and it returned `approved` at round
  2, the round's own reminder cancelled. `awf runs` counted the starting event as never taken;
  the event that started a run is `workflow.started`'s now, and isn't counted.
- `until` leaves the wait record without a `MAILBOX_RECORD_VERSION` bump: an old parked mailbox's
  `until` is ignored (beta, no compatibility). `awf tick`'s cause `until` is `timer`.
