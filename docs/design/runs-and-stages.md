---
title: Runs, attempts and stages
type: design
story: "[[018-workflow-stages]]"
---

# Runs, attempts and stages

How a workflow run is identified, kept on disk, continued, and broken down into stages, as one
model. Decided in [[0011-a-run-continues-from-its-stages|ADR 0011]], built by
[[018-workflow-stages|story 018]]. This page is the model; the ADR is the decision and its reasons.

Read in order: the picture, the author API, the files, then one attempt from start to end. The rest
is what breaks it, what stays, and what comes later.

## The model in one picture

```
workflow   implement-ticket                 the meta.name in the file; the file's path is not identity
  └─ run   AIRS-1515                        one piece of work: an id (given or generated), its argv
       ├─ attempt 1   flow.ts  v1.2.0        one `awf run`: the code it ran, its turns, its outcome
       │    ├─ stage doc-review   ran        succeeded  value ✓
       │    ├─ stage implement    ran        succeeded  value ✓
       │    ├─ stage review       ran        succeeded  value ✓
       │    ├─ stage mr           ran        succeeded  value ✓
       │    └─ stage qa           ran        failed     (agent settled without an answer)
       └─ attempt 2   flow.ts  v1.2.1        --continue AIRS-1515, after a code fix
            ├─ stage doc-review   reused     the value attempt 1 recorded
            ├─ stage implement    reused
            ├─ stage review       reused
            ├─ stage mr           reused
            └─ stage qa           ran        succeeded → the run is completed
```

A **reused** stage is not run: its work isn't called, no agent is asked anything, and
`workflow.stage(…)` returns the value recorded when it last ran. The code goes on to the next line
as if the stage had just finished.

Five things, each with one job:

- **Workflow.** Code with a `meta.name`. The name groups runs. The file may move, be copied or
  change between attempts.
- **Run.** One piece of work, such as implementing a ticket.
  - It has an id, unique within its workflow, and the argv it was started with. The id is given
    with `--id`, or derived from the args by the workflow's own `id(args)`, or generated.
  - A run is what a person comes back to, as to a Claude Code session or a docker container.
  - Its status is read off its attempts.
- **Attempt.** One `awf run` of a run: the code it ran, its flags, which stages it ran or reused,
  and its outcome.
- **Stage.** A named step the workflow marks with `workflow.stage(name, options?, work)`. It
  returns a value its `result` schema checks, or nothing, when it only has to happen. In an attempt
  a stage is `ran` or `reused`.
- **Stage record.** The run's current result of a stage: its outcome, the attempt that ran it,
  times, the agent sessions it used, and its value.

The words are GitHub Actions': a workflow run with numbered attempts. "Session" would collide with
the agents' own Claude, Codex and pi sessions, which every record already points at. "Reused", not
"replayed": Temporal and Restate replay by running the code again, the opposite. Not "skipped"
either: `--skip-stage` (later) goes on without a record at all.

## The author API

What a workflow sees. Everything else in this page is awf's.

```ts
// packages/contract/src/workflow/executable.ts, beside prepare
id?(args: Args): string;                       // the run's id, unless --id gives one
present?(value: Result, ending: Ending<Result>): string | undefined;           // a completed attempt's
report?(value: Result | undefined, ending: Ending<Result>): string | undefined; // every attempt's

// packages/contract/src/workflow/workflow.ts, on WorkflowContext
readonly runId: string;                        // the run's id, the same in every attempt
readonly attempt: number;                      // 1, 2, …
stage(name: string, work: () => Promise<void>): Promise<void>;          // only has to happen
stage<T>(name: string, options: StageOptions<T>, work: () => Promise<T>): Promise<T>;
stop(reason: string): never;

type StageOptions<T> = {
  result: OutputSchema<T>;                     // checks the value when recorded and when reused
  summary?: (value: T) => string;              // one line for the view and the records listed
};

type Ending<Result> =
  | { kind: "completed"; value: Result; stages: StageSummary[] }
  | { kind: "stopped" | "failed" | "timed-out" | "cancelled"; stage?: string; reason: string;
      stages: StageSummary[]; continue: string }; // continue: the command to go on

type StageSummary = { stage: string; source: "ran" | "reused"; outcome: StageOutcome;
                      attempt: number; spanMs: number; summary?: string; value?: JsonValue };
```

- **`stage`** runs `work` once, or reuses its record without calling it ([[#The stage plan]]). A
  stage with `result` must return a value it accepts; one without must return `undefined`. Either
  mismatch fails the stage, at run time too, since types can be cast away.
- **`stop`** ends the attempt `stopped`, in the stage it is called from, or between stages. It
  throws an engine-private error. A workflow that catches it and goes on is a bug: when it returns,
  awf ends the attempt `failed`, "stop was caught: {reason}".
- **Errors in the author's use**, each failing the attempt with a message naming the stage:
  - a name not matching `/^[a-z][a-z0-9-]*$/`;
  - entering a stage name a second time in one attempt;
  - entering a stage while another is open (nested, or two at once from `parallel`).

  A stage inside a `call`'s child workflow is ruled out too, but not checked: `call` isn't
  available in the runner yet.
- **`id(args)`** must return a valid id ([[#Ids]]); otherwise the run is refused (exit 2) before
  anything is created.

### An example

```ts
run: async (workflow, { ticket }) => {
  const worker = await openWorker(workflow);                 // between stages: runs every attempt

  const doc = await workflow.stage("doc-review", { result: DOC, summary: (d) => d.path }, async () => {
    const doc = await worker.ask(DOC, md`Review the ticket doc for ${ticket}`);
    if (doc.kind === "no-doc") workflow.stop(doc.reason);    // inside: a continue redoes doc-review
    return doc;
  });

  const branch = `feat/${ticket}-${doc.slug}`;               // between: plain code over a value
  if (!(await exists(doc.path))) workflow.stop("doc moved"); // between: checked on every attempt

  const impl = await workflow.stage("implement", { result: IMPL }, () =>
    worker.ask(IMPL, md`Implement ${doc.path} on ${branch}`));

  await workflow.stage("notify", async () => {               // no value: it only has to happen
    await postToSlack(`${ticket}: implemented on ${impl.branch}`);
  });

  const review = await workflow.stage("review", { result: REVIEW }, async () => {
    const [a, b] = await Promise.all([codex.ask(…), opus.ask(…)]); // parallel work inside a stage
    return merge(a, b);
  });
  return { mr: review.mr };
}
```

`ask`, `md` and `openWorker` are the workflow's boilerplate, not awf's.

### Code between stages

Stages are the only thing awf can reuse. Everything else is ordinary code: it runs on every
attempt, before the start point and after it alike, and sees a reused value exactly as it would
one just returned. Three things follow:

1. **It must be safe to run again.** Computing from stage values or checking a fact is fine.
   Creating a worktree, pushing, posting or compacting belongs inside a stage; a compaction that ran
   again between stages was the prototype's run 2 bug.
2. **A stage's only output is its return value.** A variable assigned inside a stage is lost when
   the stage is reused:
   ```ts
   let branch;
   await workflow.stage("implement", async () => { branch = …; }); // reused: branch stays undefined
   ```
   awf can't see a closure. `testWorkflow(…, { fromStage, recorded })` runs the workflow over
   recorded stages, so a test catches it.
3. **Agent turns between stages run again on every attempt,** and an agent remembers nothing of
   reused stages. Opening an agent between stages is cheap; a turn there is paid for again on each
   continue. awf allows it: the turn has no `stage`, and accounting counts it in a `(no stage)` row.
   Whether to put turns between stages is the workflow's call. A lint rule may flag it later.

## State on disk

### Where it lives

State lives in the project, as Terraform's does: `.awf/` in the run's working directory (`--cwd`,
else the shell's). `--run-root {dir}` replaces `.awf/runs` with `{dir}`, and lab uses it for bulk
runs. Runs from before, in `~/.awf/runs`, are not moved. awf writes
`.awf/runs/.gitignore` containing `*` on first use, as pytest, mypy and ruff do for their caches,
so no run is committed by accident, while a settings file beside it ([[operator-settings]]) can be.
Git worktrees each have their own `.awf/`, as they do `.terraform/`.

Why the project: the runs belong to the work, a person finds them where they work, and deleting the
project deletes its runs. Why not elsewhere in the tree: one folder, ignored, is what Terraform,
pytest and others taught people to expect.

### The layout

One folder per run, holding the run's current state. Attempts are small files in it, not folders,
so restarting a run twenty times adds twenty small files.

```
.awf/
  runs/
    .gitignore                 *
    {workflow}/                meta.name
      {id}/                    one run; renaming it into place claims the id
        run.json               the run's inputs; written once, before the claim
        attempts/
          1.json               one per `awf run`; creating it claims the attempt
          2.json
        stages/
          doc-review.json      the current record of each stage: what a continue reuses
          implement.json
        replaced/
          qa.1.json            a record a later attempt redid, moved here: {stage}.{attempt that ran it}
        turns.jsonl            every turn, tagged with its attempt and stage; appended
        calls/{callId}/        call.json, candidates.jsonl, result.json
        output.json            the last ended attempt's: what `--json` prints
        report.md              the last ended attempt's, when the workflow writes one
```

Calls, the output and the report are shared by the run's attempts: calls are keyed by uuid, so
attempts never collide. Sandboxes live outside the project, in
`~/.awf/sandboxes/{workflow}/{id}/{uuid}/` ([[#Sandboxes]]).

### Each file

**`run.json`**: what the run is, fixed for its life.

```json
{
  "version": 1,
  "id": "AIRS-1515",
  "workflow": "implement-ticket",
  "argv": ["AIRS-1515"],
  "cwd": "/Users/roman/dev/braintrust",
  "sandbox": null,
  "created": "2026-10-02T16:02:11Z"
}
```

- `argv`, not the parsed args: a continue runs the current `prepare` on it, so a fix to parsing
  applies, and a run whose argv no longer parses says so instead of reusing old args.
- `cwd` and `sandbox`: every attempt of a run works in the same place, the same way. A continue
  takes them from here; passing others is refused.
- No status, no current stage, no last attempt: all are read off the other files, so they can't go
  stale.

**`attempts/{attempt}.json`**: one attempt: the claim that makes it the live one, then its ending.

```json
{
  "version": 1,
  "attempt": 2,
  "file": "/Users/roman/dev/braintrust/agent/workflows/implement-ticket/flow.ts",
  "workflowVersion": "1.2.1",
  "flags": { "timeout": "10h" },
  "pid": 48211,
  "processStart": "2026-10-02T22:08:40Z",
  "started": "2026-10-02T22:08:41Z",
  "ended": "2026-10-02T22:41:09Z",
  "outcome": "completed",
  "stages": [
    { "stage": "doc-review", "source": "reused", "outcome": "succeeded", "attempt": 1,
      "spanMs": 0, "summary": "docs/AIRS-1515.md" },
    { "stage": "qa", "source": "ran", "outcome": "succeeded", "attempt": 2,
      "spanMs": 1712000, "summary": "preview ok" }
  ],
  "accounting": { … }
}
```

Written twice, each time whole, and only by its own attempt:

1. **At start**, without the ending. Creating it is the claim ([[#Why it is shaped like this]]).
2. **At the end**, with `ended`, `outcome`, `stage` and `reason` (for any outcome but `completed`),
   `stages`: each stage entered, `ran` or `reused`, with its outcome and summary (a stage the plan
   stops as it is entered is there, `stopped`, as the view shows it, though it ran nothing and has
   no record), and `accounting`:
   its totals and `byStage`, which a run's total sums. `output.json` holds only the last attempt's,
   and a turn's line has no spend to add up, so each attempt keeps its own.

- `file`: the path it ran, for the record. Not identity.
- `workflowVersion`: the workflow's `meta.version`, when it gives one; compared with each
  record's on a continue.
- `flags.fromStage`: only when `--from-stage` was given. `--values` isn't kept here: each value
  it gave is in its stage's record.
- `pid` and `processStart` make liveness checkable without a lock file: the attempt is live while it
  has no `ended` and that process, started at that time, exists. A pid alone could be another
  process after a reboot. Both sides read the start time the same way, `ps -o lstart= -p {pid}` in
  UTC (macOS and Linux), and start times within one second match, since Linux derives `lstart`
  from the boot time.

**`stages/{stage}.json`**: the run's current record of a stage.

```json
{
  "version": 1,
  "stage": "mr",
  "attempt": 1,
  "outcome": "succeeded",
  "started": "2026-10-02T16:33:05Z",
  "ended": "2026-10-02T16:38:12Z",
  "workflowVersion": "1.2.0",
  "sessions": [{ "agent": "worker", "harness": "claude", "session": "5dbd8155-…" }],
  "summary": "!2329",
  "value": { "iid": 2329, "url": "https://…/merge_requests/2329" }
}
```

- Written when the stage ends, by the attempt that ran it. Reusing it leaves the file alone.
- When a later attempt redoes the stage, the file is moved, unchanged, to
  `replaced/{stage}.{attempt}.json` ([[#The stage plan]]). A redone stage's old value often names a
  worktree, branch or MR left behind; that is where it is still found.
- `outcome`: `succeeded`, `stopped` (`workflow.stop`) or `failed` (a throw, a value that fails its
  check, a timeout, a cancellation), with a `reason` string for the last two. Only a succeeded
  record is reused.
- `attempt`: the attempt that ran it.
- `value` is absent for a stage that returns nothing. It is stored as returned, after a JSON round
  trip, and checked again by the current schema whenever it is reused.
- `sessions`: the agents' native sessions the stage used, for [[stopped-run-recovery]] and for
  reading what happened.
- `provided: true`: no turn ran it; its value came from `--values`, or it returns nothing and was
  passed ([[#Starting at a stage]]). Its `attempt` is the one it was given in. It is `succeeded`,
  and reused as any other.

**`turns.jsonl`**: each turn, nudges included, and each compaction, as it settles; `kind` tells
them apart.

```json
{"version":1,"attempt":2,"kind":"turn","agent":"worker","operationId":"…","execution":{…},"stage":"qa","label":"preview","deliveredAt":"…","settledAt":"…","outcome":"answered","sessions":[{"harness":"claude","id":"5dbd8155-…"}]}
```

- `stage` is absent for a turn between stages.
- Appended by the live attempt, a line per turn or compaction. A crash keeps every turn that
  settled, so an `interrupted` attempt still has its sessions. Not its cost: what a turn spent is
  read from its sessions once the attempt ends, and an interrupted attempt has no end. Reading it
  from the sessions later is [[stopped-run-recovery]]'s.
- A line that doesn't parse is skipped wherever it is: a crash can tear the last line, and the next
  attempt appends after it.

**`output.json`**: version 5, what `--json` prints. Replaced by each attempt that ends, so it may
be an earlier attempt's than the last; its `attempt` says which.

- `runId` (the run's id) and `attempt`.
- `outcome` in the attempt file's words: `completed` with its `value`, or `stopped`, `failed`,
  `timed-out` or `cancelled` with `reason` and `stage` (absent between stages).
- `stages`, as in the attempt file, and `report`, whatever the outcome.
- `accounting` in full: `byStage` has a row per stage entered, a reused one at zero, then
  `(no stage)`; `grouping` says whether its rows are stages or, for a run without stages, key
  prefixes.

**`calls/{callId}/`**: a call's `call.json`, `candidates.jsonl` and `result.json`.
**`report.md`**: the last ended attempt's report; removed when an attempt writes none.

### Why it is shaped like this

- **Files, not a database.** A person, an agent or `cat` can read a run; there is nothing to
  migrate, no server, and nothing for two processes to contend over. A run has tens of files and a
  workflow at most thousands of runs, which a folder scan handles.
- **One folder per run, holding its current state.** `ls stages/` is what a continue would reuse.
  Nothing is copied between attempts, and there is no chain to work out from several folders.
- **One writer at a time.** Only the live attempt writes, and the attempt claim makes sure there is
  one. So no write needs a lock.
- **Files replaced whole.** Every `.json` is written to a temp file (`.tmp-{random}`), fsynced and
  renamed into place. A crash leaves the old file or the new one, never half of either. Only
  `turns.jsonl` and a call's `candidates.jsonl` are appended.
- **Nothing stored that can be read off the files.** Status, current stage, cost: computed. A stored
  status is the first thing a crash leaves wrong ("running" forever); a derived one is right as
  soon as the files are.
- **Stale records are moved out at the start point** ([[#The stage plan]]), each by one `rename`
  into `replaced/`. One rule then covers a redone stage, a crash mid-stage and a removed stage, with
  no marker for "entered", and nothing is deleted.
- **The run claim is one `rename`.** `run.json` is written into `runs/{workflow}/.new-{random}/`,
  and the folder renamed to `{id}`. Renaming onto a folder that exists and isn't empty fails, so the
  first to rename holds the id, and a claimed folder always has its `run.json`. There is no index
  of names to keep in step.
- **The attempt claim is one `link`.** The first version of `attempts/{attempt}.json` is written to a temp
  file and linked into place; `link` fails if the name exists (as `writeAcceptedExclusive` does for
  `result.json`). `n` is one more than the highest attempt file; a failed link tries `n + 1`.
  Having claimed `n`, the attempt reads attempts `1 … n-1`; if one is live, it deletes its own file
  and refuses. Of two racing attempts, the later always sees the earlier, since it could only pick a
  higher `n` once the earlier file existed. No lock file means no stale lock and no takeover race.
- **Temp files and folders** (`.tmp-*`, `.new-*`) left by a crash are ignored by readers and
  removed when older than a day.
- **Grouped by workflow, then id.** A run is one path; a workflow's runs are one folder; an id is
  unique within its workflow, which is where a person names them.
- **`version` in every file,** as `output.json` has. A reader refuses a version newer than it
  knows rather than misread it; migrating is decided when a format first changes.
- **Mode 0600.** Records hold prompts' values and paths; secrets come from the environment, never
  argv or stage values.


### Reading it

| Question | Read |
| --- | --- |
| Is an attempt live? | its file has no `ended`, and its `pid` with its `processStart` exists |
| The run's status | the highest attempt: `running` if live; its `outcome` if ended; else `interrupted`, as is a run with no attempt file |
| What a continue reuses | the succeeded records in `stages/`, through the stage plan |
| The current stage | from outside, the stage of the live attempt's last turn; its own view knows exactly |
| The run's cost | each attempt file's `accounting`, summed; an interrupted attempt has none, and `turns.jsonl` holds turns and sessions, no spend |
| A stage's history | `replaced/{stage}.*.json` and `stages/{stage}.json`, ordered by attempt; the attempt files say which attempt reused what |
| A workflow's runs | `runs/{workflow}/*/run.json` |

### Ids

Ids match `[A-Za-z0-9._-]+`, up to 128 characters, not starting with a dot; a new id that differs
only in case from an existing one is refused, since APFS is case-insensitive. `meta.name` follows
the same rule, since it is a folder too. A generated id is sortable and short, local time plus four
random hex digits: `20261004-1532-a7f3`.

### Sandboxes

A sandbox may contain the run root; its provider hides it. Each sandbox's own folder, its homes
and quarantine, is `~/.awf/sandboxes/{workflow}/{id}/{uuid}/`, outside the project: srt on macOS
emits a deny nested in an allowed path after the allow, so a run root inside the project, denied,
would hide a sandbox folder under it too. No sandbox reaches into `~/.awf`, and a run root holding
its sandboxes is refused.

- `resolveSandbox` allows a path that contains the run root, and decides once whether to hide
  it: `ResolvedSandbox.hidden` holds the run root when an allowed path holds it. A path
  inside the run root is still refused.
- Each provider renders `hidden`: srt denies each path for reads and writes, and its
  `checkProfile` refuses an allowed path holding the run root unless it is hidden; docker mounts
  an empty tmpfs over each.

Agents outside a sandbox can reach `.awf/`, and `git clean -xfd` deletes it, as with
`.terraform/`. Only the run's own root is hidden: a sandbox that reads a folder holding other
projects reaches their `.awf/runs`, as it reaches their source.

## One attempt, start to end

```
awf run flow.ts [--id I | --continue I] [--from-stage S [--values F]] -- argv
 1. load flow.ts → meta.name, meta.version, id(args)?
 2. resolve the run
      new run     prepare(argv) → args; id = --id, else id(args), else generated;
                  claim runs/{workflow}/{id} with its run.json (taken → refuse: "AIRS-1515
                  exists; --continue it, or --id another to start over").
      --continue  read runs/{meta.name}/{id}/run.json (missing → look under the other workflows
                  and say where it is, or refuse "no run AIRS-1515 of implement-ticket in
                  {root}; a run is kept under the directory it works in, which --cwd names").
                  argv, cwd and sandbox come from it; flags giving others are refused.
                  prepare(argv) → args with the code as it is now (fails → refuse: "the
                  recorded argv of AIRS-1515 no longer parses with {file}: {error}; start a
                  new run").
                  The last attempt completed and no --from-stage → refuse: "AIRS-1515
                  completed; to redo from a stage, --from-stage one of:", then a line per
                  record: its stage, summary, attempt and age. With no records: "AIRS-1515
                  completed; there is nothing to continue".
 3. claim attempt n (another attempt live → refuse, naming it). Each earlier attempt that reads
    interrupted is named, with the stage of its last turn and the Herdr workspace its panes may
    still be open in, "awf implement-ticket AIRS-1515 #1"; awf names it without asking Herdr.
 4. run the workflow; each stage entered goes through the stage plan. The view shows each reused
    stage as ↺ with its summary and the attempt that ran it, and its age once over an hour, as a
    guard against reusing a stale record; and the stages recorded but not yet reached, dim
 5. write report.md, output.json, then the attempt's ending, last: an ended attempt lets the next
    start, whose files this one's must not overwrite. Exit with the ending's code
```

A refusal exits 2 and leaves nothing behind: a new run's folder is the last thing step 2 does, and
an attempt refused in step 3 deletes its own file. A new run whose attempt ends before it starts, its
runtime failing to install, its host or sandbox failing to open, or the operator cancelling it,
leaves nothing either: its folder goes,
so the same command starts it again. A continued run keeps such an attempt, ended with what it
cost, which is nothing, and the command that goes on.

### The stage plan

Until the attempt reaches its **start point**, each stage entered is reused from `stages/`. From
the start point on, every stage runs. The start point is the `--from-stage` stage; without it, the
first stage entered that has no succeeded record. It is found as stages are entered, so stages need
no outline, and a stage in a branch not taken costs nothing.

| A stage entered before the start point | Decision |
| --- | --- |
| a succeeded record whose value the `result` schema accepts, or no value and no `result` | reuse |
| a succeeded record from another major `meta.version` (under `0.x`, another minor) | stop: "review was recorded by 1.4.0; this is 2.0.0" |
| a succeeded record that no longer fits: its schema rejects the value, or a value where none is expected, or none where one is | stop: "doc-review's record no longer fits its result schema: {problems}" |
| no succeeded record, with `--from-stage` given | its value from `--values`, else stop: "nothing recorded for review" |
| no succeeded record, plain continue | this is the start point: run |

Each of these stops goes on with `--from-stage` that stage, which the ending's command to go on
carries, so the reason doesn't repeat it. One with nothing recorded is the exception: it goes on with
the same `--from-stage` and a value ([[#Starting at a stage]]).

- **Reuse** checks the value against the current schema and returns it; `work` is never called, so
  nothing inside a reused stage runs, compactions included.
- **Reaching the start point**, the attempt moves every record in `stages/` it hasn't reused in
  this attempt to `replaced/`: the start stage's own first, then any built after it or no longer in
  the code. Within one attempt every stage
  from the start point on runs, so each of those records is stale: a qa built on an implement that
  is being redone. It is make's and dbt's rule, with no graph to declare. An attempt that stops
  before its start point moves nothing. A crash part way through the moves is safe: the start
  stage's record went first, so the next continue starts there again and moves the rest.
- **Run** calls `work`, tags its turns and decisions with the stage, and checks the value when it
  is returned: a JSON round trip, then the schema. A value the next attempt couldn't reuse fails
  the stage now, while its context is live. The raw value is stored, so a schema with defaults
  parses it the same way next time.
- A record that is there but doesn't fit **stops** rather than reruns. A plain continue only ever
  picks up after the last thing that ran; rerunning a 3-hour stage and everything after it is the
  operator's choice, made by typing `--from-stage`.
- A `--from-stage` stage never entered (a typo, a branch not taken) ends the attempt `stopped`:
  "never reached qaa". No one command goes on from it: its `continue` ends `--from-stage {stage}`,
  literally, and the closing block lists the recorded stages to choose from under it, as the
  refusal of a completed run does. A `--from-stage` with no record is
  warned about at the start. An attempt that ends before it reaches its `--from-stage` for any
  other reason goes on with the same `--from-stage`, so the redo isn't dropped.

### Starting at a stage

A new run can start at `--from-stage` too, with nothing recorded before it: qa for a ticket built by
hand. A later stage reads the values of earlier ones, so each stage before the start point that has
no record to reuse needs its value, and `--values {file}` gives them, a JSON object by stage name:

```
awf run flow.ts --from-stage qa-local --json -- AIRS-1234
→ stopped in doc-review, needs: [{stage: "doc-review", schema: {…}}, {stage: "review", …}, {stage: "mr", …}]
awf run flow.ts --continue AIRS-1234 --from-stage qa-local --values v.json --json
→ qa-local runs
```

- A value is checked against the stage's `result`, as a recorded one is, and recorded with
  `provided: true`: no turns, no sessions, zero cost. A later continue reuses it as any succeeded
  record. One that doesn't fit stops: "review's value in --values does not fit its result:
  {problems}".
- A stage that returns nothing needs no value: it is passed, and recorded `provided` the same way.
  That holds for a continue's `--from-stage` too: such a stage before it never stops it.
- A stage with no record and no value doesn't stop the attempt at once. It hands back a stand-in its
  schema accepts, the first branch and the least of each bound, and the attempt looks on: each later
  stage with no value is noted the same way, until the start point, where it stops. Nothing is
  recorded while it looks on, no stage's work runs, and a turn, compaction or decision that would
  start ends the look there, as does the workflow's own stop, a throw, or a return: the code between
  stages is running on values no one gave.
- The stop has `needs`, each stage noted and its `result` as JSON Schema, in the order reached, in
  `output.json` and in the closing block, a line each as a type: `needs    review: {rounds: integer
  ≥ 1, ledger: string}`. Its `continue` keeps the start point and names `--values`, the file given
  or `{file}`. So one stop usually names every value, and one more attempt starts at the stage.
- Stages are only found as the run reaches them, so the list is what the stand-ins led to. A real
  value can take another branch, or code between stages can start a turn, and the next attempt
  stops for what it then finds. The loop is meant for an agent: read `needs`, find the values in the
  ticket or the repository, write the file, rerun.
- `--values` is read only for stages with no record to reuse: one recorded and reusable ignores its
  entry. A record that failed or went stale still stops, going on with `--from-stage` that stage;
  `--values` replaces it too, when it has an entry.
- The refusals stay: `--continue` of an id with no run, and a new run on an id that exists.

### Stops and failures

Where a stop happens decides what a continue redoes:

- **Inside a stage** (`workflow.stop`, a throw, a cancellation): the stage is a cancellation scope.
  Turns still open in it are cancelled, then its record is written `stopped` or `failed`. The
  stage has no succeeded record, so a plain continue starts there.
- **Between stages:** no record changes. A continue runs the code between stages again, so a check
  there checks again, and goes on from the first stage with no succeeded record.

So a check on a stage's value that means "redo this stage" belongs inside the stage, as
doc-review's `no-doc` does in [[#An example]]. Written outside, a plain continue would reuse
`no-doc` and stop again. awf catches that: when a plain continue ran no stage and stopped between
stages with the same `reason` as the attempt before, it adds "the same stop as attempt 1; if a
stage's value caused it, --from-stage {stage}, and move the check into that stage". The stage
named is the last one reused before the stop.

### Endings

| Outcome | When | Exit code |
| --- | --- | --- |
| `completed` | the workflow returned | 0 |
| `stopped` | `workflow.stop`, or the stage plan: a record from another major version, a record that no longer fits, nothing recorded after `--from-stage` and no value given, a `--from-stage` never reached | 3 |
| `failed` | an exception | 1 |
| `timed-out` | the attempt's deadline (`--timeout`) | 1 |
| `cancelled` | a signal | 128 + signal |
| `interrupted` | read off the files: an attempt with no `ended` and no live process | none |

A refusal (the id taken, an attempt live, argv on a continue) exits 2, as usage errors do.

`report` is called for every ending, with the `Ending` ([[#The author API]]), so a stopped run
can hand off what its stages found. `present` renders a completed attempt's value, and without it
awf prints the JSON. An attempt that didn't complete is awf's to print: the stage, the reason and
`continue`: `awf run {file} --continue {id}`, plus `--from-stage {stage}` when a plain continue
wouldn't start there. A completed attempt whose runtime then fails to clean up ends `failed`, and
every record of it says so.

## Workflow version

`meta.version` is optional semver, and awf doesn't hash code. Every attempt and stage record stores
it. A record from another major version stops a continue at that stage (the table above); under
`0.x` the minor must match too, as semver has it. Without a version, the schemas alone guard a
continue. A version that stops a continue is named in its stop.

A minor change, a prompt reworded, still reuses: whether this run should redo a stage after a fix
is the operator's call, made with `--from-stage`, and most often the fix is for later runs. A major
version says "records from before this mean something else".

## What breaks it, and what happens

**The workflow file is renamed, moved or copied.** Nothing breaks. A run belongs to `meta.name`,
the operator names the file on every `awf run`, and each attempt records its path for the record
only. Two copies are one workflow: a run started from `flow.ts` continues from `flow2.ts`, which is
how a fix gets tried.

**`meta.name` changes.** Old runs stay under the old name. A continue that finds nothing looks the
id up under the other workflows: "AIRS-1515 is a run of implement-ticket-old; move
runs/implement-ticket-old/AIRS-1515 to runs/implement-ticket to continue it here".

**The code changes between attempts.** Expected: restarting after a fix is the main use. The
continue shows what it reuses, and from which attempt.

**The code's types change.** The defences, from coarse to fine:
1. **Args.** A continue runs the current `prepare` on the recorded argv. argv that no longer
   parses refuses the continue.
2. **The major version.** Records from another major stop the continue.
3. **Stage values.** A value is reused only if the current schema accepts it.
4. **A stage renamed or added.** It has no record: a plain continue starts there; after
   `--from-stage` it stops. The message lists recorded stages the code never reached, so a rename
   is obvious.
5. **A stage removed.** Its record is never asked for, and moves to `replaced/` at the next start point.

A field added as optional keeps old records valid, as in a database migration; a required one
means redoing that stage.

**An attempt dies** (`kill -9`, a crash, the Mac's power). Its file has no `ended` and its process
is gone, so it reads as `interrupted`. Its finished stages were written as they ended. The stage it
was in has no record, and the records after it were moved to `replaced/` when it reached its start point, so a
continue starts there. Its turns and sessions are in `turns.jsonl`; it has no cost, which reading
its sessions afterwards is [[stopped-run-recovery]]'s. Its panes and sandboxes may still be alive,
so the next attempt names it, the stage of its last turn and its Herdr workspace, labelled with the
attempt (`awf implement-ticket AIRS-1515 #2`), without asking Herdr whether it is still open, and
leaves it: a person may be in it. Headless children are [[headless-orphans]].

**Two `awf run`s at once.** The same run: the attempt claim refuses the second. The same new id:
the run claim refuses it. Different runs run side by side.

**Someone deletes files by hand.** A run's folder: its id is free again. A stage record: that
stage runs on the next plain continue. An attempt file: the next attempt may reuse its number. A
file that doesn't parse, or has a newer `version`, refuses a continue, naming the file.

**The world changed since a stage was recorded** (the worktree moved, the MR closed). Not detected.
The continue shows each reused stage with the attempt that ran it, a completed run's refusal lists
each with its age, and a check between stages can stop on what it can see. A `fresh` check per stage is later.

**The harness, model or environment changes.** Records stay valid: only `meta.version`'s major
invalidates them. A stage that should be redone under a new model is `--from-stage`.

**awf's own record format changes.** `version` in every file; an older awf refuses a newer run.
Migrating old runs is decided when a format first changes.

## Writing a workflow with stages

- A stage value is the only hand-off between attempts, so it holds world identifiers: branch,
  worktree, commit, MR, doc path. Code between stages follows [[#Code between stages]].
- Agents start fresh in each attempt. A rerun stage's agent has none of the reused stages'
  context, so its prompt names what it needs. Reopening native sessions is [[stopped-run-recovery]].
- A stage is entered at most once per attempt, so a loop goes inside one stage. One stage at a
  time: parallel work, including child workflows run with `call`, goes inside a stage. The rules
  awf enforces are under [[#The author API]]; stages in child workflows can come later.
- A stage's type comes from `work`. A TypeBox schema doesn't carry its static type through
  `OutputSchema<T>`, so `result` checks the value but doesn't type it; `examples/feature-delivery`
  compiles under `tsc` with its stages.

## Where things are deliberately simple

- **No stored status.** It is read off the files.
- **No index of runs.** A workflow's runs are one folder, fine for thousands.
- **No history in `stages/`.** It holds the current records; redone ones are in `replaced/`.
- **No unchecked values.** A stage returns nothing, or a value its schema checks.
- **No change to a run's argv.** Different input is a different run.
- **No `always`, no `default`.** A check on every attempt is code between stages; `default` comes
  back with `--skip-stage`.
- **No rule against turns between stages.** It's the workflow's call.
- **No fork yet.** Continue the same run.
- **No liveness takeover race.** An attempt is live by its process, and a claim is exclusive.
- **No check that the project changed** since a reused stage, such as its git HEAD. Workflows are
  generic; a stage's own values (a commit, a branch) are where that belongs.

## What stays as it is

- A plain `awf run flow.ts -- argv` is a run with one attempt and a generated id. Lab, autoresearch
  and fire-and-forget use pay nothing extra.
- A workflow that marks no stages runs as before. A continue of it reruns everything.

## Later, on the same model

Each is a reader of the same files, or a row in the stage plan:

- `awf status [workflow]`: runs with their status, current stage, attempts and cost.
- `awf continue {workflow}/{id}`: the last attempt's file and the recorded argv.
- `--to-stage` and `--only-stage`: a stopping point, and a `paused` outcome.
- `--skip-stage {stage}`, with a stage's `default`.
- `fresh` per stage: a stale record reruns.
- `--set qa=file.json`: edit a recorded value, checked by its schema, then continue (LangGraph's
  `updateState`, Inngest's rerun with new input).
- Fork: a new run seeded with another run's records, with `forkedFrom` in `run.json` (DBOS's
  `forkWorkflow`), likely as `--from`, which is why stage flags say `-stage`.
- Stops worth retrying (the provider down, out of credits, a usage limit), with
  [[turn-liveness-and-limits]]: `stop` records whether a retry could help, as Restate's
  `TerminalError` and Temporal's `nonRetryable` do.
- A status the workflow sets (parked, 2026-10-04): "waiting on CI", "MR open", where the work is in
  the workflow's words. Likely a declared `meta.statuses` with a typed `workflow.status(…)`, shown
  in the view, logs, `awf status` and the report. Prior art: Temporal's `setCurrentDetails`.
- A lint rule for workflows: a turn between stages, a variable assigned inside a stage and read
  after it.

Not to copy: deterministic replay of whole functions (Temporal histories, Restate journals, DBOS
step numbers), `patched()` branches, durable timers and signals, code hashing, idempotency TTLs,
and GitHub's rerun on the original commit, the opposite of continuing after a fix. A pause is a
stop and then a continue, not a process kept alive waiting.

## Checked against implement-ticket

The prototype's `flow.ts`, its two live runs on AIRS-1515 and their run notes, through the model:

- **Run 1 stopped in qa; run 2 continued after a fix.** Attempt 2 with a plain `--continue`:
  doc-review, implement, review and mr are reused, qa runs. ✓
- **Run 2's compaction bug** (compactions between stages ran again) can't happen inside a stage,
  and the rule for code between stages is written down. ✓
- **qa's ~27m local half reran** because qa was one stage with two turns. It is two now,
  `qa-local` and `qa-mr`, so a continue after a failed qa-mr keeps the local half. ✓
- **Review runs codex and Opus in parallel** inside one stage. ✓
- **doc-review was `always`.** It becomes a plain stage whose doc path, branch and worktree are
  reused, which removes the run notes' risk of a rerun naming another worktree. ✓
- **Three stops on a stage's value** (no doc, a branch without a preview environment, review
  stopped) move inside their stages. ✓, one edit each.
- **`not-ready` stops in doc-review;** after answering the questions, a plain `--continue
  AIRS-1515` redoes it. ✓
- **Every stage returns a value**, so each gets a schema; review's needs writing. ✓
- **The prototype's `stopped()`** built its result from the stages done; the ending's `stages`
  gives `report` the same. ✓
- **The record lived beside the ticket doc, keyed by ticket.** Here it lives in `.awf/`, keyed by
  the run's id, which the workflow's `id(args)` makes the ticket.
- **`--timeout 10h`** is per attempt; a continue takes its own or none.

## Decisions

What was decided and why is [[0011-a-run-continues-from-its-stages|ADR 0011]].
