---
id: "040"
title: "A program drives a workflow's runs, typed from the workflow"
summary: "An ordinary Bun program imports a workflow and emits events to it, starts runs, and waits on them in-process, each call checked by tsc from the workflow's own definition, on the engine the project depends on."
type: story
status: ready
epic: authoring
discovered_in: "a question about driving workflows from a webhook handler, 2026-11-04"
depends_on: ["034", "039"]
---

# A program drives a workflow's runs, typed from the workflow

## Outcome

Today a program that reacts to the world (a GitHub webhook handler, a Slack bot, a cron script)
reaches a workflow only through the CLI: `awf emit --target file.ts --id {id} name '{json}'`,
`awf run file.ts -- argv`, `awf inbox --json`, then `awf runs {ref} --json` to read what happened.
It spawns a process per call, serialises its data to strings, parses what comes back, and loses
the static types the workflow already declares.

After this story the same program writes:

```ts
import { client } from "agentswf/client";
import release from "./release.workflow.ts";
import review from "./review.workflow.ts";

const runs = client();                                   // the operator's home and environment

// A webhook: the event starts the PR's run or wakes it.
const sent = await runs.emit(review, `pr-${pr.number}`, "pr.pushed",
  { sha: pr.sha, branch: pr.branch },                    // tsc checks the name and the data
  { eventId: delivery, source: "github" });              // a resent delivery is a duplicate

// A Slack bot: relay what runs posted, and a person's answer back.
const items = await runs.inbox(review, { after: cursor });
for (const item of items) if (item.kind === "post") await slack.post(threadOf(item), item.text);
cursor = items.at(-1)?.cursor ?? cursor;                 // the next read starts after these
await runs.emit(review, `pr-${pr.number}`, "thread:reply", { text, author });

// A script: start a run with typed args, and wait until nothing will continue it.
const started = await runs.start(release, { version: "1.4.0" }, { id: "v1.4.0" });
const done = await started.run.wait({ final: true });   // { state, final, ending? }
```

`tsc` refuses an event name the workflow doesn't declare, data its schema refuses, args its
`prepare` doesn't return, and a workflow with no `file`. Whether a run was live, parked or new,
and whether a process had to be launched for it, is the engine's business. Every operation on a
project's runs, from this client, `awf tick` or `awf emit`, runs on one engine: the `agentswf`
the project depends on.

This is a client of the run record and the mailbox, not [[foundation]] §7's programmatic entry
point, a run hosted in the caller with injected configuration; that stays unbuilt. A run the client
starts lives where every event run already lives: in a detached attempt, outliving the program.

## How it works

```
  your program                                    the project (nearest .awf/ above review's file)
  ────────────                                    ───────────────────────────────────────────────
  import review from "./review.workflow.ts" ───▶  node_modules/agentswf: the project's engine
  runs = client()                                  (none: the CLI runs it on the global awf;
                                                    the client refuses it)

  runs.emit(review, id, name, data)   ─▶ lock run {id} → create it / append to its mailbox → wake
  runs.start(review, args, { id })    ─▶ lock run {id} → create it with its args, or find it → launch
  runs.get(review, id)                ─▶ open run {id}
  runs.inbox(review, { after })       ─▶ what its runs posted since the cursor
          │                                        wake: live ─▶ nudge its socket
          ▼                                              parked, new ─▶ launch an attempt
  Run<Result>
    status()            { state, final, ending? }   ◀── the run's files and its attempt's pid
    wait()              the next time it rests: ends, parks, crashes or sticks
    wait({ final })     the first rest nothing will continue on its own
```

- **The types travel with the import.** `defineWorkflow` returns `Workflow<Args, Result, Events>`.
  `emit` takes the names and data the workflow declares, plus its declared `{key}:reply`; `start`
  takes `Args`; a `Run` carries `Result`. Two reviews' scratch `tsc` probes checked the
  definitions below against real workflows: names, data and args infer, and every refusal fires.
- **One way to address a run: the workflow and its id.** Every call takes the workflow value and
  the run's id, as `wf.emit` does. The value's `file` says where the workflow and its project are.
- **The record is the seam.** Each call is the code the CLI runs (`emitEvent`, the run creation,
  the readers), in the program's process. A run lives in its files and in detached attempts, so
  the program can exit or restart, and any other sender reaches the same run.
- **The project's engine runs the project's runs.** It is the `agentswf` installed in a
  `node_modules` at or above the project, and engines are told apart by their installed version:
  a copy at the same version is the same engine. The global `awf` hands a command over to a
  project at another version before parsing anything; the engine that runs a command refuses a
  file or run whose project is at another version; `awf tick --all` runs each project's own
  engine; the client refuses a project at a version other than its own. Today the global `awf`
  serves its own copy of `agentswf/workflow` even to a project that pins another: measured below.
- **A process is still launched when a run must start or continue,** and the call waits, holding
  the run's lock, until that attempt has claimed the run: up to 60 s after a Bun start and a
  workflow load. What goes away is the caller's own process and its string round trip.
- **Waiting is reading.** `wait` polls the run's state as `awf runs` reads it, the attempt's pid
  included, so a crash is seen too. Whether a rest is final is the run's to say: an event run that
  failed is continued by its next wake, a plain one is not.
- **Errors are values where the run decided, throws where the caller erred.** `emit` and `start`
  return what the run's state made of the call; a name, data, id or engine the caller got wrong
  throws a `ClientError`.
- **The client is a value.** A handler takes a `Client` as a parameter; its test passes the fake
  client from `agentswf/testing`, which keeps the calls it is given and answers as the test scripts.

## Scope

In scope:

- **One engine per project**: the global `awf` hands over to a project's `agentswf` at another
  version; an engine refuses a file or run of a project at another version; `awf tick --all` per
  project; `awf --version` shows both; the install guide's updating section, per project.
- `agentswf/client`, a third subpath of the existing `agentswf` package (no new package): `client`,
  `Client` with `emit`, `start`, `get` and `inbox`, and the `Run` handle with `status` and `wait`.
- `emit` of a workflow's own events and of the `{key}:reply` it declares.
- `source` on an event: the integration that sent it, optional in the mailbox record and on
  `WorkflowEvent`, and `awf emit --source`.
- Recorded args: a run started from code records its args, and its attempts use them.
- `file` on a workflow without events, and `defineWorkflow` keeping `file` in its type when given.
- A plain run started from code: in the workflow's project, registered, its `PATH` and `file`
  recorded, as an event run's are.
- The fake client in `agentswf/testing`.
- `packages/agentswf/src/client.typecheck.ts`.
- An example driver beside an event workflow, and a site guide page.
- ADRs: one engine per project; recorded args.

Out of scope:

- Answering an agent's question (`awf reply`), which goes over a live run's socket, not the
  mailbox.
- Stopping a run from a program. awf has no stop command yet; [[run-in-background]] notes that
  `awf stop {id}` follows from `--bg`. The handle gains `stop()` when it exists.
- `awf run --bg` and `awf wait` ([[run-in-background]]). They become the CLI's form of `start` and
  `wait`, built on this story's engine calls, in that story.
- `start`'s `cwd`, `timeout`, `sandbox` and panes. A started run works in its project root, as an
  event run does, with no deadline; each option is additive later.
- A runtime check of args from code. They are checked by `tsc` and as JSON; `prepare` doesn't run.
  An args schema on the workflow would be an author-surface addition, later.
- Showing a run's recorded args in `awf runs`.
- Node. The packages are Bun-only until [[node-runtime]].
- A limit on live runs, and a spend ceiling ([[live-spend-limits]]). `starts` bounds which events
  open a run; verifying a webhook's signature is the program's.
- An HTTP server in awf. The program owns its transport; awf owns the run.

## Context and evidence

- Measured, 2026-11-04: a project with `agentswf` 0.1.0-beta.5 in `node_modules`, the global
  `awf` at beta.4. `awf run probe.workflow.ts` ran the workflow against beta.4's author surface,
  18 exports, though `import.meta.resolve("agentswf/workflow")` reported the local path; the
  project's `awf` gave beta.5's 13; a program importing the workflow got beta.5's. The loader's
  plugin (`workflow-loader.ts` `serveAuthorSurface`) serves the running engine's copies.
- Measured: in a directory with no `node_modules` above it, `Bun.resolveSync("agentswf/workflow",
  dir)` returns a copy from `~/.bun/install/cache`, Bun's auto-install. A resolver can't tell "not
  installed" from "installed"; walking up for `node_modules/agentswf/package.json` can.
- Measured: `bun x.ts` reads a `.env` in its cwd; `bun --no-env-file` doesn't. A foreground `awf`
  reads none (its shebang, `test-command.ts:96`, `here.ts:101`); a detached attempt reads the
  project's (`wake.ts:118`).
- Fact: every command parser refuses an option it doesn't know (`emit-command.ts` `parse`,
  `run-command.ts:150`), and a record newer than the reading engine is refused (`runs.ts:666`);
  `listRuns` passes over a run it can't read. So an older global can't parse a newer project's
  command or read its runs.
- Fact: `awf init` adds `agentswf` to the project's devDependencies (`init-command.ts`
  `DEV_DEPENDENCIES`); the install guide says a workflow needs nothing installed, and that
  `bun add -g` updates what `awf` serves. After this story the second holds only for a folder
  with no `agentswf`.
- Fact: `emitEvent` (`engine/src/emit.ts:46`) checks against the value it is passed, creates a run
  for a starting event in the project root (`cwd: project`), and through `wake` launches attempts
  with `detachedLaunch`, the engine beside itself. `EmitContext` carries an injectable `launch`.
- Fact: since story 039 a participant's reply goes by `awf emit {run} {key}:reply`, data
  `ParticipantReply`; it never starts a run (`emitToRun`). `wf.emit` refuses replies: a workflow
  doesn't speak as a participant. A participant's `post` lands in `awf inbox` (`InboxItemJson`).
- Fact: `EmitResultJson` is published as `awf emit --json`, with `did`, `why`, `error`.
- Fact: the mailbox reader keeps a record by `version` and `kind` only, so an optional field there
  is additive. `run.json` is different: a field that changes what an attempt does is ignored by an
  engine that predates it.
- Fact: `prepare` maps `{ argv, cwd }` to `Args`; `run.json` records argv, "a continue prepares it
  again" (`RunRecord.argv`; ADR 0011). Stage reuse stops across a major `meta.version` for a plain
  run and ignores the version for an event run (`stage-plan.ts`).
- Fact: `awf tick` passes over runs without events (`tick-command.ts:55`), and `wake` stops
  continuing a run three failures in a row (`stuckOf`). An interrupted attempt has no outcome;
  only the pid probe in `statusOf` sees it.
- Fact: `Workflow<Args, Result, any>` selects the events branch and refuses every plain workflow;
  `Workflow<Args, Result> | Workflow<Args, Result, any>` infers both (tsc probe).
- Constraint: [[foundation]] §7: the alias table and run policy are arguments to the engine, not
  files it silently loads. The client takes neither, because it hosts no run; its `home` and
  `environment` say only whose runs it reaches and what a launched attempt inherits.
- Constraint: boundary 6. A workflow imports `agentswf/workflow` only; a program may import
  `agentswf/client`. An example driver needs its own boundary rule.
- Constraint: [[run-record-layout]] is redesigning the run's folder (`design/run-record.md`, its
  `created` line). Recorded args go into whichever record ships first; whichever lands second
  carries them over.
- Assumption: the program runs as the operator: the same user, `HOME`, and a `PATH` that holds the
  harnesses and Herdr. The `PATH` of whoever creates a run is recorded for every later attempt.
- Assumption: the program executes the workflow module and, for a starting event, its `prepare`.
  A redeployed workflow makes the program's checks stale until it restarts: the client accepts data
  for the old schema, and the attempt, loading the new file, may refuse it.

## Code map

### packages/contract

- `src/client.ts`, new, exported as `@agentswf/contract/client`, outside `author` (which
  `agentswf/workflow` re-exports and the loader serves to every workflow): `Client`, `Run`,
  `RunStatus`, `StartResult`, `ClientError`, `EventData`, `Sendable`, `EventsOf`, `Located`, and
  `Startable`; `Ending` is the existing one in `workflow/executable.ts`.
- `src/workflow/events.ts`: `WorkflowEvent.source?`, `EmitOptions.source?`; `EventData` shared with
  `WorkflowContext.emit`.
- `src/records.ts`: the mailbox event's `source?`; the run record's `args`.
- `src/workflow/executable.ts`: `WithoutEvents.file?: string`; `defineWorkflow` keeps a given
  `file` in its return type by overloads, plain and with events, that take `& { file: string }` and
  return `& { readonly file: string }`, so it holds with explicit type arguments
  (`defineWorkflow<FeatureArgs, Handoff>`, `examples/feature-delivery/workflow.ts:108`) too; the
  events form's `StartsAndFile` (`executable.ts:126`) stops widening it to `file?`.

### packages/engine

- `src/hand-over.ts`, new and small, importing nothing of the engine: finds the project's engine
  and hands over. Called first by the published bin, `agentswf/src/awf.ts`, which then imports
  `@agentswf/engine/cli` dynamically. Not by the engine's own bin, `operator-cli.ts`, which a
  clone runs and `detachedLaunch` spawns, already the project's engine; never in `runOperatorCli`,
  which tests and the lab call in-process.
- `src/operator-cli.ts`: the project check where a command resolves its file or run; `--version`.
- `src/workflow-runner.ts` `wf.emit`: the same check on its target's project.
- `src/tick-command.ts`: `--all` runs each project's engine with `--run-root --json` and merges.
- `src/workflow-loader.ts`: checks a plain workflow's `file` against its path, as an event one's.
- `src/emit.ts` `emitEvent`, `emitToRun`, `deliver`, `createEventRun`: the client's emit and reply
  paths; `source` written. `emitToRun` loads the target's file through the loader
  (`emit.ts:103`); the client's reply checks against the value it is given instead, so no
  author-surface plugin is registered in the program. `openEventRun` (`emit.ts:259`), `awf run
  --id`'s path, wakes a run that exists; `start` doesn't reuse it, since it launches only a run
  with no attempt.
- `src/run-prepare.ts`, `src/runs.ts` `createRun`, `src/projects.ts` `recordProject`: a run created
  from code, with args, registered; attempts that use recorded args.
- `src/run-state.ts` `statusOf`, `stuckOf`; `src/runs.ts` `readAttempts`; `src/attempt-output.ts`:
  `status` and `wait`.
- `src/inbox-command.ts`: the reader `inbox()` shares.
- `src/mailbox.ts`: `source` into the event a wait returns.
- `src/client/`, new; `package.json` `exports` gains `./client`.
- `src/workflow-testing/`: the fake client.
- `src/wake.ts` `detachedLaunch`: unchanged; it spawns the `operator-cli.ts` beside itself, which
  is at the project's version, the project's own after a hand-over.

### packages/agentswf

- `package.json` `exports` gains `./client`; `src/client.ts`, `src/client.typecheck.ts`;
  `src/awf.ts` runs the hand-over before importing the CLI.

### scripts/check-boundaries.ts

- The client imports neither `operator-runtime.ts` nor any provider and never calls
  `serveAuthorSurface`; an example driver imports `agentswf/client` and may use runtime built-ins.

### examples/ and site/

- One driver with its test; a guide page; `site/guide/install.md`'s updating section.

### Checked, no change expected

- `harness`, `sandbox`, `wfa`: reached through the attempt's own engine; `wfa` is bundled by it.
- The coordinator socket already refuses a peer of another version, naming both.
- `lab`: passes argv through `awf run` only.

## Proposed design

### The surface

```ts
// @agentswf/contract/client; agentswf/client adds `client`.
type EventsOf<W> = W extends Workflow<any, any, infer E> ? E : never;
type Sendable<W> = OwnNames<EventsOf<W>> | Extract<keyof EventsOf<W> & string, `${string}:reply`>;
type EventData<W, N> = N extends `${string}:reply`
  ? ParticipantReply
  : N extends keyof EventsOf<W> ? OutputOf<EventsOf<W>[N]> : never;
type Located = { readonly file: string };
type Startable<Args extends JsonValue, Result extends JsonValue> =
  (Workflow<Args, Result> | Workflow<Args, Result, any>) & Located;

type Client = {
  emit<W extends Workflow<any, any, any> & Located, N extends Sendable<W>>(
    workflow: W, run: string, name: N, data: EventData<W, N>,
    options?: { eventId?: string; source?: string },
  ): Promise<EmitResultJson>;
  start<Args extends JsonValue, Result extends JsonValue>(
    workflow: Startable<Args, Result>, args: Args, options?: { id?: string },
  ): Promise<StartResult<Result>>;
  get<Result extends JsonValue>(workflow: Startable<any, Result>, run: string): Promise<Run<Result>>;
  inbox(workflow: Startable<any, any>, options?: { after?: string }): Promise<InboxItemJson[]>;
};

type StartResult<Result> = {
  run: Run<Result>;
  did: "started" | "exists" | "launch-failed";
  error?: string;
};

type Run<Result> = {
  readonly id: string;
  readonly ref: string;                                   // {workflow}/{id}, for awf runs and logs
  status(): Promise<RunStatus<Result>>;
  wait(options?: { final?: boolean }): Promise<RunStatus<Result>>;
};

type RunStatus<Result> = {
  state: RunStateJson;                                    // running, parked, completed, stuck, …
  /**
   * Nothing will continue it on its own: completed, stopped, cancelled, stuck; a plain run also
   * failed, timed-out, interrupted. An event run that failed is continued only by its next event
   * or `awf tick`: with neither, a final wait waits on.
   */
  final: boolean;
  /** The last attempt's, once it has ended. */
  ending?: Ending<Result>;
};

declare function client(options?: { home?: string; environment?: Record<string, string | undefined> }): Client;
```

- `emit` and `wf.emit` share `EventData`. They differ in two ways, both because the client stands
  outside the run: it may send a participant's reply, which a workflow can't, and it returns the
  CLI's result. A reply goes to a run that exists and never starts one.
- `start` is "make sure this run exists and has been launched". Without `id`, the workflow's
  `id(args)` names the run, or else a new id as `awf run` makes one. A new id is created with its
  args and launched: `started`. An id already there is `exists`, its args not compared, and if it has
  never had an attempt it is launched now, so a retry after a failed launch works for a plain run as
  for an event one. A launch that fails is `launch-failed`, the run kept. For a workflow with
  `starts`, `start` is how a run gets args: a run begun by `emit` gets what `prepare` makes of none,
  and one begun by `start` has no starting event, so its first `receive` waits.
- `wait()` resolves at the run's next rest after the call, or at once if it isn't running;
  `wait({ final: true })` at the first rest whose `final` is true. A crash is a rest (`interrupted`).
  `wait` and `status` reject only when awf can't read the run.
- `ClientError { code, message, ref? }`: an unknown or refused name, data a schema refuses, an id
  the grammar refuses, a workflow whose `file` isn't its own path, a project with no `agentswf`, a
  project at another version than the client's. Whether `file` is its own path: the client imports
  `file`, which its module cache already holds, and checks its default export is the value given,
  as the loader does (`workflow-loader.ts:89`). A project with no `agentswf` is refused because it
  runs on whichever global `awf` is installed, which the client can't vouch is its version.
- `inbox(workflow, { after })` is `awf inbox --workflow {name} --after {cursor} --json` in the
  workflow's project: every item of its runs, oldest first, each with its `cursor`. A bot passes
  the last item's cursor to its next read and relays each item once.

### One engine per project

- **Found by walking, not resolving.** A workflow's project is `projectOf` today's: the nearest
  directory at or above its file holding `.awf/`, else the file's own directory. Its engine is the
  `node_modules/agentswf` found by walking up from the project for
  `node_modules/agentswf/package.json`, and its version is that file's `version`, not the range
  `package.json` declares. Declared and not installed: refused, "run `bun install`". None at all:
  the CLI runs on the global `awf`, as today.
- **Handed over before parsing, from the cwd.** The global `awf`'s `main` can't parse argv yet, so
  it walks up from the shell's cwd for `node_modules/agentswf/package.json`, before importing the
  engine, so a newer command's flags and records reach the engine that knows them; a fresh clone
  with no `.awf/` yet hands over too. A command run from outside its file's project is caught by
  the check below.
  It compares that installed version with its own; if they differ it warns and runs
  `[process.execPath, "--no-env-file", {the project's awf}, ...argv]` as a child, stdio inherited,
  SIGINT left to the process group, SIGTERM and SIGHUP forwarded, and exits with the child's code.
  `AWF_ENGINE` is set on the child, which never hands over again. `init`, `help` and `--version`
  don't hand over; `--version` prints the global's and the project's.
- **Checked where it is used.** An engine that resolves a command's file or run (`run`, `test`,
  `emit`, `runs`, `logs`, `inbox` and `reply` given a run) refuses one whose project's engine is
  at another version, and names the project to run from; so does `wf.emit`, for its target. One
  project, one engine: a file in a project whose directory resolves an `agentswf` at another
  version is refused.
- **`awf tick --all`** runs, for each project in `~/.awf/projects`, that project's engine as
  `tick --run-root {project}/.awf/runs --json`, itself in-process when the project is at its
  version, and merges the results.
- **Cost:** none when the versions match; when they differ, a second Bun start, ~10 ms, because
  the hand-over runs before the engine is imported, and a warning that names the mismatch.
- **Transition:** a global `awf` that predates this story doesn't hand over. It refuses a run with
  args, a new record version, so it never prepares one from empty argv; but it still runs a
  project's other runs on its own engine, today's bug, until the operator updates it. Nothing this
  story ships can change an engine already installed.
- An ADR records it, amending the install guide: `bun add -g agentswf` updates folders with no
  `agentswf`; an `awf init` project updates with `bun add -d agentswf`.

### Recorded args

- The run record gains `args`, written when a run is started from code, at a new record version, so
  an engine that predates it refuses the run instead of preparing empty argv. An attempt of a run
  with `args` skips `prepare` and runs with them. `id(args)` still names the run.
- A continue follows the stage rule: a plain run stops across a major `meta.version`, recorded with
  the args; an event run continues, as its stage records do.
- An ADR amends 0011: a continue adds an attempt with the argv, or the args, the run was started
  with.

### `source`

- The mailbox event and `WorkflowEvent` gain `source?: string`, an id's grammar. `from` keeps its
  closed meaning. `awf emit --source` sets it; `awf inbox` and `awf logs` show it.
- Not `via`: that name is taken in the same records, inbox messages carrying `via: OutsideVia`, a
  closed `"terminal" | "command" | "test"` (`records.ts:636`).

### The fake client

- `agentswf/testing` exports `fakeClient(script?)`, imported only by a program's tests, as
  `testWorkflow` is by a workflow's: a `Client` that keeps its calls in order and runs the real
  one's pure checks (`checkEvent`, `fileOf`, `idProblem`, the event-id grammar), so a test sees the
  `ClientError` the real one throws. Unscripted, an emit is `accepted`, `did: "started"` for an id's
  first and `"nudged"` after; a start is `started`; a `Run` rests as the script says.

Alternatives rejected:

- Export `runWorkflow` and `RunWorkflowOptions` — the runner's internal seam, and it hosts the run
  in the caller, so a webhook restart ends it.
- `runOperatorCli([...])` in-process — argv in and CLI text out: no types.
- `start` taking argv — honest about today's record, but untyped.
- A handle whose result rejects on failure — `WorkflowRunError` is in-process, and an event run's
  failure isn't final.
- `ended()` and `returned()` — two names a user would guess wrong: `returned` already means
  completed in `WakeWhy`, and `ended` resolved at a park.
- `status()` as `RunJson` — the heaviest document, assembled per call; `awf runs --json` keeps it.
- A caller-given `from` — `from` is compared with keys; `source` beside it says the same, additively.
- Finding the engine with Bun's resolver — its auto-install finds a cache copy where nothing is
  installed.
- Handing over after parsing — an older global refuses a newer command's flags and records.
- A global `awf` that always wins — today's behaviour, measured: a project's pinned version is
  silently replaced.
- Free functions instead of a client value — a handler's test would have to mock the module.

## Tasks at a glance

- [ ] 1. The surface and the two ADRs, approved: types in `@agentswf/contract/client`, the
  typecheck file, no behaviour.
- [ ] 2. One engine per project.
- [ ] 3. `emit`, replies, `source` and `inbox`.
- [ ] 4. `start`, `get` and the `Run` handle, with recorded args and plain runs from code.
- [ ] 5. The fake client.
- [ ] 6. An example driver and the guide.

## Open questions

None.

## Decisions

Settled with the user, 2026-11-04:

- **A run records its input as it was given.** A workflow turns its input into `Args` with
  `prepare`, for example `({ argv }) => ({ version: argv[0].replace(/^v/, ""), dryRun:
  argv.includes("--dry") })`. A run started by `awf run release.ts -- v1.4.0` records argv
  `["v1.4.0"]`, and every attempt calls `prepare` on it again, so a fix to `prepare` reaches a
  continued run (ADR 0011, unchanged). A run started by `runs.start(release, { version: "1.4.0",
  dryRun: false })` records those args, and every attempt uses them as they are; `prepare` never
  runs for it. Rejected: recording the first attempt's `Args` for every run, which would stop a fix
  to `prepare` from reaching a CLI-started run.
- **A version mismatch is the operator's mistake, handed over and warned about.** The global `awf`
  compares the version of the project's installed `agentswf` with its own. The same: it
  runs the command itself, at no cost. Different: it hands over, so the project's version still
  runs, and warns on stderr once per command: `awf {global} is not this project's {project};
  running the project's. Update one, or run bunx awf here.` The hand-over is a second Bun process,
  since one process can't load two engines (each serves its own author surface, the bug measured
  above) and Bun has no `exec`; it costs ~10 ms because it runs before the engine's modules load
  (~90 ms of `awf --version`). A local clone at a release's version is not told apart; its
  developer runs the clone's own `awf`.
- The export is `agentswf/client`, a subpath, no new package.
- `emit` returns `EmitResultJson`. Rejected: `EmitOutcome`, which hides a failed launch; a throw on
  `launch-failed`, wrong because the event is recorded and the next wake retries it; a new narrower
  type.
- `source` now, beside a closed `from` (first drafted as `via`, a name the records already use);
  the event-id grammar kept, the guide showing how to hash a foreign id; replies through `emit`;
  the project's `agentswf` for every operation.

Settled in refinement, each the default unless the user says otherwise: the fake client in
`agentswf/testing`, beside `testWorkflow`; a client outside a project's engine refused; one engine
per project directory; a started run in its project root; `start` idempotent by id; `inbox` in the
client.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

Every task runs this checklist:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking the task.

### 1. The surface and the ADRs

Outcome: the types written in `@agentswf/contract/client`; the ADRs for one
engine per project and recorded args drafted, the second placed against [[run-record-layout]]; the
user approves all three.

Done when:

- `client.typecheck.ts` compiles; it accepts an event and a declared reply, and refuses an
  undeclared name, refused data, `{key}:ended`, an undeclared reply key, an emit to a plain
  workflow, args `prepare` doesn't return, and a workflow without `file`; it infers `Result` on a
  `Run` for a plain, an event and a no-args workflow, and keeps `file` through `defineWorkflow`
  with explicit type arguments.
- The user has approved the types and both ADRs, recorded under Implementation notes.

### 2. One engine per project

Outcome: whatever starts a command or an attempt, a project's runs run on the project's engine.

Done when:

- A fixture project whose `node_modules/agentswf` is a copy of the engine reporting
  `0.0.0-fixture`: `awf run`, `awf emit`, `awf runs` and `awf tick --all`, invoked through the
  global `awf`, and the attempt a wake launches, each report the fixture's version and serve its
  author surface, with and without an `.awf/` in the project yet; a folder with no `agentswf` runs
  on the global one; one declared and not installed is refused with
  `bun install`; the same version runs on the global with no hand-over and no warning; a different
  one warns once; `AWF_ENGINE` stops a second hand-over; `awf --version` prints both versions.
- A foreground command still reads no `.env`, and a detached attempt still reads the project's.
- A file whose directory resolves an `agentswf` at another version than its project's is refused,
  and so are a CLI command, a `wf.emit` and a client reaching a project at another version, each
  naming the project to run from.
- Manual: the published beta.5 as the project's engine, under a global built from this branch, and
  a global older than this story, which refuses or passes over a run with args.

### 3. Emit, replies, `source` and `inbox`

Done when:

- Tests show a run started by its first event, a live run nudged, a parked run continued, a
  duplicate id, a returned run refused, a launch that failed, a reply to a run, and a reply to no
  run refused, each the `EmitResultJson` that `awf emit --json` gives for the same case.
- `source` reaches the event a wait returns, `awf emit --source` sets it, and `awf inbox` and
  `awf logs` show it.
- `inbox(workflow, { after })` returns what `awf inbox --workflow --after --json` lists, and a read
  from the last item's cursor returns only what came after.
- A reply from the client registers no author-surface plugin in the program.

### 4. Start, get and the handle

Done when:

- A run started from code, plain and with events, completes, fails, parks and continues; its
  record is `awf run`'s plus its args and, for a plain run, the `env`, `file` and project an event
  run records; its args are used by every attempt, `prepare` not run.
- `start` of an id already there is `exists`; of one with no attempt, launches it; a launch that
  fails is `launch-failed` and a second `start` launches it; with no `id`, `id(args)` names it.
- A plain workflow whose `file` isn't its own path is refused, by the client and by the loader.
- A second program gets the run by workflow and id and reads the same status.
- `wait()` resolves at a park and at a crash; `wait({ final: true })` waits across a park and a
  failed attempt a wake continues, and resolves on a stuck run and on a plain run's failure.
- A plain run started from code is found by `awf runs` from elsewhere.
- A continue of a plain run across a major `meta.version` stops; an event run's continues.

### 5. The fake client

Done when:

- A handler's test records its emits and starts in order with their typed data, scripts a
  `launch-failed` and a rest, and sees the `ClientError` the real client throws for a mixed-case
  event id.

### 6. An example and the guide

Done when:

- The example's handler is tested with the fake client under `bun test`, and the page builds.
- The page says first where the program must run (the operator's machine and user, `HOME`, a
  `PATH` with the harnesses, Bun, not a serverless function) and that the project's `agentswf` is
  the engine. It shows `eventId` from a delivery id, hashing one the grammar refuses, a handler
  that responds before an emit that may launch, an inbox read by cursor, that a failed event run
  waits for its next event or `awf tick`, that a redeployed workflow needs the program restarted,
  and that verifying the sender is the program's job.
- `site/guide/install.md`'s updating section says `bun add -g agentswf` updates a folder with no
  `agentswf`, and `bun add -d agentswf` an `awf init` project; the site builds.

## Verification

Automated:

- [ ] `client.typecheck.ts`.
- [ ] `bun test`.
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`, with the client and example-driver rules.

Manual or live evaluation:

- [ ] On a cheap model, a script emits to an event workflow, starting its run and then waking it
  parked, and starts a plain workflow with args and waits for it to be final, in a project that
  pins a version the global `awf` isn't. Cost as in [[testing]].

## Review record

### Refinement, 2026-11-04

- Round 1, a feasibility and an adversarial review of the first draft: typed args can't reach a
  detached attempt; a plain workflow can't carry `file`; configuration given to a detached start is
  dropped; a reply's data is always `ParticipantReply`; `launch-failed` would be lost behind
  `EmitOutcome`; a rejecting result doesn't fit runs a wake retries; free functions contradicted the
  injectable fake; `from` has a closed meaning; the attempt's engine, `HOME` and `PATH` were
  unstated. Disposition: split to emit alone, then merged back on the user's decision that the
  surface is designed whole, each finding answered.
- Round 2, against the code with a scratch typecheck: the emit signature infers; launching the
  `awf` on `PATH` would drop the project's `.env`; `Client` can't be author surface; the fake must
  run the real checks. Disposition: folded in; the user set the rule, the project's `agentswf` for
  every operation, after the measurement above.
- Round 3, a feasibility review with four experiments and an adversarial one, of the combined
  draft: Bun's resolver auto-installs where nothing is installed; handing over after parsing fails
  on a newer command; `run.json` with optional `args` is misrun by an older engine; `Workflow<…,
  any>` refuses plain workflows; waits never resolved on a stuck run, a crash or a plain run's
  failure; `ended`/`returned` read wrong; `start` on an existing run, its cwd and its errors were
  unstated; the Slack bot couldn't read posts; `via` on `start` was recorded nowhere. Disposition:
  all folded in. The user then settled what a run records, its input as given, and the version
  rule: compared, a mismatch handed over with a warning (Decisions).
- Round 4, a feasibility review with a scratch `tsc` probe and a coherence review, of the settled
  draft: engines compared by identity contradicted the version rule; the project was found from the
  cwd in one place and from the file in another; `.awf/`, gitignored, is missing in a fresh clone;
  `EventData` and `Any` didn't compile; `defineWorkflow` can't keep `file` with explicit type
  arguments without overloads; `via` already names a closed field in the same records; the engine's
  own bin can't import the CLI dynamically; the reply path registered the loader's plugin;
  `wf.emit` was outside the check; `inbox()` had no scope and no cursor, so a bot relayed every
  post on every read; the transition note overclaimed; a failed event run's final wait needs an
  event or a tick; several scope items had no Done-when. Disposition: all folded in; `via` renamed
  `source`; the questions moved to Decisions.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled: the record version
  and every published name here; the exact types and both ADRs are task 1's, approved by the user
  before task 2 begins.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
