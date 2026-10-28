# 0012 — An event run keeps its agents' sessions, and a kept-alive agent holds the run live

**Decided:** 2026-10-28, in [[036-agent-keep-alive|story 036]], recording what
[[034-event-driven-runs|story 034]] built. **Amends:** [`foundation.md`](../foundation.md) §
on operations, "native session references never cross into workflow or engine-owned state as
resume authority", and its §10 row on agent retention; ADR 0008, one pane per attempt.

## What was decided

- **A run of a workflow with `events` keeps each root agent's native session across attempts.**
  `turns.jsonl` names the session each turn ran on; a continue reopens each root agent on its last
  one (`keptSessionsOf`), without its instructions again, and a pane agent's pane opens at its
  first turn of the attempt. An agent with skills or a sandbox, whose home is made anew, or one the
  code now opens on another harness, starts afresh. A continue after a crash opens agents on new
  sessions (034's Q17). So for these runs, and only these, a native session reference is resume
  authority, read from the engine's own records.
- **A pane is the attempt's.** ADR 0008's one pane for every operation holds per attempt: parking
  ends the attempt and closes every pane, and the next attempt's first turn opens a new one on the
  kept session. Nothing closes or reopens a pane mid-attempt.
- **An agent opened with `keepAlive` holds the run live for a window after each turn it runs,**
  `timeoutMs`, an hour by default: claude's prompt cache lives an hour for the main conversation on
  a subscription ([`fork-cache.md`](../findings/fork-cache.md)). The run doesn't park while any
  window is open, so a message then is a warm turn in the same pane. A closed agent holds none, and
  no agent is released alone: every pane stays until the run parks.
- **Its `onTimeout` runs once the window passes,** at a wait with nothing to take and nothing
  working, awaited by the wait in its scope: a compaction with a focus written then, while the
  cache is warm, so the next wake resumes a smaller session. No turn the handler begins opens a
  window, on any agent; a message a peer sends is the peer's turn.
  Once no window is open and no handler is due, the run parks.
- **`keepAlive` is on the open spec of a workflow with `events` alone** (`EventAgentOpenSpec`),
  as ADR 0001 asks of retention: it came back with its implementation and the workflow that needs
  it, the Datadog watcher's investigator.

## Why

The watcher's case runs park between messages, so a conversation of five replies was five panes,
five starts and five resumes, each past the cache's life reprocessing the whole context at about 13
times a warm resume ([`resume-after-hours.md`](../findings/resume-after-hours.md)). Keeping the run
live for the cache's life makes a follow-up a warm turn; compacting at the window's end, still
warm, makes the cold wake after it smaller.

Foundation's rule predates 034, which needed resume to make a parked run continue at all; it
crossed the rule without amending it. The rule's worry holds for a reference the workflow could
pass around or an operator could edit: here the reference never leaves the engine's records, and
only the engine's open reads it.

## Rejected

- **Releasing each agent at its own window's end**, its pane closed and the run live for others:
  the harness refuses a session whose pane closed (ADR 0008: a close doesn't prove the process
  gone). It needs a harness release with that proof and a record of several panes per attempt
  ([[agent-release]]).
- **A window on the wait or the workflow**: it doesn't say whose turns start it, so a side agent's
  quick turn would keep the run live as long as the investigator's.

## Not decided

- Releasing one agent while its run stays live ([[agent-release]]).
- A limit on live runs: twenty cases woken at once are twenty live windows.
- Keeping a session through a crash ([[run-through-sleep]]).
