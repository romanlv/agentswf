# Timers, waits and state: how other runtimes do it

What each of thirteen frameworks does with state, events, effects and a timer that moves, explained
for someone who knows none of them, with one example written in each. It backs [[037-workflow-timers]]
Q1 and [[reconciled-runs]]. Sources are the frameworks' own docs, checked 2026-10-30 (ctx7, and
erlang.org, react.dev, doc.akka.io, developers.cloudflare.com, learn.microsoft.com directly).

**The example**, the same in every section: after a handover, nudge the author in 2 days. If the
author replies, put the nudge off to 2 days after the reply. If the MR is approved, no nudge.

**Words used throughout.** *State* is the data a program keeps between messages. An *effect* is
anything that touches the outside world: a post, an HTTP call, starting a timer. *Durable* means
written somewhere that survives the process dying. *Atomic* below means: the state change, the
effects it asks for, and "this input message is done" (its *ack*) are written in one step, or none
of them is.

---

## 1. Elm

**How a program is written.** Elm is a pure functional language for browser apps. The program's
whole state is one value, the *model*; the Elm runtime holds it, not your code. Every input (a
click, a reply from the server, a clock tick) arrives as a *message* (`Msg`) and goes to one
function, `update : Msg -> Model -> (Model, Cmd Msg)`, which returns the next model and a *command*:
a description of an effect ("POST this"), which the runtime performs and whose result comes back
as another message. After every update the runtime also calls `subscriptions : Model -> Sub Msg`,
which says what the program wants to keep listening to *given this model* (a tick every minute,
nothing). The runtime compares the new list with the old one and starts or stops listeners to match.
https://guide.elm-lang.org/effects/time

**The example.** Elm has no "fire at time T" subscription, only `Time.every {ms}`. The idiom that
keeps the nudge derived from the model is to keep `nudgeAt` in the model and tick while it's set:

```elm
type alias Model = { nudgeAt : Maybe Int }            -- millis; Nothing = no nudge
type Msg = HandedOver Int | Replied Int | Approved | Tick Time.Posix

twoDays = 2 * 24 * 60 * 60 * 1000

update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
  case msg of
    HandedOver t -> ( { model | nudgeAt = Just (t + twoDays) }, Cmd.none )
    Replied t    -> ( { model | nudgeAt = Maybe.map (\_ -> t + twoDays) model.nudgeAt }, Cmd.none )
    Approved     -> ( { model | nudgeAt = Nothing }, Cmd.none )
    Tick now ->
      case model.nudgeAt of
        Just at -> if Time.posixToMillis now >= at
                     then ( { model | nudgeAt = Nothing }, postNudge )   -- postNudge : Cmd Msg
                     else ( model, Cmd.none )
        Nothing -> ( model, Cmd.none )

subscriptions : Model -> Sub Msg
subscriptions model =
  case model.nudgeAt of
    Just _  -> Time.every 60000 Tick
    Nothing -> Sub.none
```

The other idiom is a one-shot command, `Process.sleep ms |> Task.perform (\_ -> Fire n)`. A command
can't be cancelled, so the model carries a counter `n` and `update` ignores a `Fire` whose `n` is
stale. That is today's `nudge-{n}` in awf.

**On a crash.** Nothing is durable: a page reload starts from `init`. What Elm guarantees is
determinism: the same messages give the same model, which its time-travel debugger relies on.

**awf would take** listening as a function of state, compared with the previous answer by key, so
moving a time is changing the model. **Avoid** one-shot delays as fire-and-forget commands: they
force a generation counter into the state.

## 2. React

**How a program is written.** React builds UIs from *components*: functions that take inputs
(*props*) and return what should be on screen. A component keeps state with `useState(initial)`,
which returns the current value and a setter; calling the setter makes React call the component
again (a *render*) and compare the new output with the old, matching children by their `key`.
Effects don't go in the render; they go in `useEffect(setup, deps)`: after a render in which any
value in the `deps` array changed, React runs the previous setup's cleanup function, then setup
again; cleanup also runs when the component goes away. React holds the state; your code reads it,
sets it, and declares effects with their cleanups. https://react.dev/reference/react/useEffect

**The example.** The parent keeps `handedOverAt`, `lastReplyAt` and `approved` with `useState` and
passes them in; the nudge time is computed during render, and the effect follows it:

```tsx
import { useEffect } from "react";

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

function NudgeTimer({ handedOverAt, lastReplyAt, approved }: {
  handedOverAt: number | null; lastReplyAt: number | null; approved: boolean;
}) {
  const nudgeAt =
    approved || handedOverAt === null ? null : Math.max(handedOverAt, lastReplyAt ?? 0) + TWO_DAYS;

  useEffect(() => {
    if (nudgeAt === null) return;
    const id = setTimeout(postNudge, nudgeAt - Date.now());
    return () => clearTimeout(id);           // runs before the next setup, and on unmount
  }, [nudgeAt]);                             // a reply changes nudgeAt: clear, then set again

  return null;
}
```

**On a crash.** Everything is in memory: a reload loses the timer and the state. Strict Mode, in
development, runs every setup and cleanup one extra time to prove that cleanup undoes setup.

**awf would take** reconciling by key, effects keyed by explicit dependencies, and Strict Mode's
"run it twice, nothing changes" as a test of reconciling. **Avoid** two traps:
`useState(initial)` keeps the first value and silently ignores later ones (awf's
`timer(name, when)`, where the first call wins), and hooks are identified by call order, not by
name, so one inside an `if` breaks.

## 3. Vue 3 reactivity

**How a program is written.** Vue's state lives in *reactive* values: `ref(x)` is a box whose
`.value` Vue watches, `reactive({...})` the same for an object. Code reads and writes them
directly; there is no setter call and no re-render of a whole function. `computed(() => ...)` is a
*derived* value: Vue records which reactive values the getter read (*automatic dependency
tracking*), caches the result, and recomputes only when one of those changes. For effects there are
two forms: `watch(source, cb)` runs `cb` when an explicit source changes; `watchEffect(fn)` runs
`fn` at once and again whenever anything it read changes. Either can register a cleanup with
`onWatcherCleanup(fn)` (Vue 3.5+; before that, an `onCleanup` argument), called before the next
run. https://vuejs.org/api/reactivity-core , https://vuejs.org/guide/essentials/computed

**The example.**

```ts
import { computed, onWatcherCleanup, ref, watch } from "vue";

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
const handedOverAt = ref<number | null>(null);
const lastReplyAt = ref<number | null>(null);
const approved = ref(false);

const nudgeAt = computed(() =>
  approved.value || handedOverAt.value === null
    ? null
    : Math.max(handedOverAt.value, lastReplyAt.value ?? 0) + TWO_DAYS,
);

watch(nudgeAt, (at) => {
  if (at === null) return;
  const id = setTimeout(postNudge, at - Date.now());
  onWatcherCleanup(() => clearTimeout(id));  // must be called before any await
}, { immediate: true });

// events: handedOverAt.value = t; lastReplyAt.value = t; approved.value = true
```

`nudgeAt` reads three refs, so it recomputes only when one of them changes; the watcher re-runs
only when the computed result changes, clearing the old timeout first.

**On a crash.** In memory, like React: refs and timers are gone on reload.

**awf would take** two things for [[reconciled-runs]]:

- *Declared state slots.* A ref is a typed, named value read and written through a handle. The
  durable version is a slot declared up front and typed by a schema, e.g.
  `state: { reminders: Type.Number({ default: 0 }) }`, read and set via `s.reminders`, stored by the
  engine rather than in the workflow's own files.
- *Derived values.* `wants(state)` is a `computed`: a pure function of slots, which the engine
  need only re-read when a slot it read changed (an optimisation; a pure `wants` read every pass is
  correct without it).

**Avoid** auto-tracked effects as the unit of work. A `watchEffect` has no name: it is identified
by where it was created. awf's effects are stages that run once per name and must find their
record again after a restart, so an effect needs a stable name built from state
(`nudge-{nudgeAt}`), which is what `watch`'s explicit source, or React's deps, gives.

## 4. Svelte 5 runes

**How a program is written.** Svelte is a compiler. In version 5, state is declared with *runes*,
compiler keywords: `let n = $state(0)` makes a reactive variable you assign to normally;
`const d = $derived(expr)` is a value recomputed when what it read changes; `$effect(fn)` runs
`fn` after the DOM updates and again when any reactive value it read *synchronously* changes. If
`fn` returns a function, that *teardown* runs before the next run and when the component is
destroyed. Unlike React there are no deps arrays and no re-running the whole component: each
`$state` is a *signal*, a value that knows who read it, so only the readers re-run.
https://svelte.dev/docs/svelte/$effect

**The example** (a component's `<script lang="ts">`):

```ts
const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
let handedOverAt = $state<number | null>(null);
let lastReplyAt = $state<number | null>(null);
let approved = $state(false);

const nudgeAt = $derived(
  approved || handedOverAt === null ? null : Math.max(handedOverAt, lastReplyAt ?? 0) + TWO_DAYS,
);

$effect(() => {
  if (nudgeAt === null) return;
  const id = setTimeout(postNudge, nudgeAt - Date.now());
  return () => clearTimeout(id);             // before the re-run, and on destroy
});
```

The effect read `nudgeAt` before returning, so it depends on it. Anything read after an `await` or
inside the `setTimeout` callback is not tracked.

**On a crash.** In memory: gone on reload.

**SolidJS** is the same model in plain JS functions: `createSignal`, `createMemo` (derived),
`createEffect`, and `onCleanup` inside an effect runs before it re-executes. It adds nothing new
here.

**awf would take** the same as from Vue, and one more argument for it: `$derived` over `$state` is
exactly `wants` over slots, written without a deps list. **Avoid** the same thing: an `$effect` is
identified by its place in the code, and its tracking silently drops reads after an `await`, which
is where awf's effects (agent turns, posts) spend their time. awf's effects need explicit names.

## 5. Erlang/OTP `gen_statem`

**How a program is written.** Erlang programs are many lightweight processes that share nothing
and talk by messages; each has a *mailbox*, a queue of messages waiting to be handled. `gen_statem`
is the standard library's state-machine process. The library owns the loop: it takes a message
from the mailbox and calls your callback with the event, the current *state* (a name like
`waiting`) and the *data* (everything else). The callback returns the next state, the next data,
and a list of *actions*, among them timeouts, which the library sets, restarts or cancels for you.
https://www.erlang.org/doc/system/statem.html

There are three kinds of timeout, each with its own lifetime:

| Kind | Action | Cancelled by |
| --- | --- | --- |
| event timeout | `{timeout, T, Msg}` | any event arriving (an idle timer) |
| state timeout | `{state_timeout, T, Msg}` | a change of state; setting it again restarts it |
| generic timeout | `{{timeout, Name}, T, Msg}` | nothing automatic; setting the same `Name` again restarts it; `{{timeout, Name}, cancel}` |

**The example.** A state timeout fits: it lives while the machine is `waiting`.

```erlang
-define(TWO_DAYS, 2 * 24 * 60 * 60 * 1000).

callback_mode() -> handle_event_function.

init(MR) -> {ok, idle, #{mr => MR}}.

handle_event(cast, handed_over, _State, Data) ->
    {next_state, waiting, Data, [{state_timeout, ?TWO_DAYS, nudge}]};
handle_event(cast, author_replied, waiting, Data) ->
    {keep_state, Data, [{state_timeout, ?TWO_DAYS, nudge}]};    % set again: restarts
handle_event(cast, approved, _State, Data) ->
    {next_state, done, Data};                                   % leaving `waiting` cancels it
handle_event(state_timeout, nudge, waiting, #{mr := MR} = Data) ->
    post_nudge(MR),
    {next_state, nudged, Data};
handle_event(cast, _Other, _State, _Data) ->
    keep_state_and_data.
```

With `{{timeout, nudge}, ?TWO_DAYS, nudge}` instead, the timer is named and survives state
changes; approval would then return `{{timeout, nudge}, cancel}`. Either way the library owns the
timer, so a restarted or cancelled one never delivers its old message.

**On a crash.** All in memory. The supervisor restarts the process from `init`; the state, the
data and the timer are gone unless the code stored them and re-reads them in `init`.

**awf would take** the three lifetimes (per event, per state, named), the verbs (set by name moves
it, `cancel`), and "the engine owns the timer, so a moved one never delivers". **Avoid** nothing in
particular; it simply says nothing about durability, which awf must add.

## 6. XState v5

**How a program is written.** XState models a program as a *statechart*: named states, and for
each state the events it accepts and where each goes. Extra data lives in `context`, changed only
by `assign` actions. A machine runs as an *actor*: an object with its own state that you `send`
events to, one at a time. A state can declare `after: { {delay}: target }`, a transition taken if
nothing else leaves the state first ("timers are canceled when the state is exited"), and `invoke`,
a child actor (a promise, another machine) that starts on entering the state and stops on leaving.
XState runs the effects (actions) itself. https://stately.ai/docs/delayed-transitions

**The example.** A delay can be a function of `context`, so it is computed from a stored time;
`reenter: true` leaves and re-enters `waiting`, which restarts its `after` timer.

```ts
import { assign, setup } from "xstate";

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

const nudger = setup({
  types: {
    context: {} as { nudgeAt: number },
    events: {} as { type: "handover" | "reply" | "approved"; at: number },
  },
  actions: {
    putOff: assign({ nudgeAt: ({ event }) => event.at + TWO_DAYS }),
    nudge: () => postNudge(),
  },
  delays: { untilNudge: ({ context }) => Math.max(0, context.nudgeAt - Date.now()) },
}).createMachine({
  context: { nudgeAt: 0 },
  initial: "idle",
  states: {
    idle: { on: { handover: { target: "waiting", actions: "putOff" } } },
    waiting: {
      after: { untilNudge: { target: "nudged", actions: "nudge" } },
      on: {
        reply: { target: "waiting", reenter: true, actions: "putOff" },
        approved: "done",
      },
    },
    nudged: { on: { reply: { target: "waiting", actions: "putOff" }, approved: "done" } },
    done: { type: "final" },
  },
});
```

**On a crash.** Persisting is the application's job: `actor.getPersistedSnapshot()` gives JSON
(deep: child actors included), `createActor(machine, { snapshot })` restores it. On restore,
"actions ... will not be re-executed ... However, invocations will be restarted."
https://stately.ai/docs/persistence . The docs don't promise that a pending `after` resumes; with
the delay computed from `context.nudgeAt`, re-entering `waiting` arms it correctly.

**awf would take** work and timers whose life is a state's (leave the phase, the timer and the turn
go), and "on restore, restart what the state says is running". **Avoid** a snapshot format that
names the code's state paths with no version field: change the machine and old snapshots need a
hand-written migration.

## 7. Akka Typed: timers and `EventSourcedBehavior`

**How a program is written.** Akka (Scala and Java) is built on *actors*: objects that own their
state and handle one message at a time from a mailbox, defined as a `Behavior`. Timers come from
`Behaviors.withTimers`: `timers.startSingleTimer(key, msg, delay)` sends `msg` to the actor itself
later; "if a new timer with the same key is started, the previous is cancelled", and a message from
the old one is guaranteed not to arrive "even if it was already enqueued". Timers are in memory and
cancelled when the actor stops or restarts.
https://doc.akka.io/libraries/akka-core/current/typed/interaction-patterns.html

For durable state, `EventSourcedBehavior` uses *event sourcing*: state is never stored directly.
A `commandHandler(state, command)` decides, and returns `Effect.persist(event)` to append an event
to a *journal* (a durable append-only log) and `.thenRun(...)` for side effects after the write. A
pure `eventHandler(state, event)` folds events into state; on restart Akka replays the journal
through it. https://doc.akka.io/libraries/akka-core/current/typed/persistence.html

**The example.**

```scala
def nudger(mr: String): Behavior[Command] =
  Behaviors.withTimers { timers =>
    def arm(at: Instant): Unit =
      timers.startSingleTimer(NudgeKey, Nudge, (at.toEpochMilli - System.currentTimeMillis()).max(0).millis)

    EventSourcedBehavior[Command, Event, State](
      persistenceId = PersistenceId.ofUniqueId(mr),
      emptyState = State(nudgeAt = None),
      commandHandler = (state, cmd) => cmd match {
        case HandedOver                            => putOff(Instant.now())
        case Replied if state.nudgeAt.isDefined    => putOff(Instant.now())
        case Approved => Effect.persist(Closed).thenRun(_ => timers.cancel(NudgeKey))
        case Nudge    => Effect.persist(Nudged).thenRun(_ => postNudge(mr))
        case _        => Effect.none
      },
      eventHandler = (state, evt) => evt match {
        case NudgeSet(at)     => state.copy(nudgeAt = Some(at))
        case Nudged | Closed  => state.copy(nudgeAt = None)
      },
    ).receiveSignal { case (state, RecoveryCompleted) => state.nudgeAt.foreach(arm) }
  }
// putOff(now) = { val at = now.plus(2, ChronoUnit.DAYS); Effect.persist(NudgeSet(at)).thenRun(_ => arm(at)) }
```

**On a crash.** The journal replays `NudgeSet` into `nudgeAt`, and `RecoveryCompleted` re-arms the
timer; without that line the nudge is lost, because timers aren't persisted. `thenRun` is not
re-run on recovery: a crash after `Nudged` is written but before the post means no nudge (at most
once). The mailbox isn't durable, so a command in flight is lost; there is no ack to commit.

**awf would take** keyed timers where setting the key again replaces and a stale one never
arrives, and "persist the decision, then do the effect". **Avoid** effects that run once after the
persist with nothing to retry them, and timers that vanish on restart unless code re-arms them.

## 8. Restate: virtual objects

**How a program is written.** Restate is a server that sits in front of your TypeScript handlers
and makes their execution durable. A *virtual object* is a set of handlers keyed by an id (here an
MR); each call to a handler is an *invocation*. Restate runs one exclusive handler per key at a
time, so there are no races on that key's state, which is a key/value store read with
`ctx.get`/`ctx.set`. Restate records every step of an invocation in a *journal*: state writes,
results of `ctx.run(...)` effects, calls and timers. If the handler crashes, Restate calls it again
and replays the journal so finished steps return their recorded results instead of running again.
https://docs.restate.dev/foundations/key-concepts

**The example.** `ctx.sleep` inside the exclusive handler would block every other call for that MR
for two days, so the idiom is a *delayed call* to the object's own `nudge` handler, whose
invocation id is kept in state so it can be cancelled.

```ts
import * as restate from "@restatedev/restate-sdk";

type Mr = typeof mr;

async function cancelNudge(ctx: restate.ObjectContext) {
  const id = await ctx.get<restate.InvocationId>("nudge");
  if (id) ctx.cancel(id);
  ctx.clear("nudge");
}

async function putOff(ctx: restate.ObjectContext) {
  await cancelNudge(ctx);
  const call = ctx.objectSendClient<Mr>({ name: "mr" }, ctx.key)
    .nudge(undefined, restate.rpc.sendOpts({ delay: { hours: 48 } }));
  ctx.set("nudge", await call.invocationId);
}

export const mr = restate.object({
  name: "mr",
  handlers: {
    handedOver: async (ctx: restate.ObjectContext) => putOff(ctx),
    replied: async (ctx: restate.ObjectContext) => { if (await ctx.get("nudge")) await putOff(ctx); },
    approved: async (ctx: restate.ObjectContext) => cancelNudge(ctx),
    nudge: async (ctx: restate.ObjectContext) => {
      ctx.clear("nudge");
      await ctx.run("post", () => postNudge(ctx.key));
    },
  },
});
```

https://docs.restate.dev/develop/ts/service-communication (delayed messages, cancel)

**On a crash.** A handler that dies is retried; its journal replays, so the cancel, the new
delayed call and the stored id each happen once. State writes, effect results and "this
invocation is done" are all in Restate's log, so they can't disagree. The delayed call is held by
Restate, not the process.

**awf would take** "a message's state writes commit with its completion", and "don't await long
work in the single-writer handler: start it, keep its id, get its result as a message" (a
20-minute agent turn is a separate invocation). **Avoid** keeping invocation ids in state to cancel
and resend a moved timer by hand: that is the bookkeeping 037 Q1 wants gone.

## 9. Temporal (TypeScript SDK)

**How a program is written.** A Temporal *workflow* is an ordinary async function whose local
variables are its state. The Temporal server records every step in an *event history*; when a
worker restarts, the SDK runs the function again from the top and *replays* the history, so the
code must be deterministic (same inputs, same steps; `Date.now()` and timers are supplied by the
SDK). Effects are *activities*: functions run outside the workflow and retried until they succeed.
Messages arrive as *signals*, handled by `setHandler` callbacks that change variables. A workflow
waits with `sleep(ms)` (a durable server-side timer) or `condition(fn, timeout)`, which resolves
when `fn()` becomes true, re-checked after every batch of signals, or returns `false` when the
timeout expires. https://docs.temporal.io/develop/typescript

**The example.** One workflow per handover:

```ts
import { condition, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "./activities";

const { postNudge } = proxyActivities<typeof activities>({ startToCloseTimeout: "1 minute" });
export const replied = defineSignal("replied");
export const approved = defineSignal("approved");
const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

export async function nudgeAfterHandover(mr: string): Promise<void> {
  let nudgeAt = Date.now() + TWO_DAYS;
  let done = false;
  setHandler(replied, () => { nudgeAt = Date.now() + TWO_DAYS; });
  setHandler(approved, () => { done = true; });

  while (!done) {
    const seen = nudgeAt;
    const changed = await condition(() => done || nudgeAt !== seen, Math.max(0, nudgeAt - Date.now()));
    if (!changed) {
      await postNudge(mr);
      await condition(() => done || nudgeAt !== seen);    // nudged once; wait for news
    }
  }
}
```

The timeout is relative to the call, so the loop computes it from the absolute `nudgeAt` each
pass; a fixed `condition(fn, "2 days")` in a loop would restart its two days on every signal.

**On a crash.** A new worker replays the history: same variables, same pending timer (the server
owns it). Completing a workflow step appends the signals it consumed and the commands it issued
together, atomically. Activities are at least once: `postNudge` must be idempotent.

**awf would take** predicates over state re-checked after every event, and absolute times stored
in state. **Avoid** relative timeouts in a re-read wait, and full replay with its determinism rules
and versioning (`patched()`); awf already re-runs from files with stages run once by name.

## 10. Cloudflare Durable Objects and the Agents SDK

**How a program is written.** A *Durable Object* is a JavaScript class instance with one id, its
own storage, and one thread: calls to it are handled one at a time. Code calls `this.ctx.storage`
to `put`/`get` state. Each object has one *alarm*: `storage.setAlarm(ms)` schedules the object's
`alarm()` method, a later `setAlarm` overwrites it, `deleteAlarm()` removes it, and `alarm()` is
retried with backoff if it throws. Writes made without awaiting other I/O in between are committed
together, alarm included, and replies wait for that commit.
https://developers.cloudflare.com/durable-objects/api/alarms/ ,
https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/

**The example.**

```ts
import { DurableObject } from "cloudflare:workers";

const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

export class MergeRequest extends DurableObject {
  async handedOver() { this.putOff(); }
  async replied() { if (await this.ctx.storage.get("nudgeAt")) this.putOff(); }
  async approved() {
    this.ctx.storage.delete("nudgeAt");
    this.ctx.storage.deleteAlarm();
  }
  private putOff() {
    const at = Date.now() + TWO_DAYS;
    this.ctx.storage.put("nudgeAt", at);     // committed together with the alarm
    this.ctx.storage.setAlarm(at);           // overwrites the one alarm
  }
  async alarm() {
    const at = await this.ctx.storage.get<number>("nudgeAt");
    if (!at || at > Date.now()) return;
    await postNudge(this.ctx.id.toString());
    await this.ctx.storage.delete("nudgeAt");
  }
}
```

One alarm per object means several timers share it: store each due time, set the alarm to the
earliest, and in `alarm()` handle whatever is due.

**The Agents SDK** is a class on top (`class Mr extends Agent<Env, State>`). `this.setState(s)`
persists state to the object's SQLite and syncs it to connected clients. `this.schedule(when,
"callback", payload)` (`when` is seconds, a `Date` or a cron string) stores a row and returns a
`Schedule` with an `id`; `cancelSchedule(id)` removes it; `listSchedules()` lists them. Schedules
share the object's alarm, survive restarts, and a callback that throws is retried. Moving the nudge
is `cancelSchedule(state.nudgeId)`, then `schedule(...)` and store the new id. An `idempotent`
option returns an existing schedule with the same callback, timing and payload instead of adding a
row; it is on by default for cron and interval schedules, which are typically set in `onStart`,
which runs on every restart. https://developers.cloudflare.com/agents/runtime/capabilities/scheduler/

**On a crash.** `nudgeAt` and the alarm were committed together, so they agree; the alarm fires
after a restart and `alarm()` runs again if it failed, so the post must tolerate a repeat. There is
no separate input queue: an RPC call that didn't return is the caller's to retry.

**awf would take** one wake time, the earliest of many keyed due times (a parked run plus
`awf tick` already is this), and the time committed with the state. **Avoid** id-returning
schedules that code must cancel by id, or re-creates on every start and then needs an `idempotent`
flag to undo.

## 11. Orleans reminders and Durable Functions entities

**Orleans** (.NET) has *grains*: virtual actors, one per id, activated on demand. Timers are per
activation and in memory. *Reminders* are durable and keyed by name:
`RegisterOrUpdateReminder(name, dueTime, period)` creates or moves one, `UnregisterReminder`
removes it, and the grain's `ReceiveReminder(name, status)` is called when it fires. They are
periodic, so a one-shot nudge unregisters itself on the first tick:

```csharp
public Task HandedOver() => this.RegisterOrUpdateReminder("nudge", TimeSpan.FromDays(2), TimeSpan.FromDays(2));
public async Task Replied() { if (await this.GetReminder("nudge") is not null) await HandedOver(); }
public async Task Approved() { if (await this.GetReminder("nudge") is { } r) await this.UnregisterReminder(r); }
public async Task ReceiveReminder(string name, TickStatus status) {
    await this.UnregisterReminder(await this.GetReminder(name));
    await PostNudge();
}
```

Only the reminder's definition is stored, so a tick due while the cluster is down is skipped, and
grain state is written separately (`WriteStateAsync`), not with the reminder.
https://learn.microsoft.com/en-us/dotnet/orleans/grains/timers-and-reminders

**Durable Functions entities** are small objects whose operations run one at a time, with state
persisted after each operation. A signal to an entity can be scheduled for later
(`SignalEntityOptions { SignalTime = at }`), but a scheduled signal can't be withdrawn: the entity
stores `nudgeAt`, and the `nudge` operation does nothing if it arrives and `nudgeAt` has moved.
https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-entities

**awf would take** Orleans' "register or update by name". **Avoid** a timer persisted apart from
the state, and scheduled messages that can't be withdrawn, which push a staleness check into code.

## 12. Inngest debounce

Inngest runs TypeScript functions triggered by events, with durable `step.run` effects. Its
`debounce` option is a moving timer as configuration: each matching event restarts the `period`,
per `key`, and the function runs once with the last event; `timeout` caps how long it can be put
off. `cancelOn` cancels a run when another event matches.

```ts
inngest.createFunction(
  {
    id: "nudge-author",
    triggers: [{ event: "mr/handed-over" }, { event: "mr/author-replied" }],
    debounce: { key: "event.data.mr", period: "2d", timeout: "7d" },
    cancelOn: [{ event: "mr/approved", match: "data.mr" }],
  },
  async ({ event, step }) => { await step.run("nudge", () => postNudge(event.data.mr)); },
);
```

This is close, not exact: a reply with no handover pending would start a nudge, and whether
`cancelOn` withdraws a pending debounce (rather than a running function) is not stated in the
docs; the function should check approval before posting.
https://www.inngest.com/docs/guides/debounce ,
https://www.inngest.com/docs/reference/typescript/functions/cancel-on

**awf would take** the cap: any timer that activity puts off needs a latest time, or it can be put
off forever.

---

## 13. Zustand

**How a program is written.** Zustand is a small state library for JavaScript apps. A *store* is one
object holding the state and the functions that change it, its *actions*; an action calls
`set(partial)` to merge a change. There is no loop and no reconciling: anyone can read the state
(`getState()`) or `subscribe` to it, optionally to a slice of it (`subscribeWithSelector`). Features
come as middleware; `persist` saves the state to storage with a `version`, and on load a
`migrate(persisted, version)` turns an older saved state into the current one; `partialize` picks
which fields are saved. `createStore` from `zustand/vanilla` works outside React.
https://github.com/pmndrs/zustand/blob/main/docs/reference/middlewares/persist.md

**The example.**

```ts
import { createStore } from "zustand/vanilla";
import { persist, subscribeWithSelector } from "zustand/middleware";

type Mr = { nudgeAt: number | null; handedOver(): void; replied(): void; approved(): void };

const mr = createStore<Mr>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        nudgeAt: null,
        handedOver: () => set({ nudgeAt: Date.now() + 2 * DAY }),
        replied:    () => set({ nudgeAt: Date.now() + 2 * DAY }),
        approved:   () => set({ nudgeAt: null }),
      }),
      { name: "mr-42", version: 1, migrate: (old, version) => old },
    ),
  ),
);

let timer: ReturnType<typeof setTimeout> | undefined;
mr.subscribe((s) => s.nudgeAt, (at) => {            // keep one timer in step, by hand
  clearTimeout(timer);
  if (at !== null) timer = setTimeout(sendNudge, at - Date.now());
}, { fireImmediately: true });
```

**On a crash.** The state survives: `persist` wrote it on every `set`, and `migrate` upgrades it
on load. The timer doesn't; it lived in the subscriber, and `fireImmediately` sets it again from the
saved `nudgeAt`. Nothing ties a save to the message that caused it, so a crash between a save and
the work after it is the app's problem.

**For awf.** Take: actions beside the state, so every change has a name and one place; one `version`
and a `migrate` for the saved state. Avoid: a save on every `set`, apart from the ack (awf saves
once per pass, with the acks), and timers kept by hand in subscribers.

---

## Synthesis

### Three patterns

1. **Times derived from state, compared by key.** Code says what it wants given the state; the
   runtime compares with what is running and starts, moves or stops the difference. Elm
   `subscriptions`, React `useEffect` deps, Vue `computed` plus `watch`, Svelte `$derived` plus
   `$effect`, Temporal `condition` re-checked each pass. Moving the nudge is changing a field.
2. **Timers set by key, where setting again replaces.** gen_statem `{timeout, Name}`, Akka
   `startSingleTimer(key)`, Orleans `RegisterOrUpdateReminder`, a Durable Object's single alarm.
   Where the runtime owns the timer (gen_statem, Akka), a replaced one never delivers.
3. **Timeouts tied to a state.** gen_statem `state_timeout`, XState `after` and `invoke`, a React
   effect's cleanup on unmount: leave the state and the timer goes.

They are one idea at three heights: (1) is (2) with the runtime computing the set and cancel, and
(3) is (1) with the state's name in the key. [[reconciled-runs]] takes (1), with absolute `Date`s
so re-reading can't restart a time, and the engine owning the timer as in (2).

### Compared

| | Who holds state | How the nudge moves | What survives a crash | State and ack commit together |
| --- | --- | --- | --- | --- |
| Elm | the runtime (model) | change `nudgeAt`; subscriptions follow | nothing | n/a, in memory |
| React | React (`useState`) | deps change: cleanup, then setup | nothing | n/a |
| Vue 3 | reactive refs | a `computed` changes; the watcher cleans up and re-runs | nothing | n/a |
| Svelte 5 | `$state` signals | a `$derived` changes; `$effect` tears down and re-runs | nothing | n/a |
| gen_statem | the library (state + data) | return the timeout again; same name restarts | nothing, unless code stores it | n/a |
| XState | the actor (`context`) | `reenter` restarts `after` | a snapshot, if the app saves one; invocations restart | no, persistence is the app's |
| Akka Typed | the journal (events) | `startSingleTimer` with the same key | state by replay; timers only if re-armed | state yes; no durable input to ack |
| Restate | Restate's K/V, per key | cancel the stored invocation id, send a new delayed call | state, journal, delayed calls | yes, one log |
| Temporal | local variables, by replay | re-enter `condition` with a new timeout | everything in the history | yes, per workflow step |
| Durable Objects | object storage | `setAlarm` overwrites | state and alarm | state and alarm yes; input is the caller's |
| Orleans | grain state | `RegisterOrUpdateReminder` same name | reminder definitions; state if written | no, separate writes |
| Durable entities | entity state | can't; a stale signal is ignored on arrival | state per operation | yes, per operation |
| Inngest | Inngest | each event restarts the debounce | the pending run | yes, Inngest's |

### What awf avoids, from all of them

- A later value silently ignored (React `useState`, awf's first-call-wins `timer`).
- Identity by call order or code position (hooks, auto-tracked effects): effects need explicit
  names, built from state.
- Relative timeouts in a re-read wait, which restart every pass.
- Scheduled messages that can't be withdrawn, which force a counter or staleness check into code.
- Timers that vanish on restart, and effects run at most once after a persist.
- Long work inside the single-writer step.
- A persisted state with no version field.
- A put-off with no cap.
