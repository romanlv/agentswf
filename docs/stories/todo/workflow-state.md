---
title: A workflow keeps state the engine saves
type: story
status: todo
priority: P2
epic: authoring
discovered_in: "037 Q1, moving timers, 2026-10-31: review-loop3 keeps its own ledger file to survive a wake"
depends_on: ["037"]
---

# A workflow keeps state the engine saves

A workflow can keep values across a wake, a restart and a crash without writing files of its own:
`workflow.state(name, initial)` is a durable value, read and written in the run's code, saved by
the engine with the acks of the events that changed it.

Why it matters: state lives in files today (034's Q9), so every event workflow that remembers
something writes its own. review-loop3's ledger is 326 lines, a third of them reading and writing
`ledger.json`, and five of its stages (`unapproved-`, `rereview-`, `closed-`, `apply-pass-`,
`signoff-`) exist only to make one ledger write happen once. A write and the event's ack are two
writes, so a crash between them brings the event back to a ledger that already has it, and every
method has to tolerate that.

The shape, as sketched:

```ts
const handover = workflow.state("handover", { nextNudge: null as Date | null, nudges: 0 });

handover.value.nudges;                                      // read
handover.set((s) => { s.nudges++; s.nextNudge = next; });   // write

for await (const next of workflow.select({
  reply: engineer,
  nudge: handover.at((s) => s.nextNudge),                   // 037's workflow.at over this state
})) { … }
```

- **Named, like a stage.** The first run makes it from `initial`; later ones load what was saved. A
  workflow has as many as it likes: one per phase, one per concern.
- **Typed by its initial value**, plain TypeScript, JSON-able; the engine keeps `Date`s.
- **Saved with the acks.** In a loop, when it asks for the next event: the state and the acks of
  the events that changed it go in one mailbox write, so after a crash both happened or neither.
  In straight-line code, at the next stage or wait.
- **A source of times.** `handle.at(selector)` is 037's `workflow.at(() => selector(handle.value))`.
- **A stage never writes state.** Its value is returned and set outside it: a stage reused after a
  crash doesn't run, so a write inside it would be lost with the unsaved state.

What it removes from review-loop3: `ledger.json`'s read, tmp-and-rename and `fresh`; the five
stages above; and the "applied before a crash" guards. The ledger keeps every method and stores
into a handle (review-loop3's `flow.state.ts` sketch).

Notes:

- **Open:** `.set(fn)` or plain assignment through a proxy, as Vue's `ref` is; a changed `initial`
  is ignored once a value is saved (React's `useState` trap), so a `version` and `migrate` per
  handle, as Zustand's `persist` has; where people read it, now that `ledger.md` goes (`awf runs`,
  or a file the run writes); a `handle.changes(selector)` source, for one running part to tell the
  loop something; the record format, which needs an ADR before it is built.
- **Considered and set aside:** [[reconciled-runs]], a run written as `on`, `act` and `wants`, the
  engine owning the loop and reconciling timers and work by key. It reads well on paper and asks
  too much of an author: four handlers, to-do flags in the state, and effects that can't see the
  events behind them. This story keeps today's loop and adds only the state.
- **Not here:** work running while events arrive (a keyed `workflow.work`), which the reconciled
  model had and review-loop3's review would use; a story of its own when a workflow needs it.
- [[timers-waits-and-state]] has how Elm, Vue, Svelte, Zustand, Restate and Akka keep and save
  state.
