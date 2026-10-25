---
title: An agent that parks between events and wakes in a later attempt
type: story
status: todo
priority: P2
epic: long-runs
discovered_in: "agent/workflows/datadog-watcher design (2026-10-23)"
depends_on: []
---

# An agent that parks between events and wakes in a later attempt

[[034-event-driven-runs|Story 034]] (2026-10-25) takes the parking itself: the `parked` ending, and
agents reopened on their kept sessions. What stays here is the live window (`keepAlive.timeoutMs`)
and `then`, compacting before parking.

An agent stays live for a while after its last turn, then parks: awf compacts it if the workflow
asked, keeps its native session, and ends the attempt. A message to the parked run, or an
`awf run --continue`, starts the next attempt, and the agent wakes on the same session. Nothing
runs between events.

Why it matters: most work worth automating locally comes in events with long gaps: a Datadog case
that recurs a month later, a PR that gets a review comment the next morning, a thread someone
answers after lunch. Today the only thing that keeps an agent's context is a live run, so a
workflow either holds a process and a pane for the whole gap or starts a fresh agent that relearns
everything. The datadog-watcher (`agent/workflows/datadog-watcher/README.md`, braintrust) shows
the cost of holding the run, one entry each in its `awf-issues.md`:
- a claude process and a pane per open case, for months;
- a loop that polls files, because outside events can't reach a run any other way;
- the 40-message ceiling per attempt, worked around with a restart flag;
- a fresh investigator after any restart, seeded from a memory file;
- a message thread that refuses replies whenever no attempt is live;
- a failed message turn that leaves the run looking alive.

With parking, a case's run is a page of code: read the state, open the investigator, take one turn
for why it woke, end.

## The shape

```ts
const investigator = await workflow.agents.open({
  key: "investigator",
  instructions,
  keepAlive: { timeoutMs: 60 * 60_000, then: "compact" },
});
```

- **Per agent,** decided: a run can hold an investigator worth keeping beside a reviewer that
  should start fresh.
- **While live** (within `timeoutMs` of its last turn): a message is a warm turn, as today.
- **`then`** says what parking keeps:
  - `"compact"`: compact (ADR 0007, with a focus the workflow can give), then keep the session;
  - `"session"`: keep the session as it is;
  - `"fresh"`: keep nothing; the next attempt opens a new agent. Today's behaviour, and the
    default.
- **Parking** ends the attempt with a new ending, `parked`, once every agent with `keepAlive` has
  parked and the workflow's code is waiting only on events. A pane closes; its session stays.
- **Waking**: the next attempt reopens the agent on its kept session, by key. A pane agent gets a
  new pane resumed on it (`claude --resume`, codex's `resume`). The workflow learns why it woke.

## Why compact at parking

A resumed session reprocesses its whole context, and after the prompt cache expires (about an
hour for Claude Code, five minutes for the API's default) that is cold. A 150k-token investigator
woken the next day pays for 150k cold tokens on every wake; compacted to 15k, a tenth, every time.
The compaction itself is one turn over the full context, and done at parking it runs while the
cache is still warm. So the default `timeoutMs` worth suggesting is the cache's lifetime: past it,
staying live buys only a process. On the subscription the same arithmetic is allowance.

## What it changes

- **[[foundation]]**: "native session references never cross into workflow or engine-owned state
  as resume authority" (§ on operations). This story makes them cross, for an agent that asked, in
  the run's own records. That needs an ADR, and the measured continuation support the same
  sentence asks for, per harness.
- **ADR 0001**: retention comes back as `keepAlive`, with an implementation and the workflow that
  needs it, as 0001 requires.
- **ADR 0008**: a pane agent keeps one pane per attempt, not for its whole life.
- **ADR 0011**: a parked run is continued without `--from-stage`, from the stage it parked in.
  Today a completed run is continued only to redo a stage.

## Open questions

- Q1. Who starts the attempt a message wakes? Nothing of awf runs while a run is parked. Either
  `awf send` to a parked run starts it, detached, or the host (awf-chat) runs `awf run --continue`
  and then sends. The first keeps hosts simple and needs a detached start (todo
  `run-in-background`).
- Q2. How the workflow's code waits for an event, and learns why it woke: a call such as
  `await workflow.events()` that parks when nothing is live, or a value read at the start of an
  attempt. The first keeps the loop in code; the second keeps each attempt short and stateless.
- Q3. What a parked run looks like in `awf runs` and to awf-chat: a state of its own, so a thread
  shows "parked", not ended, and keeps accepting replies.
- Q4. The message ceiling per route: counted per attempt, as now, or per wake.
- Q5. Whether `keepAlive` is the name, and `then` the field.

## To measure

- M1. `claude --resume {id}` in a new pane, and `claude -p --resume`, on a session from an earlier
  process: context intact, on the subscription for the pane. The same for codex and pi.
- M2. For a real investigator session: tokens before and after compaction, and the cost of a cold
  wake of each.
- M3. How much a compaction at parking costs with a warm cache against one after it expires.

Related: ADR 0009 makes a fork a new agent on a copy of the session; waking may share its
session-copy code.
