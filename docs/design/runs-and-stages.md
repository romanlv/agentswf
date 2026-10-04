---
title: Runs, attempts and stages
type: design
status: draft
story: "[[018-workflow-stages]]"
---

# Runs, attempts and stages

How a workflow run is identified, kept on disk, continued, and broken down into stages, as one
model. [[018-workflow-stages|Story 018]] builds it. This page is the model; the story is the plan.

Read in order: the picture, the author API, the files, then one attempt from start to end. The rest
is what breaks it, what stays, and what was decided.

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
  summary?: (value: T) => string;              // one line for the view and the reuse listing
};

type Ending<Result> =
  | { kind: "completed"; value: Result; stages: StageSummary[] }
  | { kind: "stopped" | "failed" | "timed-out" | "cancelled"; stage?: string; reason: string;
      stages: StageSummary[]; continue: string }; // continue: the command to go on

type StageSummary = { stage: string; source: "ran" | "reused"; outcome: StageOutcome;
                      attempt: number; summary?: string; value?: JsonValue };
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
  - entering a stage while another is open (nested, or two at once from `parallel`);
  - a stage inside a `call`'s child workflow.
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
   continue. awf allows it and tags the turn `(no stage)`; whether to put turns between stages is
   the workflow's call. A lint rule may flag it later.

## State on disk

### Where it lives

State lives in the project, as Terraform's does: `.awf/` in the run's working directory (`--cwd`,
else the shell's). `--run-root {dir}` replaces `.awf/runs` with `{dir}`, and lab uses it for bulk
runs. Today's default, `~/.awf/runs`, goes; runs already there are not moved. awf writes
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
        calls/{callId}/        as today: call.json, candidates.jsonl, result.json
        output.json            the last ended attempt's: what `--json` prints
        report.md              the last ended attempt's, when the workflow writes one
```

Today a run is `~/.awf/runs/invocation-{uuid}/{runId}/`, holding `calls/`, `sandboxes/`,
`output.json` and `report.md`. Calls, the output and the report stay as they are, one level up,
shared by the run's attempts: calls are keyed by uuid, so attempts never collide. Sandboxes move out
of the project, to `~/.awf/sandboxes/{workflow}/{id}/{uuid}/` ([[#Sandboxes]]).

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

**`attempts/{n}.json`**: one attempt: the claim that makes it the live one, then its ending.

```json
{
  "version": 1,
  "n": 2,
  "file": "/Users/roman/dev/braintrust/agent/workflows/implement-ticket/flow.ts",
  "workflowVersion": "1.2.1",
  "flags": { "fromStage": null, "timeout": "10h" },
  "pid": 48211,
  "processStart": "2026-10-02T22:08:40Z",
  "started": "2026-10-02T22:08:41Z",
  "ended": "2026-10-02T22:41:09Z",
  "outcome": "completed",
  "stages": [
    { "stage": "doc-review", "source": "reused", "attempt": 1, "summary": "docs/AIRS-1515.md" },
    { "stage": "qa", "source": "ran", "outcome": "succeeded", "summary": "preview ok" }
  ]
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

- `file`: the path it ran, for the record and the message when a run is continued from another
  file. Not identity.
- `workflowVersion`: compared with each record's on a continue.
- `pid` and `processStart` make liveness checkable without a lock file: the attempt is live while it
  has no `ended` and that process, started at that time, exists. A pid alone could be another
  process after a reboot. Both sides read the start time the same way, `ps -o lstart= -p {pid}`
  (macOS and Linux), and compare it to the second.

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

**`turns.jsonl`**: each turn, nudges included, and each compaction, as it settles; `kind` tells
them apart.

```json
{"version":1,"attempt":2,"kind":"turn","agent":"worker","operationId":"…","execution":{…},"stage":"qa","label":"preview","deliveredAt":"…","settledAt":"…","outcome":"answered","sessions":[{"harness":"claude","id":"5dbd8155-…"}]}
```

- Appended by the live attempt, a line per turn or compaction. A crash keeps every turn that
  settled, so an `interrupted` attempt still has its sessions. Not its cost: what a turn spent is
  read from its sessions once the attempt ends, and an interrupted attempt has no end. Reading it
  from the sessions later is [[stopped-run-recovery]]'s.
- A line that doesn't parse is skipped wherever it is: a crash can tear the last line, and the next
  attempt appends after it.

**`output.json`**: today's record, version 5, what `--json` prints. Replaced by each attempt that
ends, so it may be an earlier attempt's than the last; its `attempt` says which. Adds `run` and
`attempt`; `outcome` takes the attempt file's words, `completed` (was `succeeded`) with its
`value`, or `stopped`, `failed`, `timed-out` or `cancelled` with `reason` (was `error`) and
`stage` (absent between stages); `report` whatever the outcome; `stages`, as in the attempt file; `byStage` from stages with a `(no stage)` row, which
has each stage's time and cost, and `grouping` saying whether its rows are stages or key prefixes.
`byAgent.stage` goes.

**`calls/`, `report.md`**: as today. A call's `attempts.jsonl` becomes
`candidates.jsonl`, with the type it holds ([[#What else changes]]).

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
- **The attempt claim is one `link`.** The first version of `attempts/{n}.json` is written to a temp
  file and linked into place; `link` fails if the name exists (as `writeAcceptedExclusive` does for
  `result.json` today). `n` is one more than the highest attempt file; a failed link tries `n + 1`.
  Having claimed `n`, the attempt reads attempts `1 … n-1`; if one is live, it deletes its own file
  and refuses. Of two racing attempts, the later always sees the earlier, since it could only pick a
  higher `n` once the earlier file existed. No lock file means no stale lock and no takeover race.
- **Temp files and folders** (`.tmp-*`, `.new-*`) left by a crash are ignored by readers and
  removed when older than a day.
- **Grouped by workflow, then id.** A run is one path; a workflow's runs are one folder; an id is
  unique within its workflow, which is where a person names them.
- **`version` in every file,** as `output.json` has today. A reader refuses a version newer than it
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
| The run's cost | `turns.jsonl`, summed, by attempt or in total |
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

- `resolveSandbox` stops refusing a path that contains the run root, and decides once whether to
  hide it: `ResolvedSandbox.hidden` holds the run root when an allowed path holds it. A path
  inside the run root is still refused.
- Each provider renders `hidden`: srt denies each path for reads and writes, and its
  `checkProfile` refuses an allowed path holding the run root unless it is hidden; docker mounts
  an empty tmpfs over each.

Agents outside a sandbox can reach `.awf/`, and `git clean -xfd` deletes it, as with
`.terraform/`. Only the run's own root is hidden: a sandbox that reads a folder holding other
projects reaches their `.awf/runs`, as it reaches their source.

## One attempt, start to end

```
awf run flow.ts [--id I | --continue I] [--from-stage S] -- argv
 1. load flow.ts → meta.name, meta.version, id(args)?
 2. resolve the run
      new run     --from-stage → refuse: there is nothing to reuse.
                  prepare(argv) → args; id = --id, else id(args), else generated;
                  claim runs/{workflow}/{id} with its run.json (taken → refuse: "AIRS-1515
                  exists; --continue it, or --id another to start over").
      --continue  read runs/{meta.name}/{id}/run.json (missing → look under the other workflows
                  and say where it is, or refuse "no run AIRS-1515").
                  argv, cwd and sandbox come from it; flags giving others are refused.
                  prepare(argv) → args with the code as it is now (fails → refuse: "the
                  recorded argv no longer parses: {error}; start a new run").
                  The last attempt completed and no --from-stage → refuse: "AIRS-1515 completed;
                  --from-stage {stage} to redo from there".
 3. claim attempt n (another attempt live → refuse, naming it). An earlier attempt that reads
    interrupted is named, with its Herdr workspace if one with its label is still open.
 4. print what stages/ holds: each stage, the attempt that ran it, how old, its summary
 5. run the workflow; each stage entered goes through the stage plan
 6. write the attempt's ending, output.json and report.md; exit with the ending's code
```

A refusal exits 2 and leaves nothing behind: a new run's folder is the last thing step 2 does, and
an attempt refused in step 3 deletes its own file.

### The stage plan

Until the attempt reaches its **start point**, each stage entered is reused from `stages/`. From
the start point on, every stage runs. The start point is the `--from-stage` stage; without it, the
first stage entered that has no succeeded record. It is found as stages are entered, so stages need
no outline, and a stage in a branch not taken costs nothing.

| A stage entered before the start point | Decision |
| --- | --- |
| a succeeded record whose value the `result` schema accepts, or no value and no `result` | reuse |
| a succeeded record from another major `meta.version` | stop: "review was recorded by 1.x; this is 2.0; --from-stage review" |
| a succeeded record that no longer fits: its schema rejects the value, or a value where none is expected, or none where one is | stop: "doc-review's record no longer fits: {error}; --from-stage doc-review" |
| no succeeded record, with `--from-stage` given | stop: "nothing recorded for review; --from-stage review" |
| no succeeded record, plain continue | this is the start point: run |

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
  "never reached qaa". A `--from-stage` with no record is warned about at the start.

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
| `stopped` | `workflow.stop`, a `--from-stage` never reached | 3 |
| `failed` | an exception | 1 |
| `timed-out` | the attempt's deadline (`--timeout`) | 1 |
| `cancelled` | a signal | 128 + signal |
| `interrupted` | read off the files: an attempt with no `ended` and no live process | none |

A refusal (the id taken, an attempt live, argv on a continue) exits 2, as usage errors do today.

`report` is called for every ending, with the `Ending` ([[#The author API]]), so a stopped run
can hand off what its stages found. `present` renders a completed attempt's value, and without it
awf prints the JSON. An attempt that didn't complete is awf's to print: the stage, the reason and
`continue`: `awf run {file} --continue {id}`, plus `--from-stage {stage}` when a plain continue
wouldn't start there. A completed attempt whose runtime then fails to clean up ends `failed`, and
every record of it says so.

## Workflow version

`meta.version` is optional semver, and awf doesn't hash code. Every attempt and stage record stores
it. A record from another major version stops a continue at that stage (the table above). Without a
version, the schemas alone guard a continue. The continue prints each reused stage's version.

A minor change, a prompt reworded, still reuses: whether this run should redo a stage after a fix
is the operator's call, made with `--from-stage`, and most often the fix is for later runs. A major
version says "records from before this mean something else".

## What breaks it, and what happens

**The workflow file is renamed, moved or copied.** Nothing breaks. A run belongs to `meta.name`,
the operator names the file on every `awf run`, and each attempt records its path for the record
only. Two copies are one workflow: a run started from `flow.ts` continues from `flow2.ts`, which is
how a fix gets tried; the continue says the last attempt ran another file.

**`meta.name` changes.** Old runs stay under the old name. A continue that finds nothing looks the
id up under the other workflows: "AIRS-1515 is a run of implement-ticket-old; move
runs/implement-ticket-old/AIRS-1515 to runs/implement-ticket to continue it here".

**The code changes between attempts.** Expected: restarting after a fix is the main use. The
continue prints what it reuses, from which attempt and version.

**The code's types change.** The defences, from coarse to fine:
1. **Args.** A continue runs the current `prepare` on the recorded argv, and prints how the args
   differ from the last attempt's. argv that no longer parses refuses the continue.
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
continue starts there. Its turns, sessions and cost are in `turns.jsonl`. Its panes and sandboxes
may still be alive, so the next attempt names it and its Herdr workspace, labelled with the attempt
(`awf implement-ticket AIRS-1515 #2`), and leaves it open: a person may be in it. Headless children
are [[headless-orphans]].

**Two `awf run`s at once.** The same run: the attempt claim refuses the second. The same new id:
the run claim refuses it. Different runs run side by side.

**Someone deletes files by hand.** A run's folder: its id is free again. A stage record: that
stage runs on the next plain continue. An attempt file: the next attempt may reuse its number. A
file that doesn't parse, or has a newer `version`, refuses a continue, naming the file.

**The world changed since a stage was recorded** (the worktree moved, the MR closed). Not detected.
The continue prints each reused stage with its age, and a check between stages can stop on what it
can see. A `fresh` check per stage is later.

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
  `OutputSchema<T>` today, so `result` checks the value but doesn't type it; a type test proves the
  example compiles.

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

## What stays as it is

- A plain `awf run flow.ts -- argv` is a run with one attempt and a generated id. Lab, autoresearch
  and fire-and-forget use pay nothing extra.
- A workflow that marks no stages runs as today. A continue of it reruns everything.

## What else changes

- **`WorkflowContext.runId`** is the run's id, the same across attempts, beside an `attempt`
  number. A workflow that keys a branch on `runId` keeps it across a continue.
- **The run root.** `~/.awf/runs` and `invocation-{uuid}/` go; `operator-cli.ts`'s default and its
  help text, and AGENTS.md's mention, change with them.
- **`output.json` goes to version 5**, as under [[#Each file]]; `byAgent.stage` goes, since an
  agent now works in several stages.
- **The word "attempt".** The result-slot candidate `Attempt` in
  `packages/contract/src/records.ts`, whose doc already calls it a candidate, becomes `Candidate`,
  before `AttemptRecord` is published, and the call's `attempts.jsonl` (now in `runs.ts`) becomes
  `candidates.jsonl`.
- **lab.** `RUN_OUTCOMES` (`packages/lab/.../format/scoring.ts`) gains `stopped`, and keeps
  `succeeded` for a completed run, which its stored scores say; contained runs
  move `runs/*`; `tests/calling-session.eval.ts` and lab's reference stop expecting `invocation-*`.
- **The caller claim** (`claimCaller`, now in `here.ts`) moves to one machine-wide path, since
  per-project run roots would split it.
- **`--here` with `--continue`** resolves the run first and prepares the recorded argv.
- **Workflow tests:** `runId` becomes an input to `startWorkflow`, `TestRun` gains `stopped`, and
  `testWorkflow(…, { fromStage, recorded })` reuses recorded stages without calling their work.
- **ADR 0011** states how `stage` and the unbuilt `steps` relate: a step is a durable unit inside a
  stage. `Steps` stays.
- **ADR 0001:** each task adds its use to the in-repo example, so no published type lands without a
  consumer.

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
  `forkWorkflow`).
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
- **qa's ~27m local half reran** because qa is one stage with two turns. Splitting it into
  `qa-local` and `qa-mr` is the workflow's choice. ✓
- **Review runs codex and Opus in parallel** inside one stage. ✓
- **doc-review was `always`.** It becomes a plain stage whose doc path, branch and worktree are
  reused, which removes the run notes' risk of a rerun naming another worktree. ✓
- **Three stops on a stage's value** (no doc, a branch without a preview environment, review
  stopped) move inside their stages. ✓, one edit each.
- **`not-ready` ends completed;** after answering the questions, `--continue AIRS-1515
  --from-stage doc-review`. ✓
- **Every stage returns a value**, so each gets a schema; review's needs writing. ✓
- **The prototype's `stopped()`** built its result from the stages done; the ending's `stages`
  gives `report` the same. ✓
- **The record lived beside the ticket doc, keyed by ticket.** Here it lives in `.awf/`, keyed by
  the run's id, which the workflow's `id(args)` makes the ticket.
- **`--timeout 10h`** is per attempt; a continue takes its own or none.

## Settled in the second pass

Settled by reasoning on 2026-10-04, from the review's questions. Each is in the model above; veto
any here.

- **Stale records:** at its start point an attempt moves every record it hasn't reused to
  `replaced/`. A crash mid-stage then leaves no later records to reuse.
- **A record that is there but doesn't fit stops**, naming `--from-stage`. A completed run needs
  `--from-stage` to continue.
- **Stops:** inside a stage, the stage reruns; between stages, nothing is invalidated and the check
  runs again. A repeated stop between stages says to move the check.
- **Versioning:** `meta.version`'s major, as decided. No per-stage version: a minor change is
  reused, and redoing a stage for this run is `--from-stage`. The reviewers' "too coarse" holds
  only if a major is bumped for a minor change.
- **`default` cut** until `--skip-stage`, and `--from-stage` on a new run refused.
- **No separate lock file:** the attempt claim is the lock, live by pid and process start time.
- **Exit codes:** `stopped` 3, refusals 2, as in the endings table.
- **`interrupted`** is read off the files, never written.
- **The result-slot `Attempt` becomes `Candidate`.**
- **A dead attempt's panes and sandboxes are listed, not closed:** a person may be in one.
- **Claims:** a run by renaming a prepared folder into place, an attempt by linking its file.
- **Generated ids** use local time.
- **Dropped from the review's proposals:** warning when the project's git HEAD changed since a
  reused stage. Workflows are generic, and a stage's own values (a commit, a branch) are where
  that belongs.

## Decided

- **State lives in the project:** `.awf/` in the working directory, as Terraform's; `--run-root`
  overrides it. A sandbox may contain it, and its provider hides it. (2026-10-04)
- **One folder per run, holding its current state.** Attempts are files in it; `stages/` holds one
  record per stage; a redone stage's old record moves to `replaced/`. (2026-10-04)
- **"Reused", not "replayed".** A reused stage's work is not called; its recorded value is
  returned. (2026-10-04)
- **Turns between stages are allowed,** tagged `(no stage)`; a lint rule may flag them later.
  (2026-10-04)
- **No code hashing:** an optional `meta.version` (semver); its major decides compatibility.
  (2026-10-04)
- **`--id`, no names.** A run's id is given with `--id` or generated, unique within its workflow;
  runs live at `runs/{workflow}/{id}/`, and creating that folder claims the id. (2026-10-04)
- **Stage flags say they're about stages:** `--from-stage`, later `--to-stage`, `--only-stage`,
  `--skip-stage`. Run flags stay `--id` and `--continue`, leaving a bare `--from` for a fork.
  (2026-10-04)
- **`result` is optional.** A stage returns nothing, or a value its schema checks. (2026-10-04)
- **No `always`.** A check on every attempt is code between stages. (2026-10-04)
- **One stage at a time.** Parallel work, including child workflows with `call`, goes inside a
  stage. (2026-10-04)
- **`runId`** is the run's id, the same across attempts, with a separate `attempt` number.
  (2026-10-04)
- **`stopped`** is its own outcome, apart from `failed`. (2026-10-04)
- **awf provides the API; wrappers ship in a workflow's boilerplate.** awf gains `stage`, `stop`,
  `id(args)` and a stage's `summary`. `ask` (a turn that stops without an answer), `md` and
  duration strings stay in the boilerplate, over `run` and `stop`; whether `timeoutMs` becomes a
  duration in awf's API is [[readable-workflows]]. (2026-10-04)
- **The workflow derives the id:** an optional `id(args)` in its definition, beside `prepare`. awf
  calls it after `prepare` and before creating the run; `--id` overrides it; a taken id refuses
  ("AIRS-1515 exists; --continue it, or --id another to start over"). (2026-10-04)
- **A stage may give a one-line `summary(value)`** for the view and the reuse listing
  (`mr ↺ attempt 1 · !2329`). (2026-10-04)
