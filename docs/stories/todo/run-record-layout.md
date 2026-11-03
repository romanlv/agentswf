---
title: A run's records, designed as a whole
type: story
status: todo
priority: P1
epic: launch
discovered_in: "038, documenting site/reference/data.md, 2026-11-01"
depends_on: []
---

# A run's records, designed as a whole

Review the layout of a run's folder (`.awf/runs/{workflow}/{id}/`) as one design and propose the
one it should have, before agents.wf leaves evaluation. This is the investigation and the
proposal; nothing changes before the design is reviewed.

Why it matters: the layout grew a story at a time, and record formats are what others build on:
`awf logs`, `awf runs`, an agent reading a run, a dashboard. Changing it costs a release note
today and a migration once the project leaves evaluation, so it has to be settled before then.

What is sound, to keep: records replaced whole and logs appended, so a crash leaves the old file
or the new one; status, current stage and last attempt derived, never stored; replay by name, the
code run again from the top with each named step answered from its record; and an inbox written
by outsiders under a lock, apart from the run's own writes.

Where it shows it accreted, as of 2026-11-01:

1. **One idea, three stores.** A named step's recorded answer is a stage's value in `stages/`, a
   race's winner as a `took` line in `mailbox.jsonl`, and a timer's time as a `timer` line there,
   each with its own keys and its own rule for a second call under a name.
2. **The mailbox is not only an inbox.** Beside the events from outside it holds the run's own
   bookkeeping: `wait`, `took`, `timer`, `timer-cancelled`, `turn`, `launch-failed`.
3. **`turns.jsonl` is the run's whole log** (stages, logs, decisions, messaging, tools), named
   for one kind of its lines.
4. **The run's own records are split** between the mailbox, what replay reads, and
   `turns.jsonl`, what the run did; a started turn is written to both.
5. **Sessions are recorded three ways:** `turn` lines, `session-known` lines, and each stage
   record's `sessions`.
6. **Decisions are numbered by order and overwritten each attempt,** while a redone stage keeps
   its old record in `replaced/`.
7. **`output.json` repeats** the attempt file's stages and accounting.
8. **Records and scratch share the folder:** `agents/`, `staging/`, `forks/` and `skills/` are
   harness working space beside the run's records.

A shape to weigh, not a decision: `inbox.jsonl`, written only by outsiders; `journal.jsonl`, the
run's own history, one line per named step settled (stage ended, race won, timer set or
cancelled, wait took, decision, turn settled) under one key scheme; `stages/` and `output.json`
as views built from it for fast reads; harness scratch under one `work/`.

Notes: the proposal should say what replay, `awf logs`, `awf runs`, `awf tick`, accounting and
the lab's readers change, and how a run made before it is read or refused. Weigh it with
[[workflow-state]], whose durable values are saved with the acks of the events that changed them,
and which would be one more store unless it lands in the same journal. The current layout is in
[`site/reference/data.md`](../../../site/reference/data.md) and `MailboxRecord` and the records
around it in `packages/contract/src/records.ts`.
