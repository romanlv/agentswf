
Status: **set aside** (2026-10-31), nothing built. It grew out of [[037-workflow-timers]] Q1 and
answered it with a wider idea: a run written as `on`, `act` and `wants`, the engine owning the loop.
Ported to review-loop3, it asked too much of an author: four handlers in place of one loop, to-do
flags in the state for effects owed, and an `act` that can't see the events behind them.

Chosen instead, keeping today's loop:

- **A time that moves** is a `select` branch read from state, `workflow.at(() => Date | null)`:
  the engine arms, moves or drops the branch's timer to match, and fires once per time. Decided in
  037 Q1; this doc's level 1, as a source rather than a `Date` in a function.
- **State the engine saves** is a named handle, `workflow.state(name, initial)`, saved with the
  acks, its times plugged in as `handle.at(selector)`: [[workflow-state]], for later.
- **Work running while events arrive**, this doc's level 2, waits for a workflow that needs it.

Kept for its reasoning and the hazards it found, which the two above inherit. Reviewed twice, against
the engine and by porting workflows to it ([Review](#review)). The frameworks it borrows from, each
with the same example: [[timers-waits-and-state]].

## A nudge that won't sit still

review-loop3 reviews an MR, signs it off, and hands it to the engineer. If nothing happens in two
days, it nudges them. Simple, until the engineer replies: now the nudge should wait two days from
the reply. Then they push, and the MR isn't theirs to act on at all. Then they approve, and there
should be no nudge ever again.

The logic fits in a sentence: *the nudge is due two days after the last thing the engineer did,
unless it's not their turn.* The code doesn't fit in a sentence. awf's timers can't move, so every
change of plan makes a new one:

```ts
workflow.timer(`nudge-${view.nudgeTimers}`, new Date(view.nextNudge));  // a new name for every move
…
for await (const next of workflow.select({ …, timer: workflow.timers() })) {  // catch them all: a select's branches are fixed at the start
  if (next.timer?.name.startsWith("nudge-")) {
    if (next.timer.name !== `nudge-${view.nudgeTimers}`) return;          // an old one: still fires, ignored
    …
  }
}
```

The ledger carries a counter, `nudgeTimers`, that exists only to make the next name. Every old
timer still fires and is thrown away by comparing names. A catch-all branch takes them all, because
the branches were fixed before the timers existed. And if the process crashes after a nudge is
sent but before the loop moves on, the event comes back, and only that counter, by accident, stops
a second nudge.

That is the timer. Look around and the same thing happens twice more:

- **Turns.** dd-case starts its investigator when `!investigator.turn && !kase.retrying(now) &&
  needsTurn(kase)`, and cancels it by hand on a close. Whether a turn *should* run is a fact about
  the case. Whether one *is* running is the engine's. The code spends its time keeping the two in
  step.
- **Saving.** A handler writes the ledger; the event is acknowledged only later, when the loop asks
  for the next one. A crash in between hands the event back with its effect already in the ledger,
  and review-loop3 counts one failure twice.

Here is the thing: every one of these workflows already *thinks* the right way. Each takes an event,
writes it into its state, asks a pure function what to do (`nextStep`, `needsTurn`, `nextAsk`), and
does it. Only the timers, the turns and the saving are done by hand. Those are exactly the parts
where the bookkeeping is.

## UI frameworks solved this already

A screen has the same problem. The data changes, and the screen should follow: rows appear and
disappear, a spinner shows while something loads, a toast vanishes after three seconds. Early UI
code did it all by hand, and drowned in it. The frameworks that won all stopped doing it by hand.

**Elm** made a program three functions and took the loop away:

- `init` makes the first state, the *model*;
- `update(msg, model)` takes one message, a click, a reply, a tick, and returns the next model;
- `subscriptions(model)` says what the program listens to *while the model is what it is*: "a
  tick every second while the clock runs", nothing when it's stopped.

The runtime holds the model. A message arrives, it calls `update`, then asks `subscriptions` again
and starts or stops whatever changed. The program never starts or stops a timer. It changes the
model, and the timers follow.

**React** made "follows" precise. A component returns what *should* be on the screen. React compares
that with what *is*, matched by `key`: a new key is added, a missing key is removed, a kept key is
left alone. Several changes in a row are batched and compared once.

**Vue and Svelte** fixed two of React's sharp edges. A React hook is found by its position among
the calls, so a hook inside an `if` breaks; and `useState(initial)` uses `initial` only the first
time, so a line can't tell you whether it makes a value or reads one. Vue's `ref()` and Svelte's
`$state` are declared values with names. And a derived value (`computed`, `$derived`) knows what it
read, so it is worked out again only when that changes.

Put a workflow run next to a screen and the mapping is direct. Events are the messages. The ledger
is the model. Times, turns and the sources the run listens to are what's on the screen.

## The idea

A run in this shape is written as three functions, and the engine owns the loop:

```ts
on(next, s)   { if (next.reply) s.nextNudge = w.after("2d"); }   // fold an event into the state
async act(s)  { await advance(s); }                               // do what the state asks for
wants(s)      { return { nudge: s.theirTurn ? s.nextNudge : null }; }   // what the run wants, now
```

- **`on`** is Elm's `update`. It takes one event and writes it into the state. Nothing else: no
  I/O, no waiting.
- **`act`** does the effects the state now asks for, as stages: post the findings, sign off.
- **`wants`** is Elm's `subscriptions`. From the state alone, it says which times the run waits for,
  which sources it listens to, and what work should be running, each under a key.

The engine compares what `wants` returns with what it has armed and running, and changes only the
difference, as React does. `nudge` had one time and now has another: the timer moves, and the old
time can never fire. `nudge` is `null` now: the timer is gone. A turn's key appeared: it starts. Its
key changed: the old one is cancelled.

Go back to the nudge. *Due two days after the last thing the engineer did, unless it's not their
turn.* That is now the code: a line in `on` and a line in `wants`. No names, no counter, no
catch-all, no stale check.

One pass of the loop:

```
          ┌──────────────────────────────────────────────────────────────────┐
          ▼                                                                  │
   take every ready event                                                    │
          │                                                                  │
          ▼                                                                  │
   on(next, s)        each event in turn: fold it into the state             │
          │                                                                  │
          ▼                                                                  │
   act(s)             once: the effects the state now asks for, as stages    │
          │           then save the state, the acks and any ending together  │
          ▼                                                                  │
   wants(s)           { key: Date | source | work | null }                   │
          │                                                                  │
          ▼                                                                  │
   reconcile by key   a time armed, moved or withdrawn                       │
                      work started, left running, or cancelled               │
          │                                                                  │
          ▼                                                                  │
   anything ready? ── yes ───────────────────────────────────────────────────┘
          │ no
          ▼
   park until the earliest time
```

Events are folded one at a time, but `act` and the comparing run once for all of them, as React
batches. If `[changes, closed]` arrive together, `act` sees the close before it posts anything for
the changes, and no turn is started for the first event only to be killed by the second.

**Workflows without events don't change.** Most workflows are a sequence: open agents, run turns,
stage results, perhaps `sleep` or `race`, return. That stays `run`, and reads best that way. This is
a second shape, for runs that live on events and are a `receive` or `select` loop today. One part
reaches sequences too: the state below.

## A walk through a whole workflow

Something small that is miserable to write today. A babysitter for one PR:

- review comments are batched until ten minutes pass without a new one, but never more than an
  hour after the first; then a fixer agent takes the batch;
- a push by the author cancels a running fix, since its comments may be stale;
- three days with no activity pings the author, then once a day, five times at most.

Today that's a timer name per comment and per ping, a counter for each, a "is this the latest?"
check on every firing, a catch-all branch, a flag for the running turn, and a `cancel()` on push.

**The state** is declared like events: named slots, each with a type and a starting value.

```ts
export default defineWorkflow({
  meta: { name: "pr-babysitter", description: "Fix review comments in batches; ping when idle." },
  events: { "pr.comment": Comment, "pr.push": Push, "pr.closed": Closed },
  starts: ["pr.comment"],
  // %% does it (state type) have to be a Typebox? why not simple typescript type? 
  state: {
    slots: {
      pending:  Type.Array(Comment, { default: [] }),                // comments no fix has taken
      first:    Type.Union([Time, Type.Null()], { default: null }),
      settleAt: Type.Union([Time, Type.Null()], { default: null }),  // when the batch is ready
      fixing:   Type.Union([Fix, Type.Null()], { default: null }),   // the fix that should be running
      fixes:    Type.Number({ default: 0 }),
      idleAt:   Type.Union([Time, Type.Null()], { default: null }),  // when to ping
      pingDue:  Type.Union([Time, Type.Null()], { default: null }),
      pings:    Type.Number({ default: 0 }),
    },
    version: 1,
  },
  async setup(w) {
    return { author: await w.participants.connect({ key: "author", to: "code" }) };
  },
```

**`on`** reads like the spec. Notice there is no timer in it, only times written into the state.

```ts
  on(next, s, { w }) {
    if (!next.idle) { s.idleAt = w.after("3d"); s.pings = 0; }      // any activity puts the ping off
    if (next.comment) {
      s.pending.push(next.comment.data);
      s.first ??= w.now();
      s.settleAt = earliest(w.after("10m"), plus(s.first, "1h"));   // each comment moves it; capped
    }
    if (next.push && next.push.data.by !== "fixer") s.fixing = null; // stale fix: let it go
    if (next.settle && !s.fixing) {                                   // the batch is ready
      s.fixing = { n: ++s.fixes, comments: s.pending };
      s.pending = []; s.first = null; s.settleAt = null;
    }
    if (next.fix && s.fixing?.n === next.fix.meta.n) s.fixing = null; // the fix ended
    if (next.idle) s.pingDue = next.idle.at;
    if (next.closed) return w.done({ fixes: s.fixes });
  },
```

**`act`** does the one effect this workflow has, the ping. It is a stage, named by the time it is for,
so a restart finds it and doesn't ping twice.

```ts
  async act(s, { w, author }) {
    if (s.pingDue) {
      await w.stage(`ping@${s.pingDue.toISOString()}`, () => author.post(PING));
      s.pingDue = null; s.idleAt = w.after("1d"); s.pings++;
    }
  },
```

**`wants`** is where it all lands. Three keys, three facts about the state:

```ts
  wants(s, { w }) {
    return {
      settle: s.fixing ? null : s.settleAt,                    // hold the batch while a fix runs
      idle: s.pings >= 5 ? null : s.idleAt,
      fix: s.fixing
        ? w.agents.turn("fixer", { key: `fix-${s.fixing.n}`, prompt: fixPrompt(s.fixing), meta: s.fixing })
        : null,
    };
  },
});
```

Follow a push through it. `on` sets `s.fixing = null`. `wants` no longer returns a `fix`. The
engine sees the key `fix-3` gone and cancels the turn. Nobody called `cancel()`; the state said
there should be no fix, and the engine made it so. The same for the debounce: each comment moves
`settleAt`, the engine moves the timer, and the old time never fires.

## State you can keep

That `state` block deserves a second look, because it is the `useState` this engine never had.

Today, anything a run must remember across a restart lives in a file the workflow writes itself
(review-loop3's ledger, dd-case's case folder) or is squeezed out of stage names. A slot is that
memory, given by the engine: named, typed by its schema, kept in the run.

It is also the other half of a stage. Both are a named, typed value kept in the run. A stage's value
is made once, by an effect, and never changes. A slot's value is set by the code, as often as it
likes. They meet in one assignment: `s.posted[f.id] = await w.stage(…)`.

**Actions beside the state.** The state can declare the only ways it changes, as named functions
next to its slots, the way a Zustand store holds its state and its actions together:

```ts
state: {
  slots: {
    nudgeAt:  Type.Union([Time, Type.Null()], { default: null }),
    approved: Type.Boolean({ default: false }),
  },
  actions: {
    handedOver: (s, at: Date) => { s.nudgeAt = plus(at, "2d"); },
    replied:    (s, at: Date) => { s.nudgeAt = plus(at, "2d"); },   // the reason a nudge moves, named
    approved:   (s) => { s.approved = true; s.nudgeAt = null; },
  },
  version: 1,
},
```

`on` then only routes events to actions:

```ts
on(next, s) {
  if (next.handover) s.handedOver(next.handover.at);
  if (next.reply)    s.replied(next.reply.at);
  if (next.approved) s.approved();
}
```

The why of every change has one name and one place, which is what 037 asked for when it turned
down times "computed at the wait, not where their reason is". An action gets the time it needs as
an argument and reads no clock, so a test calls `s.replied(t)` and checks `s.nudgeAt`, with no run.
And it is the shape review-loop3's ledger already has (`saw`, `approved`, `nudgePutOff`): the ledger
is a store with actions, kept in a file. The babysitter above writes its slots straight from `on`;
with actions, its `on` becomes a list of `s.commented(…)`, `s.pushed(…)`, `s.settled()`.

Slots aren't only for event runs. approval-reminders, a sequence, counts its reminders:

```ts
async run(workflow) {
  const s = workflow.state;                                   // the same declared slots
  for (;;) {
    const next = await workflow.race(`answer-${s.reminders}`, {
      reply: thread,
      remind: workflow.timer(`remind-${s.reminders}`, "2d"),
    });
    if (next.reply) return decide(next.reply);
    await workflow.stage(`remind-${s.reminders}`, () => thread.post(REMINDER));
    s.reminders += 1;                                         // saved at the next wait or stage
  }
}
```

**When a slot is saved.** In an event run, with the pass, in the same write as the acks. In a
sequence, at the next point the engine records anyway, a stage's end or a wait. A crash in between
loses the set, and the code before it runs again from the last record, as today.

**Where it lives, and how it changes shape.** The whole state is one JSON file per save, with one
`version` for all of it, as Zustand's `persist` keeps it. When the code's `version` is newer than
the saved one, `migrate(saved, fromVersion)` turns the old state into the new, once, before the run
goes on:

```ts
state: {
  slots: { …, lastActivity: Type.Union([Time, Type.Null()], { default: null }) },
  version: 2,
  migrate: (saved, from) => (from === 1 ? { ...saved, lastActivity: saved.handedOverAt } : saved),
},
```

A state that `migrate` can't read, or one whose schema still doesn't fit after it, stops the run
with the command to go on, as a stage record that no longer fits does (ADR 0011). A slot added with
a default needs no migration; renaming or reshaping one does. Derived values aren't saved at all:
they are worked out again, in `wants` or an action, from what is.

**What it reverses.** Two rules give way for the workflow's own data: "files, git and forges hold
state" (034) and "nothing stored that can be read off the files" (ADR 0011). The world still lives
in files and forges; what the run *knows* about the world moves into the run. That needs an ADR.

## Getting there in three steps

Each step is worth having alone, and each publishes more than the one before.

**Level 1: times read from state, in today's `select`.** `select` takes a function, called again at
every wait, and a branch may be a `Date` or `null`. review-loop3 keeps its ledger and its loop; the
counter, the name check, the catch-all and both `*Timer()` functions go, about twenty lines. This
closes 037 Q1.

```ts
for await (const next of workflow.select(() => {
  const v = run.ledger.view();
  return { …signals, reply: run.engineer, nudge: v.closed ? null : v.nextNudge, retry: v.retryAt };
})) {
  if (next.nudge) await nudge(run, next.nudge.at);    // fires only for the time read last
  …
}
run.ledger.nudgePutOff(workflow.after("3h"));          // moving the nudge is writing the ledger
```

**Level 2: work read from state.** A turn becomes a branch value, keyed. dd-case loses its turn flag,
its `start` and its `cancel()`:

```ts
turn: needsTurn(kase)
  ? investigator.turn({ key: `turn-${kase.turnsGiven()}`, prompt: promptFor(kase), meta: kase.pending() })
  : null,
retry: kase.retryAt(),
```

The key is where the code says what a change *means*. A triage close bumps `turnsGiven`: new key,
the running turn is cancelled, the close write-up starts after it. A close the turn sends itself,
through its tool, leaves the key alone, and the turn finishes. review-loop3 lets a review finish when
a push comes, so its key is the pass, `pass-{n}`; a workflow that wants a push to cut it short keys
it by the head.

review-loop3's review isn't one turn, though: it's a part that may run several agents. So level 2
also needs keyed **work**, `workflow.work({ key, run })`, an async function the engine starts, keeps
and cancels by key (Q5). dd-case can take level 2 without it; review-loop3 can't.

**Level 3: the engine keeps the state, as slots, and saves it with the acks.** The babysitter above.
A pass's slots, the acks of its events, and the run's ending go in one write: after a crash, all of
them happened or none did. No event comes back with its effect already saved.

## What can go wrong

The shape is simple; the corners are where it earns its keep. Each of these was found by the
reviews or by a framework that hit it first.

**The time that never comes.** `wants` is called at every pass. Put `"3h"` there and it means three
hours from *each call*, so it never arrives; Temporal's `condition(fn, timeout)` in a loop does
exactly this. So a time in `wants` is a `Date`, and a duration becomes one where the state is
written (`s.idleAt = w.after("3d")` in `on`). `after()` and `now()` throw inside `wants`.

**The condition that never wakes.** "Start the turn once the backoff is over" can't be
`retrying(now)` in `wants`: nothing calls `wants` just because time passed, and a parked run can't
run code at all. A condition on time is a time: a `retry` branch whose firing changes the state.

**The time that fires forever.** A past time left in state would fire at every pass. So the engine
remembers which time each key fired for, and the same time doesn't fire twice. The flip side: a
fired time left in state looks armed and never fires again. The handler moves it or clears it, and
a lint looks for one that doesn't.

**The ghost timer.** When a key's time moves, a `timer:due` already queued for the old time is
withdrawn, as gen_statem and Akka do for their keyed timers. After a crash, before levels 1 and 2
save state with the acks, a due given back is dropped unless `wants` still reads its time.

**The nudge from yesterday.** review-loop3 can compute a nudge "due a day ago" after a laptop sleeps.
Events are ordered by time, so that nudge would jump ahead of events that came before it was set.
A past time is ordered when it was read, not when it was due.

**The debounce that never settles.** A time that activity keeps putting off needs a cap, as Inngest's
debounce has a `timeout`; the babysitter's `earliest(…, first + 1h)` is one. Without it, a chatty
reviewer puts the fix off forever.

**The parked run.** A parked run has no process; `awf tick` only reads the mailbox. So the engine
writes a timer record for each time `wants` returns, as `timer()` does today, and the existing wake
check reads those unchanged. A file edited by hand while the run is parked isn't seen until
something wakes it.

**The turn that starts twice.** A key runs once. A turn whose key ended, answered, failed or
cancelled, doesn't start again while the key is still wanted; a retry is a new key. Counters come
back here, but they count real things, passes and fixes and attempts, not timers.

**The reworded prompt.** A turn's prompt and `meta` are read when its key first appears. Read again
under the same key, they are ignored and logged, or a reworded prompt would cancel a running turn.
What the end's handler needs goes in `meta`, since the state may have moved on by then.

**The lost end.** Every end is delivered under its branch, cancelled ones too, and acknowledged
like any event. Otherwise the engine still thinks the agent is busy after a restart, and dd-case
can't record what an answered turn did after a newer one was asked for. When a key is replaced, the
old turn is cancelled, its end taken, and only then does the new one start: an agent runs one turn
at a time. A failed turn closes its agent today, so the engine opens it again for the next key.

**The review that no longer blocks.** review-loop3 awaits its review, so nothing else happens during
one. As keyed work, events are handled while it runs: nudges, approvals, posts. A workflow that
wants the old behaviour checks `s.reviewing` in `act`.

**The stage that forgets.** review-loop3 writes its ledger *inside* stages so each write happens once.
With saved state that turns silently wrong: a crash rolls the state back, the stage is reused
without running, and the write is gone. So a stage never writes the state; its value does, by
assignment. A lint checks it, and the engine can, by comparing the slots around a stage.

**The effect that runs twice.** A stage isn't an outbox: it runs its effect, then writes its record,
and a crash between the two runs the effect again. That's ADR 0011's rule already. The new part: a
rerun reuses a stage only if it builds the same name, so a name comes from the saved state, the
event, or another stage's value, never from a read made outside a stage. A GitLab read that decides
names is a stage itself.

**The half-saved pass.** State and acks in two files can't be saved together. So the state is
written first, as a new file, then one mailbox line, `{ kind: "handled", ids, state, done? }`, makes it
current, acknowledges the pass's events, and records the ending. Everything that reads the mailbox
today keeps reading only the mailbox.

**The forgotten source.** A `wants` that leaves out `mr.rereview` would never hear it. So declared
events and participants are wanted unless `wants` gives them `null`.

## What it changes in what we decided

| Decision | Where | Here |
| --- | --- | --- |
| State that outlives a park lives in files or a stage; a wake doesn't replay the loop (Q9) | 034 | Levels 1–2 keep it: `wants` is Q9's "decide from the files as they are now". Level 3 keeps the workflow's state in slots; still nothing is replayed |
| "Events notify; files, git and forges hold state" | 034 | Kept for the world; what the run knows moves into slots |
| `until` removed: which time passed was guessed from the clock | 037 | Each time has a name, its key |
| Named `until`s rejected: "the times are still computed at the wait, not where their reason is" | 037 | The reason is written into state where it happens; `wants` only reads it |
| A relative deadline on the wait rejected: a rerun moves it | 034 | Only `Date`s; `after()` throws in `wants` |
| A timer recorded at the call; the first call names the time | 037 | Kept for `timer(name, when)` in a sequence; a loop's times are read from state |
| `timer.cancel()`; `timers()`, the catch-all | 037 | Neither needed in this shape: `null` empties a time, and every time has a key |
| One wait at a time; wake only for what it would take | 037 | Kept; the wake check unchanged |
| A turn isn't awaited; the engine keeps `agent.turn` | 034 | The engine starts and cancels it from its key; `start` and `agent.turn` go for this shape |
| Every source that can wake a run is declared (Q19) | 034 | Kept, and wanted by default |
| Style B, a handler per event with state saved after each: sequences spread over handlers; state the next version must read; a turn cut by a reboot is every handler's problem | [[workflow-styles]] | Level 3 is style B. Sequences stay `run`; the state has a `version` and a `migrate`; a cut turn is the engine's, by key |
| Reducers parked until a workflow needs them | workflow-styles, ideas | `on` with actions is a reducer; review-loop3's ledger already is one, in a file |
| The journal shelved until persistence and versioning are decided | foundation §10 | Not a journal: nothing is replayed. Slots decide persistence and versioning for the workflow's data: an ADR amending ADR 0011 |
| An unbuilt interface leaves the surface | ADR 0001 | Each level lands with a workflow using it: level 1 review-loop3, level 2 dd-case |

## Borrowed, and refused

| | What it does | Taken | Refused |
| --- | --- | --- | --- |
| Elm | `subscriptions(model)` after every `update`; the runtime starts and stops what changed | waits as a function of state | one-shot delays that can't be cancelled, which force a counter into the model: today's `nudge-{n}` |
| React | returns what should be; matched by `key`; batched; effects re-run when listed dependencies change | matching by key; batching; dependencies written out, which is what a stage name is | hooks found by call order; `useState`'s first value silently winning |
| Vue, Svelte | declared state (`ref`, `$state`); derived values (`computed`, `$derived`) re-run only for what they read | declared, named state; `wants` worked out only when its slots change | effects whose dependencies are found by running them: no stable name for a restart to find |
| gen_statem | a timeout returned with the next state; setting a named one again restarts it | named times; a moved or cancelled one never fires | in memory: says nothing about a crash |
| XState | a delay (`after`) or a child (`invoke`) lives as long as its state | work whose life is the state's | saved snapshots with no version |
| Akka | `startSingleTimer(key)` replaces; save state, then run effects | keyed replacement | effects at most once after the save; timers lost on restart |
| Restate | state writes saved with the message's completion; long work is a separate call | state saved with the message; long work not awaited in the handler | ids kept in state to cancel and resend a delayed call |
| Temporal | `condition(fn, timeout)` checked after every event; a `Selector` built each pass | conditions over state, checked again | relative timeouts in a repeated check; replaying code to rebuild state |
| Durable Objects | one alarm, `setAlarm` overwrites it, saved with the state | one earliest wake from many keyed times, which `awf tick` already is | |
| Zustand | a store: state and the actions that change it, together; `persist` saves it with a `version` and `migrate`; `subscribe(selector, listener)` | actions beside the state; one version and a `migrate` for saved state | saving on every `set`, apart from anything else: the half-saved pass; timers kept by subscribers, in memory |
| Inngest | `debounce` restarts per event, capped by `timeout` | the cap | |

**Why not Elm's commands.** In Elm, `update` returns the new state *and* a list of effects described
as data; their results come back as messages. In awf, a GitLab post's note id would come back as an
event, and every kind of effect would be a type awf publishes. Stages already run an effect once per
name and hand back its value. So `on` stays pure and `act` calls stages.

## Open questions

### Q1. Which levels, in what order

Level 1 removes only bookkeeping and touches one call: proposed for 037 now. Level 2 has one consumer
that fits (dd-case) and one that needs keyed work first (review-loop3). Level 3 and slots cost a
record format, an ADR and the stage rule, and move review-loop3's `ledger.md` out of the project;
they wait until a port shows a crash loss levels 1 and 2 can't prevent (M1). Slots in a sequence
could come earlier, since they don't need the model. Both reviews agree with this order.

### Q2. Names

`wants` rather than `waits`, since it holds running work as well as times. `setup` rather than
`open`, which clashes with `agents.open` and reads as once per run, though it runs at every process
start. `on` and `act`. `workflow.state` for the slots.

### Q3. `setup`, and agents

`agents.open` and `participants.connect` are idempotent by key, so `setup` runs at every process
start and hands its refs to `on`, `act` and `wants`. An agent a failed turn closed is opened again by
the turn that names it.

### Q4. Where `ledger.md` goes

review-loop3 renders its ledger for people. With the state in slots, that is a view `awf runs` could
print, or a file `act` writes.

### Q5. Keyed work

`workflow.work({ key, run })`: an async function started, kept, cancelled and restarted by key, its
value its end. What it may do inside (stages, agents, its own waits), and how a cancel reaches it.

### Q6. Slots in a sequence

Saved at the next stage or wait, or at once; and whether a slot set outside both is an error.

## To measure

### M1. The ports

review-loop3 at level 1, and at level 3 with keyed work; dd-case at level 2; the babysitter;
approval-reminders with a slot. What each removes and adds, whether the tests stay as short, and
whether a crash loss remains at level 2 that only level 3 prevents.

### M2. A save per pass

Writing the state and a commit line every pass, for state the size of review-loop3's ledger,
including the mailbox fold every reader does.

## Review

Two reviews, 2026-10-30: one against the engine, the contract and the decisions; one porting
review-loop3, dd-case, approval-reminders and a new babysitter from the doc alone. Their findings
are the "What can go wrong" section; in short:

- a stage that writes state is lost when state is saved with the pass (both);
- stages are not an outbox, and names must never come from unstaged reads (engine);
- state and acks in two files can't be saved together: one commit line (engine);
- no level batched: `on` per event, `act` once per pass (both);
- a clock read in `wants` never wakes: a condition on time is a time (engine);
- turns: a key runs once, its spec read at start, every end delivered, the old turn ended before the
  next starts, an agent reopened after a failure (engine);
- the first dd-case port was wrong: a triage close supersedes by a state write (both);
- review-loop3's review is a part, not a turn: keyed work first (both);
- a background review lets nudges and posts run during it (both);
- a forgotten source never wakes: sources wanted by default (author);
- level 3 is style B, not reducers, and its costs needed answers (engine);
- an event run written as a sequence keeps `run` (engine).

Both endorsed level 1 as scoped, keys never order, no Elm commands, and level 3 gated on an ADR and
the measurements. After the reviews, from discussion: state as declared slots, `useState` the way
Vue and Svelte declare it; actions beside the state, and one `version` and `migrate` for it, as a
Zustand store has.
