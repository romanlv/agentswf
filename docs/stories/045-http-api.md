---
id: "045"
title: "Drive awf from a web page: every command as an HTTP endpoint"
summary: "awf serve answers HTTP on the loopback with what each awf command prints as --json, streams logs and the inbox as server-sent events, and starts runs detached, so a frontend an agent writes in an afternoon can list runs, follow them and answer their questions. A new command gets its endpoint from one table, and the server can do nothing the commands can't."
type: story
status: ready
epic: operator
discovered_in: "a request for a frontend an agent can vibe-code, 2026-11-25"
depends_on: ["028", "032", "040", "043"]
---

# Drive awf from a web page: every command as an HTTP endpoint

**How to read this.** Outcome and How it works say what is planned and how you would use it; read
those two to decide whether it is right. The route list and Proposed design are the rules for
whoever builds it. Sample output is a sketch.

## Outcome

Today a program reaches awf two ways: it runs `awf … --json` and parses stdout, or it imports
`agentswf/client` and holds the workflow it starts. Neither works from a browser. Anyone who wants
a page that shows their runs, follows one live and answers an agent's question has to write a
server first, and that server becomes a second copy of awf's commands that drifts from them.

After this story:

```text
$ awf serve
awf: serving ~/dev/acme at http://127.0.0.1:7420/api
     token  awf_3f9c…   (kept in ~/.awf/serve/token; send it as Authorization: Bearer)
```

- Every operator command a page has a use for is an endpoint: `GET /api/runs`, `GET
  /api/runs/{workflow}/{id}/logs`, `POST /api/runs/{workflow}/{id}/replies`, and so
  on. A response body is exactly the document that command prints with `--json`, with the same
  `v`, so one set of types describes both.
- Logs and the inbox stream as server-sent events. A page opens an `EventSource` and gets each new
  page of a run's log as it happens. If the connection drops, the browser reconnects and resumes
  where it stopped.
- `POST /api/runs` starts a run in the background and answers `202` with its ref. So does the
  CLI, with the new `awf run --detach`.
- A frontend is written against a base URL, `http://127.0.0.1:7420/api` here, and never assumes
  `/api`. Later, one server can front several folders, each at `/{prefix}/api`, and the same
  frontend works there unchanged (see Several folders, later).
- `GET /api` lists every route, each field it takes and the type it returns. That and the guide
  page are enough for an agent to write the frontend.
- Nothing is on the network. The server listens on the loopback only, refuses a request without
  the token, and refuses a `Host` header other than its own.

Why now: the coordinator (story 032) and the client (story 040) made awf something other programs
drive. A local web page is the next host, and the first one that can't run a subprocess.

## How it works

```text
 browser (any localhost origin)            awf serve: one project, on its engine
 ─────────────────────────────            ─────────────────────────────────────
 fetch GET /api/runs/w/id/logs   ──────▶  token · Host · CORS
   Authorization: Bearer …                  │
                                            ▼
                                ROUTES: declared fields → argv
                                ["logs", "w/id", "--limit", "40", "--json"]
                                            │
                          ┌─────────────────┴──────────────────┐
              loads no workflow code: in process      loads workflow code: a child
              runOperatorCli(argv, {stdout, …})       awf run --detach · awf emit
              runs · logs · inbox · reply · send
              wake · park · allowance
                          └─────────────────┬──────────────────┘
                                            ▼
              stdout is the --json document          ──▶  200 (202 for a start) + body
              a refusal {v, code, error}             ──▶  STATUS[code] + body
```

**One table maps routes to commands.** Each route names its command and declares its fields: where
each comes from (path, query or body), its kind and the flag it becomes. The table also says
whether the route streams and which type it returns. The server is a loop over that table, and
`GET /api` and the exported request types are read off it. It has no logic of its own about runs.
A command added to `COMMANDS` gets a route, or a line in `NOT_SERVED` saying why it has none, or
the build fails. A refusal code added to the contract needs an HTTP status, or the build fails.

**The server only transports; the commands decide.** It can do nothing an `awf` command can't, and
it adds nothing to the answer. When a page needs something no command does, the command learns it
first. This story adds three such things to the CLI:

- `awf run --detach`;
- `awf run {run} --continue` and `awf emit {run} {event}` by the run's ref, so a page never has to
  know a workflow's file to continue a run or send it an event;
- `final` on the run's head in `awf runs` and `awf logs`, so a stream knows when to end.

**Code that loads a workflow runs in a child; the rest runs in the server's process.** Bun keeps a
module once it has been imported, so a long-lived server that imported a workflow file would serve
its first version forever, and a workflow's crash would take the server down. `awf run` and `awf
emit` load the workflow (emit, to check an event against its schema), so they run as a child
`awf` on the server's own engine. Every other served command only reads the run's files or talks
to its sockets. Those run in process: about 5 ms, against 75 ms for a new `awf` (measured below),
and a page polls them.

**Streams are the same documents, one after another.** `GET …/logs` with `Accept:
text/event-stream` runs `awf logs --json --after {cursor} --wait 30s` in a loop. Each page that
has events goes out as one SSE message whose data is the same `LogsJson` the plain GET returns and
whose `id` is the page's cursor. A browser that reconnects sends `Last-Event-ID`, and that becomes
`--after`. The stream ends with an `end` event once the run head says `final` and no newer page
is left. A parked
run is not final: its stream stays open, polling every 2 s, because `--wait` returns at once when
a run isn't running. The inbox streams the same way, one item per message, each item's cursor as
its `id`, and it never ends on its own.

**One server serves one project,** on that project's engine (ADR 0015). `awf serve` is handed over
like any command, from the directory it is typed in. The project it serves is the one a workflow
file there would keep its runs in: the nearest directory at or above it holding `.awf`. Without
one, `awf serve` makes `.awf` where it was typed, so a run it starts lands where it reads. A
workflow with events, or one that gives `file`, keeps its runs in its file's own project
(`projectOf`), not under the directory it was started from. When that project isn't the one
being served, its runs would land where this server can't see them. `awf run` and `awf emit
--target` with `--this-project` refuse such a workflow as `outside-project`, so the commands
decide that too, and the operator gets the same check. A plain workflow that doesn't give `file`
keeps its runs under the served project wherever its file is, and is never refused for it. It
takes no `--cwd`, because hand-over goes by the shell's directory. A request can't name another
directory, and a ref finds runs in the served project only. `awf runs {ref}` on its own also looks in every other project awf knows, which would
let `/api/runs/review/7` answer with another project's run. So every command the server runs gets
`--this-project`, a new flag that turns that search off, and a ref with no run here is `404
no-run`. A ref on a page then always belongs to the server that returned it.

### Several folders, later

Serving several folders from one server is a follow-up, [[serve-several-projects]]. It comes after
this story and is developed alongside a real dashboard, which will show which views across
projects are worth building. The shape is settled now, because this story has to leave room for
it:

- **Each folder keeps this API under a prefix,** `/{prefix}/api/…`, unchanged. A gateway, `awf
  serve {dir}...`, starts one `awf serve --port 0 --json` per folder, each handed over to its own
  project's engine, and proxies to them. `GET /api/projects` lists the prefixes.
- **Not a `?project=` parameter on one API.** One process can't load two engines (ADR 0015), so
  that server would proxy to per-project children all the same. Every URL would carry the
  parameter. A route without it would have to merge documents from engines of different versions,
  which breaks the rule that the server only transports.
- **What this story does so that works later:**
  - a frontend takes the base URL as one opaque string;
  - `GET /api` lists paths relative to it (`runs/{workflow}/{id}/logs`);
  - `ApiRequest` is keyed by those relative paths;
  - no response carries an absolute URL, so there is no `Location` header, and a page follows a
    started run by `RunStartedJson.ref`;
  - a ref is confined to the served project.

  None of those changes any behaviour in this story. Each would break frontends if it were changed
  after they were written.

The case people ask about first, **"can a web page I visit start a run on my machine?"** No:

- The server binds to `127.0.0.1` only and needs the token on every request. A page on another
  site can't read the token, and the server refuses its `Origin` anyway.
- A sandboxed agent can't read the token either: srt denies the operator's home, where the token
  is kept, and a docker box sees only its mounts. An agent that isn't sandboxed already has the
  operator's authority.
- The server refuses a `Host` header other than `127.0.0.1:{port}` or `localhost:{port}`, which
  stops DNS rebinding.
- Starting a run runs trusted code, as `awf run` does, so the file it names and any sandbox spec
  must be inside the served project, checked after symlinks are resolved, and the file's own
  project must be the served one.

## The routes

`{run}` is `{workflow}/{id}`, as `awf runs` prints it. A field that can repeat is a repeated query
parameter (`?tool=Read&tool=Edit`). A body is a JSON object.

| Method and path | Fields | Command | Returns |
| --- | --- | --- | --- |
| `GET /api` | — | — | `ApiJson`: the routes (paths relative to the base) and their fields, the engine's version, the project's absolute path |
| `GET /api/runs` | `limit` | `awf runs` | `RunsJson` |
| `POST /api/runs` | `file`, `argv?`, `id?`, `timeout?`, `fromStage?`, `sandbox?`, `workspace?`, `keepPanes?` | `awf run --detach` | `RunStartedJson`: `202` when `ok`, else `200` |
| `GET /api/runs/{run}` | — | `awf runs {run}` | `RunJson` |
| `POST /api/runs/{run}/attempts` | `timeout?`, `fromStage?` | `awf run {run} --continue --detach` | `RunStartedJson`: `202` when `ok`, else `200` |
| `GET /api/runs/{run}/logs` | `agent`, `stage`, `tool…`, `grep`, `after`, `limit`, `full` | `awf logs {run}` | `LogsJson`, or a stream of them |
| `GET /api/runs/{run}/logs/{handle}` | — | `awf logs {run} @{handle}` | `LogsJson` |
| `GET /api/runs/{run}/inbox` | `open`, `as`, `after` | `awf inbox {run}` | `InboxPageJson`, or a stream of items |
| `GET /api/inbox` | `workflow`, `open`, `as`, `after` | `awf inbox` | `InboxPageJson`, or a stream of items |
| `POST /api/runs/{run}/events` | `name`, `data?`, `eventId?`, `source?` | `awf emit {run} {name}` | `EmitResultJson` |
| `POST /api/events` | `file`, `id`, `name`, `data?`, `eventId?`, `source?` | `awf emit --target {file} --id {id} {name}` | `EmitResultJson` |
| `POST /api/runs/{run}/replies` | `agent`, `text`, `to?`, `as?` | `awf reply` | `ParticipantResultJson` |
| `POST /api/runs/{run}/messages` | `agent`, `text`, `as?` | `awf send` | `ParticipantResultJson` |
| `POST /api/runs/{run}/wake` | `timer?` | `awf wake` | `WakeResultJson` |
| `POST /api/runs/{run}/park` | — | `awf park` | `ParkResultJson` |
| `GET /api/allowance` | `harness…` | `awf allowance` | `AllowanceReport` |

An event to a run that is there goes by its ref. An event that may start a run, as a webhook's
first does, goes to `POST /api/events` with the workflow's `file` and the run's `id`, as `awf
emit --target` takes them: the file names the workflow, so there is no ref to disagree with it.
That form checks `starts` and records the event that began the run. `POST /api/runs` starts an
event run with no event, as `awf run --id` does.

An agent is named in the body, not the path: an agent in a child call has an address with a `/`
in it (`review/lens-1`), as `awf inbox` prints it.

`argv` is named as ADR 0016 names it: strings `prepare` parses, again at every attempt. A page
can't send typed `args` here. Only `client().start` records those, as it holds the workflow's
type, and a route has no type to check them against.

`workspace` takes `run` or a label. `origin`, the workspace `awf run` was typed in, would mean
wherever the server was started, which no page means, so it is refused.

Not served, each with its reason in `NOT_SERVED`:

- `init` and `test` work on a folder of source, a developer's job, not a page's.
- `open` is a TUI. `open -p` holds a harness for minutes on one request; a follow-up can start it
  and answer through the inbox.
- `run --here` takes over the terminal session that typed it.
- `tick` is a scheduler's job, and `--all` spans projects on other engines.
- `serve` is the server itself.

`help` and `--version` aren't commands in `COMMANDS`; `GET /api` says both.

**Status codes.** The status comes from the document, never the exit code, because exit codes say
different things in different commands (`wake` with nothing due exits 2, `emit` exits 1 when a
launch failed and still prints its result). A document with no `code` answers `200`, or `202` for
a start that is `ok`; a start whose launch failed is a `200` whose `RunStartedJson` says so. A
refusal answers its code's status, with the refusal document as the body:

| Status | Codes |
| --- | --- |
| 400 | `usage`, `id`, `no-id`, `cursor`, `bad-request` |
| 401 | `unauthorized` |
| 403 | `forbidden-host`, `forbidden-origin`, `outside-project` (a command's, from `--this-project`) |
| 404 | `no-run`, `no-session`, `no-participant`, `unknown-agent`, `not-found` |
| 405 | `method` |
| 409 | `ambiguous`, `other-args`, `live`, `opened`, `wake`, `park`, `not-started`, `project`, `no-engine`, `other-engine`, and the participant codes `ended`, `closed`, `expired`, `no-route`, `peer-stopped`, `unsupported-version` |
| 413 | `too-large` |
| 422 | `event`, `file`, `prepare` |
| 429 | `limit`, `inbox-full` |
| 500 | `internal-error` |
| 503 | `unreachable` |

`unreachable` is 503 everywhere. Whether it is a run's files mid-write or a socket that isn't up
yet, trying again later is the right answer. The server's own refusals (`unauthorized`,
`forbidden-*`, `bad-request`, `not-found`, `method`) have the same `{v, code,
error}` shape, `v` being `ApiJson`'s. What a run decided is a value, as it is in the client: an
event the run refused is a `200` whose `EmitResultJson` says so.

## Scope

In scope:

- `awf serve`: the server, its token, loopback only, the Host check and CORS.
- The route table with declared fields, `NOT_SERVED` and the status table, each checked to be
  complete at compile time; `GET /api` read off the table.
- SSE streams for logs and the inbox, resumable by `Last-Event-ID`.
- In the CLI: `awf run --detach`, `awf run {run} --continue`, `awf emit {run} {event}` for a
  workflow's own events, `final` on the run head and on each row of the runs list, and a `logs`
  wait that ends on its signal, and `--this-project` on every command that finds a run by ref
  (`findRunByRef`).
- `agentswf/api`, a new entry built on the contract alone: the document types, the route table
  and the request types derived from it, so a browser project type-checks against them with no
  engine and no Bun types.
- A guide page on the site, written for the agent that builds the frontend.

Out of scope:

- Stopping a run and listing a project's workflow files. A page wants both on day one, but each
  needs a command first (`awf stop` is in [[run-in-background]]). The guide says so, and both
  todos move to the top.
- Reading a log backwards past its last page. `awf logs` pages forward only.
- Serving a frontend's files (`awf serve --ui {dir}`); the `/api` prefix leaves `/` free for it.
  It is a todo.
- Several folders behind one server: [[serve-several-projects]], whose shape is settled above.
- Any address but the loopback, TLS and accounts. The server is local, as the control plane is
  (foundation §10, remote execution).
- An OpenAPI document, until M1 says it can be made without hand upkeep.
- `--values` on `POST /api/runs`, which takes a file. A body would need `--values -` first.

## Context and evidence

Measured 2026-11-25, with a prototype `Bun.serve` that called `runOperatorCli` in process against
this repository's `.awf/runs`, nearly all of them ended:

- Fact: `GET /api/runs` in process answered in about 5 ms end to end; `awf runs --json` as a new
  process took 70–80 ms. Twenty requests at once finished in 33 ms, with no errors.
- Fact: `runOperatorCli(argv, {cwd, home, stdout, stderr, signal, stdin, environment})`
  (`packages/engine/src/operator-cli.ts`) takes its I/O from what it is given. It falls back to
  `console.log`, `process.*` and `Bun.stdin` only for a field left out, so the server passes every
  one. `takeLaunch` deletes `process.env.AWF_LAUNCH` on each call, which does nothing after the
  first. The module-level state, the write queues in `jsonl.ts` and `run-lock.ts`, is safe under
  concurrent calls.
- Fact: reading a live attempt checks its process with a synchronous `Bun.spawnSync(["ps", …])`
  (`runs.ts`, via `probeProcess`). In process, that blocks the server once per live run read.
  That is M3.
- Fact: only `run` (`run-prepare.ts`) and `emit` (`--target` at `emit-command.ts:55`; the ref form
  at `emit.ts:134`) call `loadWorkflowFile`. Every command imports `workflow-loader.ts` through
  `refusals.ts`, so the test spies on the call, not the module graph.
- Fact: a missing run comes back as `{"v":2,"code":"no-run",…}` on stdout. `emit` and `wake` exit
  1 on `launch-failed` with a result document, not a refusal, and `wake` with nothing due is a
  `wake` refusal with exit 2. The status has to come from the document.
- Fact: `awf logs --follow --json` is refused ("--json takes --wait"). `--after {cursor} --wait
  5s` on an ended run answers at once with no events and the same cursor. `--wait` waits only
  while the run is `running`, and `next` is absent on any run that isn't, a parked one included
  (`logs-command.ts`), so `next` can't tell a stream to end.
- Fact: `logsCommand` takes no signal and sleeps on its clock; `inboxCommand` takes `signal`.
- Fact: `reply` and `send` read their text from stdin when none is given, after a `--`. `open -p`
  reads stdin only as `-p -`.
- Fact: run ids and workflow names match `^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$`, and agent keys
  `^[a-z0-9][a-z0-9._@-]*$`; neither can begin with `-`. An agent's address in a child call joins
  keys with `/` (`inbox-command.ts`, `address()`), so an agent is a body field, never a path
  segment.
- Fact: an event run, and a run `client().start` makes, start detached through `wake`, whose
  `detachedLaunch` (module-private in `wake.ts`) spawns `awf run {file} --id {id} --continue
  --run-root …` and passes nothing else. A plain run `awf run` starts never runs detached.
- Fact: each attempt records the `file` it ran in `attempts/{n}.json`. `run.json` has `file` only
  for event runs and runs started with `args`.
- Fact: `allowance` and `emit --target` refuse `--cwd` and `--run-root`, and the harnesses are
  bare words, not a flag. For `run` they set the run's working directory and run root, an event
  run refuses both, and a continue whose `--cwd` differs from the recorded one is `other-args`.
- Fact: an event run, and a plain run of a workflow that gives `file`, are kept in
  `projectOf(file)`: the nearest directory at or above the file holding `.awf`, else the file's
  own (`projects.ts`, `run-prepare.ts`).
- Fact: hand-over goes by the process's directory, not `--cwd` (`hand-over.ts`). A child whose
  `AWF_ENGINE` is the realpath of its own `agentswf` folder skips it.
- Fact: srt denies reading the host home and the run root, and asserts it
  (`packages/sandbox/src/srt/profile.ts`).
- Fact: Bun's server closes a connection idle for 10 s by default (`idleTimeout`). A stream sets
  `server.timeout(request, 0)`.
- Constraint: one engine per project (ADR 0015). One process can't load two.
- Assumption: a browser's `EventSource` can't send `Authorization`, so a stream also takes the
  token as `?token=`. A `fetch`-based reader can use the header.

## Code map

### `packages/engine`

- `src/operator-cli.ts`: `runOperatorCli`, which every in-process route calls. Gains the `serve`
  handler, and passes `signal` to `logsCommand`.
- `src/commands.ts`: `COMMANDS`, `CommandName`. `serve` joins "This machine". `ROUTES` and
  `NOT_SERVED` are checked against `CommandName`.
- `src/run-command.ts`, `src/run-prepare.ts`: `--detach`, and `{run} --continue` by ref.
- `src/wake.ts`: `detachedLaunch` exported, taking the attempt's own flags (`--timeout`,
  `--from-stage`) and the file. `src/client/runs.ts`'s `start` and `--detach` share make-and-launch.
- `src/emit-command.ts`, `src/emit.ts`: the ref form takes a workflow's own events, loading the
  last attempt's file as it does for a reply. `emitToRun` takes only `{key}:reply` today, and
  its `checkEvent` call is for a reply's sender; it gains the operator as sender for own events.
- `src/logs-command.ts`: the `--wait` sleeps end on the signal.
- `src/run-state.ts`: `findAnywhere` searches every project awf knows after the run root. With
  `--this-project`, parsed by `parsePlace` and by `run` (for a new run's file and for continue by
  ref), it searches the run root only. Every command that finds a run by ref goes through it (`findRunByRef`), so the
  flag covers them all.
- `src/run-state.ts`, `src/runs-command.ts`, `src/logs-command.ts`: `final` on the head and on
  each runs-list row, from the rule `client().wait` already uses (`isFinal`).
- New `src/serve-command.ts` and `help/serve.txt`, beside the other commands: it parses the
  flags, finds the served project with `projectOf` (given a path in the directory, as it takes a
  file; refused as `project` in the home directory itself, as `projectOf` refuses there) and
  makes its `.awf` when missing, reads or
  makes the token, and hands the server the project, the token, the command line that runs this
  engine's `awf` (today a private `CLI` in `wake.ts`, exported for both) and the environment a
  child runs with, `AWF_ENGINE` set to the realpath of this engine's `agentswf`.
- New `src/http/`: `routes.ts` (each route's command and `where`, keyed by the contract's routes;
  `NOT_SERVED`; the `CommandName` coverage check) and `server.ts` (`Bun.serve`, token check, Host, CORS, dispatch, streams). It is given everything
  it needs and finds nothing itself.
- `src/run-prepare.ts`, `src/emit-command.ts`: with `--this-project`, a loaded workflow that is
  kept in `projectOf(file)` (one with events, or one that gives `file`) is refused
  `outside-project`, a new code in `REFUSAL_CODES`, when that project isn't the run root's
  (`rootProject`, as `run-state.ts` names a run's project).
- Tests: `src/http/routes.test.ts` (pure), and `src/http/server.test.ts` against runs built with the
  helpers `runs-command.test.ts` and `logs-command.test.ts` use. `json-refusals.test.ts` gains the
  new forms.

### `packages/contract`

- New `src/api.ts`: `ROUTES` as data (method, relative path, fields, `place`, `stream`, `ok`,
  `returns`), the field kinds, `STATUS`, `ApiJson`, `ApiRequest<Method, Path>`. Pure, as the
  contract is. It names a route's command as a plain string; the engine checks each against
  `CommandName`.

- `src/records.ts`: `RunStartedJson`, `InboxPageJson`, `ApiJson`, `RunHeadJson.final`; the
  server's refusal codes; `outside-project` in `REFUSAL_CODES`; `final` on each `RunsJson` row.
  `PARTICIPANT_CODES` and
  `INBOX_CODES` in `src/wire.ts` are what `STATUS` must also cover.

### `packages/agentswf`

- `package.json` gains `./api` in `exports`; `@agentswf/contract` gains `./api` in its own.
- New `src/api.ts`, published as `agentswf/api`: re-exports `@agentswf/contract/api` and the
  document types from `@agentswf/contract/records`. It imports nothing else, so a frontend's
  `tsc` checks the contract's files only. `agentswf/client` would pull in the engine: its
  entry re-exports `engine/client`, which imports `node:os` and the commands, and the package
  ships `.ts`, so `import type` still type-checks all of it.

### `scripts/check-boundaries.ts`

- An eighth rule: `engine/src/http` does no run-directory I/O and imports nothing of the engine but
  its command entry points (`operator-cli`, `commands`), the contract and itself. A command that
  later grows a typed core its route calls amends this rule by name.

Checked and unchanged: the control plane and `wfa` (an agent never talks HTTP), `harness`,
`sandbox`, `lab`.

## Proposed design

### The route table

```ts
type Kind =
  | "ref"                  // {workflow}/{id}: two path segments, one word
  | "handle"               // the word is @{handle}
  | "agent-address" | "word" | "int" | "flag" | "duration" | "json"
  | "string"               // any text as a flag's value (grep); a leading "-" is a bad-request
  | "text"                 // free text, sent on stdin
  | "project-file"         // resolved by realpath, inside the served project
  | { oneOf: readonly string[] };

type Field = {
  from: "path" | "query" | "body";
  kind: Kind;
  /** Where it goes: a flag, a positional word, after `--`, or stdin. */
  as: `--${string}` | "positional" | "after-dashes" | "stdin";
  optional?: true;
  repeats?: true;
};

// In the contract. The engine adds `where: "process" | "child"` per route, keyed by path.
type Route = {
  method: "GET" | "POST";
  path: string;                          // "runs/{workflow}/{id}/logs", as GET /api lists it
  command: string;                       // checked against CommandName in the engine
  /** Words before the fields', such as `["--detach"]`. */
  fixed?: readonly string[];
  fields: Record<string, Field>;
  /** What the server adds: "place", the served `--cwd`, `--run-root` and `--this-project`;
      "project", `--this-project` alone; "none", nothing. */
  place: "place" | "project" | "none";
  stream?: "pages" | "items";
  returns: string;                       // the type's name, for GET /api
};
```

- `{run}` in a path is one `ref` field matched from two segments, and a kind formats its own word
  (`handle` as `@{handle}`), so `ApiRequest` has `run` and `handle` as plain fields.
- argv is built from the fields alone: words, never a string a shell parses. Each value is
  checked against its kind before it becomes a word. A free-text field goes on stdin, so no text
  is ever read as a flag. A body field the route doesn't declare is a `bad-request`.
- The server adds `--json` before any `--`. A route with `place: "place"` also gets the served
  `--cwd`, `--run-root` and `--this-project`: `runs`, `logs`, `inbox`, `reply`, `send`,
  `wake`, `park` and `emit` by ref. Each route declares it, as one command can have forms that
  differ. A test runs each route's minimal request and fails on a `usage` refusal, which catches
  a wrong declaration.
- `place: "project"` goes on `run` (start and continue) and `emit --target`. For `run`, `--cwd`
  and `--run-root` mean where the agents work and where the run is kept, and an event run refuses
  both (`run-prepare.ts`); `emit --target` refuses place flags. So the child runs with the served
  project as its working directory instead, as `detachedLaunch` runs a woken attempt in the run's
  recorded cwd. `--this-project` alone then refuses a file kept in another project, and confines
  a continue by ref.
- `place: "none"` is `allowance`'s alone.
- `ROUTES satisfies readonly Route[]`, in the contract. The engine's `routes.ts` gives each a
  `where` and checks that the commands named in `ROUTES` and the keys of `NOT_SERVED` together
  cover `CommandName`, or the build fails.
- `STATUS satisfies Record<RefusalCode | ParticipantCode | InboxCode | ApiCode, number>`.
- `ApiRequest<"POST", "runs">` is derived from the table's `as const` fields. The request
  types and `GET /api` can't drift from what the server accepts.
- A test spies on `loadWorkflowFile` and fails when a `process` route calls it.

### The server

- `awf serve [--port {n}] [--origin {url}]... [--new-token] [--json]`. The port is 7420 by
  default, and 0 picks one; a port in use is a usage refusal naming `--port`. It runs until
  interrupted, as a dev server does. It prints the URL and
  token once, or one `{v, url, token, project}` line with `--json`.
- Listens on `127.0.0.1` only, and has no `--host`. The guide says to use `127.0.0.1` rather than
  `localhost`, which some clients resolve to `::1` first.
- **Token.** 32 random bytes with an `awf_` prefix, made once in `~/.awf/serve/token` with mode
  `0600` and kept across restarts, so a frontend's `.env` keeps working. `--new-token` replaces it.
  It is sent as `Authorization: Bearer {token}`, or as `?token=` on a stream request only, which
  is what `EventSource` can send. It is compared in constant time against the file as it is now,
  re-read when the file changes, so `--new-token` in one project's server reaches every other
  one running. Every response carries
  `Referrer-Policy: no-referrer`.
- **Host.** Only `127.0.0.1:{port}` and `localhost:{port}`; any other is `403 forbidden-host`. The
  guide's Vite example sets `changeOrigin: true`, so a proxied request carries the server's host.
- **CORS.** An `Origin` of `http://localhost:{any}` or `http://127.0.0.1:{any}` is allowed, as is
  each `--origin`. Another origin is `403 forbidden-origin`. Preflight answers `OPTIONS`, allowing
  `Authorization`, `Content-Type` and `Last-Event-ID`.
- **In process.** `runOperatorCli(words, {cwd, home, environment, stdout, stderr, stdin, signal:
  request.signal})`. stdout is the document. stderr is dropped: it holds progress and the sentence
  that a refusal's `error` repeats.
- **The inbox page.** `awf inbox --json` prints one item per line, the one command that doesn't
  print one document. The route collects them into `InboxPageJson {v: 1, items, cursor?}`, where
  `cursor` is the last item's, or the `after` given when nothing is new. Items print only on
  success, so a page is all items or a refusal. That collecting is the server's one change to a
  body, and it is defined in the contract beside `InboxItemJson`. A first read without `after`
  is the whole history, as the command gives it; a limit waits for the command to have one.
  `open` is a snapshot with no cursors, so `open` on a stream is a `400`, as the CLI refuses
  `--open` with `--wait`.
- **Child.** `Bun.spawn([...awfCommand, …words])`, with the command line and environment `serve`
  handed it, whose `AWF_ENGINE` means the child never hands over. The request's abort kills an `emit`
  child that is still running. A `--detach` child is never killed: it may be making the run or
  launching it, and a run left with no attempt, under a generated id, would be made again by a
  retry. Only its response is dropped.
- A thrown error is `500 internal-error`, and the server goes on.

### Streams

- **Pages, for logs.** Loop on `logs {run} --json --after {cursor} --wait 30s`. A page with events
  goes out as a default SSE message (`data:` the `LogsJson`, `id:` its cursor), so
  `EventSource.onmessage` gets it. The stream ends with `event: end` once the head says `final`
  and the page has no `more.newer`; a reconnect to an ended run still gets every page after its
  cursor first. A failed plain run is final, so after `POST …/attempts` the page opens a new
  stream; the guide says so.
  While the run is not running and not final, the loop sleeps 2 s between reads. It starts from
  `Last-Event-ID`, else `?after`, else the last page as the plain GET returns it.
- **Items, for the inbox.** The same loop over `inbox … --after {cursor} --wait 30s`, one message
  per item, each item's cursor as its `id`. It never ends on its own: the project's inbox
  outlives any one run, and a page following one run closes that run's inbox stream when its log
  stream ends.
- Over HTTP/1.1 a browser holds six connections per origin, so a page follows one run's log and
  the inbox, and polls `GET /api/runs` for the rest; the guide says so. More open streams stall
  the page's plain requests.
- A comment line every 15 s keeps proxies open. `server.timeout(request, 0)` lifts Bun's idle
  limit for the stream alone.
- Each subscriber runs its own loop. Ten open streams cost ten pollers, which is fine on one
  machine. Sharing one per run waits until it is measured as needed.

### `awf run --detach`

- `awf run {file} --detach [--id {id}] [run options] [-- argv]` loads the workflow and runs
  `prepare` on the argv in this process, so a refusal (`file`, `prepare`, `no-id`, `id`,
  `other-args`) is said here, exit 2. It then makes the run and records it as `awf run` would.
  It launches the first attempt detached in its project through `detachedLaunch`, passing that
  attempt's `--timeout` and `--from-stage`. It prints `RunStartedJson {v: 1, ok, ref, dir, did,
  error?}`. `did` is `started` (a new run), `exists` (an event run already there, woken),
  `continued` (a next attempt), or, with `ok: false`, `launch-failed` or `stuck`: the client's
  words for the same outcomes, which `StartResult` keeps. It is a document, not a refusal,
  because the run is kept and the page needs its `ref` to follow or retry it. Exit 0 when `ok`, 1
  otherwise, as `emit` exits on a launch that failed. A retry is `POST …/attempts`: `--detach`
  records `file` in `run.json`, as a run started with `args` does, because a launch that failed
  leaves no attempt to read the file from.
- `prepare` runs twice: in this process to check, and in the attempt, as ADR 0016 has every
  attempt do. A `prepare` with side effects sees both. The help says so.
- **Continue by ref.** With `--continue` and no `--id`, `awf run`'s word is a run, `{workflow}/{id}`
  or an `{id}` only one workflow has, as `awf reply` takes it, found as `awf runs` finds it, and
  continued from its last attempt's file. With `--id`, the word is a file, as today. Whether the
  word exists as a path never decides it, as `w/id` is a valid relative path. Without `--detach`
  it works the same, so the operator gets it too.
- The attempt has no terminal: a coordinator's questions go to the inbox only, as for an event
  run, and its progress is in `awf logs`.
- `--detach` with `--here`, or with `--workspace origin`, is refused. For a workflow with events,
  which `awf run` already starts detached, `--detach` changes only that it prints `RunStartedJson`.
- [[run-in-background]]'s `--bg` becomes `--detach` plus its progress tab and its caller fork,
  with no second flag.

Alternatives rejected:

- **One endpoint that runs any argv** (`POST /api/commands/{name}` with `{argv}`). It is complete
  by construction, but a page would be building flag strings and parsing exit codes. That is the
  CLI with extra steps, and every flag becomes HTTP surface.
- **Handwritten handlers over the engine's functions** (`viewRun`, `listRunEntries`). The
  commands' parsing, defaults and refusals would be copied, and the server would drift from the
  CLI. The argv between table and command is internal. A command can later expose a typed core,
  and its route can call that instead with nothing visible changing.
- **Fields as code**, each route an `argv(request)` function. It is quicker to write, but `GET
  /api` couldn't list a route's fields and no request type could be exported. Every flag would be
  mapped by hand in two places.
- **Build on `agentswf/client`.** The client holds the workflow value it starts, so the server
  would have to import workflow files, and the client has no runs list and no logs.
- **Every route as a child `awf`.** It is simplest, but costs 75 ms per poll and one process per
  open stream.
- **`inbox --json` changed to print one document.** That would make it like every other command,
  but it breaks the line-per-item stream its `--wait` readers rely on, to save one bounded
  collecting step.
- **WebSockets.** Nothing here is two-way on one connection: a page reads a stream and writes with
  plain POSTs. SSE reconnects and resumes by itself, needs no library and passes through proxies.
- **A token per start.** It is a little safer, and it breaks every frontend's `.env` at each
  restart.
- **No token, Origin and Host checks only.** That stops other sites, but not another user on the
  machine or a process that isn't the operator's, either of which can reach the loopback.

## To measure

- M1. Whether a generator such as `ts-json-schema-generator` makes JSON Schemas from the document
  types in `contract/src/records.ts` without changes to them. If it does, `GET /api/openapi.json`
  is a follow-up with no upkeep. Not run: installing the package was refused in the planning
  session.
- M2. Whether an agent can build a working page from the guide page and `GET /api` alone. See
  Verification.
- M3. What `ps` per live run costs a server answering in process, with five live runs and a page
  polling `GET /api/runs` every second. If the event loop stalls, the probe moves to `Bun.spawn`.

## Tasks at a glance

- [ ] 1. The CLI learns what a page needs: `--detach`, continue and emit by ref, `final`,
  `--this-project`
- [ ] 2. `awf serve`: the table, statuses, token, Host and CORS, in-process and child dispatch
- [ ] 3. Streams: logs and the inbox as SSE, resumable, ending on abort
- [ ] 4. `agentswf/api`, the guide page, help, changelog and status

## Open questions

None.

Settled:

- Q1. **No version in the URL** (decided 2026-11-26): routes are `/api/…`. Each body carries its
  document's `v`, as the CLI's does, and the routes change with the package, as the commands do.
  A second version in the path would be one nothing reads.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. The CLI learns what a page needs

Outcome: from the CLI, a run of any workflow starts or continues in the background and says where
it is. A run is continued, or sent one of its workflow's events, by its ref alone, and the run's
head says whether anything will go on by itself. `--this-project` keeps any command to the
project it is given.

Execution:

- [ ] Plan: settle the make-and-launch path `--detach` shares with `client().start`.
- [ ] Implement: the flags and forms, `RunStartedJson`, `final`, help text.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Done when:

- On a fake launch, `--detach` of a plain workflow prints `RunStartedJson`, and the launch got the
  run's id, its file, `--timeout` and `--from-stage`. `{run} --continue --detach` does the same for
  the next attempt.
- `prepare` refusing exits 2 with `code: "prepare"`, and no run is left behind.
- `--detach --here` and `--detach --workspace origin` are usage refusals.
- `--detach --json` of a workflow with events prints `RunStartedJson`; without `--detach` it is
  still refused, as today.
- `awf emit {run} {event}` delivers one of the workflow's own events to a parked run.
- `final` is true for a completed run and false for a parked event run, in the list, in `runs
  {run}` and in `logs`.
- `awf run {workflow}/{id} --continue` continues a run started from another directory, and
  `awf run w/id --id x --continue` still reads `w/id` as a file.
- `awf runs {ref} --this-project` is `no-run` for a run only another project has, which `awf runs
  {ref}` finds. `awf run {file} --this-project` and `awf emit --target {file} --this-project` are
  `outside-project` for an event workflow in a subfolder with its own `.awf`, and a plain workflow
  there that doesn't give `file` runs. `awf run {run} --continue --this-project` is `no-run` for
  another project's run.
- After a `launch-failed`, `awf run {run} --continue --detach` launches the run from the file in
  `run.json`.
- `json-refusals.test.ts` covers every new form.

### 2. `awf serve`

Outcome: every route in the table answers with its command's document, behind the token, on the
loopback.

Execution:

- [ ] Plan: write the table and the status map first, and see both fail to compile when
  incomplete.
- [ ] Implement: `engine/src/http`, `serve` in `COMMANDS`, rule 8.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Done when:

- `routes.test.ts` checks, for each route, the argv from a full request and from a minimal one.
  Text starting with `--` arrives on stdin, and a value that fails its kind is refused.
- Removing a route, or adding a refusal code with no status, fails `bunx tsc --noEmit`.
- A served project with no `.awf` gets one, and a run `POST /api/runs` starts there is found by
  `GET /api/runs/{run}`. An event workflow in a subfolder with its own `.awf` is
  `outside-project`.
- An agent address with a `/` is answered through `POST …/replies`.
- `server.test.ts` runs on port 0 with a temporary home. Every GET route returns the document the
  command prints. A missing token is 401 and a wrong `Host` or `Origin` is 403. A preflight from
  `localhost:5173` passes. A missing run is 404 with the command's refusal. A file or sandbox spec
  outside the project, a symlink out of it included, is 403. A `wake` with nothing due is 409.
- `POST /api/runs` on a fake launch answers 202 with `RunStartedJson`, and no response carries an
  absolute URL.
- `GET /api/runs/{ref}` for a run that only another project has is a 404, though `awf runs {ref}`
  without `--this-project` finds it.
- The `loadWorkflowFile` spy passes for every `process` route.

### 3. Streams

Outcome: a page follows a run's log and an inbox live, and picks up where it left off after a
dropped connection.

Execution:

- [ ] Plan: settle the loop, the heartbeat and when a stream ends.
- [ ] Implement: the stream path in `server.ts`, and `signal` into `logsCommand`.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Done when:

- A test appends events to a fixture run while a stream is open and receives them in order, each
  page's `id` its cursor. Reconnecting with `Last-Event-ID` gets only what came after.
- A completed run's stream ends with `end`, and a reconnect to it from an old cursor gets every
  later page before `end`. A parked run's stream stays open past 30 s, which also proves the idle
  limit lifted.
- `open` with `Accept: text/event-stream` is a 400.
- An aborted request ends its `logs` wait within one poll: the test's clock sees no further sleep.
- An inbox stream gets a question as it is asked, and the answer after `POST …/replies`.

### 4. Types, guide, help, changelog, status

Outcome: an agent given the guide page builds a frontend without reading awf's source.

Work:

- `agentswf/api`, with a typecheck file under a DOM-only tsconfig and no Bun types that imports
  it, as a Vite frontend would.
- `site/guide/http.md`, under the site's writing rules: start the server, the token, a curl for
  each kind of route, a stream in ten lines of browser code, the Vite proxy, the status table, and
  what isn't there yet (stop, workflow list). It is written to be pasted into an agent's prompt.
- CHANGELOG under Unreleased; `docs/status.md`; [[run-in-background]] built on `--detach`; todos
  for `awf serve --ui`, listing workflow files and `open -p` over HTTP.

Done when:

- `bun run check` passes and the site builds.
- The live check in Verification has been run once and its findings fixed in the guide or the API.

## Verification

Automated:

- [ ] `src/http/routes.test.ts`, `src/http/server.test.ts`, the task 1 tests
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] M2, the outcome itself. Give a fresh codex agent on a cheap model, in an empty folder, only
  `site/guide/http.md` and the output of `GET /api`. Ask it for one HTML file that lists the runs,
  follows one's log live and answers an open question. Run it against `examples/quick-check` and a
  workflow with a coordinator. Record what it got wrong, and fix the guide or the API, not the
  agent's page. Cost: one codex session and two cheap runs.
- [ ] M3, with five live runs.

## Review record

Draft reviews, 2026-11-25:

- Design (fresh subagent, read-only). It accepted the seam, the compile-time completeness checks,
  SSE with cursors, process versus child, and no URL version. Taken:
  - fields declared rather than coded;
  - `argv` named as ADR 0016 names it;
  - continue and emit by ref, not by a page-supplied file;
  - `--detach` passing the attempt's `--timeout` and `--from-stage`;
  - the launch outcome named as the client names it;
  - an inbox page document;
  - SSE default messages;
  - Bun's idle timeout;
  - `Location` exposed (dropped in round three: no absolute URLs);
  - `?token=` on streams only, `Referrer-Policy`, realpath confinement of the file and the
    sandbox spec;
  - `workspace: origin` refused;
  - rule 8 worded so a typed core can amend it;
  - `tick` and `open -p` cut.
  Kept against it: `unreachable` stays one 503, because a retry is right for every case of it.
- Facts (fresh subagent, against the code). Corrected:
  - the workflow-name grammar;
  - event runs already start detached;
  - where an attempt's file is recorded;
  - commands that take no `--cwd`;
  - `AllowanceReport`;
  - the `no-route` collision, now the server's `not-found`;
  - status from the document, not the exit code;
  - stream end on `final`, not on a missing `next`;
  - hand-over by the shell's directory, so `serve` takes no `--cwd`;
  - `AWF_ENGINE` as a realpath;
  - `detachedLaunch` exported;
  - the `loadWorkflowFile` spy;
  - the `ps` probe (M3).

Second round, 2026-11-26 (fresh subagent, against the code). Taken:
  - no place flags for `run`, the child run in the project instead, and the place list derived;
  - a log stream ends only with no `more.newer` left;
  - `RunStartedJson` as a document with `ok`, `exists` and the launch outcomes, not two new
    refusal codes;
  - continue-by-ref grammar settled by `--id`, never by whether a path exists;
  - the events route's `file` for an event that may start a run;
  - the inbox page rules: `open` not streamed, no partial refusal, whole history on a first read;
  - `final` on the list's rows.

Third round, 2026-11-26: several folders (fresh subagent, both shapes weighed against the code).
Prefixes behind a gateway, in a follow-up; a `?project=` parameter rejected. Taken into this
story: the base URL as an opaque string, paths relative to it in `GET /api` and `ApiRequest`, no
`Location` header, and refs confined to the served project by `--this-project`.

Fourth round, 2026-11-26 (fresh subagent, against the code). Taken:
  - agents named in the body, since a child call's address holds a `/`;
  - `place` declared per route and checked by a test, `emit --target` and `allowance` getting none;
  - starting by event as its own route, `POST /api/events`, so no ref can disagree with the file;
  - the served project is `projectOf`'s, made when missing, and a workflow kept in another
    project is `outside-project`;
  - `--detach --json` for an event workflow;
  - a port in use.
  It confirmed that every lookup by ref goes through `findRunByRef`, that the inbox without a run
  reads the run root only, and that the status table covers every code.

Fifth round, 2026-11-26 (fresh subagent). It found a stale copy of the story's first half
spliced into Context and evidence by a scripted edit (a `$` and a backtick read as a replace
pattern); removed, and nothing from rounds three and four was lost. Taken:
  - the project check moved into `run` and `emit --target` under `--this-project`, and `serve`'s
    own setup into `serve-command.ts`, so rule 8 holds as written;
  - route paths held relative, as `GET /api` lists them;
  - `serve` in `NOT_SERVED`;
  - `202` only when a start is `ok`.

Sixth round, 2026-11-26 (fresh subagent; integrity clean). Taken: `place` three-valued, so `run`
and `emit --target` get `--this-project` without `--cwd`/`--run-root` and the project check
fires; `--this-project` and `outside-project` tested on the CLI in task 1; the child's
environment handed over by `serve`.

Seventh round, 2026-11-26 (fresh subagent; integrity clean). Taken: the published types moved to
a pure `agentswf/api` built on the contract, as `agentswf/client` drags the engine into a
browser's type check; `outside-project` only for a workflow kept in `projectOf(file)`, against
the run root's project; `{run}` and `@{handle}` formed by their kinds; a `--detach` child
never killed on abort.

Eighth round, 2026-11-26 (fresh subagent): no blocking issues. Its minor points taken: `file` in
`run.json` for a detached run, so a failed launch can be retried; `Route` split between the
contract and the engine's `where`; a `string` kind for `grep`; one stream per page plus the
inbox, for the six-connection limit; the token re-read when its file changes; the `./api`
exports, and `serve` refused in the home directory.

### Task 1

### Task 2

### Task 3

### Task 4

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
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
