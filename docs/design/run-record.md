---
title: A run's record
type: design
story: "[[041-run-record-layout]]"
---

# A run's record

The layout a run's folder has, designed as a whole, and built by
[[041-run-record-layout|story 041]]. It ignores compatibility on purpose: a run made before it is
listed `unreadable` and not read. It keeps [[0011-a-run-continues-from-its-stages|ADR 0011]]'s model
(stages reused by name, code run again from the top, no replay of calls) and 037's and 039's rules
for waits, timers, races, acknowledgements and redos as they are built; it changes where their
facts are kept, and how a reader finds them.

## The rule: one home per fact, chosen by its writer and its reader

| Kind | What it is | Written by | Relied on by | Home |
| --- | --- | --- | --- | --- |
| **Identity** | what the run is, fixed for its life | whoever makes the run | everything | `run.json` |
| **Claims and endings** | which attempt holds the run, whether it lives, how it ended | each attempt; a launcher | everything | `attempts/` |
| **What the run settled** | stage outcomes and values, races, timers, what waits took and acknowledged, state, started turns, sessions | the attempt that holds the run, alone | continue, the waits, `wake`, `awf tick`, `awf emit`, 040's client | `run.jsonl` |
| **What came in** | events the run's code takes | senders, under the run's lock | the waits | `in.jsonl` |
| **What happened** | the story: attempts, stages, operations, tools, messages, decisions, logs | the attempt, best effort | people, `awf logs`, `awf runs`, `awf inbox` | `log.jsonl`, `ops/{op}/` |
| **Views** | the attempt's published result and report | the attempt, at its end | `awf run --json`, the lab | `out.json`, `report.md` |

Three rules make the split hold:

- **Nothing reads the log to decide what the run reuses, takes or wakes for.** Stories 028 and
  039 said this of `turns.jsonl` ("`--continue` never reads it"), and before 041 the engine broke
  it: a run with events resumed its agents' sessions from turn lines
  (`keptSessionsOf(readTurns(…))`). Here a session is a settled fact. The log may still be read to
  present a run, or to choose a default the live run then checks, as `awf reply` picks the
  question a participant answers (`holder-command.ts`, `awaitedBy`). `awf send --event-id` still
  gates on the log; 039's task 10 removes it.
- **A settled fact is written once, in one place.** The log may *name* what settled ("stage `plan`
  succeeded") so it reads as a whole story, but never carries a value a continue reads.
- **`run.jsonl` is a closed set of lines with a published reading.** Its line types and
  `readRun`, the view an outside reader needs, are in `contract`; what the engine does with the
  lines is its own policy (What is published, below). A reader refuses a kind it doesn't know rather
  than skip it, since a skipped `stage` line misreports what a continue reuses. Only the log, which
  nothing acts on, skips what it doesn't know.

Harness working space is none of these: it moves under `work/`.

## The folder

```text
.awf/runs/
  .gitignore              *
  {workflow}/
    {id}.lock             held while an event is added, and while a run is made or woken
    {id}/
      run.json            what the run is: written once, with the record's format
      run.jsonl           what the run settled, in order: what a continue reads
      in.jsonl            what came in: what the waits take
      attempts/
        {n}.json          one attempt's claim and ending, or a background launch that never began
      launches/
        {launch}.log      a background launch's output, whichever attempt it became
      log.jsonl           what happened, for reading
      ops/
        {op}/             one turn, compaction or decision, named {agent}.{n} or {decision}.{n}
      out.json            view: the last ended attempt's result
      report.md           view: the last ended attempt's report, when the workflow writes one
      work/               harness working space
```

Gone: `stages/`, `replaced/`, `mailbox.jsonl`, `turns.jsonl`, `calls/`, `decisions/`,
`process.log`, and `output.json`, renamed `out.json`. `agents/`, `staging/`, `forks/` and `skills/`
move under `work/`. Every run has this layout, with events or without; only `in.jsonl`,
`launches/` and `{id}.lock` belong to a run with events: they are made by a sender, a background
launch and the lock a sender takes.

## run.json: identity

Written into `.new-{random}/` and claimed by renaming the folder to `{id}`, with `format`, the
version of the whole record, and `args`, typed for 040 and not yet written. A run an event starts
has that event written into `.new-{random}/in.jsonl` before the rename, so no run exists without
the event that made it (before 041, a crash between making the run and appending its event left
one).

```ts
type RunRecord = {
  format: 1; id: string; workflow: string; argv: string[]; args?: JsonValue; cwd: string;
  sandbox: JsonValue | null; created: string;
  events?: true; env?: { PATH: string }; file?: string; panes?: RunPanes;
};
```

`format` versions `run.json`, `run.jsonl`, `in.jsonl` and the attempt files
together: a reader that doesn't know it refuses the run. The log and the operation files keep a
`version` per kind or file where they had one, since they are read only to present.

## run.jsonl: what the run settled

### Its lines

```ts
/** What a wait took. A timer's or a time's id is derived; `timer`, or `branch` and `due`, say which. */
type Taken = { id: EventId; timer?: string; branch?: string; due?: string };

/** State saved at this line: each name given takes this value; a name not given keeps its own. */
type Saved = { name: string; value: JsonValue }[];

type RunLine = { attempt: number; at: string } & (
  // the attempt begins writing: the fence (Writing it, below)
  | { kind: "claimed" }
  // a stage's end, every outcome; only `succeeded` settles it, a provided one included;
  // `redo` on the stage its attempt started at (Redo, below)
  | { kind: "stage"; name: string; outcome: StageOutcome; reason?: string; started: string;
      summary?: string; value?: JsonValue; provided?: true; redo?: true; state?: Saved }
  // a race's winner, and what it took
  | { kind: "race"; name: string; branch: string; took: Taken[] }
  // a timer as first called; cancelled, the same line again with `cancelled`
  | { kind: "timer"; name: string; due: string; when: string; cancelled?: true }
  // what a wait returned: held until a later wait acknowledges it, or a stage's own
  | { kind: "took"; took: Taken[]; stage?: string }
  // a wait: what it waits for, and, outside a stage and a race, what it acknowledges and saves
  | { kind: "wait"; label?: string; takes?: WaitTake[]; stage?: string; race?: string;
      acks?: EventId[]; state?: Saved; returns?: true }
  // a turn that outlives the call that began it, start(); its end is an event a wait takes
  | { kind: "turn-started"; agent: AgentKey; turn: TurnId; meta: JsonValue; execution: AgentExecution }
  | { kind: "turn-ended"; id: EventId; agent: AgentKey; turn: TurnId; began: number; end: AgentEnded }
  // an agent's native session, as soon as it is known
  | { kind: "session"; agent: AgentKey; harness: HarnessKind; session: string;
      operation?: string; home?: string }
);
```

Nine kinds, `claimed` among them. Each has one moment it is written and a reader that needs it; a
timer's cancelling is the timer's own line again, so every key is one kind. Names are run-wide: a
child call's scope (`wf.call`, designed and unbuilt) is a field it adds with a new `format`.

A turn has three records, each a different fact: its operation's folder is what it was asked and
what it spent; the log's `turn` line is how it settled, for reading; and, only for a turn
`start()` began, `turn-started` and `turn-ended` are the run's promise that its end reaches a wait.

### The rules

- **The latest line under a key is its current line**, a key being a kind and a name. A step writes
  a line only when it settles anew: a race once ever; a timer once, and once more if cancelled (037:
  the first call names the time, and a cancelled name stays cancelled, so calling it again returns
  the cancelled timer); a stage each time it ends, which is once per attempt that ran it, except
  where an event run enters a failed stage again in the same attempt.
- **A stage has two answers.** `last` is its latest line of any outcome: what `--from-stage` reads to tell a failed stage from one never run (`stage-plan.ts`). `settled` is
  its latest `succeeded` line, a provided stage's included, since one is written `succeeded` with
  `provided`: what a continue may reuse, and the engine reuses it only when it is also `last`, so a
  stage that failed after its success runs again. Its history, failures
  included, is every line under its name; `awf runs` shows, for each time the latest attempt
  entered it, that time's own line.
- **A state's value is its latest entry**, on whichever `stage` or `wait` line saved it; a line that
  doesn't name a state leaves it as it was.
- **A timer is `due` at its time.** Whether it has fired is the reader's to say against its own
  clock: `wake`, `awf tick` and a wait compare `due` with now; `awf runs` shows a finished run's
  untaken timer as due and untaken, which is true. A fired timer is never written as an event: a wait
  that takes it names it in its `took` by its derived id, `awf.timer.{hash}` of its name, with the
  name beside it as `timer`, and a `workflow.at` time read from state by `awf.at.{hash}` of its
  branch and time, with `branch` and `due` beside the id, so a reader can say what each was without
  deriving an id. That removes 037's appended event whose `at` is
  earlier than the lines above it, and the run's only reason to write its own inbox.
- **A turn is (agent, turn, began).** `began` is the attempt that started it: code rerun from the
  top begins the same turn id again in a later attempt, and that is a turn of its own. Its end's id is
  `awf.end.{hash}` of the three, so one end is ever kept. `turn-ended.end` is the `AgentEnded`
  the code was handed (`{ turn, meta, outcome }`), so a held end returned after a crash is the event
  the code saw; its usage is what the code saw, and `spend.json` stays the account.
- **An operation's sessions**, which accounting and `awf logs` read, are its agent's `session` line
  current at the operation's start, plus every line naming the operation: a fresh agent's session is
  known only after delivery, and a turn can move to another (a fork, a compaction). Resuming an agent
  reads its latest `session` line.

### Redo

039's rule, as built, over `attempt`. The stage attempt *N* started at writes its line with
`redo: true`, whatever its outcome: the stage `--from-stage` named, or, in a run without events, the
first stage it didn't reuse. From then on, in *N* and every later attempt, a stage first entered
after it whose line is from an attempt before *N* runs again; one not
entered after it keeps its reuse, so a per-event stage before the redo point still runs once (039:
moving every record not yet entered "lost their run-once reuse"). Races, timers, what the waits took
and saved state are not stage results: a redo leaves them as they are.

```text
attempt 1   plan ✓   build ✓   qa ✓            a bug in build is found
attempt 2   --from-stage build
            plan     reused: entered before build
            build ✓  runs; its line has redo: true, attempt 2
            qa ✓     runs: entered after build, and its settled line is from attempt 1
attempt 3   (a continue, no flag)
            plan, build, qa   reused: each settled line is from attempt 2 or is entered before build
```

Whether a stage is entered after the redo stage is known only while the code runs, so no reader of
the file can say what a continue will reuse, only what it may: each stage's `settled`, and the redo.
What a reader can say is which stages the redo left behind, such as one the code no longer has: a
stage whose latest line is older than the redo's attempt, and which started after the redo stage
in the attempt that wrote it, since the redo's attempt runs every stage after its start point
again. Where the attempt that wrote a stage's line reused the redo stage, so wrote it no line, the
redo stage's line before it stands in, as what that attempt ran came after what it reused. A
continue's stages to come, and a completed run's `--from-stage` choices, leave those out. Two cases
the lines can't tell: a stage dropped from before the redo stage looks reused there, and is kept;
a stage first run before the redo stage, in an attempt that reused the redo stage, looks as if it
came after it, and is left out. Both only change what is shown, never what a continue runs.
A crash inside the redone stage writes no line. In a run without events, the next continue sees the
attempt that died without an ending, its `flags.fromStage` and no line of that stage from it, says
so, and starts at that stage again, as `--from-stage`, as 018 promised. A wake carries no flag, so
in an event run the redo is lost and the old value stands, and the operator issues it again; a run
never parks short of the redo stage (`FromStageUnreached`).

### Taking and acknowledging

037's and 039's rules, made explicit as fields:

| Wait | Takes | Acknowledges | Writes |
| --- | --- | --- | --- |
| `receive`, `select` outside a stage | the held batch if it is its attempt's first wait, else what is new | the held batch, as it asks for the next | `wait` with `acks` and changed `state`, then `took` |
| a wait inside a stage | the stage's own batch on a rerun, else what is new | its `took`, at once: the stage holds it | `wait` with `stage`, `took` with `stage` |
| `race`, `sleep` | its recorded winner, else the first ready source | its winner only | `wait` with `race`, `race` |

- **Held** is the one run-wide batch a `took` outside a stage returned and no wait has acknowledged.
  An attempt's first wait (no `wait` from it since its `claimed`) gets it back; if that wait doesn't
  take it, it writes `returns` and the batch goes back unacknowledged. A held time read from state
  whose state has since moved is acknowledged, not returned (037).
- **State and the acks that changed it are one line**, the acknowledging `wait`: [[workflow-state]]'s
  promise, both or neither after a crash. A wait inside a stage or a race carries neither, and a wait
  rewritten because a time read from state moved doesn't repeat them.
- **State saved elsewhere** goes on a `stage` line, and only when nothing is held: inside a handler,
  or beside one, nothing is saved until the next acknowledging wait. In straight-line code with
  nothing held, a state set between two stages is saved on the second's line; and code rerun from the
  top sets it again before it, so a crash between the two loses nothing.
- **What a wait can take** is the merge of `in.jsonl`'s events, `turn-ended` lines and due
  timers, ordered by `(at, origin, arrival)`: for equal times a timer comes before a turn's end,
  before an event, and of one origin the one written first (a sender's order in `in.jsonl`, the
  run's in `run.jsonl`) first; a time read from state comes after every ready event (037).

### Writing it

- **One writer, fenced by a claim.** Only the attempt that holds the run appends, so no lock. Before
  it reads the file, a new attempt waits until the previous attempt's process is gone, for every run
  (before 041 `previousGone` waited only for runs with events); truncates the file to its
  last newline, so a torn line a crash left never merges with the next; and appends `claimed`. Then
  it reads. Waiting for attempt *N−1* alone is enough because a refused claim unlinks its own file, so
  no attempt below it can still be live. The wait is bounded (five minutes, then `SIGTERM`,
  then `SIGKILL`), with the lock free meanwhile, so a sender's event waits in `in.jsonl`; a kill
  mid-close can leave panes or sandboxes, which is [[crash-leftovers-reaper]]'s to clean.
- **The fence** is there because that `SIGKILL` isn't confirmed (`runs.ts`, `previousGone`): any line
  from an attempt before *N* that comes after *N*'s `claimed` is ignored, so the claimant's view and
  every later reader's agree. Before it, an ended attempt may still append `session` lines while it
  closes its agents, so a session that moved in a compaction or fork at close is resumed; nothing
  else is written after an attempt's ending. One case the fence can't mend: a process thought killed
  that finishes a short-written line after the claim cut its start leaves a complete line that isn't
  JSON, which a reader refuses rather than guess at.
- **Whole lines, durably.** Each line is one `O_APPEND` write, fsynced (a plain `fsync` on macOS
  until 041's Q5 settles `F_FULLFSYNC`) before the step it settles returns; the folder rename and
  the attempt's `link` fsync their folder. `timer()`, which returns at once, is written before the
  next stage or wait (037). A complete line not yet on disk matters only if the machine itself
  crashes, and then whatever acted on it went with it.
- **A stage's effects come before its line.** A crash between them runs the stage again: stages are
  at-least-once, as ADR 0011 says, and state saved on its line is saved with it.
- **A crashed attempt's turns are ended by the next.** A run never parks with a turn running (036), so
  an end is seen by its live attempt, or its attempt ended with the turn in flight (crashed, stopped,
  timed out or failed). Then the next attempt writes, right after its `claimed` and before any wait or
  `spend.json`, a `turn-ended` for every `turn-started` with none, matched on the turn's three parts.
  Only the live attempt and this recovery write ends.

### What is published

`contract` publishes the line types and `readRun(lines)`, the view a reader outside the engine
needs: each stage's `settled`, `last` and history, the redo (the stage the latest attempt that ran
one started at), races, timers with `due` and whether a wait took
or a cancel withdrew them, state, the last wait, and sessions. That is the format's meaning for a
dashboard, an agent or `awf runs`.

What the engine does with the lines (whether a stage is reused, what a wait takes, the held batch
and the first wait, which turns need an end, the clock a wait fires timers by) is policy, in a pure
engine module checked as `engine/src/accounting` is: no I/O, contract only. Every reader that acts on
the record is the engine, so publishing that would make each change to a wait's internals a format
change for no reader. A reader outside the engine that meets a kind it doesn't know refuses the run.

## in.jsonl: what came in

Written by senders: `awf emit`, 040's client, `awf reply`'s answer routed to the code, a test's
scripted events. Each appends holding `{id}.lock`, which is beside the folder because an event that
starts a run takes it before the folder exists; 040's client holds it across making the run and
launching it.

```ts
type EventLine = {
  at: string; id: EventId; name: string; data: JsonValue; from: string;
  starts?: true; source?: string;
};
```

Events only: a wait can take every line. An id is unique in the file, which makes a resent delivery
a duplicate; `awf.`-prefixed ids are awf's own and refused from a sender (`emit.ts`), which keeps
them free for the derived timer, time and turn-end ids. Event names stay as awf records them
(`participant:reply`, `agent:ended`), whatever name the workflow is handed: 039's commitment, which
is to the names, not the file. It's `in.jsonl`, not `inbox.jsonl`, because `awf inbox` is
another thing: a participant's conversation, read from the log.

An attempt that parks takes the lock to read the events one last time, so one added after its last
wait wakes it rather than being missed. Its `wait` line is already written, so a sender holding the
lock sees both what the run waits for and whether it has ended.

## attempts/: claims and endings

`attempts/{n}.json` is still claimed by one `link` and still says whether an attempt is live (`pid`
and `processStart`). It keeps what only an attempt knows: `file`, `workflowVersion`, `flags`,
`messageLimits`, `launch`, `started`, `ended`, `outcome`, `reason`, `stage`; and a completed one's
`value`, the run's return value, which before 041 only `output.json` kept. `awf emit` refuses a returned run, and 040's `run.ended()`
reads its ending, from here. It loses `stages`, which `run.jsonl` has; `unacknowledged`, which the
engine counts from the `took` and `wait` lines; and `accounting`, a priced total: foundation §8 prices a run when it is summed, never
when it is written, so a run's cost is its operations' `spend.json` priced at read, and only
`out.json`, a view, holds a priced figure. [[crash-leftovers-reaper]]'s record of an attempt's
processes belongs in this file when it is designed.

A start or continue that `awf emit` or `awf tick` launched in the background and that died before
its attempt claimed a number, such as a file that no longer loads, is an attempt file too, linked by
the launcher once the child has exited, or was stopped when it gave up on it: `{ attempt,
kind: "failed-launch", launch, file, started, ended, outcome: "failed", reason }`, with no `pid`; a claimed attempt's `kind` is `"attempt"`, and the
contract's `AttemptRecord` is the union of the two. If the child did claim that number first, the launcher's `link` fails, which is the
right answer. So `stuck`, three failed or crashed attempts in a row, reads attempt files only.
Everything else reads the attempts that claimed their number: a run's state and wait, what a wake
does, the attempt a claim waits for, and the one a continue stops and decides whether to resume
sessions from, so a failed launch never hides the attempt before it; the next launch runs the last
claimed attempt's file. A launcher that gives up on a child that hasn't claimed kills its process
group (`SIGKILL`: a `SIGTERM` is a cancel to `awf run`, which ends an event run for good) before it
writes the failed file, and one whose link is refused, the child having claimed
after all, reports the launch as started. Each background launch's output is `launches/{launch}.log`: the launcher opens it before it
spawns and hands the child its id (`AWF_LAUNCH`), which the attempt records as `launch`.

## log.jsonl: what happened

`turns.jsonl` renamed for what it is: every `RunEvent` kind and every settled turn's line, with
these changes from before 041:

- `session-known`, and the `sessions` on turn and `operation-started` lines, go: they are
  `run.jsonl`'s `session`.
- What only `output.json` held gets a line as it happens: `sandbox-opened` (a
  `SandboxRecord`), the agent's skills and its pane's placement on `agent-opened`, and a pane's
  `kept` or `notKept` on `agent-stopped`, decided at close.
- A decision's lines carry its `operation`.

`attempt-started` and `attempt-ended` stay, as the story's narration: `awf logs` prints them, and
`run-read.ts` closes each agent's window of native activity on `attempt-ended`. Written best effort: a failed write is warned about and the run goes on. That is why nothing that acts on the
run reads it, and why `out.json` isn't built from it.

## ops/{op}/: one folder per operation

Before 041, `calls/{operationId}/` held turns and `decisions/{n}.json` decisions; now there is one
folder per operation: a turn, a message operation, a compaction, a decision, or an agent's start that failed,
which already has an operation id (`operation-failed` "may have no start").

### Op ids

An operation's id names whose it is and which: `{agent}.{n}`, the agent's `n`th operation in the
run, or `{decision}.{n}`, the `n`th asking of the decision keyed `{decision}`. So a path reads
`ops/reviewer.3/screen.txt`, where it read `calls/e5277958-d7a5-4f6a-954a-714d16371a2a/`, and
`awf logs` and the log's lines show the same id.

- **`n` counts from 1 across the run's attempts**, so an id is never reused and an earlier attempt's
  decisions are no longer overwritten (before 041 they were, and written without a rename). An attempt
  learns each key's last `n` by listing `ops/` once as it claims the run, once the previous attempt
  is gone; it is the only writer, so nothing else takes a number meanwhile. An operation's folder
  and `op.json` are written as its id is drawn, before any line names it; one that can't be
  written fails the operation. A message operation withdrawn before it opens keeps its folder, so
  numbers may skip.
- **A key is a name**, by the rule events, stages and races already follow: lowercase letters,
  digits, `.`, `_`, `@` and `-`, starting with a letter or digit. One that isn't a name is refused
  when the agent opens, and a decision's when it is asked. A colon is still accepted, deprecated,
  until 039's task 10 refuses it: `triage:42.1` is a valid folder name on macOS and Linux. `n` is
  the digits after the last `.`, so a key may hold dots.
- **Agents and decisions share the names**: a decision keyed as an open agent is, or an agent keyed
  as a decision already asked, is refused, so `{key}.{n}` is one operation. An earlier attempt's
  key is the kind its highest-numbered readable `op.json` says.
- A message operation, a nudge's turn and a compaction are their agent's operations and take its
  next `n`; a nudge within an operation is that operation's.

### Its files

| File | Holds |
| --- | --- |
| `op.json` | what it is: `id`, `kind`, `at`, `attempt`, `stage`; an agent's operation's `agent`, `execution` and `cwd`, what its spend is read with; a turn's question and `schema` (before 041, `call.json`) |
| `answers.jsonl`, `result.json` | each answer offered, refused ones with why, and the one accepted (before 041, `candidates.jsonl`) |
| `decision.json` | a decision's request and answers, a `DecisionArtifact` |
| `spend.json` | an agent operation's settled usage: billing, spend per model, charge, its delivery and settle times, and `settledBy` when the next attempt read it; a decision's is its `decision.json` record |
| `live.jsonl` | delivery and nudge diagnostics (before 041, `liveness.jsonl`) |
| `screen.txt` | what the pane showed when it ended without an answer or its agent failed to start ([[non-answered-evidence]]) |

`spend.json` is a measurement taken once, while the native session files exist, so it is recorded,
not derived; every total is summed from it, or a decision's `decision.json`, with `op.json`'s
attempt and stage, without the log, and priced at read. It is written with `link`, so only one
write ever lands, and only by a claimed attempt: the attempt as it ends, for every agent operation it drew, one that never reached
its agent with nothing spent; or, for any earlier operation still without one (an attempt
interrupted, or one whose read a Ctrl-C cut, [[interrupted-accounting-read]]), the next attempt as
it starts, while the sessions are there to read. That is the attempt's first act once claimed,
before any agent opens: the session reader is the runtime's, which the claim doesn't have yet.
Its agents are read in the order they first started an operation, each request counted once, by
the first to log it, so a fork's copy of its parent's rows stays the parent's, settled or not. An
agent's sessions are its `session` lines of that attempt and the one before it, read with each
operation's own `execution` and `cwd`; what they logged from its first operation's start until the
attempt ended, the next claimed, or now (nothing of the settling attempt has opened yet), is shared
out by `op.json`'s `at`. A calling session isn't read: nothing on record says where the run's turns
on it ended, so its spend is written unknown. A metered operation read this way has an unknown
charge, which the run's figures count as not billed. The read is bounded as a run's end is; what it
doesn't reach, and an ending attempt's read cut short by a stop or its deadline, is left for a later
attempt. A run never continued keeps its unread spend in the agents' session files, and `work/`
for a codex agent with a home of its own.

## Views

`out.json` is the attempt's published result, `output.json` renamed, written at its end from what
the attempt holds in memory, and printed by `awf run --json`, which the lab
parses. Its shape stays the published `OutputRecord`, priced with the table the attempt ran with. It is a full second copy, as a
view is, and nothing in it is only there any more: the value is the attempt file's, spend the
operations', stages `run.jsonl`'s, and sandboxes, skills and panes the log's, best effort. `report.md` is the workflow's own text. Delete either and
the run continues the same.

## work/: scratch

`work/skills/` (the checked snapshot of each skill), `work/agents/{uuid}/` (a host agent's placed
skills, and a codex agent's own home, with its copied login), `work/staging/` and `work/forks/`.
Only the attempt that made them uses them, and `awf logs` and accounting, which read a codex agent's
sessions where its `session` line's `home` says. Sandbox providers already hide the whole run root,
so the move changes nothing for them. Deleting `work/` once no attempt is live loses those agents'
activity in `awf logs`, and any of their spend no attempt has read yet.

## What a reader may rely on

| Tier | Files | Promise |
| --- | --- | --- |
| **Public, stable** | `run.json`, `run.jsonl`, `in.jsonl`, `attempts/`, `out.json`, `ops/*/{op,result,spend,decision}.json` | typed in `contract`, `run.jsonl` with `readRun`; a change is a new `format`, and a reader refuses one it doesn't know |
| **Public, for reading** | `log.jsonl`, `report.md` | typed in `contract`, `version` per kind; a reader skips what it doesn't know |
| **Diagnostic** | `answers.jsonl`, `live.jsonl`, `screen.txt`, `launches/` | readable; the shape may change without notice |
| **Private** | `work/`, `.tmp-*`, `.new-*` | awf's own; may vanish |

`records.ts` says which tier each type is in, beside the type.

## Reading it

| Question | Read | Before 041 |
| --- | --- | --- |
| Is an attempt live? | its file: no `ended`, and its `pid` with its `processStart` | same |
| The run's status | the attempt files; `readRun`'s last wait for `waiting` | the attempt files, and the mailbox for `stuck` and `waiting` |
| What a continue may reuse | each stage's `settled` line, from `readRun`, when it is also its `last`: those from the redo's attempt on, and earlier ones the code reaches before the redo stage; `awf runs {ref} --json` for the latest attempt's stages, which gain `value` | `ls stages/` |
| A stage's history | every `stage` line under its name, each with its attempt, outcome and `redo` | `stages/` and `replaced/`; a failure only if it is the latest |
| What the run waits for | `readRun`'s last wait | the mailbox's last `wait`, events runs only |
| What it took and acknowledged | `took` lines, and `acks` on the waits after them | `took`, then the next `wait` by rule, `returns` aside |
| The current stage, what an agent is doing | the log's `stage-started`, and the sessions in `run.jsonl` | the log alone |
| The run's cost | the operations' `spend.json`, priced at read; `out.json` for the last attempt as it ran | the attempt files; an interrupted attempt's is lost |
| Its result | the last completed attempt's `value` | `output.json` only |
| A workflow's runs | `runs/{workflow}/*/run.json`: `awf runs` | same |

## Who changes

| Reader or writer | Now reads or writes |
| --- | --- |
| the stage plan and `attemptRefusal` (`stage-plan.ts`, `stage-ledger.ts`, `run-prepare.ts`, `runs.ts`) | the engine's pure reading of `run.jsonl`, where `stages/` was; `replaced/`, `replaceStale`, `sessionsOf` and `lastRedo` went: the redo is `readRun`'s |
| the waits (`waits.ts`, was `mailbox.ts`; their policy in `run-policy/waits.ts`) | the engine's merge of `in.jsonl`, `turn-ended` lines and due timers; writes `took`, `wait`, `race`, `timer`, `turn-started` and `turn-ended` to `run.jsonl`; no longer appends `timer:due`, `at:due` or `agent:ended` |
| resuming a kept session | `session` lines, never the log |
| claiming an attempt (`run-prepare.ts`) | waits for `previousGone` for every run, truncates, writes `claimed`, ends a crashed attempt's turns; the attempt's start (`spend.ts`, `settleEarlier`) settles missing `spend.json` before any agent opens |
| `wake`, `awf tick`, `awf emit`, 040's client (`wake.ts`, `tick-command.ts`, `emit.ts`) | read the attempt files, `in.jsonl` (to dedupe and match the wait) and `readRun`'s wait and timers; `emit` writes a starting event into `.new-*/in.jsonl`; `wake` links a failed launch's attempt file, writes `launches/{launch}.log` and passes `AWF_LAUNCH` |
| `run-state.ts` (`waiting`, `stuck`) | `readRun`, and the attempt files |
| `awf runs`, `awf logs` (`run-view.ts`, `run-read.ts`, `runs-command.ts`, `logs-command.ts`) | the log for the story and the current stage; `run.jsonl` for stages' outcomes and values, waits and sessions; a stage's `value` in `awf runs --json`; the cursor spans the two files; cost from `spend.json` |
| `awf inbox`, `awf reply` (`inbox-command.ts`, `holder-command.ts`) | the log, as before; wait labels from `readRun` |
| a continue's "interrupted in stage …" notice (`run-prepare.ts`) | the log's last `stage-started`: it presents, it doesn't decide |
| the end of an attempt (`attempt-output.ts`) | writes the attempt's ending with `value`, `out.json` and `report.md`; no `stages`, `accounting` or `unacknowledged` |
| result slots and operations (`result-slots.ts`, `ops.ts`, `operation-events.ts`) | `ops/{op}/`; the engine numbers operations per key where it drew a UUID (`workflow-runner.ts`) |
| opening an agent, asking a decision | refuse a key that isn't a name, or that the other already uses |
| accounting (`run-usage.ts`, `run-commands.ts`, `attempt-view.ts`) | `spend.json` with `op.json`, and a decision's `decision.json`, priced at read (`accounting/spent.ts`) |
| decisions (`decisions/directory.ts`) | `ops/{decision}.{n}/decision.json`, written whole; `DecisionRecord.artifact` names it |
| the harness's scratch (`run-skills.ts`, `workflow-runner.ts`) | `work/` |
| workflow tests (`run-test.ts`, `testing.ts`) | `earlier: { stages, events, run }` (below); `TestRun.stages` becomes stage lines, a new type: each stage the attempt entered, in order, a reused one by the line it reused; `TestRun.mailbox` becomes `run` and `events`; due timers are no longer appended |
| the lab | nothing: it parses `awf run --json` and globs run folders, and reads no `output.json` |
| the site and `runs-command.ts`'s `records:` line | the new files' names |

## How it fits the stories in progress

- **039, one way to do each thing.** Its redo rule is kept as built, now over `stage` lines. Its
  task list makes "the mailbox's record names" permanent (line 723): the event *names*
  (`participant:reply`, `agent:ended`) carry over unchanged, the line kinds don't, so that line
  should say "event names". Its test option `earlier: { stages, mailbox }` (task 6) is unpublished,
  and the next beta publishes it; after that, changing it costs a deprecation cycle. Keep its value
  map, `stages: { plan: value }`, which reads better than raw lines, and replace `mailbox` with
  `events` (the event lines attempt 1 had) and `run` (its other lines: races, timers, waits). This
  must be settled before that beta. Task 7's stage around a `receive` keeps working through
  `took.stage`.
- **037, timers.** Behaviour unchanged; a fired timer and a time read from state stop being written
  events and become ids a `took` names.
- **[[workflow-state]].** Its record format is `state` on a wait or stage line, its save moment
  the acknowledging wait; it needs no store of its own, and its open "where people read it" has
  an answer: `awf runs`, through `readRun`.
- **040, a program drives runs.** Its `args` and `source` are typed in `run.json` and the event
  line, and not yet written; its
  client takes the lock as `awf emit` does, and reads an ending from the attempt files.
- **036, keep-alive.** A run parks only with no turn running, which is what lets a turn's end be
  the run's own fact.
- **[[woken-run-bounds]]**: the claim now waits for the previous attempt's process for every run,
  which bounds how long a parked attempt may go on closing agents before a wake starts the next.
- **[[non-answered-evidence]]**, **[[interrupted-accounting-read]]** and
  **[[crash-leftovers-reaper]]** get their homes: `ops/{op}/screen.txt`, `spend.json` settled
  by the next attempt, and the attempt file.
- **ADR 0011.** Kept. "The journal" it shelves is a replay of calls; `run.jsonl` replays nothing.
  Its "Persistence" paragraph changes from "one record per stage" to this file, and its "one writer
  at a time, so no write needs a lock" now holds for every file the run writes.

## Considered and set aside

- **One file for everything**, Temporal's history: a continue would read every tool call and
  message to find a stage's value, and the log is the file that grows, written best effort.
- **The run's lines and the events in one file**, for one total order: the run would need the lock
  for every line it writes, and a sender could stall it. Nothing needs atomicity across the two: the
  order between them is the waits' merge.
- **A `save` line of its own** for acks and state: a second line beside the wait or stage it belongs
  to, so a crash between them splits what must be one. They are fields of the line whose moment they
  share.
- **Keeping `stages/` as a view** for `ls`: a second copy of every value. `awf runs --json` and
  `readRun` read a value.
- **Values in files of their own**, referenced from a line: smaller lines, but two writes per stage
  and an orphan per crash, for runs with tens of stages.
- **A fixed list of voided stages on a redo**: the rule 039 tried and rejected, since it made a
  per-event stage before the redo point run twice.
- **Publishing the whole fold** (what a continue reuses, what a wait takes): only the engine acts
  on it, so it would make every change to a wait's internals a format change with no reader to serve.
- **Firing timers by a clock in the format** (the latest of now and the newest line, stopped at a
  final ending): two exceptions to keep a derived "fired" stable. The line records `due`; each reader
  compares it with its own clock, and a test's clock is the test's concern.
- **A `launches/` record for a launch that never began**: a file kind and a special case in `stuck`
  for what an attempt file with `outcome: "failed"` already says.
- **A redo pending from `flags.fromStage` alone**: an attempt that never reached the stage would
  count as one, the bug 039 fixed (`lastRedo`). The flag is read only to start a plain run's
  continue at the stage an attempt died inside, which no line records.
- **Folding `run.json` into `run.jsonl`'s first line**: one file fewer, but a first line unlike the
  rest, inside an append-only file.
- **A priced total in each attempt file**: one read per attempt for `awf runs`'s cost, but a price
  fixed at write time, against foundation §8.
- **SQLite**: transactions for free, but no `cat`, and a binary file where the record is meant to
  be read.

## Open

- **A child call's record.** `wf.call` is designed, not built (`composition.md`). When it is, it
  adds a scope to every name-keyed line and derived id, and a settled call result under its id: a new
  `format`, which is what `format` is for. Reserving the field now would publish a shape for an
  interface nobody has used.
- **`returns` and the first-wait rule** are carried over from the waits as 037 built them. If either
  exists only by accident, dropping it is a behaviour change for 037's waits, and cheaper before this
  format is published than after.
- **`awf runs`'s cost over many runs.** Priced at read, a listing reads every operation's `spend.json`
  of every run listed. Tens of files a run is fine; if a listing of thousands is slow, a cache beside
  the attempt file, marked as one, is the fix, not a priced fact.
