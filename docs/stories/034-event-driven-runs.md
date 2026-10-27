---
id: "034"
title: "An event starts a run, and wakes it while it runs"
summary: "A workflow declares the events it takes and the id of the run each is for. awf emit starts that run or lands in its mailbox; the run's code takes every waiting event at a wait, starts agent turns without awaiting them, and hears their end as an event. Between events the run parks and no process runs. Code handles most events and an agent gets a turn only when judgement is needed."
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

After this story, a workflow says which events it takes and the id of the run each belongs to. An
event starts that run if it has none, and otherwise lands in its mailbox. The run's code takes the
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
awf emit --target case.ts --id {case} dd.changes {json} --event-id {commit}     the triage tick, a script
        │  checked against case.ts's events: a wrong name or shape is an error
        ▼
  run = dd-case/{case}; under the run's lock: a repeated id ► duplicate; the run returned, or no run
        │  and not a starting event ► refused; otherwise appended ► accepted, and the run is woken:
        │    no run ► started    live ► nudged over its socket    parked or crashed ► continued
        ▼
  ┌──────────────────────── run "dd-case/{id}" ────────────────────────┐
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

- **The definition** declares `events: { name: schema }`, `starts: [names]`, optional, the events
  that may start a run, every event when absent, and `file: import.meta.path`, which tells a sender
  where the workflow lives. The sender names the run an event is for, by its id, as `awf send`
  names a run; its ref is `{workflow}/{id}`, as for any run, and `awf run {file} --id {id}` starts
  one with no event, which parks at its first wait (task 10).
- **The sender names its target**, the workflow the event is for, so a wrong name or shape fails
  at the sender: `tsc` for `workflow.emit(caseRun, run, "dd.changes", data, { eventId })`, which imports the
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
export default defineEventWorkflow({
  definition: {
    meta: { name: "dd-case", description: "Investigate one Datadog case in its own thread." },
    file: import.meta.path,
    events: { "dd.changes": Changes, "dd.closed": Closed },
    starts: ["dd.changes"],
    async run(workflow) {
      const kase = openCase(workflow.runId);                     // the files hold the state
      const thread = await workflow.participants.connect({ key: "thread", to: "code" });
      const investigator = await workflow.agents.open({ key: "investigator", runtime: "claude" });

      for (;;) {
        const events = await workflow.receive({                  // the first takes the event that started it
          label: investigator.turn ? "investigating" : `${kase.unseen().length} unseen`,
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
awf emit --target case.ts --id kombo-unique dd.changes '{"case":"kombo-unique"}' --event-id 83d34d7   # per changed case
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

- `events`, `id`, `starts` and `file` on the definition; `receive`; `awf run --id` with no event;
  `workflow.emit` to a target;
- the run's mailbox: append under the run's lock, deduplicate by id within the run, what each wait
  took and acknowledged, its `until` and label;
- stages by content in a run with `events`: a record reused wherever it is entered;
- `awf emit --target {workflow} --id {id} {name} {json} [--event-id {id}]`: check against the target's
  schema, append, wake the run, and print the outcome;
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

- tools an agent calls ([[035-workflow-tools|story 035]]), which doesn't depend on this one, and
  the emit to the run's own mailbox a tool's handler may use, a follow-up after both; 035, landing
  second, takes the rules in its "With story 034"; this story's port has none;
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
  the run's lock for it.
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
  stages by content in a run with `events`; the stage and run names of Q10; the run's lock.
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
  appended under the run's lock, and `wake(run)` acts on the run before the lock is let go. `awf
  tick` takes each run's lock and calls the same `wake`, so two wakers never both continue a run. A
  limit on live runs, later, goes here and nowhere else.

  | The run | `wake` |
  | --- | --- |
  | none: a starting event was just appended, or `awf run --id` made it | starts it |
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
- **The run's lock** is a file beside the run directory, `{root}/{workflow}/{run id}.lock`, so it
  exists before the run does. It is claimed by linking into place, as a run folder is, and holds
  the holder's pid and process start; when `isLive` says that process is gone, it is stale and
  taken over.

### The mailbox and waits

- **A mailbox per run**, an append-only file in the run directory, `mailbox.jsonl`; it is not what
  `awf inbox` shows, which is a coordinator's questions. Every append, the run's own included, is
  made under the run's lock. Each record has a `kind`:
  - `event`, `{ id, name, data, from, at }`;
  - `wait`, `{ until, label, stage }`, a wait called; outside a stage it acknowledges what the last
    `took` outside one returned, and in a stage nothing, as the stage holds its own batch;
  - `took`, `{ ids, stage }`, the wait returning, with `ids` empty when its `until` passed;
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

- **Parking** takes the run's lock only to check once more for unacknowledged events and to write
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
- **`awf tick`**, run on any schedule, calls `wake` on every run of a workflow with `events` in
  its project, or with `--all` in every project awf recorded (Q8, task 12), so it continues a parked run whose `until` has passed, a crashed one, and a failed one under Q13's
  limit. Runs without `events` are left as they are.
- **Only a workflow with `events` waits.** `receive` exists only on a workflow with `events`, by
  type; at run time a plain run's `receive` rejects. Such a workflow takes no input. An event
  starts its run, or `awf run --id {id}` with none, detached in its project like an event's, and
  it parks at its first wait. That start ignores `starts`, and wakes a run already there, as `awf tick` would. `awf run --continue` is
  allowed too, for a run that needs the operator.
- **`return`** cancels a turn still running, and its ending records how many events no wait
  took, which `awf runs` shows; the batch the code returned after was handled. A later event for the key is refused (Q14).

### Turns

- `start()` takes what `run()` takes (`id`, `prompt`, `schema`, a deadline) plus `meta`, and
  returns once the turn is recorded and launched. `agent.turn` is `{ id, cancel }`, with no result:
  the end comes through the mailbox, and `agent.ended<M, T>(e)` is true for this agent's end and
  narrows `e.data` to `{ turn, meta: M, outcome: TurnOutcome<T> }`, the code saying what it started
  the turn with; the engine checks `outcome.value` against the turn's `schema`, as `run()` does. While `agent.turn` isn't `null`, the agent refuses `start()`, `run()`, `compact()`,
  `set()` and `fork()`; messages from other agents wait until a wait takes the end, and a reply
  awaited from it is refused, as the code that would take the end may be waiting on that reply. An
  awaited `run()` writes no mailbox `turn`
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
`events` in the project it runs in, as every other command reads that folder's runs, and
`awf tick --all` on every project in `~/.awf/projects`; a wake continues a parked run whose
`until` has passed. Changed 2026-10-26 from every project by default (task 12). A scheduler can be
built on it later; Q9, below.

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

- [x] 1. The contract: `events`, `key`, `starts`, `file`, `receive`, `emit`, `start`, `turn`, the records, the names (Q10–Q12); reviewed before building
- [x] 2. Stages by content in a run with `events`
- [x] 3. The mailbox and `receive` in the engine
- [x] 4. One way in: `awf emit --target`, the run's lock, append or refuse, `wake`
- [x] 5. Parking: the `parked` ending, a continue to the wait with agents on their kept sessions, and `awf tick`
- [x] 6. Turns not awaited: `start()`, `turn`, `agent:ended`, `cancel()`
- [x] 7. A participant routed to the code: `participant:reply`, `post`
- [x] 8. workflow-testing: scripted events
- [ ] 9. The Datadog case run on it, against its sketch
- [x] 10. One run id: the sender names the run, no `key`, no `{workflow}.` prefix, `starts` optional, `awf run --id` with no event
- [ ] 11. One kind of workflow: `events` optional on `defineExecutableWorkflow`, `defineEventWorkflow` gone; design reviewed before building
- [x] 12. `awf tick` wakes its own project's runs; `--all` wakes every project's

## Open questions

Q19 is open. Q1–Q9 are decided in "Proposed design". Q10–Q18 came out of review and were settled
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
  **Revised in task 10** (2026-10-26): the ref already names the workflow and every sender names
  its target, so the prefix said it twice. `key` went, the sender names the run, and the ref is
  `dd-case/kombo-unique`, as for a run without events. Run ids keep one
  grammar for both kinds, case kept as a ticket's key has it (`createRun` refuses an id differing
  only in case); event ids and stage names stay lowercase.
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
  starts a run there; `awf tick --all` goes through that list, and `awf runs`, `awf logs`, `awf inbox`
  and `awf send` find keyed runs through it too. The run always runs in its project, with the
  `PATH` recorded at its first start, and reads the project's `.env` again at every start and
  continue: its values are never recorded, so no secret lands in `.awf/runs`, and a rotated token
  reaches a run parked for weeks. Of the waker's environment the attempt gets only who and where
  the engineer is (`HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM`), the
  machine's plumbing (`SSH_AUTH_SOCK`, the proxy variables, `XDG_*`), and awf's own
  `AWF_COORDINATOR_DIR` and `AWF_HERDR_SESSION`, which are the engineer's, not the run's, and only
  in the environment, never in `.env`. A variable already set would win over `.env`, so anything
  else a run needs, such as `CLAUDE_CONFIG_DIR` or a token, goes in the project's `.env`. An
  operator's own `awf run --continue` runs with their whole environment. A file directly in home
  has no project, as `~/.awf` is awf's own, and is refused (decided in task 4's review). A ref
  found in two projects, workflows of one name keyed alike, is refused naming both; `--cwd`
  chooses (task 7's review).

### 6. Turns not awaited

- Q17. **Agents that outlive their run's process.** A Herdr pane keeps working after the bun
  process dies, and a headless child can be orphaned. On continue, the engine writes a failed end
  and reopens the same session, so two writers could share it. Decided, since two
  writers on one session corrupt it and Q6 already gives up the turn: the continue stops the
  old run's panes and agent processes before writing the failed end and reopening, as Q6 already
  treats the turn as failed. Adopting a turn still running would keep its work but needs reattaching to
  a pane; not now. Measured in task 6 (2026-10-26): with the old attempt's process group stopped
  and its panes swept, resuming a codex session the killed attempt was writing is refused by codex
  itself, "thread … already has an active writer", as its thread store still counts the killed
  writer. So a continue after a crash stops the old panes and processes, writes the failed end, and
  opens its agents on new sessions; a continue after a parked or ended attempt reopens the kept
  ones. To confirm with the operator.

### 7. A participant routed to the code

- Q18. **A participant routed to the code.** Decided, as the smallest change to today's
  participants: `participants.connect({ key, to: "code" })` routes its messages to the code, where
  a participant without `to` keeps today's routes to agents. awf-chat delivers a reply with
  `awf send dd-case/{id} --as thread --event-id {message id} {text}`. Today `awf send` needs an agent,
  has no `--id` and fails on a run that isn't live (`holder-command.ts`); for a participant routed
  to the code the agent is left out, `--id` is taken, and the reply goes through the one way in,
  not the socket, so it continues a parked run.

- Q19. **What wakes a run isn't in its definition.** Open (2026-10-26). `events` lists only the
  workflow's own events, `dd.changes` and `dd.closed`, yet a reply in the case's thread wakes the
  parked run too: `participant:reply` comes from `participants.connect({ to: "code" })` inside
  `run`, and `agent:ended` from `agent.start()`. Reading the definition, the operator can't tell
  that a Slack reply starts an attempt; they have to know what `to: "code"` does. To decide: keep
  it as it is and document it; declare the participant in the definition, beside `events`, so
  every wake source is listed in one place; or something else.

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

- [x] Plan, implement, review, resolve, verify (as in the template).

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

- a stage replaced more than once in an attempt keeps each replaced record:
  `replaced/{stage}.{attempt}.json` assumes one per attempt, so it gains a sequence number;
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
  returns its recorded batch on a rerun and takes no later event, and one whose work returns
  other events than its one wait took fails; a wait whose `until` passed
  returns none, recorded as an empty `took`; a rerun that computes the same `until` waits for the
  same time; `awf runs` shows a waiting run's label; `receive` on a workflow without `events` is an
  error.

### 4. One way in

Outcome: `awf emit --target` refuses an event its target doesn't declare, that doesn't match the
schema, or that has a colon in its name; otherwise it appends under the run's lock, or refuses for
a returned run or a non-starting event with no run, and `wake` starts, nudges or continues the run.

Done when:

- tests for each outcome (`accepted`, `duplicate`, `refused`); a refused or duplicate event is not
  appended; a wrong name, shape or colon is an error, not an outcome; an event without an id gets
  one and isn't deduplicated; each row of `wake`'s table, from an emit and, but for the first, from `awf tick`; an emit and a
  tick at once continue a parked run once;
  `awf emit` prints what `wake` did; `awf run` refuses a workflow with `events`; two events for one
  key at once start one run (Q5); a nudge that fails leaves the event in the mailbox and is not an
  error; (`awf tick`'s rows, an emit and a tick at once, and an event while the run parks moved to
  task 5, which builds both); a lock left by a killed process is
  taken over; `workflow.emit` to a target finds its file by its `file` (Q11), and a definition with
  `events` and no `file` is refused.

### 5. Parking

Order in a continue's process, which `wake` relies on, since it holds the run's lock until the
attempt is claimed: claim the attempt first, taking no key lock; then wait for the previous
attempt's process to be gone; then stop its panes and agent processes and write the failed ends
(Q17), each append under the lock. A test holds that order.

Outcome: a run waiting with no turn running and no event unacknowledged ends `parked`,
and its process exits; a continue runs from the top and takes what arrived at its wait, with its
agents on their kept sessions.

Done when:

- tests: a parked run continued with one new event takes it at the loop's wait and runs no
  recorded stage again; a decision after the wait reads the files as they are at the wake; parking
  holds the run's lock only to check and write `parked`, then closes the run's agents, and a
  continue waits for the previous process to be gone; a pane and a headless agent each reopen
  on their session, and a pane agent opened on a continue starts no pane until its first turn;
  a continue resumes each agent's last session without sending its instructions again; `awf tick`
  continues a parked run whose `until` passed, a crashed one and a failed one under Q13's limit,
  each row of `wake`'s table but the first from `awf tick`, leaves the others, and leaves
  crashed runs without `events`; an emit and a tick at once continue a parked run once; an event
  sent while the run parks is taken or wakes it; senders in different directories, and `awf tick`, find the same
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
  `compact()`, `set()` and `fork()` are refused while a started turn is set, and a message to the agent waits; a turn that ended but whose
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
  `awf send --as … --event-id …` with no agent; a reply delivered twice is appended once; a parked run's participant is still listed in `awf inbox`, and a continue
  reattaches the same participant; a fake chat host receives `post`'s text. awf-chat's own change
  follows this story.

### 8. workflow-testing

Outcome: a workflow's test gives the first event and scripts later ones at points in the run, such
as `{ during: "investigator#1", name: "participant:reply", from: "thread" }`, where
`investigator#1` is that agent's first turn. `testWorkflow` takes the starting `event`, whose
`id`, the run's, and `files` to lay out before the run; it returns when the run parks
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
until [[035-workflow-tools|story 035]] lands; the triage tick runs without `singleton` and `workflow.allowance`,
which aren't in the contract yet. `awf tick` runs in a loop in awf's Herdr session, as the engineer, so it starts runs in the
environment their pane agents open in (M1).

Done when:

- a live case: occurrences below the threshold start no turn; a reply during a turn, delivered by
  hand with Q18's command until awf-chat has it, gets the next one; a close from the triage tick
  cancels a running turn; a failed turn is retried by `awf tick` after its `until`.
- the sketch's `case.test.ts`, ported beside `case.ts`, passes with no `todo` (task 8's Done when),
  its files laid out under the run's directory, as `files` takes them, with the case root found
  from `workflow.cwd`; `examples/event-sketches/mr-review.test.ts` stays a sketch, `todo`, until
  the review loop is ported.

### 10. One run id

Outcome: a run of a workflow with events is named the way any run is, by whoever starts it or
sends to it: `awf emit --id {id}`, `workflow.emit(target, id, …)`, `awf run --id {id}`. The
definition has no `key` and no routing function, the run's id has no `{workflow}.` prefix, so the
ref is `{workflow}/{id}`, and `workflow.key` goes, `workflow.runId` says it. `starts` may be left
out, and then every event starts a run. `awf run {file} --id {id}` starts a run with no event,
which parks at its first wait; `testWorkflow` takes `{ id, event? }`.

Done when:

- an emit with `starts` absent starts a run from any event; `awf emit` without `--id` is an
  error; `awf run --id` starts a run that parks with no event, says so for one already there and
  for one that returned, and refuses an event workflow without `--id`, and the flags a wake can't
  pass on; `--id` names the run on `awf run` and `awf emit`, `--event-id` an occurrence on `awf
  emit` and `awf send`, and `--continue` is a switch; `testWorkflow(…, { id })` parks at the
  first wait; the docs and the sketches name runs at the sender.

### 11. One kind of workflow

Outcome: a workflow is one definition, and `events` is optional on it. The split into
`defineEventWorkflow` came from typing alone (task 1's notes: a context type per kind, and an
overload a generic helper lost); the runtime needs only a run's way in, its id, and code safe to
run again from the top, which `--continue` already asks of it (ADR 0011). The split costs: the
watcher's tick, while it had `events`, could only start through a made-up `awf emit`, and a case
can't be started by hand to try it. So:

- `awf run {file}` starts any workflow with its args; one with `events` also starts from an event
  in `starts`, sent to the run its sender names (task 10).
- any run may `receive` while it lives and park at a wait with nothing to do; it returns when done.
- the context's typing follows whether `events` is declared, with no second function; that
  replaces the overload task 1 rejected.

To decide in review, before building: whether a workflow with `events` takes args at all, since its
run's id is its one input and the rest comes as events or files, and whether a run with no
`events` may park at all.

Done when:

- `defineEventWorkflow` is gone, with no shim, and the watcher's `case.ts` and the examples use
  the one definition; `tsc` still refuses `receive` in a workflow without `events`, including one
  wrapped in a generic helper.
- `awf run case.ts -- {args}` starts a case by hand, and an emit for its id lands in that run.
- a workflow without `events` behaves as today.

### 12. A tick for its own project

Outcome: `awf tick` wakes the runs with `events` of the project it runs in, the one `awf runs`
there lists, and `awf tick --all` keeps today's loop over every project in `~/.awf/projects`
(Q8, changed 2026-10-26). Why: every other command works on its folder, and a tick that reaches
every project is the riskier default. A test in a scratch folder wakes real runs elsewhere, a
folder in the list that is gone fails every tick on the machine, and each tick reads every
project's runs when one is due. Finding a run by its id from any folder, for `emit`, `send`,
`runs`, `logs` and `inbox` (Q15), stays as it is: only what the tick wakes changes.

Done when:

- tests: `awf tick` in one project leaves a due run in another; `--all` wakes both; `awf tick` in
  a folder with no `.awf/runs` wakes nothing and exits 0; a gone folder in `~/.awf/projects` fails
  only `--all`.
- `awf tick --help`, `docs/workflow-api.md` and the watcher's `process-compose.yaml`, whose
  `awf-tick` runs in the watcher's folder, say the same.

## Implementation notes

Task 10 replaced `key` with `id` and dropped the `{workflow}.` prefix; the notes of tasks 1–8
keep the names they were built with.

### Task 1: the contract

Built in the worktree `../worktrees/awf-event-driven-runs`, branch `event-driven-runs`.

- **Where the types live.** A new `contract/src/workflow/events.ts` holds the event types, the name
  grammar (`NAME_PATTERN`, `nameProblem`, used by stage names too) and emit's outcomes. A workflow
  with `events` is its own definition and executable, `EventWorkflowDefinition` and
  `ExecutableEventWorkflow`, made with `defineEventWorkflow` and its own kind,
  `awf.event-workflow/v1`, which `isEventWorkflow` reads. Its context, `EventWorkflowContext`, has
  `key`, `receive`, agents that are `EventAgentRef`s (`start`, `turn`, `ended`) and a participant
  directory that routes to the code; a workflow without `events` fails `tsc` on each. `emit` is on
  every context, since a tick without `events` sends.
- **A function of its own, not an overload of `defineExecutableWorkflow`**: with overloads, a
  definition wrapped in a generic helper took the first overload's context type. This is the
  story's only rename: its snippets say `defineEventWorkflow`.
- **A colon in an event name fails `tsc`** (`NoColonNames`), and at load for a file `tsc` didn't see.
- **`receive`'s `label` is a string**, not the sketches' `() => string`: it is computed at each
  call either way, and nothing changes while the code waits.
- **A wait in a stage**: `took` carries `stage`, and on a rerun the stage returns the batch read
  back from the mailbox, so `stage(name, () => workflow.receive(…))` needs no `result`;
  `EventWorkflowContext.stage` has that overload.
- **`agent.ended<Meta, T>(e)`**: `T` defaults to `JsonValue`, so `ended<Batch>(e)` is enough.
  `start()` takes `run()`'s spec plus `meta` and returns the `StartedTurn`, which is also
  `agent.turn`; `cancel()` resolves `false` on a turn that had ended. `enqueue` and `TurnRef` are
  gone; `AgentTextTurnSpec` and `AgentStructuredTurnSpec` stay, as the harness's turn spec.
- **Ids.** Ids starting `awf.` are awf's and a sender's are refused: an end is
  `awf.end.{hash of agent key and turn id}`, so it fits the grammar whatever the key and is kept
  once; an event sent without an id gets `awf.{random}`. A chat message id and an emit's id are
  both a sender's, and may collide; naming occurrences apart is the senders'.
- **`participant:reply`'s data is `{ text, author? }`**: the message id is the event's id and its
  time the event's `at`. `awf send` takes `--author` for it.
- **`parked`** is an `AttemptOutcome`, its own `Ending` arm and `output.json` outcome, each with the
  last wait's `label` and `until`. Lab reads `awf run`'s record only, never parked since `awf run`
  refuses a workflow with `events`: its `RunOutput` excludes it, and its formats are unchanged.
- **Records.** `MailboxRecord` (`mailbox.jsonl`, version 1): `event`, `wait`, `took` and `turn`,
  each with `at`, and `attempt` on the run's own. `RunRecord` gains `key` and `env: { PATH }`;
  `AttemptRecord` gains `unacknowledged` for a returned run, and its `file` is where a wake that
  names no target continues from. The wire gains `{ command: "nudge" }`, answered by the internal
  `NudgeWireResult`, `{ v: 1, code: "nudged" }`, kept out of `awf send`'s published output.
- **Names (Q10).** Stage names take the shared grammar in every run, a superset of today's; run ids
  also take `@` past their first character, for `{workflow}.{key}`. An event workflow's `meta.name`
  has no `.` (checked at load), and the whole run id is checked against 128.
- **Commands and their output**, built in tasks 4, 5 and 7, typed in `records.ts`:
  - `awf emit --target {file} {name} [{json}] [--id {id}] [--json]`: an outcome exits 0, `refused`
    included, so a script going through cases doesn't stop; a wrong name or shape, a colon or an
    `awf.` id exits 2. It prints `{outcome} {ref}: {did}`, with why when there is one, such as
    `accepted dd-case/kombo-unique: started` or `refused dd-case/x: returned` (task 10's names);
    `--json` is `EmitResultJson`, `{ v: 1, outcome, run, id, did, why? }`, with `did` one of
    `started`, `nudged`, `continued`, `none` and `why` a closed set (`WakeWhy`).
  - `awf tick [--json]`: a line per run it woke, `continued {ref}: until`, and nothing when it woke
    none; `--json` is `TickResultJson`, `{ v: 1, woke: [{ run, did, why }] }`, the same words.
  - `awf send {ref} --as {participant} --id {message id} [--author {name}] {text}`, for a
    participant routed to the code: no agent, it prints as `awf emit` does, and `--json` is
    `EmitResultJson`.
  - `awf inbox` gains a `post` item, `{ kind: "post", coordinator, id, text }`, printed
    `{id}  run → {participant}` and the text.
  - `awf runs` gains the `parked` and `stuck` states, and `waiting: { label?, until? }` for a run
    at its wait, live or parked.
  - `~/.awf/projects`: one absolute project directory per line, appended when awf first starts a
    keyed run there.
- **The sketches as `.ts`** are in `examples/event-sketches/`: the Datadog case run and tick, and
  the review loop's run and tick, with their domain files and what comes after this story (tools
  and the emit to the run's own mailbox, `singleton`, the allowance) declared as stubs. Their tests
  are `test.todo` until task 8 makes `testWorkflow` run them; they type-check now.
  `events.typecheck.ts` holds what `tsc` must refuse: an undeclared or misspelled name read at a
  wait, wrong data, awf's names sent by a sender, a colon in a declared name, and `receive`, `key`,
  `start` or `to: "code"` on a workflow without `events`.
- **Review 1** (architecture): 12 findings, all applied as above: the file a wake continues from,
  awf's ids, a wait in a stage, `EventAgentRef`, the nudge's answer kept internal, the run-id
  grammar, the undrafted formats, the parked record without a shim and lab left alone,
  `defineEventWorkflow`, the colon in `tsc`, `env`, and the story's snippets.
- **Review 1** (correctness): 11 findings. Four were the architecture review's, fixed above (a
  colon in a name, awf's ids, `start` on every agent, a leading `@`). Fixed: `Pass` in the review
  loop sketch has a value, so `bun test` loads it; `OutputOf` gives `JsonValue` for a schema
  without a type carrier, as a stage's result does; `events.typecheck.ts` and `dd-case.test.ts` pin
  each wrong shape of awf's own events. Dispositioned: a key too long for its run id is refused
  where the run id is made, task 4, as `key`'s doc says; a starting event outside `starts` in a
  test is refused at run time, as `awf emit` refuses it, rather than adding a type parameter for
  `starts` to the published definition; a stage name over 128 is now refused, the one way the
  grammar is not a superset (none in the repo or the sketches is near it); a parked attempt whose
  cleanup failed stays parked, as a completed one stays completed.
- **Review 2**: clear of blockers; six small findings, all fixed: a stage around a wait whose
  work returns other events than its wait took fails (task 3's tests); `awf tick`'s `did` is only
  `continued`; `stuck`'s doc on `RunStateJson`; reply ids are a sender's, not `awf.`; a generic
  helper over `defineEventWorkflow` types its parameter `NoColonNames<E>`; a stage replaced twice
  in an attempt keeps both (task 2's details). `docs/design/README.md` no longer lists `signals`,
  `enqueue` or `TurnRef`.
- **Review 3**: two leftovers, fixed: a sentence doubled in `stage`'s doc, and `Signals` still in
  `docs/design/README.md`'s table, now `emit` on `WorkflowContext`. Clear.
- **Verified**: `bun run check` passes (Biome, `tsc`, boundaries); `bun test` 1990 pass, 1 fail, the
  workflow-api samples test that fails on main too; the sketches' tests are `todo`. Live, on the
  changed engine, `examples/quick-check` completed on codex headless and on claude in a pane
  (`quick-check/20261025-1950-bc1d`, `-3334`). Operator review of the formats was taken as a
  self-review gate in this approved story; the formats above are what to look at first.

### Task 2: stages by content

- **Where.** `planStageByContent` in `stage-plan.ts`, pure: a succeeded record whose value fits is
  reused whatever its version (Q12), one that doesn't fit stops the attempt, a failed record or
  none runs. `StageLedger` takes `byContent`, set by `runWorkflow` for a definition with `events`;
  it keeps the run's records as they stand, this attempt's included, so a name entered again in
  the same attempt is reused from what it just wrote. There is no start point and no
  `replaceStale`; a record a run replaces, a failed one, moves to `replaced/` as it is written.
- **A name entered again** in the attempt that ran it hands back its value with no second line in
  the view or the event log: the stage happened once.
- **`replaced/{stage}.{attempt}.json`** takes `.{n}` from 2 for a stage replaced again in the same
  attempt; nothing parses those names.
- **`--from-stage` and `--values`** are refused by the ledger for a run with `events`; `awf run
  --continue` reaches that once the loader takes event workflows (task 4).
- Alternative rejected: a second ledger class for by-content runs. The two rules share opening,
  recording, sealing and the view; only entering differs.
- **Review** (one agent, both lenses, as the diff was small): 7 findings, all fixed or recorded. A
  failed write after its record was moved no longer breaks the reruns after it (`#records` drops
  the moved record); `--from-stage` and `--values` are refused in `startWorkflow` before anything
  opens, and the ledger keeps the check as an invariant; nothing is `upcoming` in a by-content run,
  where an earlier event's stage may never be entered again; a stage re-entered in the attempt that
  ran it counts as reused, so it is never where the attempt ended; a further replacement in one
  attempt is `{stage}.{attempt}+{n}.json`, which no stage's name can read as. Recorded: the view
  keeps one line per name, the last run of it, as the stage happened once; the event log keeps
  each run. Tests added for the event-log lines, a misfit at the same version stopping the attempt
  as `WorkflowStopped`, and nothing upcoming. Owed to task 3, where `testWorkflow` runs an event
  workflow: the runner's `byContent` wiring and its refusal of `--from-stage` and `--values`. Not
  tested: a write failing after its record moved, which needs a fault the file layer has no seam
  for; the fix is one line.
- **Verified**: `bun test packages/engine/src/stage-ledger.test.ts` 21 pass; `bun test
  packages/engine` and `bun run check` pass.

### Task 3: the mailbox and `receive`

- **Where.** `engine/src/mailbox.ts`: `foldMailbox`, pure, which reads the records in order (a
  `wait` acknowledges the last `took`; a `took` in a stage acknowledges its own batch, which the
  stage holds; the first event under an id is the one kept), and `RunMailbox`, a live run's waits.
  Every append goes through an `append` the runner gives it, so task 4 puts the run's lock there
  and nothing here changes. The runner adds `key` and `receive` to the context of a run with
  `events`; a plain run's `receive` rejects, "receive needs a workflow with events".
- **A wait** writes `wait`, then reads the mailbox until it has events not yet acknowledged, or its
  `until` passes, and writes `took`. It is armed before each read, so a nudge between the read and
  the wait is not lost, and it polls the mailbox's size each second, so a nudge that failed loses
  only that second. One wait at a time: a second while one waits throws.
- **After a crash**, the attempt's first wait outside a stage returns the held batch alone and
  writes nothing, so the batch stays held until the next wait acknowledges it. An empty `took`, an
  `until` that passed, holds nothing (a bug the tests found: it was returned again).
- **A stage around a wait.** The wait writes `took` with the stage; the stage records no value, and
  on reuse returns the batch read back from the mailbox. A stage whose work returns other events
  than its wait took fails.
- **`awf runs`** reads a keyed run's last wait while it is running or parked: `waiting: { label,
  until }` in `--json`, and the label and `until {time}` after the row.
- **`testWorkflow`** starts an event workflow from `event`, appended as `awf emit` would, under the
  key it makes, refusing one outside the grammar. Scripted events, `files`, parking and `maxTurns`
  are task 8's.
- **Verified**: `mailbox.test.ts` (9), `receive.test.ts` (5) and the new `runs-command.test.ts`
  case pass; `bun test packages/engine` 856 pass; `bun run check` passes. Task 2's runner wiring is
  proven here: a stage entered twice in a run with `events` runs once.
- **Review 1** (two agents): 15 findings between them, all fixed. A wait in a stage that took its
  batch and failed, or died before its record, returns that batch again and writes nothing, so the
  batch isn't lost to the next events. A wait in a stage leaves the loop's batch to the loop: its
  `wait` record carries `stage`, and only a wait outside a stage acknowledges a `took` outside
  one, so a crash while the loop handles a batch doesn't lose it to a stage's wait (the story's
  "each call acknowledges what the one before it returned" holds per wait: the loop's, or a
  stage's). The work path compares against the batch the owner saw the stage's wait take, not the
  mailbox. A wait ends with its run (the owner's closing signal) or its scope, so a deadline while
  waiting no longer leaves it polling. `RunMailbox` takes `locked(work)`, not `append`, so parking
  and emit can decide and write under one lock. The poll's baseline is taken before the read. An
  attempt's first wait in a stage leaves a crash's held batch to the first one outside. `awf runs`
  ignores a wait an earlier attempt died in, and spaces the label from the cost. `testWorkflow`
  checks a starting event's data against its schema. Tests added for each, and for one wait at a
  time; the design line now says a plain run's `receive` rejects.
- **Verified**: `bun test packages/engine` 861 pass; `bun run check` passes.
- **Review 2**: nothing blocking; five small findings, fixed: `testWorkflow` refuses `files`,
  `events` and `maxTurns` until task 8 builds them, and a missing `event` says so; a stage holds
  one wait, and a second throws; a wait cut by its scope rejects with an `Error`; with no `until`, a
  wait sleeps until a nudge or the size poll wakes it rather than rereading each second; the
  records' docs and the design's record list say how a wait in a stage acknowledges. Noted, not
  done: a reused void stage reads the mailbox to find a batch, worth caching if wakes on long
  mailboxes get slow. Clear.
- **Verified**: `bun test packages/engine` 862 pass; `bun run check` passes.

### Task 4: one way in

- **Where.** `emit.ts`, `emitEvent`: checks the event against its target (`EmitError` for a wrong
  name, a colon, data its schema refuses, an id outside the grammar or starting `awf.`, a key
  outside it, a target with events and no `file`), keys it, and under the run's lock finds a
  duplicate, refuses it, or creates the run (with `key`, `cwd` its project and `env.PATH`, and the
  project in `~/.awf/projects`), appends it and calls `wake`. `wake.ts`, `wake`: the table, from
  the run's attempts and mailbox; `failuresInARow` for Q13. `key-lock.ts`, `withKeyLock`: the file
  linked into place with the holder's pid and process start, taken over when that process is gone
  (re-read just before the unlink, the one race left), and a queue per lock within a process.
  `projects.ts`: the project of a file (Q15) and `~/.awf/projects`. `emit-command.ts`: `awf emit`.
- **Start is a continue.** `wake` creates the run's folder, then launches `awf run {file}
  --continue {id} --run-root {root}`, the same command that continues a parked run, so one path
  starts and continues. It is spawned detached, in the run's project (Bun reads its `.env` there)
  with the recorded `PATH`, output to the run's `process.log`, and `wake` returns once the attempt
  has claimed its number, so its pid is recorded while the lock is held. The file is the target's
  for an emit, and the last attempt's otherwise.
- **`awf run`** loads a workflow with `events` as one with no arguments, `keyed` beside it, after
  checking what `tsc` would have: no `.` in its name, no colon in an event's, `key` a function,
  `starts` among its events, `file` its own path. It refuses one without `--continue`, and with
  `--from-stage`, `--values` or arguments; a keyed run's root is its project's unless
  `--run-root` is given. The attempt takes the run's lock for every mailbox append, and opens the
  socket at once, which hands a nudge to the mailbox.
- **`workflow.emit`** checks its target is an event workflow and sends through `emitEvent`, from
  `{workflow}/{id}`; `RunWorkflowOptions.emit` replaces it, and `testWorkflow` records `run.emits`
  instead of starting runs.
- **Output.** `awf emit` prints `accepted dd-case/dd-case.k: started`, `duplicate {ref}`, `refused
  {ref}: returned`; `--json` is `EmitResultJson`. Exit 0 for an outcome, 2 for an `EmitError`, 1
  when the run couldn't be woken.
- **Verified**: `emit.test.ts` (20: each outcome; errors not outcomes; ids made and not
  deduplicated; each row of the table from an emit, with a fake launch and nudge; Q13's limit and
  its reset; two events at once start one run; a stale lock taken over; the in-process queue; `awf
  emit`'s lines, `--json` and exit codes), `emit-e2e.test.ts` (2: a real detached run started by
  `awf emit` from another directory, nudged by the next, completed, and the next refused; `awf
  run` refusing the workflow), `receive.test.ts`'s `workflow.emit` case. `bun test packages/engine`
  885 pass; `bun run check` passes. Tried by hand in a scratch project too. Owed to task 5: `awf
  tick`'s rows of the table, an emit and a tick at once, and an event while the run parks.
- **Review 1** (two agents): 22 findings between them, fixed or recorded.
  - Fixed, design: `emitEvent` is the sender's way in, its checks and key, and hands the event to
    `deliver`, the one way in for every event (`awf send`'s replies, task 7, and the engine's own,
    task 6, call `deliver` alone). The attempt gets an allowlist of the waker's environment (who
    and where the engineer is, the ssh agent, proxies, `XDG_*`, awf's own `AWF_*`) and the recorded
    `PATH`; tokens and harness settings come from the project's `.env`, which a variable already
    set would override (written into Q15). A launch that never claims an attempt is `accepted`
    with `did: "none", why: "launch-failed"` and its `error`, recorded in the mailbox as
    `launch-failed` and counted with failed and crashed attempts toward `stuck`; the run record
    keeps the file it was first started from, so a tick can relaunch a run with no attempt. A
    duplicate still wakes the run: a sender retrying after a failed launch sends the same id.
  - Fixed, bugs: a project is never `{home}/.awf`, awf's own, so a file under home with no `.awf/`
    nearer runs in its own directory, not home; `awf emit` exits 1 and says why when the attempt
    didn't start; the lock treats a holder `ps` can't be asked about as alive, and a holder
    removes the lock on release only while it is still its own; a sender's `file` must be
    absolute; the launch waits up to 5 s for the attempt's socket, so the next event nudges it;
    the sandboxes check runs on a keyed run's project root; `starts` can't be empty; a malformed
    event schema is an `EmitError`; the loader and the sender share the contract's
    `eventWorkflowProblem`; `awf run`'s `workflow.emit` is built from its operator environment.
  - Recorded: the order a continue's process keeps (claim, then wait for the old process, then
    the failed ends), in task 5's details; the three items needing `awf tick` and parking moved to
    task 5's Done when. Left: a nudge answered before the run's listener is set (the first wait
    reads the mailbox anyway); a launch that times out at 60 s while its child still claims later
    (the next wake's second child is refused at its claim); an operator's own `awf run --continue`
    runs with their environment, not the allowlist.
  - Tests added: `wake` directly for a parked run's `until` and nothing due; each loader refusal;
    exit 1 on a failed launch; the project root under home; a lock held from another process; a
    lock taken over not removed by its old holder; `awf run`'s refusals for a keyed run.
- **Verified**: `bun test packages/engine` passes (898 before the last two tests); `bun run check`
  passes.
- **Review 2**: every round-1 fix confirmed; seven small findings, fixed: Q15 lists exactly what
  the attempt keeps of the waker's environment, with `AWF_*` narrowed to `AWF_COORDINATOR_DIR` and
  `AWF_HERDR_SESSION`, which live only in the environment; the project is found from the file's
  real directory, so senders naming it through a link find the same runs; a file directly in home
  is refused; the socket wait also stops on a signal; a duplicate doesn't nudge a live run, which
  has the event already, and still starts or continues one that never took it; `wake` reads the
  mailbox only where it needs it; the lock asks `ps` for its own start once. Clear.
- **Verified**: `bun test packages/engine` 901 pass; `bun run check` passes.

### Task 5: parking

- **Where a run parks.** `RunMailbox`'s wait, given `parking` (`idle()`, `park()`), checks at the
  point it would sleep: with nothing to take, no `until` passed, and every agent idle (no turn,
  message or compaction), it takes the run's lock, reads the mailbox once more, writes the
  attempt's `parked` ending through `park()` and throws `RunParked`. The runner's ending is
  `parked`, with the wait's label and `until`; a stage the wait was in is abandoned, unrecorded, so
  the next attempt runs it again. With a turn running the wait looks again each second, as the
  turn's end may let it park. `awf run` gives `park()` as an early `endAttempt`, under the lock, so
  a waker sees `parked` at once and continues the run while this process is still closing agents.
  `testWorkflow` parks too: `run.parked` gives the wait, and `run.value` says the run parked.
- **A continue** claims its attempt first, taking no key lock, then waits for the previous
  attempt's process to be gone, stopping it past five minutes (`previousGone`), as `wake` holds the
  lock until the claim.
- **Agents reopen on kept sessions.** A keyed run reads its earlier turns at start
  (`keptSessionsOf`): each root agent's last native session is handed to its activation as
  `continues`, as a fork's session is, and its instructions are not sent again. In a keyed run every
  pane agent opens with `paneAtFirstTurn`, a new harness option: the herdr adapter places its pane
  at its first turn, so an agent reopened on a wake with nothing to do shows nothing. The
  contract's placement wording says both ways.
- **`awf tick`** (`tick-command.ts`): every project in `~/.awf/projects`, every keyed run in it,
  under its key's lock, `wake` with no file and no nudge of a live run; a line per run woken,
  `continued {ref}: until|event|crashed|failed`, and `started` for one whose first launch failed.
  `TickResultJson.did` takes `started` for that.
- **`stuck`** is derived in `runStatus` for a keyed run whose failed, crashed and failed-to-launch
  attempts in a row reach three; `failuresInARow` and `STUCK_AFTER` moved to `run-state.ts`.
- **A returned run** records `unacknowledged`, the events no wait took, and `awf runs` says
  `{n} events never taken`. The batch it returned after counts as handled: the design's "taken or
  not" now reads "no wait took".
- **Live, on real harnesses** (`scratchpad/live`, `recall.ts`: one awaited turn per event):
  codex headless and claude in a pane each took a first event ("remember PELICAN-42", "OSPREY-17"),
  parked, and on the second event were continued by `awf emit`, reopened on the same native
  session (`01a175c3…`, `4a8f8afe…`), and answered the word; the second turn's prompt carried no
  instructions. Claude's pane opened from the detached run, whose environment had none of the
  Herdr variables, and was billed `subscription` (awf's label).
- **Tests**: `receive.test.ts` (a run parks at its wait's label and `until`), `mailbox.test.ts` (an
  event sent as the run parks is taken; the park's lock order; no park while a turn runs),
  `emit.test.ts`'s `awf tick` (each row, from every project; an emit and a tick at once continue
  once), `emit-e2e.test.ts` (start, park, continue, complete and refuse across processes, with
  `unacknowledged` and `process.log`; a continue reads a rotated `.env` and none of the sender's
  `TOKEN` or `PATH`; `previousGone` waits for the old process), `herdr.test.ts` (no tab until the
  first turn). `bun test packages/engine` 909 pass, `packages/harness` 438 pass; `bun run check`
  passes.
- **Owed to task 6**: Q17's stopping of the old attempt's panes and agent processes, and the
  failed ends it writes, which need turns not awaited.
- **Review 1** (two agents): 19 findings between them, fixed or recorded.
  - Fixed: a park can't be swallowed: once `parked` is written the body is raced out and the ending
    is `parked`, whatever the code caught. `idle()` counts every tracked operation and any open
    stage but the wait's own, so a wait beside a stage or a decision doesn't park. Kept sessions
    are reopened only when the attempt before ended (a crashed one's panes may still write its
    sessions, until task 6 stops them, Q17), when the harness is the same, and when the agent has
    no skills or sandbox, whose home is made anew; otherwise the agent starts afresh, with its
    instructions, and the log says why. A continue waits for the previous process inside
    `claimNext`, after the claim and before it writes a line, so the old attempt's records come
    first; past five minutes it is cancelled, then killed after 30 s, each signal guarded. A keyed
    run's ending, and a returned run's count, are written holding the run's lock, as parking's
    is. One `stuckOf` for `awf runs` and `wake`. `wake` says what was due (`cause`), which `awf
    tick` prints. A failed launch quotes only what it wrote. `awf tick` exits 1 for a project that
    is gone. A stage around a wait entered again in one attempt throws: it would return its batch
    forever. Forking a pane agent before its first turn says so.
  - Recorded: before an agent's first turn in an attempt it can't be forked or compacted, and
    `beside` it falls back to a tab (`docs/workflow-api.md`); a resumed claude headless turn's
    printed dollars are dropped for that turn, tokens counted once (the usage window starts at the
    attempt); instructions changed in the code don't reach a kept session; a stage abandoned at a
    park leaves its `stage-started` without an end in the event log, followed by the attempt's
    `parked` end; `TickResultJson.did` gained `started`, a published type for review.
  - Tests added: a caught park still parks; a wait in a stage that parks leaves it unrecorded; a
    wait beside an open stage parks only once it ends; `keptSessionsOf` keeps each root agent's
    last session; `awf tick` starts a run never started, continues a parked one with an untaken
    event, leaves a run without events, and exits 1 for a project gone; `awf runs` shows `stuck`
    and `{n} events never taken`; a stage around a wait entered twice in one attempt is refused.
- **Verified**: `bun test packages/engine` 916 pass, `packages/harness` 438 pass; `bun run check`
  passes.
- **Review 2**: every round-1 fix confirmed, no deadlock; six small findings, fixed: a failed
  launch's quote is cut by bytes, not characters; `workflow.emit` is tracked, so a wait beside one
  doesn't park; a stage a wait parked in is abandoned where the park is thrown, before anything
  closes it; the claim-first order has a test, which found the launch waiting up to 5 s for the new
  attempt's socket while the old process closed, now skipped while that process lives; the
  workflow API says plain code beside a wait is cut off at a park; stale wording. Clear.
- **Verified**: `bun test packages/engine` 917 pass, `packages/harness` 438 pass; `bun run check`
  passes.

### Task 6: turns not awaited

- **Where.** `LogicalAgent.start()`: refused outside a keyed run, and anywhere but the run's root,
  as a turn not awaited would outlive a stage or a `parallel`. It records the mailbox's `turn`
  (under the run's lock) before launching, hands the turn to the agent's own `run()`, and returns
  the `StartedTurn`. The turn's whole chain, `run()` then the end's append, is tracked, so the run
  neither parks nor reads as idle until `agent:ended` is in the mailbox. `RunMailbox.endTurn`
  appends the end once, `awf.end.{sha256 of agent, turn and attempt}`, and nudges the run's own
  wait.
- **`agent.turn`** is set from `start()` until the owner's wait takes the end
  (`endTaken`); meanwhile `start`, `run`, `compact`, `set` and `fork` are refused, also once the
  turn ended untaken, messages to the agent wait, and a reply awaited from it is refused.
  `cancel()` stops the turn's own operation, or, queued behind other work, has it settle cancelled
  when reached, and resolves once the end is in the mailbox, `true` when that end is the cancelled
  one, `false` at once on a turn that ended.
- **When the code returns or throws**, the owner cancels every started turn still running and
  waits for its end before the attempt's ending (`endStartedTurns`).
- **After a crash** (`recoverTurns`, before the code runs): a `turn` of an earlier attempt with no
  end gets a failed one, `retryable`, with its `meta`, so a process killed between the record and
  the launch leaves an end, not an orphan; each agent's last turn whose end no wait took (not yet
  taken, or taken and not acknowledged) is restored as its `agent.turn` when it opens.
- **Q17.** A continue after a crash, before the code runs, stops what is left of the crashed
  attempt's process group (only once its leader is gone, so a reused pid's group is never hit) and
  sweeps its Herdr session when it left a workspace, which closes the workspaces of runs whose
  process is dead (`stop-crashed.ts`). A harness's own process runs in a session of its own
  (`setsid`), so one the crash orphaned is not reached; it isn't stopped yet. Agents open new
  sessions after a crash, as the amended Q17 says: codex refused to resume a killed attempt's
  session. Owed: recording each agent launch's group, as `LaunchedGroups` in the sandbox package
  does, so a continue can stop an orphaned harness too.
- **A type fix in task 1's contract**, found by these tests: `agent.ended(e)` and
  `participant.replied(e)` narrow to their event `& Matched`, a type-only brand, since without it
  a false branch ruled out every agent's end, and a second agent's `ended(e)` after the first's
  narrowed to `never`. `events.typecheck.ts` pins two agents.
- **`testWorkflow`** returns `run.mailbox`, the run's mailbox as it left it, for tests to see ends.
- **Tests** (`turns.test.ts`, 9): the end arrives with the turn's id, `meta` and outcome, and
  `ended` matches only its agent; every refusal, before and after an untaken end; an event during
  a turn is taken before it ends; `cancel()`'s two answers; a throw and a return each cancel a
  running turn and write its end; no park while a started turn runs, and a park once its end is
  taken; `start` refused in a stage; `recoverTurns` writes a failed end for a crash's turn, keeps
  one end, and restores the turn whose end no wait took. `bun test packages/engine` 926 pass;
  `packages/contract`, `harness` and `examples` 554 pass; `bun run check` passes.
- **Review 1** (two agents): 18 findings between them, fixed or recorded.
  - Fixed: a turn a crash left is restored from a map the owner keeps and the wait clears, read
    when the agent first needs it, so an agent opened after the wait took its end is free, and one
    opened before refuses work from its first call, not only once `turn` is read; a turn id is
    begun once per attempt, and an end's id includes the attempt its turn began in, so code that
    begins the same id again after a crash gets a turn of its own; two `start()` at once start one
    turn (the turn is claimed before the first await); `start()` is refused while the agent works
    on something else, so `cancel()` stops its own turn; `cancel()` is `true` only when the end it
    waited for is the cancelled one; a synchronous throw from `run()` becomes the turn's failed
    end; ending started turns at the body's end is bounded like cleanup, and a failure is logged;
    the `turn` record keeps the agent's `execution`, which an end written after a crash carries;
    a reply awaited from an agent with a started turn is refused, as it could wait on code that is
    itself waiting (messages to it wait, as the design now says).
  - Q17: a continue after a crash stops what is left of the crashed attempt's process group and
    sweeps its Herdr workspace before the failed ends are written (`stop-crashed.ts`); live,
    resuming the killed attempt's codex session was then refused by codex's thread store, so
    agents still open new sessions after a crash, and Q17 says so, for the operator to confirm.
  - Recorded: `Matched` is a published-type change, beta; `#launching` stays rather than a split
    `run()`.
  - Tests added: after a crash, the first wait gets the held batch and the failed end follows,
    with its `meta`; an agent opened after the wait took its end runs, one opened before is refused
    from its first call; one turn id per attempt and one turn for two starts at once; `start()`
    refused while the agent works; a return's end is `cancelled`; `stopCrashed` stops a detached
    attempt's whole group.
  - Live (codex headless): a run killed mid-turn was continued by the next event; its turn ended
    failed, a new turn answered `KITE` on a new session, and nothing of the killed attempt was left
    running.
- **Verified**: `bun test packages/engine` 931 pass; `packages/contract`, `harness` and `examples`
  554; `bun run check` passes.
- **Review 2**: every round-1 fix confirmed; six findings, fixed or recorded: the group kill
  reaches only what the attempt itself spawned, as each harness runs in a session of its own, so
  an orphaned harness isn't stopped (recorded above and owed), and the kill now waits until the
  leader is gone, so a reused pid's group is never hit; `start()` no longer refuses an agent busy
  with a message held during the last turn, which the wait's taking of the end had woken: it queues
  behind it, and `cancel()` stops only its own turn, or has a queued one settle cancelled; an end
  that can't be written fails the run rather than leaving the turn set silently; a message held
  while `begin` failed is taken; stale wording in these notes and the Done when.
- **Verified**: `bun test packages/engine` 932 pass; `packages/contract`, `harness` and `examples`
  554; `bun run check` passes. Clear.

### Task 7: a participant routed to the code

- **Where.** `participants.connect({ key, to: "code" })`, in a run with `events` only, returns a
  `CodeParticipantRef`: `replied(e)` is true for its `participant:reply` events, and `post(text)`
  writes a `participant-post` line to the run's event log, which `awf inbox` turns into its `post`
  item, `{ kind: "post", coordinator, id: "{attempt}.p{n}", text }`. `participant-connected`
  records `to: "code"`; `awf logs` shows both.
- **`awf send {ref} --as {participant} --id {message id} [--author {name}] [{text}]`**
  (`holder-command.ts`, `toTheCode`): no agent; the id is checked against the grammar and refused
  starting `awf.`; the run is found under `--cwd`'s runs, or in a project in `~/.awf/projects`
  (Q15); the participant must be one the run connected to its code, in any attempt; the reply goes
  through `deliver`, as `participant:reply` from the participant, with the message's id as the
  event's and `{ text, author? }`, so it nudges a live run, continues a parked one, and is a
  duplicate when the chat delivers it twice. It prints as `awf emit` does; `--json` is
  `EmitResultJson`.
- **A parked run keeps its participant**: the next attempt's code connects it again under the same
  key, and `awf send` accepts it from the earlier attempt's record while the run is parked.
- **Tests** (`participant-e2e.test.ts`, across processes): a reply while the run is live is nudged,
  one while it is parked continues it, the same message id again is a duplicate and is appended
  once; the replies reach the code with their id, text and author; the run's posts are `post`
  items in `awf inbox --as thread`; an id outside the grammar is a usage error. `bun test
  packages/engine` 934 pass; the rest pass but for the workflow-api samples test, as on main;
  `bun run check` passes.
- **Review 1** (one agent, both lenses): 10 findings, fixed or recorded. Fixed: a `post` item
  carries the participant's `labels`, which a chat host titles its thread with (a code participant
  has no routes, which carried them before); `awf inbox {ref}` finds a keyed run through
  `~/.awf/projects` from anywhere, as `awf send` does (`findKeyedRun`, in `run-state.ts`), with
  `home` passed through; `send --id`'s refusals print a `HolderResultJson` on stdout under
  `--json`, and the usage says it exits as `awf emit` does; `participant-connected` is version 2,
  read from 1, as it gained `to`; only `RunNotFound` falls through to the next project; a released
  participant takes no more posts. Recorded: a reply id shares the run's one id space, as every
  event's does, which the usage says ("one the run has not had from anyone"); a post's id is new
  at each attempt, so a post made again after a crash may reach a host twice (the `post` item's
  doc says so); a reply after a release still reaches the code, as a release leaves nothing on
  disk for `awf send` to see; `awf inbox --all` still reads one run root, so a chat host watching
  every keyed run reads each project's (owed); `awf inbox`'s JSON stands in for a chat host in the
  tests. Tests added: the posts' ids and labels, read from a directory with no runs; attempt 2
  connecting the same participant to its code; a participant not routed to the code refused, with
  JSON on stdout; each usage error of `send --id`; `to: "code"` refused without `events`.
- **Review 2**: every round-1 fix confirmed; five small findings, fixed: a ref that is a run in
  two projects is refused naming both, `--cwd`'s own runs winning, as Q15 now says; the inbox
  tests use a home of their own; a post after the attempt ended is refused; the usage says which
  exit is which; a malformed ref keeps its own message. Left: a code participant's connect opens
  the coordinator socket too, which is harmless. Clear.
- **Verified**: `bun test packages/engine` 939 pass; `bun run check` passes.

### Task 8: workflow-testing

- Much of it landed with the tasks that needed it: the starting `event` (task 3), parking and
  `run.parked` (task 5), `run.emits` (task 4), `run.mailbox` and a seeded `mailbox` for a continue
  (task 6). `turnsOf` already gave each turn's `prompt`.
- **`events`**: the scripted host calls `onTurnStarted` once a turn's record is made and before its
  script answers; each scripted event due `during` that `{agent}#{n}` is appended to the mailbox
  then, and the run nudged, so it is in before the turn's end. An own event's data is checked
  against its schema; a reply's `author` defaults to `engineer`, its id to `awf.test.{n}`. One
  never sent fails the test.
- **`files`**, laid out under the run's `cwd` before it starts; **`maxTurns`**, 20, counted in the
  same hook, fails the test past it.
- **Tests** (`event-testing.test.ts`): a reply scripted during the first turn reaches the second's
  prompt and the run parks; files laid out; a run that never parks fails at `maxTurns`; an unsent
  scripted event fails; a scripted own event is checked against its schema.
- **Done when** names the Datadog sketch's `case.test.ts`: it needs the case's files, which task 9's
  port writes, so it is run there; `examples/event-sketches/dd-case.test.ts` stays `todo` beside
  the sketch, whose case is declared, and these tests hold the same mechanics.
- **Review** (one agent, both lenses): 6 findings, fixed. `files` lays out only under the run's
  directory, which the test removes: an absolute path, or one escaping it, is refused, as it would
  be left behind on the real disk (the sketch's `{ [DD_CASES]: … }` becomes a path under `cwd` in
  task 9's port); it runs inside the test's `try`, so its failure leaks nothing. A scripted or
  starting event's id is checked against the grammar and the `awf.` prefix, and an id given twice,
  among them and a seeded mailbox, is refused rather than silently dropped. `maxTurns` is a whole
  number from 1. The API docs say `#n` is `TurnRecord.n`, which a nudge or a message wake keeps,
  and what `maxTurns` counts. Task 9's Done when names the sketch's `case.test.ts`, and
  `mr-review.test.ts` stays a sketch. Test added: an own event and a reply due at one turn arrive
  in order, the own event `from: "operator"`.
- **Verified**: `bun test packages/engine` 946 pass; `bun run check` passes. Clear.

### Task 10: one run id

Settled with the engineer on 2026-10-26, while the story waited for review: `--id` on a plain run
and `--key` on an event run, and `dd-case/dd-case.kombo-unique`, named one idea twice. Built first
with `id(e)` in place of `key`, then, the same day, without it: every sender already knows the run
(the tick decided which case changed, a reply comes on a run's thread, a person names the case),
every other command addresses a run by its ref, and the event's data repeated the id only so the
function could read it back. A routing function can come back as an optional fallback for senders
that can't name a run, such as webhooks, without changing a call.

- **The definition.** No `key` or `id`. `starts` is optional: absent, every event starts a run;
  `[]` is still refused at load, so "none" can't be spelled. The load check no longer refuses a
  `.` in an event workflow's name, which only separated the key.
- **The sender names the run.** `workflow.emit(target, run, name, data, { id })`,
  `awf emit --target {file} --id {id} …`, and `emitEvent`'s event `{ run, name, data, id? }`;
  `deliver` was already given a run id. `idProblem` checks it, the grammar of every run id: letters
  of either case, digits, `.`, `_`, `@` and `-`, starting with a letter or digit. Lowercase-only
  was tried and dropped: plain runs are named by ticket keys (`PROJ-1515`), and `createRun` already
  refuses an id differing only in case. `workflow.key` is gone from `EventWorkflowContext`;
  `workflow.runId` is the same value.
- **Records.** `RunRecord.key` became `events: true`, which marks a run of a workflow with events;
  its value was the run's id.
- **One name per id on the CLI.** `--id` was the run on `awf run`, the event on `awf emit` and
  the message on `awf send`, while the run was also `--continue {id}` and, for a moment, `--run`
  on `emit`. Now `--id` is always the run's id (`awf run`, `awf emit`), `--event-id` the
  occurrence's (`awf emit`, `awf send`, where a message's id becomes its event's), and `--continue`
  a switch: `awf run {file} --id {id} --continue`. awf prints its go-on lines and `wake` launches
  in that form, and awf-lab passes `--id`. In code the run is `emit`'s second argument and the
  event's id `EmitOptions.eventId`, as on the CLI; `run.emits` is `{ ref, name, data, eventId? }`.
- **`awf run --id`.** `loadAndPrepare` returns `opens` for an event workflow with `--id` and no
  `--continue`, and refuses one without either, and one given `--timeout`, `--sandbox`, `--cwd` or
  `--run-root`, which a wake would not pass on to later attempts; `openEventRun` (`emit.ts`) makes the run under its
  lock, as `deliver` does, and calls `wake`, which starts it detached, so every run with events runs
  the same way, its output in `process.log`. It prints `{ref}: started`, or
  `{ref} was there: {what wake did}`, and exits 1 when the launch fails. `--here` refuses it: it
  runs detached in its project. A first `receive` with an empty mailbox parks at once, so nothing
  else was needed for the pending state; work to do once goes in a stage, which a run with events
  reuses for good.
- **`testWorkflow`** takes `{ id, event? }`: `id` names the run, and without `event` it starts
  with none.
- **Names inside the engine.** The key lock is the run lock (`run-lock.ts`, `withRunLock`), and
  comments say "event run" for "keyed run". `LoadedWorkflow.keyed` and `findKeyedRun` keep their
  names.
- **Tests**: `emit.test.ts` (no `starts`; `--id` on every `awf emit`), `emit-e2e.test.ts`
  (`awf run --id` detached: parks, found there, returned, refused without `--id` and with
  `--timeout`), `receive.test.ts` (`testWorkflow` by `{ id }`). The fixtures lost their
  `{workflow}.` prefixes; the sketches' ticks name each case's run.
- **After an API review** (2026-10-27): a test's `run.emits` names the run each event went to,
  `{ run: "{workflow}/{id}", name, data, id? }`, in place of the target's file. Every command that
  takes a run (`awf runs`, `logs`, `inbox`, `reply`, `send`) finds it one way, `findRunByRef`:
  `{workflow}/{id}` or an `{id}` one workflow has, under `--cwd` first, then in each project in
  `~/.awf/projects`. Before, only `inbox` and `send --id` looked in other projects, and `inbox`,
  `reply` and `send` refused a bare id.
- **Verified**: `bun test` 2188 pass; `bun run check` passes.

### Task 12: a tick for its own project

- **`awf tick`** takes `--cwd` and `--run-root` as `awf runs` does (`parsePlace`) and wakes the runs
  with events under that one root; with neither, `{cwd}/.awf/runs`. A folder with no runs wakes
  nothing and exits 0. It never reads `~/.awf/projects`, so a gone project there fails no bare
  tick.
- **`awf tick --all`** is the old loop over `~/.awf/projects`, a gone folder failing it with 1, as
  before. It takes no `--cwd` or `--run-root` (usage error 2): it has no place of its own.
- **The watcher.** Its runs are under `workflows/datadog-watcher/.awf/runs`, and
  `process-compose.yaml`'s `awf-tick` already runs a bare `awf tick` in that folder, so it wakes the
  watcher's runs alone; a comment there says so.
- **Tests**: `emit.test.ts`'s `awf tick` block: its own project's run and not another's; `--cwd`
  to the other; a folder with no runs; `--all` wakes both; `--all --cwd` refused; a gone project
  fails only `--all`.
