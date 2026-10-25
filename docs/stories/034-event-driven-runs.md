---
id: "034"
title: "An event starts a run, and wakes it while it runs"
summary: "A workflow declares the events it takes and how they map to a key. awf emit starts that key's run or lands in its mailbox; the run's code takes every waiting event at a wait, starts agent turns without awaiting them, and hears their end as an event. Between events the run parks and no process runs. Code handles most events and an agent gets a turn only when judgement is needed."
type: story
status: ready
depends_on: ["032"]
---

# An event starts a run, and wakes it while it runs

## Outcome

The workflows worth automating locally react to things that happen: a Datadog case gets new
errors, an MR gets a push or a reply, CI fails, someone says "this is noise". Today a running
workflow can be reached only through an agent (`awf send`, `wf send`, each one a turn) or through
files its code polls, so every such loop polls, and every event costs a turn.

After this story, a workflow says which events it takes and which key each belongs to. An event
starts that key's run if it has none, and otherwise lands in its mailbox. The run's code takes the
waiting events at a wait, decides what they mean, records and counts in plain code, and
starts an agent turn only when one is needed. A turn runs while more events arrive; its end is an
event too.

Nothing stays running between events. A run that waits with no turn running parks: its process
exits, and its files and record hold everything. The next event starts a new process that runs the
code from the top, skips the stages already done, and takes the event at its wait. Old rounds are
not replayed, so a wake decides from the files as they are now. A case that lives for weeks costs a
file on disk between its events, not a process.

The style was chosen by comparing four against eight automations
([`workflow-styles.md`](../research/workflow-styles.md), "Event-driven automations"). Two sketches
written in it are the design's test cases: the Datadog watcher's case run
(`agent/workflows/datadog-watcher/style-c-sketch.md`) and the MR review loop
(`agent/loops/review-loop/style-c-sketch.md`).

## How it works

```text
awf emit --target case.ts dd.changes {json} --id {commit}     the triage tick, a script, a thread reply
        │  checked against case.ts's events: a wrong name or shape is an error
        ▼
  key = key(event); under the key's lock: a repeated id ► duplicate; the run returned, or no run
        │  and not a starting event ► refused; otherwise appended ► accepted, and the run is woken:
        │    no run ► started    live ► nudged over its socket    parked or crashed ► continued
        ▼
  ┌──────────────────────── run "dd-case.{key}" ───────────────────────┐
  │ mailbox: dd.changes · participant:reply · agent:ended · …          │
  │                                                                    │
  │ for (;;) {                                                         │
  │   events = await receive({ label, until })                         │ ◄─ takes all waiting
  │   …plain code: record in files, count, post…                       │
  │   await investigator.start({ prompt, meta })    // not awaited     │ ──► agent:ended
  │ }                                                                  │     arrives later
  └────────────────────────────────────────────────────────────────────┘
        waiting, no turn running, nothing unacknowledged → parked: the process exits
```

- **The definition** declares `events: { name: schema }`, `key: (e) => …`, which maps each of its
  events to a run, `starts: [names]`, the events that may start one, and `file: import.meta.path`,
  which tells a sender where the workflow lives.
- **The sender names its target**, the workflow the event is for, so a wrong name or shape fails
  at the sender: `tsc` for `workflow.emit(caseRun, "dd.changes", data, { id })`, which imports the
  workflow; a run-time error for `awf emit --target case.ts`; `testWorkflow` in a test. There is no
  registry and no routing by name. An emit returns `accepted`, `duplicate` or `refused`: whether
  the run has the event. What awf then did to the run (started, nudged or continued it) is printed,
  not returned, so a limit on live runs or a scheduler can change it later.
- **A key is a run.** The run's id is made of the workflow and the key, so every event for a case
  reaches the same run, in the same Slack thread, because awf-chat keys a thread by run.
- **Parking.** When the code waits at `receive`, no agent of the run has a turn running, and no
  event is waiting, the run keeps its agents' native sessions, closes them, and its process exits.
  The next event continues it: `awf run --continue`, a normal bun process, runs the code from the
  top. Opening agents and the thread is cheap, recorded stages are reused, and the loop's wait takes
  the new event. While a turn runs, the process stays alive.
- **A wake doesn't replay the loop.** A run parks only with no turn running and its events
  handled, so the loop's variables hold nothing worth keeping then, and a wake starts the loop
  fresh. Its decisions read the files as they are now, which is what they should read. The rule for
  authors: what must outlive a park or a crash lives in files or a stage, not in a variable, and
  code between waits must be safe to run twice, since a crash reruns the unfinished round.
- **Stages by content, not by round.** A stage is named by the one effect it has
  (`close-{event id}`, `post-f3@abc123`), and done once, ever: a succeeded record is reused wherever
  it is entered again. A crash then skips what's done, and the record grows by what happened, not by
  how many rounds went by.
- **A closed case keeps waiting.** It records the close in its files and parks; a later change or
  reply continues it. `return` ends a run for good, for work with a real end, such as a merged MR.
- **`receive({ label, until, take })`** waits, then returns the waiting events in arrival order:
  all of them, or with `take: "oldest"` one at a time. The next call acknowledges the last batch
  and takes the next, and after a crash the unfinished batch comes back once, so the code handles
  every event of a batch, in order. `label` is what `awf runs` shows while it waits. `until` is a
  time the code computes from its files, such as when to retry a failed turn, so a rerun computes
  the same one; `awf tick`, run on any schedule, continues a parked run whose `until` has passed.
- **`agent.start({ prompt, meta })`** takes what `agent.run()` takes, plus `meta`, and begins the
  same turn, but returns at once. `agent.turn`, kept by the engine, is that turn until a wait has
  taken its end, and the agent refuses other work meanwhile, so nothing is given to two turns. The
  end arrives as `agent:ended` from the agent's key, with the outcome and the `meta` the turn was
  started with, and `investigator.ended(e)` picks it out; the engine writes it, even for a turn cut
  by a reboot, where it writes a failed end. `agent.turn.cancel()` stops a turn.
- **A participant whose messages go to the code** turns each reply into `participant:reply` from
  its key, which comes in the same way as an emit, so it can continue a parked run.
  `participant.post(text)` writes back without a turn.

A Datadog case, cut down from the watcher's sketch:

```ts
export default defineExecutableWorkflow({
  definition: {
    meta: { name: "dd-case", description: "Investigate one Datadog case in its own thread." },
    file: import.meta.path,
    events: { "dd.changes": Changes, "dd.closed": Closed },
    key: (e) => e.data.case,
    starts: ["dd.changes"],
    async run(workflow) {
      const kase = openCase(workflow.key);                      // the files hold the state
      const thread = await workflow.participants.connect({ key: "thread", to: "code" });
      const investigator = await workflow.agents.open({ key: "investigator", runtime: "claude" });

      for (;;) {
        const events = await workflow.receive({                  // the first takes the event that started it
          label: () => (investigator.turn ? "investigating" : `${kase.unseen().length} unseen`),
          until: !investigator.turn && needsTurn(kase) ? kase.retryAt() : undefined,   // a retry, only when it would act
        });
        for (const e of events) {                                // in order: each event is handled
          if (investigator.ended<Given, JsonValue>(e)) {
            if (isAnswered(e.data.outcome)) kase.markGiven(e.data.meta);
            else if (e.data.outcome.kind !== "cancelled") kase.markFailed(e.id);   // sets retryAt, backing off
          }
          if (thread.replied(e)) kase.addReply(e.id, e.data);   // pending; by id, so twice adds once
          if (e.name === "dd.closed") {                         // triage closed it
            await investigator.turn?.cancel();
            await workflow.stage(`close-${e.id}`, () => kase.close(e.data, e.at));   // the pending replies with it
          }
        }
        if (!investigator.turn && !kase.retrying() && needsTurn(kase)) {
          const given = kase.pending();
          await investigator.start({ prompt: promptFor(kase, given), meta: given });   // returns at once
        }
      }
    },
  },
});

// A first look, a reopen or a close not yet asked for, or replies: always. Occurrences: past 50, unless closed.
const needsTurn = (kase: Case) =>
  kase.writeUpDue() || kase.pendingReplies().length > 0 || (!kase.closed() && kase.unseen().length >= 50);
```

```sh
awf emit --target case.ts dd.changes '{"case":"kombo-unique"}' --id 83d34d7   # once per changed case
```

Thirty triage ticks that add occurrences are thirty events and no turn. A reply during a turn is
taken at the next wait, written to the case's pending replies, and given to the turn after. A turn
that answered marks what it was given, which its end carries back in `meta`, including the
write-up it was asked for, so a turn that answered without writing case.md isn't asked again
until a new event. A failed or cancelled one marks nothing, so the next turn gets it again; a failure
records in the case's files when to retry, the wait's `until`, and `awf tick` continues the parked
run then. An event before that is recorded but starts no turn. How often to retry, and when to
stop, is the code's choice; the sketch backs off. `kase.close` records the close
event's time, so a reopen triage wrote after it wins.

Between events the run parks, so the process exists only while there is work. Weeks later, a wake
with 80 unseen occurrences reads 80 and starts a turn, as it should. A reply in the thread of a
closed case continues the run like any other event, and the investigator's next turn answers it,
from a prompt that says the case is closed.

Events notify; files, git and forges hold state. A lost event loses nothing a run can't read back.

Event names: a dot for the workflow's own (`dd.changes`, `mr.closed`); a colon for awf's, a
closed set, `agent:ended` and `participant:reply`, with the agent's or participant's key in `from`.
A run with two agents tells them apart by `from`, and `tsc` checks every name.

## Scope

In scope:

- `events`, `key`, `starts` and `file` on the definition; `workflow.key`; `receive`;
  `workflow.emit` to a target;
- the run's mailbox: append under the key's lock, deduplicate by id within the run, what each wait
  took and acknowledged, its `until` and label;
- stages by content in a run with `events`: a record reused wherever it is entered;
- `awf emit --target {workflow} {name} {json} [--id {id}]`: check against the target's schema,
  key, append, wake the run, and print the outcome;
- `workflow.emit` typed from the target it imports, so a wrong event fails `tsc`;
- `agent.start()`, `agent.turn`, `agent:ended` written by the engine with the turn's id and
  `meta`, `cancel()`;
- parking: a new attempt ending, `parked`, at a wait with no turn running; agents reopened by key
  on their kept native sessions when the run continues; a run whose process died is continued too;
- `wake`, one policy for what an accepted event, or `awf tick`, does to a run; `awf tick`: wake the
  runs of workflows with `events`, and continue parked ones whose `until` has passed;
- a participant routed to the code: `participant:reply`, delivered like an emit, and `post`;
- `awf runs` showing a waiting or parked run's label;
- workflow-testing: a first event and scripted events at points in the run;
- porting the Datadog case run, as the proof.

Out of scope:

- tools an agent calls ([[workflow-tools]]), which builds on `workflow.emit`, and the emit to the
  run's own mailbox that a tool's handler needs; this story's port has none;
- the rest of [[agent-keep-alive]]: an agent kept live for a while after its turn
  (`keepAlive.timeoutMs`), and compacting it before it parks;
- a limit on how many runs of a workflow are live at once (the review loop's `MAX_NEW`); until it
  exists, a triage tick that changes twenty cases starts twenty runs. It goes in `wake`;
- compacting a run's mailbox: every wake reads it whole, which is fine for a handful of runs and
  weeks of events. A compaction must keep the log a later reducer would fold;
- named waits and waits that take only some types: no workflow here has nested waits; they can be
  added without changing `receive`'s calls;
- reducers and observing agent-to-agent messages: parked until a workflow needs them
  (`workflow-styles.md` "To decide", `docs/design/ideas.md`). `again(state)` isn't needed: a wake
  doesn't replay rounds;
- schedules (a workflow started on a timetable) and a scheduler, which can come later on top of
  `awf tick`;
- webhooks or a daemon: events come from scripts and ticks on the machine. Either would call the
  same append and `wake`.

## Context and evidence

- Fact: `workflow.signals.receive` is in the contract and throws `unavailable`
  (`packages/contract/src/workflow/workflow.ts:54`, `packages/engine/src/workflow-runner.ts:919`).
  This story replaces it; the earlier todo built on it routed every event into a turn.
- Fact: the four-style comparison found that styles whose state changes during an awaited turn
  lose updates (a CI pass during a fix reset to pending); taking events at a wait doesn't.
- Fact: a run's socket opens only when a participant connects ([[032-run-coordinator|story 032]],
  `packages/engine/src/coordinator-socket.ts:77`, called from `operator-cli.ts:487`), and the wire
  knows two requests, `reply` and `send` (`decodeHolderRequest`, `contract/src/wire.ts`). A run with
  `events` opens it at start, and the wire gains the nudge.
- Fact: today a continue reuses recorded stages only up to the first one that runs fresh; from
  there, the records not yet reused move to `replaced/` and every later stage runs again
  (`stage-plan.ts`, `replaceStale` in `runs.ts`). A name is entered at most once per attempt
  (`stage-ledger.ts`). A loop with stages by content needs neither rule.
- Fact: a stage name must match `^[a-z][a-z0-9-]*$` and a run id letters, digits, `.`, `_` and `-`,
  at most 128 (`runs.ts:52,61`), so `post-f3@abc123` and `dd-case/{key}` are invalid today (Q10).
- Fact: a completed run can't be continued today (`{id} completed; there is nothing to continue`,
  `packages/engine/src/attempt-view.ts:279`); a parked run is not completed, so this story's
  continue doesn't touch that.
- Constraint: no compatibility shims; the `signals` stub goes. There is no `workflow.event`: the
  starting event is in the mailbox, and the first wait takes it.
- Fact: an agent's placement defaults to a pane it keeps between turns
  (`packages/contract/src/workflow/agents.ts:49`); a parked run closes it, and its session is kept.
- Fact: the contract already has `AgentRef.enqueue` and `TurnRef`, a turn started without awaiting
  (`agents.ts:305,364`), as stubs the engine throws on (`workflow-runner.ts:2216`). They go:
  `agent.start()` and a smaller `agent.turn` replace them, the end coming through the mailbox.
- Fact: a turn's outcome is the contract's `TurnOutcome<T>`: answered, with its `value`,
  unanswered, blocked, timed-out, failed or cancelled (`agents.ts:273`). `turns.jsonl` already
  records each turn (`TurnRecord`, `records.ts:397`).
- Fact: today only the live attempt writes to a run directory, and claiming a folder or an attempt
  file are the only locks (`runs.ts`'s header). The mailbox has many writers, so this story adds
  the key's lock for it.
- Fact: a participant today stays connected "until released, or until the workflow has returned"
  (`participants.ts:34`); a parked run hasn't returned, so it keeps its participants.
- Constraint: published formats, which task 1 stops for review before any is built: `events`,
  `key`, `starts`, `file`; the mailbox records and the `parked` ending; awf's event names and data;
  emit's outcomes; stage and run names; the wire's nudge; the `awf emit`, `awf tick` and changed
  `awf send` commands, their printed and `--json` output; `post`'s item in `awf inbox`;
  `~/.awf/projects` and a run's recorded project and `PATH`.
- Constraint: a variable lives only as long as its process. What must outlive a park or a crash
  lives in files or a stage (Q9).
- Assumption: running from the top on every wake is cheap for runs that last weeks: opening agents
  and a thread, and one record lookup per stage before the loop. Each wake adds an attempt and the
  stages it ran, not a replay of the rounds before it.
- Fact: opening a pane agent places its pane at once, a login shell with no agent in it
  (`packages/harness/src/adapters/herdr.ts:821-825`, and the contract's "once, as it opens",
  `agents.ts:131`); claude itself starts at the first turn (`herdr.ts:1348-1365`), and `launchPane`
  already places a pane that was never placed (`herdr.ts:1023-1035`). So a lazy pane is a small
  harness change, and the contract's wording changes with it (task 1).
- Fact: nothing resumes a session across attempts today; a continue opens agents on fresh sessions,
  and the previous sessions are only in `turns.jsonl`. `launchPane` already resumes a session it is
  given (`--resume`, `herdr.ts:1016-1093`), so reopening on the kept session is new engine work:
  find the agent's last session and hand it over, without sending the instructions a second time.
- Fact: a pane takes its environment from the Herdr server's login shell, not from the process that
  asks for it (`herdr.ts:608-614`), and claude on the host uses the default `~/.claude` and the
  keychain login (`packages/harness/src/capabilities/skills.ts:35-46`). Pane claude in the `awf`
  session reads the claude.ai login today (story 024's M5; a review run on 2026-10-21 recorded
  12 pane claude agents with `billing: "subscription"`, awf's label, not a bill). A run a tick
  starts from a pane of that session opens its panes the same way.

## Code map

### contract

- `packages/contract/src/workflow/workflow.ts` — `Signals`, `SignalSpec`, `WorkflowDefinition`: the
  stub goes; `events`, `key`, `starts`, `file`, `receive`, `emit` come.
- `packages/contract/src/workflow/agents.ts` — `AgentRef`: `start()`, `turn`, `ended(e)`;
  `enqueue` and `TurnRef` go.
- `packages/contract/src/workflow/participants.ts` — routing a participant to the code; `post`,
  `replied(e)`.
- `packages/contract/src/wire.ts` — the nudge request.

### engine

- `workflow-runner.ts` — the context's `signals` stub; the mailbox and waits go here or beside it.
- `stage-plan.ts`, `stage-ledger.ts`, `runs.ts` (`replaceStale`, `stageNameProblem`, `idProblem`) —
  stages by content in a run with `events`; the stage and run names of Q10; the key's lock.
- `coordinator-socket.ts`, `control-plane.ts` — nudging a live run.
- new `emit-command.ts` and `tick-command.ts`, each a row in `commands.ts` — `awf emit`, `awf tick`,
  and `wake` beside them; `holder-command.ts` — `awf send` for a participant routed to the code
  (Q18).
- `attempt-ending.ts`, `attempt-view.ts`, the continue path (`continue.test.ts`) — the `parked`
  ending, how it prints, and a continue of a parked or crashed run; `isLive` in `runs.ts` for
  "the previous process is gone".
- `agent-launcher.ts`, `packages/harness/src/adapters/herdr.ts` — reopening an agent by key on its
  kept native session; a pane placed at the first turn.
- `workflow-testing/` — scripted events and recorded emits; an event the workflow doesn't declare
  is refused.

### examples and the watcher

- `agent/workflows/datadog-watcher` — the case run, ported from the sketch.

## Proposed design

As in "How it works". The rules and records in full:

### Sending

- **Target, not routing**: the sender names the workflow (`--target`, or the imported definition,
  whose `file` says where it lives, Q11), which gives the schema and `key`. Routing by event name
  alone can come later, if naming the target gets tedious. A sender can't emit a name with a colon;
  those are awf's.
- **Errors and outcomes.** A wrong name, a wrong shape or a colon is an error: `workflow.emit`
  throws, and `awf emit` exits non-zero. Anything about the run's state is an outcome, returned, so
  a tick going through its cases doesn't stop at the first refusal: `duplicate`, a repeated id, in
  any state; `refused`, when the run has returned, or there is none and the event doesn't start
  one; otherwise `accepted`. A duplicate or refused event is not appended. The outcome says only
  whether the run has the event; `awf emit` prints what `wake` then did.
- **Ids.** An id names one occurrence, forever, within the run: a repeated id is a duplicate. It is
  optional; without one, awf makes one, and nothing deduplicates the event. A sender whose code can
  run twice gives one made from what the event is about. Ids awf takes in, a turn's end and a
  reply's message id, which comes from the chat, fit the same grammar (Q10).
- **One way in, then `wake`.** Every event, from `awf emit`, `workflow.emit` or a participant, is
  appended under the key's lock, and `wake(run)` acts on the run before the lock is let go. `awf
  tick` takes each run's lock and calls the same `wake`, so two wakers never both continue a run. A
  limit on live runs, later, goes here and nowhere else.

  | The run | `wake` |
  | --- | --- |
  | none: a starting event was just appended | starts it |
  | live | nudges it over its socket; a nudge that fails isn't an error, its next wait takes the event |
  | parked | continues it if an event is unacknowledged or its `until` has passed; else nothing |
  | crashed: no ending, its process gone | continues it, under Q13's limit |
  | failed | continues it, under Q13's limit |
  | `stuck` (Q13), `stopped` or `cancelled` | nothing: they need the operator, `awf run --continue` |
  | returned, the `completed` outcome | never reached: its events are refused |

  A run that `wake` starts or continues has its pid and process start recorded before the lock is
  let go; one whose process is gone and that has no ending is crashed. A run that has written
  `parked` is continued, even while its process is still exiting. `timed-out` doesn't occur: a run
  started by an event takes no `--timeout`.
- **The key's lock** is a file beside the run directory, `{root}/{workflow}/{run id}.lock`, so it
  exists before the run does. It is claimed by linking into place, as a run folder is, and holds
  the holder's pid and process start; when `isLive` says that process is gone, it is stale and
  taken over.

### The mailbox and waits

- **A mailbox per run**, an append-only file in the run directory, `mailbox.jsonl`; it is not what
  `awf inbox` shows, which is a coordinator's questions. Every append, the run's own included, is
  made under the key's lock. Each record has a `kind`:
  - `event`, `{ id, name, data, from, at }`;
  - `wait`, `{ until, label }`, a wait called, which acknowledges what the last `took` returned;
  - `took`, `{ ids }`, the wait returning, with `ids` empty when its `until` passed;
  - `turn`, `{ turn, agent, meta }`, written before the agent is launched; the rest of the turn is
    in `turns.jsonl`. Its end is the event `agent:ended`, from the agent's key, with
    `{ turn, outcome, meta }`, `outcome` a `TurnOutcome`, and an id made from the turn's, so only
    one end is ever kept.
- **A wait** returns every event not yet acknowledged, in arrival order, or the oldest alone with
  `take: "oldest"`, and waits when there is none. Each call acknowledges what the one before it
  returned; an acknowledged event never comes back. After a crash, the first call returns the
  batch taken and not acknowledged, alone. A wait in straight-line code, which must not take later
  events on a rerun, goes in a stage: `workflow.stage("approval-{id}", () => workflow.receive(…))`
  returns its recorded batch on a rerun, and a batch a stage recorded counts as acknowledged. Named
  waits, and waits that take some types only, can be added when a workflow with nested waits needs
  them, without changing these calls.
- **`until`** is a time, epoch milliseconds or a `Date`, which the code computes from its files,
  so a rerun computes the same one. A wait whose `until` has passed returns at once, so code
  passes one only when it would act on it. It is recorded so `awf tick` can read it from a parked
  run.
  While the process lives, the wait honours it; once the run parks, `awf tick` does, at the
  granularity it is run at.
- **The label** is computed at each call and recorded, since a parked run has no process to ask.

### Stages by content

- In a run with `events`, a succeeded stage record is reused wherever and however often its name is
  entered, in any attempt, and a failed one runs again, its record replaced. A name is entered more
  than once per attempt freely. If the same effect can be wanted again (a thread resolved,
  unresolved by a person, resolved again), the name carries what makes it new
  (`resolve-f3-{last note id}`). `--from-stage` and `--values` are refused for a run with `events`;
  a run without `events` keeps today's rule.

### Parking and continuing

- **Parking** takes the key's lock only to check once more for unacknowledged events and to write
  the `parked` ending, which carries nothing its last `wait` record doesn't say. It then lets go,
  closes the run's agents (panes and headless processes) with their sessions kept, and exits. So an
  event that comes while a run parks is either taken or wakes the parked run, and no sender waits
  on agents closing. A turn's end no wait took is an unacknowledged event, so a run never parks
  with one. A message an agent is handling, or a compaction, counts as a turn running.
- **A continue** waits until the previous attempt's process is gone, so two never share an agent's
  session, then runs from the top, reading the project's `.env` again (Q15). Agents are opened
  again by key on their kept native sessions (`claude --resume`, codex's `resume`), found from the
  earlier attempts' turns, without sending the workflow's instructions twice; a pane starts with
  the agent's first turn, not when it is opened. If a turn was cut, the engine writes its failed
  end before the code runs (Q17).
- **`awf tick`**, run on any schedule, calls `wake` on every run of a workflow with `events`, so it
  continues a parked run whose `until` has passed, a crashed one, and a failed one under Q13's
  limit. Runs without `events` are left as they are.
- **Only a workflow with `events` waits.** `receive` exists only on a workflow with `events`, by
  type and at run time. Such a workflow takes no input and is started only by an event: `awf run`
  refuses it, and `awf run --continue` is still allowed, for a run that needs the operator.
- **`return`** cancels a turn still running, and its ending records how many events were never
  acknowledged, taken or not, which `awf runs` shows. A later event for the key is refused (Q14).

### Turns

- `start()` takes what `run()` takes (`id`, `prompt`, `schema`, a deadline) plus `meta`, and
  returns once the turn is recorded and launched. `agent.turn` is `{ id, cancel }`, with no result:
  the end comes through the mailbox, and `agent.ended<M, T>(e)` is true for this agent's end and
  narrows `e.data` to `{ turn, meta: M, outcome: TurnOutcome<T> }`, the code saying what it started
  the turn with; the engine checks `outcome.value` against the turn's `schema`, as `run()` does. While `agent.turn` isn't `null`, the agent refuses `start()`, `run()`, `compact()`,
  `set()`, `fork()` and messages from other agents. An awaited `run()` writes no mailbox `turn`
  record and no `agent:ended`, only its `turns.jsonl` record, and a run never parks
  during it, since the code isn't at a wait. `agent.turn` clears when a wait takes the turn's end;
  on a continue, it is restored from the mailbox for a turn whose end no wait took. `cancel()` returns once the cancelled end is in the
  mailbox, and at once on a turn that has already ended. When the code throws, the engine cancels a
  running turn and writes its end before the `failed` ending.

### Participants

- A participant routed to the code (Q18) delivers each reply through the one way in, as
  `participant:reply` from its key, with the message's own id; `participant.replied(e)` picks its
  replies out. A parked run keeps its participants connected, so awf-chat keeps the thread.
  awf-chat is a separate app: this story gives it the command and tests it with a fake; the change
  in awf-chat follows it.

Alternatives rejected:

- Style A (one live script, state in closures, strict replay) — a code fix stops weeks-old runs as
  diverged, and the agent goes cold across `continueAsNew`.
- Style B (a handler per event kind) — sequences spread over handlers and a hand-kept phase.
- The Restate SDK (style D) — four processes, re-registering after each change, and a failing step
  that pauses the key.
- Refusing an event to a run that isn't live (the old todo's first question) — the run's id is its key, so
  continuing it is simple and keeps the thread.
- A registry of which workflows take which events — the sender knows its target, and naming it is
  what lets the event be checked statically.
- `agent:ended` from a library over `agents` and `emit` — a reboot mid-turn loses the promise
  that would send it.
- Names per agent (`investigator:ended`) — `tsc` can't check a name made from a key opened at run
  time; a closed set with the key in `from` it can.
- Emit outcomes that say what was done to the run (`started`, `rung`, `continued`) — every sender
  would then decide how runs are woken, and a limit on live runs or a daemon would change a
  published type. `wake` decides, once.
- A deadline relative to the call (`timeoutMs`) — a rerun would move it, unless the engine's record
  overrides the code, which is state outside the files.
- The running turn in a variable of the code — after a crash the fresh process starts a second
  turn, and the first turn's late end then clears the variable while the second runs.
- Delivering over the socket without appending first — an event sent as the run parks is lost.
- `take: "latest"` — drops events for good.
- Replaying every wait by its recorded events, with a name per round (`events-${round}`) — a wake
  walks weeks of old rounds to reach the new event, and plain code in them reads today's files, so
  it would start real turns about old rounds (Q9). The record would also grow every round, which
  is what `again(state)` was for.

Decided (2026-10-25): Q1, a wait takes all by default, `take: "oldest"` on request; Q2, the engine
writes `agent:ended`; Q3, the sender names its target; Q6, a turn cut by a reboot arrives as a
failed `agent:ended`, not started again, and the code decides whether to retry; Q4, a run started
by an event runs detached: its process is started in a session of its own (M1), has no terminal and
writes to the run's log, its pane
agents open in awf's Herdr session ([[024-herdr-run-session|story 024]]) and draw on the
subscription as any pane does, and `awf runs` and `awf logs -f` watch it. No `--pane`: a run's
process in a pane shows nothing `awf logs -f` doesn't, and closing the pane or restarting Herdr
would crash it; Q5, a lock per key, so two events at once
start one run and the other lands in its mailbox; Q7, a run that may reopen doesn't `return`: it
records the close in its files and parks, so a reopen is an ordinary continue, and a `return` ends
the run for good; Q8, `awf tick`, run on any schedule, calls `wake` on every run of a workflow with
`events`, which continues a parked one whose `until` has passed. A scheduler can be built on it
later; Q9, below.

### A wake doesn't replay the loop (Q9)

The first draft replayed every wait by its recorded events, with a name per round. A wake then
walked the old rounds to reach the new event, and plain code between them ran again against
today's files:

```ts
for (let round = 1; ; round++) {
  const events = await workflow.receive(`events-${round}`, …);    // replay: the old events
  if (!investigator.turn && kase.unseen().length >= 50) await investigator.start(…);   // today's file
}
```

```text
first time   round 1: 30 unseen → no turn      round 2: 55 unseen → turn #1     … parked at round 5
the wake     round 1: 80 unseen → turn!        round 2: 80 unseen → turn!       …
```

Asking the investigator at 80 is right; asking it in round 1, about weeks-old events, isn't. The
fix is to not have old rounds. A run parks only with no turn running and its wait's events
handled, so the loop's variables are empty then, and everything that matters is in the files. A
wake starts the loop fresh, and its one wait takes the new event:

```ts
for (;;) {
  const events = await workflow.receive(…);               // acknowledges the last batch, takes the next
  …
  if (!investigator.turn && kase.unseen().length >= 50) await investigator.start(…);   // today's file, today
}
```

This also removes the replay past a `return` (Q7's first problem), the record's growth per round,
`again(state)`, and `workflow-styles.md`'s "names in a long loop". The cost: a variable that held
state across rounds now lives in a file or a stage. Neither sketch needed one beyond the running
turn, which the engine keeps, the turn's batch, which `meta` carries, and when to retry a failed
turn, which the case's files keep and the wait's `until` reads.

## Tasks at a glance

- [ ] 1. The contract: `events`, `key`, `starts`, `file`, `receive`, `emit`, `start`, `turn`, the records, the names (Q10–Q12); reviewed before building
- [ ] 2. Stages by content in a run with `events`
- [ ] 3. The mailbox and `receive` in the engine
- [ ] 4. One way in: `awf emit --target`, the key's lock, append or refuse, `wake`
- [ ] 5. Parking: the `parked` ending, a continue to the wait with agents on their kept sessions, and `awf tick`
- [ ] 6. Turns not awaited: `start()`, `turn`, `agent:ended`, `cancel()`
- [ ] 7. A participant routed to the code: `participant:reply`, `post`
- [ ] 8. workflow-testing: scripted events
- [ ] 9. The Datadog case run on it, against its sketch

## Open questions

None open. Q1–Q9 are decided in "Proposed design". Q10–Q18 came out of review and were settled
there (2026-10-25), each by the reason it gives; they are grouped by the task they shape. Q16 went
into Q4. The published formats among them still stop for review at task 1.

### 1. The contract

- Q10. **Names made from keys and event ids.** Stage names are `[a-z][a-z0-9-]*` and run ids
  letters, digits, `.`, `_` and `-`. A key like `kombo-unique` fits; a commit id or `2084:abc` as an
  event id, `post-f3@abc123`, and a `/` between workflow and key don't. Decided: one grammar for keys,
  event ids and stage names, `[a-z0-9][a-z0-9._@-]*`, lowercase since records are files on a
  case-insensitive disk, so a stage named by an event id (`close-{event id}`) is always valid. A key
  or an event id that doesn't fit is refused at the sender; ids awf makes, a turn's end or a reply's
  message id, are made to fit. A run's id is
  `{workflow}.{key}`, with no `.` in a workflow's name, in the same grammar, checked whole against the 128 limit. It
  carries the workflow because a bare id that names runs of two workflows is ambiguous (`findRun`,
  `run-state.ts:126`) and `openRun` refuses one of another workflow (`runs.ts:178`). The ref becomes
  `dd-case/dd-case.kombo-unique`.
- Q11. **How `workflow.emit(caseRun, …)` finds the target's file.** Starting a run needs the file,
  and a definition doesn't know where it lives. Decided: the definition carries
  `file: import.meta.path`, written by the author, and a definition with `events` must have it.
  Finding the file among loaded modules would be magic with a fallback, and the file also decides
  where the run lives (Q15).
- Q12. **A new version of the code and a parked run.** Today a stage recorded under another major
  version isn't reused, and the run stops. A case parked for weeks meets every code change. Decided,
  since a run that parks for weeks must survive the code it is part of changing: in a run with
  `events`, a stage record is reused whatever the version, as long as its value still fits the
  stage's `result`; one that doesn't fit stops the run, ending `stopped`, as today.

### 5. Parking

- Q13. **An event for a run that keeps failing.** A run whose code threw ended `failed`; one whose
  process died (a syntax error, out of memory) has no ending. A bug would make every event, and
  every `awf tick`, fail it again. Decided, so a bug costs three attempts and not one per event:
  `wake` continues it, up to three failed or
  crashed attempts in a row, counted together and reset by a parked ending; after that the run is
  `stuck`, events are only appended, and it waits for `awf run --continue` by hand.
- Q14. **Starting a key again.** A returned run refuses its key for good. Decided: no way to start
  it again in this story. Neither sketch needs one: a Datadog case that may reopen parks instead of
  returning (Q7), an MR's iid is never reused, and a stuck run is fixed and continued (Q13). When a
  workflow needs a key back, a command could later move the run aside; it isn't built.
- Q15. **Where a keyed run lives.** Runs live under the sender's `{cwd}/.awf/runs` today. The
  triage tick, an engineer's `awf emit` from another directory, awf-chat and `awf tick` must all
  find the same run for a key, or a second run and Slack thread start. Decided, since the target's
  file is the one thing every sender names: a run with `events` lives under the `.awf/runs` of its
  project, the nearest directory above the target's file that holds `.awf/`, or else the file's
  own directory, whoever sends. awf records each such project in `~/.awf/projects` when it first
  starts a run there; `awf tick` goes through that list, and `awf runs`, `awf logs`, `awf inbox`
  and `awf send` find keyed runs through it too. The run always runs in its project, with the
  `PATH` recorded at its first start, and reads the project's `.env` again at every start and
  continue: its values are never recorded, so no secret lands in `.awf/runs`, and a rotated token
  reaches a run parked for weeks.

### 6. Turns not awaited

- Q17. **Agents that outlive their run's process.** A Herdr pane keeps working after the bun
  process dies, and a headless child can be orphaned. On continue, the engine writes a failed end
  and reopens the same session, so two writers could share it. Decided, since two
  writers on one session corrupt it and Q6 already gives up the turn: the continue stops the
  old run's panes and agent processes before writing the failed end and reopening, as Q6 already
  treats the turn as failed. Adopting a turn still running would keep its work but needs reattaching to
  a pane; not now.

### 7. A participant routed to the code

- Q18. **A participant routed to the code.** Decided, as the smallest change to today's
  participants: `participants.connect({ key, to: "code" })` routes its messages to the code, where
  a participant without `to` keeps today's routes to agents. awf-chat delivers a reply with
  `awf send dd-case/{id} --as thread --id {message id} {text}`. Today `awf send` needs an agent,
  has no `--id` and fails on a run that isn't live (`holder-command.ts`); for a participant routed
  to the code the agent is left out, `--id` is taken, and the reply goes through the one way in,
  not the socket, so it continues a parked run.

## To measure

- M1. **A pane claude started by a tick is on the subscription.** Measured 2026-10-25: yes. From
  a tab in the `awf` session (up for days), `awf run examples/quick-check/workflow.ts -- claude`
  was started detached and the tab closed; its pane claude opened with no login prompt, answered
  both questions, and the run recorded `billing: "subscription"` (awf's label, not a bill; no
  `ANTHROPIC_API_KEY` in the environment), `quick-check/20261025-1921-7981`. Started with
  `nohup … &` instead, the run was cancelled when the tab closed: a detached run must be started in
  a session of its own (`setsid`; Bun's `spawn` with `detached: true`), as Q4's runs are. Again
  after a reboot if something other than a terminal brought the server back.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. The contract

Outcome: the types, record formats and names are written, with both sketches type-checking against
them, and reviewed by the operator before anything is built.

Execution:

- [ ] Plan, implement, review, resolve, verify (as in the template).

Work:

- the contract types, with `enqueue` and `TurnRef` gone; the mailbox records and the `parked`
  ending; the data of `agent:ended` and `participant:reply` (text, author, message id, at); emit's
  outcomes; the wire's nudge; Q10–Q12; the contract's "placed once, as it opens" for a pane
  (`agents.ts:131`) becomes "placed at its first turn"; `docs/workflow-api.md`;
- the commands' usage and output: `awf emit`, `awf tick`, the changed `awf send`;
- the sketches as `.ts`, with what they use from outside this story (tools and the untargeted
  `workflow.emit` their handlers use, `singleton`, `workflow.allowance`) declared as stubs.

Done when:

- both sketches, their tests included (written against task 8's `testWorkflow` options), pass
  `tsc`, and a wrong name or shape of an event, the workflow's own or awf's, fails it.

### 2. Stages by content

Outcome: in a run with `events`, a succeeded stage record is reused wherever and however often
it is entered, in any attempt; a failed one runs again.

Done when:

- tests: a stage entered twice in one attempt runs once; a continue that runs a new stage first
  still reuses the old ones after it; a failed stage runs again on the next attempt and its record
  is replaced; a record from another version is handled as Q12 decides; `--from-stage` and
  `--values` are refused for a run with `events`; a run without `events` behaves as today.

### 3. The mailbox and `receive`

Outcome: a run takes events at its waits; a wait called again acknowledges what it returned;
`awf runs` shows the label.

Done when:

- tests: events taken in arrival order, and one at a time with `take: "oldest"`; a duplicate id
  appended once; a wait called again acknowledges its last batch and takes the next; after a crash,
  the first wait returns the batch it took and hadn't acknowledged, alone; a wait in a stage
  returns its recorded batch on a rerun and takes no later event; a wait whose `until` passed
  returns none, recorded as an empty `took`; a rerun that computes the same `until` waits for the
  same time; `awf runs` shows a waiting run's label; `receive` on a workflow without `events` is an
  error.

### 4. One way in

Outcome: `awf emit --target` refuses an event its target doesn't declare, that doesn't match the
schema, or that has a colon in its name; otherwise it appends under the key's lock, or refuses for
a returned run or a non-starting event with no run, and `wake` starts, nudges or continues the run.

Done when:

- tests for each outcome (`accepted`, `duplicate`, `refused`); a refused or duplicate event is not
  appended; a wrong name, shape or colon is an error, not an outcome; an event without an id gets
  one and isn't deduplicated; each row of `wake`'s table, from an emit and, but for the first, from `awf tick`; an emit and a
  tick at once continue a parked run once;
  `awf emit` prints what `wake` did; `awf run` refuses a workflow with `events`; two events for one
  key at once start one run (Q5); an event sent while the run parks is taken or wakes it; a nudge
  that fails leaves the event in the mailbox and is not an error; a lock left by a killed process is
  taken over; `workflow.emit` to a target finds its file by its `file` (Q11), and a definition with
  `events` and no `file` is refused.

### 5. Parking

Outcome: a run waiting with no turn running and no event unacknowledged ends `parked`,
and its process exits; a continue runs from the top and takes what arrived at its wait, with its
agents on their kept sessions.

Done when:

- tests: a parked run continued with one new event takes it at the loop's wait and runs no
  recorded stage again; a decision after the wait reads the files as they are at the wake; parking
  holds the key's lock only to check and write `parked`, then closes the run's agents, and a
  continue waits for the previous process to be gone; a pane and a headless agent each reopen
  on their session, and a pane agent opened on a continue starts no pane until its first turn;
  a continue resumes each agent's last session without sending its instructions again; `awf tick`
  continues a parked run whose `until` passed, a crashed one and a failed one under Q13's limit,
  leaves the others, and leaves
  crashed runs without `events`; senders in different directories, and `awf tick`, find the same
  run, as Q15 decides; a continue from another directory with a stripped environment behaves like
  the first start, and reads a changed `.env`; a run started by an event is detached, with its output in the run's log, and outlives the
  sender's terminal closing (Q4, M1);
  a run that keeps failing behaves as Q13 decides, a returned
  run's ending counts the events it never took; `awf runs` shows a parked run and where.

### 6. Turns not awaited

Outcome: `start()` returns at once; while `agent.turn` isn't `null` the agent refuses other work;
`agent.turn` stays set until a wait has taken the turn's end; the end arrives as `agent:ended`
with its id and `meta`; `cancel()` stops it.

Done when:

- tests with a fake agent: an event during a turn is taken before the turn ends; code that throws
  with a turn running cancels it and writes its end before the `failed` ending; `start()`, `run()`,
  `compact()`, `set()`, `fork()` and a message to the agent are refused while a started turn is set; a turn that ended but whose
  end hasn't been taken still refuses them; a continue after a crash restores `agent.turn` from
  the mailbox for a turn whose end no wait took; `agent:ended` carries the turn's id and `meta`, also when the engine writes it after
  a crash, and `agent.ended(e)` matches only its own agent's; a process killed between writing the
  turn record and launching the agent leaves a failed end, not an orphan; `cancel()` returns once
  the cancelled end is in the mailbox, and at once on an ended turn; a turn left without an end by
  a killed process arrives as a failed `agent:ended` before the code runs again, and a pane turn is
  handled as Q17 decides; a `return` cancels a running turn.

### 7. A participant routed to the code

Outcome: a participant routed to the code, as Q18 decides, turns each reply into
`participant:reply`, through the same way in as an emit; `post` writes back without a turn; a
parked run keeps its participants.

Done when:

- tests: a reply to a live run, and a reply to a parked run that continues it, both through
  `awf send --as … --id …` with no agent; a reply delivered twice is appended once; a parked run's participant is still listed in `awf inbox`, and a continue
  reattaches the same participant; a fake chat host receives `post`'s text. awf-chat's own change
  follows this story.

### 8. workflow-testing

Outcome: a workflow's test gives the first event and scripts later ones at points in the run, such
as `{ during: "investigator#1", name: "participant:reply", from: "thread" }`, where
`investigator#1` is that agent's first turn. `testWorkflow` takes the starting `event`, whose
`key(event)` is the run's key, and `files` to lay out before the run; it returns when the run parks
or returns, and fails a run that starts more turns than `maxTurns` (20 by default), so a loop that
never parks fails the test instead of hanging it. `run.stages`, as today, lists the stages that
ran, and `run.emits` the events the run sent to other workflows, which a test doesn't start.
`run.turnsOf(agent)` gains each turn's `prompt`. A scripted awf event may give part of its `data`;
`testWorkflow` fills the author, time and id.

Done when:

- the Datadog sketch's `case.test.ts` passes as written.

### 9. The Datadog case run

Outcome: the watcher's case run is the sketch's `case.ts`; the polling and the triage tick's run
management are gone. `verdict.json` stays, read when a turn ends, in place of the `close_case` tool,
until [[workflow-tools]] lands; the triage tick runs without `singleton` and `workflow.allowance`,
which aren't in the contract yet. `awf tick` runs in a loop in awf's Herdr session, as the engineer, so it starts runs in the
environment their pane agents open in (M1).

Done when:

- a live case: occurrences below the threshold start no turn; a reply during a turn, delivered by
  hand with Q18's command until awf-chat has it, gets the next one; a close from the triage tick
  cancels a running turn; a failed turn is retried by `awf tick` after its `until`.
