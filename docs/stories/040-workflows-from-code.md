---
id: "040"
title: "A program drives a workflow's runs, typed from the workflow"
summary: "An ordinary Bun program imports a workflow and emits events to it, starts runs, and waits on them in-process, each call checked by tsc from the workflow's own definition, on the engine the project depends on."
type: story
status: awaiting-human-review
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
const started = await runs.start(release, { version: "1.4.0", dryRun: false }, { id: "v1.4.0" });
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
  recorded, as an event run's are; and continued after a failure or crash by `awf run {file}
  --id {id} --continue`, which finds it there.
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
- Showing a run's recorded args in `awf runs`, and received events, with their `source`, in `awf
  inbox` and `awf logs`.
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
  Story 039's task 10 removes the deprecated `participant:reply`; the client's reply typing knows
  only declared `{key}:reply` names, so task 3 starts after it.
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
  `RunStatus`, `StartResult`, `ClientError` (a class, pure: no I/O), `ClientErrorCode`, `Sendable`,
  `EventsOf`, `Located`, and `Startable`;
  `Ending` is the existing one in `workflow/executable.ts`, and `EventData` the one in
  `workflow/events.ts`, both re-exported.
- `src/workflow/events.ts`: `WorkflowEvent.source?`, read only (`wf.emit` gives none: its `from` is
  the sending run); `EventData`, new here
  because `WorkflowContext.emit`, author surface, uses it too.
- `src/records.ts`: the mailbox event's `source?`; the run record's `args`.
- `src/workflow/executable.ts`: `WithoutEvents.file?: string`; `defineWorkflow` keeps a given
  `file` in its return type, `Located`: a plain workflow by an overload taking `& Located`, so it
  holds with explicit type arguments (`defineWorkflow<FeatureArgs, Handoff>`,
  `examples/feature-delivery/workflow.ts:108`) too; one with events by inferring a `File` type
  parameter, so it holds only when its type arguments are inferred. Three overloads, not four:
  past three, `tsc` reports only the last overload's error (task 1).

### packages/engine

- `src/hand-over.ts`, new and small, importing nothing of the engine: finds the project's engine
  and hands over. Called first by the published bin, `agentswf/src/awf.ts`, which then imports
  `@agentswf/engine/cli` dynamically. Not by the engine's own bin, `operator-cli.ts`, which a
  clone runs and `detachedLaunch` spawns, already the project's engine; never in `runOperatorCli`,
  which tests and the lab call in-process.
- `src/operator-cli.ts`: the project check where a command resolves its file or run; `--version`.
- `src/emit.ts` `targetProject`, which `emitEvent` and `openEventRun` call: the same check on a
  `wf.emit` target's project, and on `awf emit --target`'s and `awf run --id`'s.
- `src/tick-command.ts`: `--all` runs each project's engine with `--run-root --json` and merges.
- `src/workflow-loader.ts`: checks a plain workflow's `file` against its path, as an event one's.
- `src/emit.ts` `emitEvent`, `emitToRun`, `deliver`, `createEventRun`: the client's emit and reply
  paths; `source` written. `emitToRun` loads the target's file through the loader
  (`emit.ts:102`); the client's reply checks against the value it is given instead, so no
  author-surface plugin is registered in the program. `openEventRun` (`emit.ts:240`), `awf run
  --id`'s path, wakes a run that exists; `start` doesn't reuse it, since it launches only a run
  with no attempt.
- `src/run-prepare.ts`, `src/runs.ts` `createRun`, `src/projects.ts` `recordProject`: a run created
  from code, with args, registered; attempts that use recorded args; a plain workflow that gives
  `file` keeps its runs in its project's run root, registered, without `eventRunRefusal`.
- `src/run-lock.ts`: a reader of the run lock's live holder, judged as `claim` judges one gone.
- `src/run-state.ts` `statusOf`, `stuckOf`; `src/runs.ts` `readAttempts`; `src/attempt-output.ts`:
  `status` and `wait`.
- `src/inbox-command.ts`: what `inbox()` runs in-process, `--workflow --run-root --json`, its
  lines parsed: one reader, and the items the command lists.
- `src/mailbox.ts`: `source` into the event a wait returns.
- `src/client/`, new; `package.json` `exports` gains `./client` and `./hand-over`, the bin's
  import, so the hand-over loads none of the engine.
- `src/workflow-testing/`: the fake client.
- `src/wake.ts` `detachedLaunch`: it spawns the `operator-cli.ts` beside itself, which is at the
  project's version, the project's own after a hand-over. After the claim it waits up to 5 s for
  the coordinator socket (`wake.ts:229`), which a plain run opens only when a participant connects;
  it waits for it only for a run with events, so a plain `start` returns at the claim.

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
    workflow: Startable<Args, Result>, args: NoInfer<Args>, options?: { id?: string },
  ): Promise<StartResult<Result>>;
  get<Result extends JsonValue>(workflow: Startable<any, Result>, run: string): Promise<Run<Result>>; // ClientError if it isn't there
  inbox(workflow: Startable<any, any>, options?: { after?: string }): Promise<InboxItemJson[]>;
};

type StartResult<Result> = {
  run: Run<Result>;
  did: "started" | "exists" | "launch-failed" | "stuck";
  error?: string;
};

type Run<Result> = {
  readonly id: string;
  readonly ref: string;                                   // {workflow}/{id}, for awf runs and logs
  status(): Promise<RunStatus<Result>>;
  wait(options?: { final?: boolean; signal?: AbortSignal }): Promise<RunStatus<Result>>;
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
  CLI's result. A reply goes to a run that exists and never starts one; to an id with no run it
  throws `no-run`, where `awf emit {run}` exits 1 with no JSON (`emit-command.ts:50`).
- `start` is "make sure this run exists and has been launched". `args` is `NoInfer<Args>`, so
  `Args` is inferred from the workflow alone: inferred from both, `null` widened it, and `start`
  took `null` for any workflow and anything for one without args (tsc probe, round 6). Without
  `id`, the workflow's `id(args)` names the run, or else, for a workflow without `starts`, a new id
  as `awf run` makes one; a workflow with `starts` and no `id()` is refused (`no-id`), as `awf run`
  refuses it (`run-prepare.ts:86`), since its senders name its runs. A new id is created with its
  args and launched: `started`. An id already there with the same args, compared as canonical JSON
  (`canonical-json.ts`), is `exists`, and if it has never had an attempt it is launched now, so a
  retry after a failed launch works for a plain run as for an event one; that call is `exists` too,
  since the run was there, and `launch-failed` if the launch fails again. An id already there with
  other args, or with no `args` field (begun by `emit` or by `awf run`, which records argv), throws
  `other-args`, as `awf run --id` refuses other argv (`openEventRun`): a second `start` with
  `dryRun: true` must not quietly return the first run. `get` reaches such a run. A launch that
  fails is `launch-failed`, the run kept; three in a row make the run stuck (`stuckOf` counts the
  mailbox's `launch-failed`), and a `start` then is `stuck`, launching nothing, as `wake` does.
  For a workflow with
  `starts`, `start` is how a run gets args: a run begun by `emit` gets what `prepare` makes of none,
  and one begun by `start` has no starting event, so its first `receive` waits.
- A plain run that failed or crashed is not continued by `start` (`exists`, nothing launched) nor
  by `tick`, which passes over runs without events (`tick-command.ts:55`). `awf run {file}
  --id {id} --continue` continues it: a plain workflow that gives `file` keeps its runs in its file's
  project's run root, registered, whoever starts or continues them, as an event workflow's are.
  Only that part of the event rule (`run-prepare.ts:72-82`) is extended: `eventRunRefusal` is not,
  so `awf run` keeps `--values`, `--from-stage`, `--timeout`, `--sandbox`, `--cwd` and an explicit
  `--run-root` for it, and a CLI start works in the shell's directory or `--cwd` as today. A run
  started from code works in the project root. No plain workflow gives `file` today, so no run
  moves. The client gains a `continue` when a program needs one, additively.
- `wait()` resolves at the run's next rest after the call, or at once if it isn't running;
  `wait({ final: true })` at the first rest whose `final` is true. A crash is a rest (`interrupted`).
  A rest is read from the attempt records, not by sampling `state`: an attempt current at the call,
  or any later one, gaining an `outcome` or found dead by its pid; or a `launch-failed` appended to
  the mailbox after the call, the run's lock free. Sampled, a park a wake continued between two
  polls would read `running` both times and be missed.
  `wait` and `status` reject only when awf can't read the run, and `wait` when its `signal` aborts,
  with the signal's reason: a final wait on a parked run, or on an event run that failed with
  nothing to wake it, would otherwise never resolve. `get` of an id with no run throws `no-run`.
- A run with no attempt whose mailbox holds a `launch-failed` is `interrupted` at once, not
  `running` for the minute `statusOf` gives an attempt to claim it (`run-state.ts:80`): `awf runs`
  reads it so too, and a `wait()` after `launch-failed` resolves at once. While a live sender holds
  the run's lock it is `running`, since that sender is launching it again: a plain run read
  `interrupted` then would be `final`, and another program's final wait would resolve mid-launch.
  The lock is read without taking it; a holder whose process is gone, a webhook killed mid-launch,
  is not live. The rule applies only to a run with no attempt, in `status()` and `awf runs` alike.
- A plain run reads its mailbox only for `launch-failed`, which only a run started from code has:
  those count toward `stuck`, and a plain run's failed attempts don't, so a plain run continued and
  failing three times is `failed` in `awf runs`, as today (`run-state.ts:48`, `records.ts:827`).
- A run started from code is detached, with no terminal. What its agents ask a person and what it
  posts land in `inbox()` and `awf inbox` as an event run's do (story 032), and an answer goes by
  `awf reply` from a shell until the client gains it; until then the run waits, `running`, as long
  as the question's `timeoutMs` allows. The guide says so.
- `class ClientError extends Error { code: ClientErrorCode; ref?: string }`, declared in
  `@agentswf/contract/client` and exported as a value by `agentswf/client`, so a handler can
  `instanceof` it and the fake throws the same class. Its `code` is one of: `event`, an unknown or
  refused name or data a schema refuses; `id`, a run or event id the grammar refuses, or one
  `id(args)` returns; `no-id`; `prepare`, a starting event whose `prepare` refuses no argv
  (`checkStartArgs`, `emit.ts:195`) or an `id(args)` that throws; `file`, a workflow whose `file`
  isn't its own path; `project`, a workflow directly in home (`projects.ts:16`); `no-engine`, a
  project with no `agentswf`, or one declared and not installed; `other-engine`, a project at
  another version than the client's; `no-run`; `other-args`; `cursor`, an `after` made for another
  run or filter (`inbox-command.ts:124`). Every `EmitError` and `RunRefused` the shared code throws
  maps to one; anything else, such as a run awf can't read or an I/O failure, rejects as it is. Whether `file` is its own
  path: the client imports `file`, which its module cache already holds, and checks that its default
  export is the value given. The loader takes the default export (`workflow-loader.ts:72`) and
  compares real paths (`:91`); the identity check is new, and refuses a workflow exported only by
  name, which the loader refuses too. A project with no `agentswf` is refused because it runs on
  whichever global `awf` is installed, which the client can't vouch is its version.
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
  SIGTERM and SIGHUP forwarded, and exits with the child's code or signal. SIGINT reaches the child
  through the process group, and the parent ignores it and waits, so the shell's prompt doesn't
  return while the child is still ending its run.
  `AWF_ENGINE`, the path of the engine the child is, is set on it, and an `awf` skips the hand-over
  only when it names that `awf`'s own engine: a guard against a loop, since the child, walking from
  the same directory, finds itself at its own version and wouldn't hand over anyway. Agents inherit
  a foreground run's environment (`harness/src/command.ts:232`); the `awf` an agent runs is the
  global on its `PATH`, which `AWF_ENGINE` doesn't name, so it hands over as any command does, in
  the run's project or another. `init`, `help`, `--version` and
  `tick --all` don't hand over; `--version` prints the global's and the project's. `tick --all`
  names no project, so the cwd's would be the wrong one to hand it to: an engine older than this
  story would wake every project's runs on itself, today's bug.
- **Checked where it is used.** An engine that resolves a command's file or run (`run`, `test`,
  `emit`, `runs`, `logs`, `inbox` and `reply` given a run) refuses one whose project's engine is
  at another version, and names the project to run from; so does `wf.emit`, for its target. One
  project, one engine: a file in a project whose directory resolves an `agentswf` at another
  version is refused. A project with no `agentswf` has no engine of its own, so any engine runs its
  runs, as every engine does today; the client alone refuses it (`no-engine`). One declared and not
  installed is refused by every engine, naming `bun install`.
- **`awf tick --all`** runs, for each project in `~/.awf/projects`, that project's engine as
  `[process.execPath, "--no-env-file", {the project's awf}, "tick", "--run-root",
  "{project}/.awf/runs", "--json"]`, in the project's directory with `AWF_ENGINE` set, as the
  hand-over launches it, so the child never hands over by its own cwd; itself in-process when the
  project is at its version, and merges the results. A project with no `agentswf` is ticked in-process; one declared
  and not installed is reported and passed over, as a project that is gone is, and the others are
  ticked.
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
  an engine that predates it refuses the run instead of preparing empty argv. Every run started
  from code has the field, `null` included for a workflow without args, and `argv: []`; only such a
  run is written at that version, and every other run keeps today's, so an older engine still reads
  and wakes them. An attempt of a run
  with `args` skips `prepare` and runs with them. `id(args)` still names the run.
- A continue follows the stage rule: a plain run stops across a major `meta.version`, recorded with
  the args; an event run continues, as its stage records do.
- An ADR amends 0011: a continue adds an attempt with the argv, or the args, the run was started
  with.

### `source`

- The mailbox event and `WorkflowEvent` gain `source?: string`, an id's grammar. `from` keeps its
  closed meaning. `awf emit --source` sets it, the mailbox record keeps it, and the event a wait
  returns carries it. Neither `awf inbox` nor `awf logs` shows a received event today; showing
  them, with `source`, is a new item in two published JSON formats, later.
- Not `via`: that name is taken in the same records, inbox messages carrying `via: OutsideVia`, a
  closed `"terminal" | "command" | "test"` (`records.ts:636`).

### The fake client

- `agentswf/testing` exports `fakeClient(script?)`, imported only by a program's tests, as
  `testWorkflow` is by a workflow's: a `Client` that keeps its calls in order and runs the real
  one's pure checks (`checkEvent`, `fileOf`, `idProblem`, the event-id grammar), so a test sees the
  `ClientError` the real one throws. Unscripted, it keeps the ids it has seen and answers as the
  real one's rules do: an event to a new id is `started` if it may start one and refused
  `not-a-start` if not, and to an id seen it wakes the run as the real `wake` does (see the
  Implementation notes); a reply to an unseen id throws `no-run`; a start is `started` for a new
  id, `exists` for one seen with the same args, and `other-args` for other args; a `Run` rests as
  the script says.

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

- [x] 1. The surface and the two ADRs, approved: types in `@agentswf/contract/client`, the
  typecheck file, no behaviour.
- [x] 2. One engine per project.
- [x] 3. `emit`, replies, `source` and `inbox`.
- [x] 4. `start`, `get` and the `Run` handle, with recorded args and plain runs from code.
- [x] 5. The fake client.
- [x] 6. An example driver and the guide.

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

- `start` is idempotent by id and args: the same args are `exists`, other args a `ClientError`, as
  `awf run --id` refuses other argv (review round 5).
- A detached run's questions are read with `inbox()` and answered with `awf reply`; the client
  gains a reply later (review round 5).

Proposed in refinement, for the user's approval at task 1: the fake client in `agentswf/testing`,
beside `testWorkflow`; a client outside a project's engine refused; a project with no `agentswf`
refused by the client; one engine per project directory; a started run in its project root;
`inbox` in the client; `wait`'s `signal`.

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
  workflow, args `prepare` doesn't return, `null` args for a workflow that takes some, args for
  one that takes none, and a workflow without `file`; it infers `Result` on a
  `Run` for a plain, an event and a no-args workflow, and keeps `file` through `defineWorkflow`
  with explicit type arguments.
- The user has approved the types, both ADRs and the refinement proposals under Decisions,
  recorded under Implementation notes.

### 2. One engine per project

Outcome: whatever starts a command or an attempt, a project's runs run on the project's engine.

Done when:

- A fixture project whose `node_modules/agentswf` is a copy of the engine reporting
  `0.0.0-fixture`: `awf run`, `awf emit`, `awf runs` and `awf tick --all`, invoked through the
  global `awf`, and the attempt a wake launches, each report the fixture's version and serve its
  author surface, with and without an `.awf/` in the project yet; a folder with no `agentswf` runs
  on the global one; one declared and not installed is refused with
  `bun install`; the same version runs on the global with no hand-over and no warning; a different
  one warns once; an `awf` that `AWF_ENGINE` names doesn't hand over, and one it doesn't name
  does, so an agent of a handed-over run that runs the global `awf`, in its own project or another,
  hands over; `awf --version` prints both versions;
  Ctrl-C during a handed-over `awf run` returns the prompt only after the child has exited, with
  its code.
- A foreground command still reads no `.env`, and a detached attempt still reads the project's.
- A file whose directory resolves an `agentswf` at another version than its project's is refused,
  and so are a CLI command, a `wf.emit` and a client reaching a project at another version, each
  naming the project to run from.
- `awf tick --all` from inside a third project at another version runs on the global and wakes each
  project on its own engine, a project with no `agentswf` in-process, and reports and passes over
  one declared and not installed.
- An engine at this story's version runs a `--target` or `wf.emit` into a project with no
  `agentswf`.
- Manual: the published beta.5 as the project's engine, under a global built from this branch,
  including `awf tick --all` run from inside it; and a global older than this story, which refuses
  or passes over a run with args.

### 3. Emit, replies, `source` and `inbox`

Done when:

- Tests show a run started by its first event, a live run nudged, a parked run continued, a
  duplicate id, a returned run refused, a launch that failed and a reply to a run, each the
  `EmitResultJson` that `awf emit --json` gives for the same case; a reply to no run throws
  `no-run`.
- `source` reaches the event a wait returns, `awf emit --source` sets it, and the mailbox record
  keeps it.
- `inbox(workflow, { after })` returns what `awf inbox --workflow --after --json` lists, and a read
  from the last item's cursor returns only what came after.
- A reply from the client registers no author-surface plugin in the program.

### 4. Start, get and the handle

Done when:

- A run started from code completes and fails, plain and with events; an event run parks and an
  event continues it; its
  record is `awf run`'s plus its args and, for a plain run, the `env`, `file` and project an event
  run records; its args are used by every attempt, `prepare` not run.
- `start` of an id already there with the same args is `exists`; with other args, or of a run the
  CLI started with argv, throws a `ClientError`; of one with no attempt, launches it; a launch that
  fails is `launch-failed` and a second `start` launches it; with no `id`, `id(args)` names it,
  and a workflow with `starts` and no `id()` throws `no-id`; with neither `id` nor `id(args)` on a
  workflow without `starts`, a new id is generated; a run begun by `emit` throws `other-args`; the
  same args in another key order are `exists`; a no-args workflow started twice by id is `exists`;
  a `start` that relaunches a run with no attempt is `exists`.
- A plain run started from code that failed is continued by `awf run {file} --id {id} --continue` run
  from outside its project, and `start` of it is `exists` with nothing launched. On a plain
  workflow with `file`, `awf run` still takes `--from-stage`, `--timeout` and `--cwd`, and its runs
  land in the project.
- A plain run whose launch failed three times is `stuck`; one whose continues failed three times is
  `failed`.
- A lock left by a sender killed mid-launch doesn't hold a run with no attempt at `running`.
- A plain `start` returns once its attempt has claimed the run, with no wait for a socket.
- While a second `start` holds the lock relaunching a run whose launch failed, `status()` from
  another program is `running` and a final wait there doesn't resolve.
- Three launches that fail make a `start` `stuck`; after one, `status()` is `interrupted` at once
  and `wait()` resolves at once.
- `get` of an id with no run throws `no-run`.
- A run started from code is written at the new record version with `args`, `null` for a no-args
  workflow, and `argv: []`; every other run at today's.
- A plain workflow whose `file` isn't its own path is refused, by the client and by the loader; a
  workflow whose default export isn't the value given, the client refuses with `file`.
- The client refuses a project with no `agentswf`, and one declared and not installed, with
  `no-engine`; each `ClientErrorCode` is thrown by at least one test, and is an `instanceof
  ClientError` imported from `agentswf/client`.
- A second program gets the run by workflow and id and reads the same status.
- `wait()` resolves at a park and at a crash, and at a park a wake continued before its next
  poll; `wait({ final: true })` waits across a park and a
  failed attempt a wake continues, and resolves on a stuck run and on a plain run's failure; an
  aborted `signal` rejects a pending wait with its reason.
- A plain run started from code whose agent asks a person shows the question in `inbox()`, and an
  `awf reply` to it lets the run go on.
- A plain run started from code is found by `awf runs` from elsewhere.
- A continue of a plain run across a major `meta.version` stops; an event run's continues.

### 5. The fake client

Done when:

- A handler's test records its emits and starts in order with their typed data, scripts a
  `launch-failed` and a rest, and sees the `ClientError` the real client throws for a mixed-case
  event id. Unscripted, it refuses a non-starting event to a new id as `not-a-start`, throws
  `no-run` for a reply to an unseen id, and answers a second `start` of an id `exists`.

### 6. An example and the guide

Done when:

- The example's handler is tested with the fake client under `bun test`, and the page builds.
- The page says first where the program must run (the operator's machine and user, `HOME`, a
  `PATH` with the harnesses, Bun, not a serverless function) and that the project's `agentswf` is
  the engine. It shows `eventId` from a delivery id, hashing one the grammar refuses, a handler
  that responds before an emit that may launch, an inbox read by cursor, that a failed event run
  waits for its next event or `awf tick`, a final wait bounded by a `signal`, that a person
  answers a started run's questions with `awf reply`, that a redeployed workflow needs the program
  restarted, and that verifying the sender is the program's job.
- `site/guide/install.md`'s updating section says `bun add -g agentswf` updates a folder with no
  `agentswf`, and `bun add -d agentswf` an `awf init` project; the site builds.

## Verification

Automated:

- [x] `client.typecheck.ts`.
- [x] `bun test`.
- [x] `bunx tsc --noEmit`
- [x] `bun run scripts/check-boundaries.ts`, with the client and example-driver rules.

Manual or live evaluation:

- [x] On a cheap model, a script emits to an event workflow, starting its run and then waking it
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
- Round 5, a review against the code (every cited line checked): `start` returned `exists` for an
  id started with other args, where `awf run --id` refuses other argv; a detached plain run's
  person questions had no stated home; the hand-over's parent could exit on Ctrl-C before its
  child; `get` of a missing id was unspecified; a final wait had no way out; whether every new run
  or only one with `args` takes the new record version was unstated; `EventData` had two homes;
  task 3's order against 039's task 10 was unstated; refinement defaults read as settled. Disposition:
  all folded in, the defaults moved to task 1's approval. Considered and not taken: one engine per
  project as its own story; it stays task 2, and can be split out unchanged if task 1's approval
  wants it.
- Round 6, a fresh adversarial review with a scratch `tsc` probe: `start` inferred `Args` from both
  parameters, so `null` passed for every workflow and anything for one without args; a reply to no
  run promised an `EmitResultJson` the CLI never gives; `start` on a run begun by `emit` fit no
  stated case; `start` without `id` on a workflow with `starts` and no `id()` contradicted `awf
  run`; `tick --all` handed over by cwd to whatever engine the cwd's project pins; the file check
  cited the wrong loader line and `ClientError.code` had no values. Disposition: all folded in;
  `args: NoInfer<Args>` probed to refuse both and still infer.
- Round 7, a fresh review with a `tsc` probe of the whole surface (every Outcome call compiles,
  every task 1 refusal fires): `ClientError` was neither a declared class nor a published value, and
  its codes missed `prepare`, `id(args)`, a workflow in home, a bad cursor and an engine declared and
  not installed; `null` args and `argv` were unstated in the record and JSON comparison ignored key
  order; `start` had no answer for a stuck run and a failed launch read `running` for a minute; a
  project with no `agentswf` was unstated under the engine check and `tick --all`; `source` on
  `wf.emit` appeared only in the Code map; the fake's defaults contradicted the real rules; several
  promises had no Done-when; the Outcome's `release` args disagreed with Decisions; the bin's import
  of the hand-over needed its own export; four line citations were off. Disposition: all folded in;
  `wf.emit` takes no `source`.
- Round 8, a fresh consistency review: `tick --all`'s per-project child had no bin, cwd or
  `AWF_ENGINE`, so it could hand over by the shell's cwd again; nothing continued a plain run that
  failed, since `start` is `exists`, `tick` passes it over and `awf run --continue` looked in the
  cwd; a wait sampling `state` could miss a park a wake continued between polls; a run relaunching
  under the lock read `interrupted`, final for a plain run; a relaunch's `did` was unstated.
  Disposition: all folded in; a plain workflow with `file` lives in its project as an event one
  does, and the client's `continue` is left additive.
- Round 9, a review of round 8's text against the code: extending the event project rule whole
  would have taken six `awf run` options from plain workflows with `file` (`eventRunRefusal`); a
  plain run never reads its mailbox, so a failed launch never counted for it, and counting its
  failed attempts would change `awf runs`; `wait` couldn't see a failed launch, which has no
  attempt; a dead sender's lock would hold a run at `running` for ever; `AWF_ENGINE` leaked to a
  foreground run's agents and stopped their hand-over in another project. Disposition: all folded
  in; only the run root and registration move for a plain workflow with `file`.
- Round 10, a review of round 9's text against the code: `AWF_ENGINE` naming the target engine let
  the global `awf` an agent of a handed-over run ran in its own project skip the hand-over, and the
  version check then refused it; a plain `start` held the lock 5 s more waiting for a socket a
  plain run doesn't open. Disposition: both folded in; `AWF_ENGINE` guards only the engine it names.
- Round 11, a review of round 10's text against the code: the doc wrote `awf run {file} --continue
  {id}`, where `--continue` takes no value and the run is named by `--id` (`run-command.ts:98`).
  Disposition: written `awf run {file} --id {id} --continue`, as `detachedLaunch` runs it.
- Round 12, a full read against the code: `awf inbox` and `awf logs` were promised to show
  `source`, but neither shows a received event, so keeping it meant a new item in two published
  JSON formats. Disposition: cut to what exists; showing received events moved out of scope.
  Nothing else material.

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

Built in the worktree `../worktrees/awf-workflows-from-code`, branch `workflows-from-code`.

### Task 1, 2026-11-04

- Approval: the user asked for the story to be implemented after the review rounds above, which
  listed the refinement proposals under Decisions; that is taken as approving them, the types and
  both ADRs, as the approval gates are checked by the implementer in an approved story.
- Built: `packages/contract/src/client.ts` (`@agentswf/contract/client`): `Client`, `Run`,
  `RunStatus`, `StartResult`, `ClientError`, `ClientErrorCode`, `ClientOptions`, `Sendable`,
  `Startable`, re-exporting `Ending`, `EventData`, `EventsOf` and `Located`; `EventsOf` and
  `EventData` in `workflow/events.ts`, which `wf.emit` now types its data with;
  `WorkflowEvent.source?`; `WithoutEvents.file?: string`; `agentswf/client` re-exports the
  contract's module, and gains `client` with task 3; ADRs 0014 and 0015.
- `EventsOf` matches `events` structurally rather than through `Workflow<any, any, infer E>`: the
  same result, with no import of `executable.ts` into `events.ts`.
- `defineWorkflow` has three overloads: events, inferring a `File` type parameter; plain with
  `file`; plain. A fourth (events with `file`) would make `tsc` report only the last overload's
  error for every mistake in a `defineWorkflow` call. Costs, accepted: an events workflow given
  explicit type arguments isn't `Located`, which no workflow in the repo does; a `file` typed
  `string | undefined` on an events workflow is typed `Located`; a mistake in a `defineWorkflow`
  call that gives `file` is reported at the call, each overload's error listed, not at the
  property, so `events.typecheck.ts`'s colon case moved its `@ts-expect-error` to the call.
- `Startable` lists the plain form last, so a plain workflow without `file` is told `file` is what
  it lacks.
- Review (one subagent, both lenses, with `tsc` probes): no blocking finding. Folded in: the Code
  map's overload text; ADR 0015 says "a new record version", not 2, as story 041 may replace
  `version` with `format`; ADR 0014 says `tick --all` passes over a project declared and not
  installed; a misplaced `biome-ignore`. Accepted as above: explicit type arguments on an events
  workflow, the `string | undefined` file, errors at the call. A union-typed event name accepts
  either event's data, as `wf.emit` always has; the schema check at run time refuses it.

### Task 2, 2026-11-04

- Built: `engine/src/hand-over.ts` (finding an installed or declared `agentswf`, the hand-over),
  run first by `agentswf/src/awf.ts`; `engine/src/project-engine.ts` (`engineOf`,
  `checkProjectEngine`, `EngineRefused`), called by `loadWorkflowFile` before the import (run,
  test's paths, emit --target, a reply's check), `findRunByRef` and `awf logs` (with the run's last
  file), `emit.ts` `targetProject` (`wf.emit`, `awf run --id`) and `awf test`; `awf tick` and
  `--all` per project; `--version` prints the project's engine.
- A deviation, from both reviews: a project's engine is the `agentswf` installed above it, else
  the one its workflow files resolve. A workspace whose root holds `.awf/` and whose packages each
  have a `node_modules`, as this repository's `examples/` under Bun's isolated linker, resolves
  none from its root; refusing that layout would refuse this repository's own examples. One
  definition, `engineOf(project, files)`, serves every check: the loader and `wf.emit` pass the
  file, the run readers the run's last attempt's file, and `tick` the files of the project's event
  runs. Files resolving two versions are refused. The refusal names the directory whose
  `node_modules` holds the engine to run from.
- Also from review: plain `awf tick` of a project's own `.awf/runs` runs on that project's engine,
  as `--all` does, so a tick typed elsewhere never wakes a project's runs on another engine; the
  `declared` walk stops at the nearest `package.json`; an install whose manifest gives no version
  or `awf` is treated as declared and not installed; a child tick's JSON is checked; `tick`'s help.
- `awf runs`/`logs` refusing another engine's run exit 3, as for a run whose files this engine
  can't read.
- `awf init --no-install` then `awf test` is now refused, naming `bun install`, as the story's rule
  says of a project that declares `agentswf` without installing it; `tests/init-command.test.ts`
  runs `awf test` after its simulated install.
- Accepted: `awf test` checks its directory and the paths given, not each test file it discovers.
- For the manual check: every package of this branch is still at the published beta.5's version,
  so a global built from it is the same engine as beta.5. The check needs the global's copy at
  another version.

### Task 3, 2026-11-04

- Built: `engine/src/client/` (`index.ts`: `client`, and `clientWith`, the tests' factory with a
  fake launch, nudge and clock, which `agentswf/client` doesn't publish; `locate.ts`; `exported.ts`,
  the `file` identity check, the one computed import, allowed in `boundary-paths.ts`);
  `EmitError.code`, an `Extract` of `ClientErrorCode`; `source` on the mailbox event, `eventOf`,
  `emitEvent` and `deliverReply`, and `awf emit --source`, on both forms.
- Story 039's task 10 is not done; task 3 went ahead of it, as the client's reply typing reads
  only declared `{key}:reply` names, and task 10 removes nothing on the reply path.
- `source` is taken on a reply too, from the client and `awf emit {run} --source`: a reply reaches
  the code as a `WorkflowEvent`, which carries it. Its grammar is the event id's.
- `inbox()` runs `inboxCommand` in-process rather than a factored reader: one implementation, the
  same items; its coupling is to argv and the `bad-cursor` code. An `after` that is empty or starts
  with `-` is refused as `cursor` before it reaches argv.
- Boundaries: the client's own files may not import the runtime, a decision provider or a sandbox
  provider, nor name `serveAuthorSurface`; and `clientReachProblems` follows what
  `agentswf/client` loads at run time, type-only imports erased, refusing `operator-runtime.ts` and
  every provider. It loads the harness and `workflow-runner.ts` through `inbox-command.ts` and
  `attempt-ending.ts`, which host nothing unless called.
- From review: `deliver` refuses an event to a run without events (an `awf emit --target` to a
  plain run of the same name used to start it) and to an id differing only in case from the run
  there, which a disk that doesn't tell case apart opened instead; the client's reply, `start` and
  `get` do the same; a non-string name, run id, event id or source is a `ClientError`.

### Task 4, 2026-11-04

- Built: `RUN_RECORD_ARGS_VERSION` (2) and `RunRecord.args`, written only by `createRun` given
  args; `openRun` reads both versions; a continue of a run with args takes them and never calls
  `prepare` (`run-prepare.ts`), which covers every attempt, a wake's included; a plain workflow
  that gives `file` is checked by the loader and keeps its runs in its project's run root,
  registered, unless `--run-root` names another, every other `awf run` option kept;
  `detachedLaunch` waits for the socket only for a run with events; `lockHeld` in `run-lock.ts`;
  `runStatus` reads every run's mailbox, and a run with no attempt that is past its minute, or
  whose launch failed, is `running` only while a live process holds its lock; a plain run counts
  only failed launches toward `stuck`. `client/runs.ts`: `start`, `get`, the `Run` handle,
  `status` with `final` and `ending` (from the attempt record and, for the last, `output.json`),
  and `wait`, read from the attempt records and the mailbox's `launch-failed` lines.
- `RunRecord` is one type with `version: 1 | 2` and `args?`, not a union by version: `createRun`
  alone writes it, and holds the invariant.
- From review: `wait` reads the attempts before the status, so an attempt that rests and is
  continued between the two reads is still seen; a rest it returns is `final` by the run kind's
  rule; a failed launch it sees while a sender holds the lock is a rest only once the lock is free,
  and is returned as `interrupted`; a generated id another caller drew the same minute is drawn
  again under the lock, never taken as theirs; only a `RunRefused` from `createRun` is `id`, a disk
  failure rejects as it is; the lock rule covers a first launch slower than a minute; the project
  is registered only when its run root is used; an abort before the first poll rejects; the
  ending's `continue` is quoted.
- The test of a continue across a major version runs the continue in a process of its own: the
  test's process holds the file's older module. An event run's continue across a major version is
  `planStageByContent`'s existing rule, which a run's args don't reach; it has no test here.
- Left for the live check: a detached plain run's question in `inbox()`, answered by `awf reply`.

### Tasks 5 and 6, 2026-11-05

- Built: `fakeClient` in `engine/src/workflow-testing/fake-client.ts`, published by
  `agentswf/testing`; `examples/site/guide/programs/` (`pr-review.ts`, `release.ts`,
  `handlers.driver.ts` and their tests); `site/guide/programs.md`, linked from Hosting events;
  `fakeClient` on the Testing API reference; Install's Updating section; the `*.driver.ts` rule in
  the boundaries, AGENTS.md's boundary 6 and `site/AGENTS.md`.
- From review, the fake was reworked to answer as the real rules do in the cases the guide
  teaches: a run whose launch failed is kept, and its next event is `started`; an event id it has
  is a `duplicate`; a run at rest is `continued`, a live one `nudged`, a returned one `refused`; a
  run named in `rests` is there; a wait on a run that isn't running answers at once, and one with
  nothing scripted left ends with its signal; it runs the real client's checks that need no file
  (`file` absolute, `meta.name`, `source`, JSON args, `id(args)`, run ids, cursors); every call is
  kept, refused ones included; generated ids skip ids in use.
- `awf test` now serves `agentswf/client` from its engine, as it serves `agentswf/testing`, so a
  handler under test and the fake share one `ClientError`; `agentswf/client` is the engine's
  `client/published.ts`.
- The example's webhook hashes a delivery id that doesn't fit the grammar or starts `awf.`, logs
  what came of an emit after answering, and the guide says a refusal after the answer is lost and
  a launch that failed waits for the next event or `awf tick`; the relay's cursor must be kept
  where a restart finds it. Pages that said an `awf init` folder needs no install (Quick start,
  Testing, the Testing API) now say it runs on the `agentswf` it installs.

- A targeted re-review of the reworked fake found it still diverged where it matters most: a
  resent event id after a failed launch, which the real `deliver` wakes, relaunching it. The fake's
  `emit` now follows the real `wake` step by step: a duplicate wakes the run without a nudge; a run
  not launched is `started`, or `stuck` after three failed launches; a stopped, cancelled or stuck
  run is left alone, `none` with its state; a parked, failed or crashed one is `continued` (a
  parked run whose wait doesn't take the event is `nothing-due` to the real client, which a test
  scripts). It checks `prepare` with no argv before an event makes a run; a scripted answer is
  `outcome`, `did`, `why` and `error` only, `why` alone meaning `did: "none"`, and the fake then
  knows what it said (a refusal leaves no run). Every `FakeClientCall` names its `workflow`.

### Verification, 2026-11-05

- `bunx tsc --noEmit`, `bun run check` (Biome, tsc, boundaries) and the site build pass.
- `bun test`: 2580 pass; one Herdr host test failed under load and passes alone, here and on main.
- Live: `AWF_LIVE_EVAL=1 bun tests/client.eval.ts` passed on codex `gpt-6-luna`, in a project
  pinned to `0.0.0-live` under the branch's global at `0.1.0-beta.5`: an event started a run, it
  parked, a second event continued it to completion with its `source`; `start` of a plain run with
  args completed with 42, `prepare` (which throws) never run; a detached run's agent asked a
  person, the question showed in `inbox()`, and `awf reply` to the global `awf`, handed over with
  its warning, delivered the codeword, which the run returned. Each run under $0.01 by awf's
  records. Its first try failed on the eval's own workflow, which kept a count in memory across
  attempts.
- Manual, the published beta.5 as a project's engine under a global built from this branch (a copy
  at `0.1.0-beta.6-dev`, since every package here is still at beta.5's version): `--version` prints
  both; `awf run`, `awf emit` and `awf runs` are handed over with the warning and run on beta.5;
  `awf tick --all` from inside that project runs on the global, beta.5 accepting `tick --run-root
  --json` for its project's tick.
- Manual, beta.5 as an older global over a run started from code (record version 2): its `awf
  runs` listing passes over it, and `awf runs add/a1` and `awf run add.ts --id a1 --continue` refuse
  it, "version 2, newer than this awf reads"; it never prepares empty argv for it.

### Final review, round 1, 2026-11-05

Three reviewers, one each on the hand-over and recorded args, the client, and the fake client
with the docs. Folded in:

- The hand-over forwards SIGINT, as it does SIGTERM and SIGHUP: one sent to the global `awf` alone
  was swallowed and the child ran on. The terminal's Ctrl-C now reaches the child twice, which a
  run already takes as one.
- `awf tick` of a project on its own engine refuses, instead of handing over again, when it is
  already that engine (`AWF_ENGINE`) and its `agentswf` and engine disagree, which looped.
- `awf test` passes each folder's test files to the engine check, so a workspace root with no
  `agentswf` of its own is refused when its packages' tests resolve another version.
- `awf run` checks the engine of the project its run is kept in, with the file, at start, as every
  later command does: a run could start and then have its `awf logs` and `awf reply` refused.
- `emit`: a run in another case found only as the folder is claimed, on a case-sensitive disk,
  throws `ClientError` `id`, not a bare `RunRefused`. `start` draws a generated id again when an
  `awf run`, which takes no lock, took it meanwhile.
- `wait()` doesn't take a failed launch as a rest when an attempt has started since, by a sender
  that launched it again.
- The fake client: a resent event to a completed run is `none`, `returned`, and leaves it
  completed; a run whose launch failed reads `interrupted` (final for a plain run) or `stuck`
  after three, as `runStatus` does, and stays at its last rest if it had one; a run that had an
  attempt is `continued` after a failed relaunch, not `started`; it checks a reply's run before its
  `source`, and the types of `eventId`, `source` and `after`, in the real client's order.
- Docs: the stories index says `awaiting-human-review`; the guide says the fake runs the checks
  that need no files, that a failed post relays its batch again, and `awf inbox --workflow`;
  install.md says the hand-over happens only at another version; the Testing API puts its code
  first; the design's fake-client section no longer says `nudged` to an id seen.

Left: a failed or crashed attempt counts toward the fake's `stuck` only as its scripted rests say.
`bun run check` passes; `bun test` 2598 pass, 0 fail.

### Final review, round 2, 2026-11-05

Three fresh reviewers. Round 1's run-start engine check was wrong, and two more of its fixes too
broad; folded in:

- A run's engine is the project of the file it runs, at start and after: `checkRunEngine` checks
  the file's project, as the loader does, not the folder a `--cwd` put the run to work in. Round
  1's start check is gone: it refused `awf run review.ts --cwd ~/clone` whenever the clone
  declared or pinned `agentswf`.
- `awf tick` refuses a project only when the project's `agentswf` runs on this very engine package,
  not whenever `AWF_ENGINE` names it: an agent of a handed-over run inherits it.
- `awf test` with paths checks only those paths' tests; with none, everything under the folder.
- The client: event data that isn't JSON is `event`, before any run is made; a named `start` that
  an `awf run --id` beat to the folder is `other-args`, as it is a moment later.
- The fake client: `prepare`'s result for an event-made run is checked as JSON, in the workflow's
  folder; a rest's `final` is the real client's, from its state and the workflow's kind; a start
  with no id takes a `fake-{n}` that `rests` names. The Testing API page says so, and that a parked
  run's `nothing-due` is scripted.
- Docs: README.md and docs/status.md no longer say `awf` runs a folder's workflows on its own
  copies or that `awf test` needs nothing installed where `agentswf` is declared; testing.md and
  install.md list `agentswf/client` among what `awf test` serves.

Left: a non-final `wait()` returns the last of several rests within one 500 ms poll, not the first;
an attempt takes seconds to start. `bun run check` passes; `bun test` 2600 pass, 0 fail, before the
last two client fixes, whose suites pass (289).

### Final review, round 3, 2026-11-05

Two fresh reviewers; the engine and client side came back clean but for one item. Folded in:

- The fake client: the first event to a run only `rests` names, before a wait takes one of its
  rests, makes the run, as a first `start` does: `started`, or `not-a-start`, and a reply to it is
  `no-run`. It answered `nudged`, so a handler's `did === "started"` branch went untested.
- `awf tick --all` passes over a project whose runs are all plain: a plain workflow with `file`
  registers its project (ADR 0015), and tick has nothing there to wake, so a declared, an
  uninstalled or another version's engine there is no failure.
- README.md says the global `awf` hands over only at another version.

Left: the fake runs an event-made run's `prepare` in the workflow file's folder, where the real
client runs it in the project; and a registered project that is gone still fails `tick --all`, as
it did for event projects, though a plain run may be what registered it.

### Final review, round 4, 2026-11-05

One reviewer, on round 3's changes. Folded in:

- `awf tick --all` passes over a project with no event runs only when its runs would run on this
  engine, or none is installed there. One installed at another version is handed over as before:
  its records may be newer than this engine reads, and a run it can't open isn't known to be plain.
- The fake client makes a run only `rests` names in place, so a handle `get` gave before its first
  event sees it; and `start` claims such a run only before a wait has taken one of its rests, as an
  event does, so a later `start` with an id is `other-args`.

Left: `tick --all` lists a project's runs up to three times. `bun run check` passes; `bun test`
2605 pass, 0 fail.

### Final review, round 5, 2026-11-05

One reviewer, on rounds 3 and 4: clean. Left, older than both: a workspace root with no
`agentswf` of its own, whose packages install a newer one that writes records this engine can't
read, shows `tick --all` no event runs, so they are passed over silently; it needs a record-format
bump between the two versions.

### A runnable example, 2026-11-05

Asked for in review: `examples/programs/`, a program a reader can run. `desk.driver.ts` sends
each term to a `glossary` run, waits for it to park and relays its post from `inbox()`, closes it,
then `start`s `glossary-summary` with the definitions as args and waits until final. Its test runs
the handlers on `fakeClient`. Live, on codex `gpt-6-luna`, `idempotent backpressure`: three
attempts of the glossary, each term `continued` from parked, both definitions relayed, the summary
completed; under $0.01 a run.

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
