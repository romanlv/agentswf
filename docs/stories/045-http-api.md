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
those two to decide whether it is right. The routes and Proposed design are the rules for whoever
builds it. Sample output is a sketch.

## Outcome

A program reaches awf today in two ways: it runs `awf … --json` and parses stdout, or it imports
`agentswf/client` and holds the workflow it starts. Neither works from a browser. A page that shows
your runs, follows one live and answers an agent's question needs a server first, and that server
becomes a second copy of awf's commands that drifts from them.

After this story:

```text
$ awf serve
awf: serving ~/dev/acme at http://127.0.0.1:7420/api
     token  awf_3f9c…   (kept in ~/.awf/serve/token; send it as Authorization: Bearer)
```

- Every operator command a page has a use for is an endpoint: `GET /api/runs`,
  `GET /api/runs/{workflow}/{id}/logs`, `POST /api/runs/{workflow}/{id}/replies`, and so on. A
  response body is exactly the document the command prints with `--json`, `v` included, so one set
  of types describes both.
- Logs and the inbox stream as server-sent events. A page opens an `EventSource` and gets each new
  page of a run's log as it is written. After a dropped connection the browser reconnects and
  resumes where it stopped.
- `POST /api/runs` starts a run in the background and answers `202` with its ref. The CLI does the
  same with the new `awf run --detach`.
- `GET /api` lists every route, the fields it takes and the type it returns. That and the guide page
  are all an agent needs to write the frontend.
- Nothing is on the network. The server listens on the loopback only, and refuses a request without
  the token or with a `Host` other than its own.

**Why now.** The coordinator (story 032) and the client (story 040) made awf something other
programs drive. A local web page is the next host, and the first that can't run a subprocess.

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
each comes from (path, query or body), its kind, and the flag it becomes. The server is a loop over
that table, and `GET /api` and the exported request types are read off it. A command added to
`COMMANDS` needs a route or a line in `NOT_SERVED` saying why not, and a refusal code added to the
contract needs an HTTP status; otherwise the build fails.

**The server only transports; the commands decide.** It can do nothing an `awf` command can't, and
it adds nothing to the answer. When a page needs something no command does, the command learns it
first. This story teaches the CLI four things:

- `awf run --detach`;
- `awf run {run} --continue` and `awf emit {run} {event}` by ref, so a page never needs a workflow's
  file to continue a run or send it an event;
- `final` on a run's head, so a stream knows when to end;
- `--this-project`, so a ref only finds runs in the project given.

**Code that loads a workflow runs in a child; the rest runs in process.** Bun keeps a module once
imported, so a long-lived server that imported a workflow file would serve its first version
forever, and a workflow's crash would take the server down. `awf run` and `awf emit` load the
workflow (emit, to check an event against its schema), so they run as a child `awf` on the server's
own engine. Every other served command only reads run files or talks to sockets, and runs in
process: about 5 ms against 75 ms for a new `awf`, which matters for a page that polls.

**Streams are the same documents, one after another.** `GET …/logs` with
`Accept: text/event-stream` loops on `awf logs --json --after {cursor} --wait 30s`. Each page with
events is one SSE message: its data is the `LogsJson` the plain GET returns, its `id` the page's
cursor. A reconnecting browser sends `Last-Event-ID`, which becomes `--after`. The stream ends with
an `end` event once the head says `final` and no newer page is left. A parked run is not final, so
its stream stays open. The inbox streams the same way, one item per message, and never ends on its
own.

**One server serves one project,** on that project's engine (ADR 0015). `awf serve` is handed over
like any command, from the directory it is typed in, and serves the project a workflow file there
would keep its runs in: the nearest directory at or above it holding `.awf`, made where it was typed
if there is none. A request can't name another directory, and every command it runs gets
`--this-project`:

- A ref finds runs in the served project only. Without the flag, `awf runs {ref}` also searches
  every other project awf knows, so `/api/runs/review/7` could answer with another project's run.
- A workflow kept in its own file's project (one with events, or one that gives `file`) is refused
  as `outside-project` when that isn't the served one, because its runs would land where this
  server can't see them. A plain workflow keeps its runs under the served project wherever its file
  is.

**Can a web page I visit start a run on my machine?** No:

- The server binds `127.0.0.1` only and needs the token on every request. A page on another site
  can't read the token, and its `Origin` is refused anyway.
- A sandboxed agent can't read the token: srt denies the operator's home, and a docker box sees
  only its mounts. An agent that isn't sandboxed already has the operator's authority.
- A `Host` other than `127.0.0.1:{port}` or `localhost:{port}` is refused, which stops DNS
  rebinding.
- Starting a run runs trusted code, as `awf run` does, so the workflow file and any sandbox spec
  must resolve, symlinks followed, inside the served project.

### Several folders, later

One server for several folders is a follow-up, [[serve-several-projects]], to be built alongside a
real dashboard. Its shape is settled because this story has to leave room for it: each folder keeps
this API unchanged under `/{prefix}/api`, served by its own `awf serve` child that a gateway
proxies to. A `?project=` parameter was rejected: one process can't load two engines, so it would
need the same children, change every URL, and make the server merge documents from engines of
different versions.

What this story does so that works, none of which changes anything today and all of which would
break frontends if changed later:

- a frontend takes its base URL as one opaque string and never assumes `/api`;
- `GET /api` lists paths relative to that base (`runs/{workflow}/{id}/logs`), and `ApiRequest` is
  keyed by them;
- no response carries an absolute URL, so there is no `Location` header; a page follows a started
  run by `RunStartedJson.ref`;
- refs are confined to the served project.

## The routes

`{run}` is `{workflow}/{id}`, as `awf runs` prints it. A field that repeats is a repeated query
parameter (`?tool=Read&tool=Edit`). A body is a JSON object.

| Method and path | Fields | Command | Returns |
| --- | --- | --- | --- |
| `GET /api` | — | — | `ApiJson`: the routes and their fields, the engine's version, the project's path |
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

- An event to an existing run goes by its ref. An event that may start a run, as a webhook's first
  does, goes to `POST /api/events` with the workflow's `file` and the run's `id`, as
  `awf emit --target` takes them; that form checks `starts` and records the event that began the
  run. `POST /api/runs` starts an event run with no event, as `awf run --id` does.
- An agent is named in the body, not the path, because an agent in a child call has an address with
  a `/` in it (`review/lens-1`).
- `argv` is named as ADR 0016 names it: strings `prepare` parses, again at every attempt. A page
  can't send typed `args`: only `client().start` records those, since it holds the workflow's type.
- `workspace` takes `run` or a label. `origin` would mean wherever the server was started, so it is
  refused.

Not served, each with its reason in `NOT_SERVED`:

- `init` and `test` work on a folder of source: a developer's job, not a page's.
- `open` is a TUI, and `open -p` holds a harness for minutes on one request. A follow-up can start
  it and answer through the inbox.
- `run --here` takes over the terminal that typed it.
- `tick` is a scheduler's job, and `--all` spans projects on other engines.
- `serve` is the server itself.

`help` and `--version` aren't in `COMMANDS`; `GET /api` carries both.

**Status codes.** The status comes from the document, never the exit code, which means different
things in different commands: `wake` with nothing due exits 2, and `emit` exits 1 on a failed
launch and still prints its result. A document with no `code` is `200`, or `202` for a start that
is `ok`. A refusal answers its code's status, with the refusal as the body:

| Status | Codes |
| --- | --- |
| 400 | `usage`, `id`, `no-id`, `cursor`, `bad-request` |
| 401 | `unauthorized` |
| 403 | `forbidden-host`, `forbidden-origin`, `outside-project` |
| 404 | `no-run`, `no-session`, `no-participant`, `unknown-agent`, `not-found` |
| 405 | `method` |
| 409 | `ambiguous`, `other-args`, `live`, `opened`, `wake`, `park`, `not-started`, `project`, `no-engine`, `other-engine`, and the participant codes `ended`, `closed`, `expired`, `no-route`, `peer-stopped`, `unsupported-version` |
| 413 | `too-large` |
| 422 | `event`, `file`, `prepare` |
| 429 | `limit`, `inbox-full` |
| 500 | `internal-error` |
| 503 | `unreachable` |

- `unreachable` is 503 everywhere: whether a run's files are mid-write or a socket isn't up yet,
  trying again later is the right answer.
- The server's own refusals (`unauthorized`, `forbidden-*`, `bad-request`, `not-found`, `method`)
  have the same `{v, code, error}` shape, `v` being `ApiJson`'s.
- What a run decided is a value, as in the client: an event the run refused is a `200` whose
  `EmitResultJson` says so.

## Scope

In scope:

- `awf serve`: the server, its token, loopback only, the Host check and CORS.
- The route table with declared fields, `NOT_SERVED` and the status table, each checked complete at
  compile time; `GET /api` read off the table.
- SSE streams for logs and the inbox, resumable by `Last-Event-ID`.
- In the CLI: `awf run --detach`, `awf run {run} --continue`, `awf emit {run} {event}` for a
  workflow's own events, `final` on the run head and on each runs-list row, a `logs` wait that ends
  on its signal, and `--this-project` on every command that finds a run by ref.
- `agentswf/api`, a new entry built on the contract alone: the document types, the route table and
  the request types derived from it, so a browser project type-checks with no engine and no Bun
  types.
- A guide page on the site, written for the agent that builds the frontend.

Out of scope:

- Stopping a run and listing a project's workflow files. A page wants both on day one, but each
  needs a command first (`awf stop` is in [[run-in-background]]). The guide says so, and both todos
  move to the top.
- Reading a log backwards past its last page: `awf logs` pages forward only.
- Serving a frontend's files (`awf serve --ui {dir}`). The `/api` prefix leaves `/` free for it; it
  is a todo.
- Several folders behind one server: [[serve-several-projects]].
- Any address but the loopback, TLS and accounts. The server is local, as the control plane is
  (foundation §10, remote execution).
- An OpenAPI document, until M1 shows it can be made without hand upkeep.
- `--values` on `POST /api/runs`, which takes a file. A body would need `--values -` first.

## Context and evidence

Measured 2026-11-25 with a prototype `Bun.serve` that called `runOperatorCli` in process against
this repository's `.awf/runs`, nearly all of them ended:

- Fact: `GET /api/runs` in process answered in about 5 ms end to end; `awf runs --json` as a new
  process took 70–80 ms. Twenty concurrent requests finished in 33 ms with no errors.
- Fact: `runOperatorCli(argv, {cwd, home, stdout, stderr, signal, stdin, environment})`
  (`packages/engine/src/operator-cli.ts`) takes its I/O from what it is given, falling back to
  `console.log`, `process.*` and `Bun.stdin` only for a field left out, so the server passes every
  one. `takeLaunch` deletes `process.env.AWF_LAUNCH` on each call, a no-op after the first. The
  module-level state, the write queues in `jsonl.ts` and `run-lock.ts`, is safe under concurrent
  calls.
- Fact: reading a live attempt checks its process with a synchronous `Bun.spawnSync(["ps", …])`
  (`runs.ts`, via `probeProcess`). In process, that blocks the server once per live run read: M3.
- Fact: only `run` (`run-prepare.ts`) and `emit` (`--target` at `emit-command.ts:55`, the ref form
  at `emit.ts:134`) call `loadWorkflowFile`. Every command imports `workflow-loader.ts` through
  `refusals.ts`, so a test has to spy on the call, not the module graph.
- Fact: a missing run is `{"v":2,"code":"no-run",…}` on stdout. `emit` and `wake` exit 1 on
  `launch-failed` with a result document, not a refusal, and `wake` with nothing due is a `wake`
  refusal with exit 2. The status has to come from the document.
- Fact: `awf logs --follow --json` is refused ("--json takes --wait"). `--after {cursor} --wait 5s`
  on an ended run answers at once with no events and the same cursor. `--wait` waits only while the
  run is `running`, and `next` is absent on any run that isn't, a parked one included
  (`logs-command.ts`), so `next` can't tell a stream to end.
- Fact: `logsCommand` takes no signal and sleeps on its clock; `inboxCommand` takes `signal`.
- Fact: `reply` and `send` read their text from stdin when none follows `--`.
- Fact: run ids and workflow names match `^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$`, agent keys
  `^[a-z0-9][a-z0-9._@-]*$`; neither can begin with `-`. An agent's address in a child call joins
  keys with `/` (`inbox-command.ts`, `address()`).
- Fact: an event run, and a run `client().start` makes, start detached through `wake`, whose
  module-private `detachedLaunch` spawns `awf run {file} --id {id} --continue --run-root …` and
  passes nothing else. A plain run never runs detached.
- Fact: each attempt records its `file` in `attempts/{n}.json`. `run.json` has `file` only for event
  runs and runs started with `args`.
- Fact: `allowance` and `emit --target` refuse `--cwd` and `--run-root`. For `run` they set where
  the agents work and where the run is kept; an event run refuses both, and a continue whose `--cwd`
  differs from the recorded one is `other-args`.
- Fact: an event run, and a plain run of a workflow that gives `file`, are kept in
  `projectOf(file)`: the nearest directory at or above the file holding `.awf`, else the file's own
  (`projects.ts`, `run-prepare.ts`).
- Fact: hand-over goes by the process's directory, not `--cwd` (`hand-over.ts`). A child whose
  `AWF_ENGINE` is the realpath of its own `agentswf` folder skips it.
- Fact: srt denies reading the host home and the run root, and asserts it
  (`packages/sandbox/src/srt/profile.ts`).
- Fact: Bun's server closes a connection idle for 10 s by default (`idleTimeout`);
  `server.timeout(request, 0)` lifts it per request.
- Constraint: one engine per project (ADR 0015); one process can't load two.
- Assumption: a browser's `EventSource` can't send `Authorization`, so a stream also takes the token
  as `?token=`. A `fetch`-based reader can use the header.

## Code map

### `packages/contract`

- New `src/api.ts`: `ROUTES` as data, the field kinds, `STATUS`, `ApiJson`,
  `ApiRequest<Method, Path>`. Pure, as the contract is. A route names its command as a plain
  string; the engine checks it against `CommandName`.
- `src/records.ts`: `RunStartedJson`, `InboxPageJson`, `RunHeadJson.final`, `final` on each
  `RunsJson` row, `outside-project` in `REFUSAL_CODES`, the server's own codes.
- `src/wire.ts`: `PARTICIPANT_CODES` and `INBOX_CODES`, which `STATUS` must also cover.
- `package.json`: `./api` in `exports`.

### `packages/engine`

- `src/operator-cli.ts`: `runOperatorCli`, which every in-process route calls. Gains the `serve`
  handler and passes `signal` to `logsCommand`.
- `src/commands.ts`: `serve` joins "This machine" in `COMMANDS`.
- `src/run-command.ts`, `src/run-prepare.ts`: `--detach`, and `{run} --continue` by ref. With
  `--this-project`, a loaded workflow kept in `projectOf(file)` is refused `outside-project` when
  that project isn't the run root's (`rootProject`).
- `src/wake.ts`: `detachedLaunch` exported, taking the attempt's `--timeout`, `--from-stage` and
  file; the private `CLI` command line exported for `serve`. `--detach` and `client().start`
  (`src/client/runs.ts`) share make-and-launch.
- `src/emit-command.ts`, `src/emit.ts`: the ref form takes a workflow's own events, loading the last
  attempt's file as it does for a reply. `emitToRun` takes only `{key}:reply` today, with the
  reply's sender passed to `checkEvent`; it gains the operator as sender. `--target` gets the same
  `outside-project` check as `run`.
- `src/logs-command.ts`: the `--wait` sleeps end on the signal.
- `src/run-state.ts`: `findAnywhere` searches every known project after the run root; with
  `--this-project`, parsed by `parsePlace` and by `run`, it searches the run root only. Every lookup
  by ref goes through `findRunByRef`, so the flag covers them all.
- `src/run-state.ts`, `src/runs-command.ts`, `src/logs-command.ts`: `final`, from the rule
  `client().wait` already uses (`isFinal`).
- New `src/serve-command.ts` and `help/serve.txt`. It parses the flags, finds the served project
  with `projectOf` (refused as `project` in the home directory itself, as `projectOf` refuses
  there), makes `.awf` when missing, reads or makes the token, and hands the server the project, the
  token, the command line for this engine's `awf`, and the child environment, with `AWF_ENGINE` set
  to the realpath of this engine's `agentswf`.
- New `src/http/routes.ts`: each route's `where` (`process` or `child`), keyed by the contract's
  routes; `NOT_SERVED`; the check that the two cover `CommandName`.
- New `src/http/server.ts`: `Bun.serve`, the token, Host and CORS checks, dispatch and streams. It
  is given everything it needs and finds nothing itself.
- Tests: `src/http/routes.test.ts` (pure); `src/http/server.test.ts` against runs built with the
  helpers `runs-command.test.ts` and `logs-command.test.ts` use; `json-refusals.test.ts` gains the
  new forms.

### `packages/agentswf`

- New `src/api.ts`, published as `agentswf/api`, with `./api` in `exports`: re-exports
  `@agentswf/contract/api` and the document types from `@agentswf/contract/records`, and nothing
  else, so a frontend's `tsc` checks the contract's files only. `agentswf/client` won't do: its
  entry re-exports `engine/client`, which imports `node:os` and the commands, and since the package
  ships `.ts`, even `import type` type-checks all of it.

### `scripts/check-boundaries.ts`

- An eighth rule: `engine/src/http` does no run-directory I/O and imports nothing of the engine but
  its command entry points (`operator-cli`, `commands`), the contract and itself. A command that
  later grows a typed core its route calls amends the rule by name.

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

- `{run}` in a path is one `ref` field matched from two segments, and each kind formats its own
  word (`handle` as `@{handle}`), so `ApiRequest` has `run` and `handle` as plain fields.
- argv is built from the fields alone, as words, never a string a shell parses. Each value is
  checked against its kind first. Free text goes on stdin, so no text is ever read as a flag. A body
  field the route doesn't declare is a `bad-request`.
- The server adds `--json` before any `--`, and what the route's `place` says:
  - `"place"`: `runs`, `logs`, `inbox`, `reply`, `send`, `wake`, `park` and `emit` by ref.
  - `"project"`: `run` (start and continue) and `emit --target`. For `run`, `--cwd` and
    `--run-root` mean where the agents work and where the run is kept, and an event run refuses
    both; `emit --target` refuses them outright. So the child runs with the served project as its
    working directory instead, as `detachedLaunch` runs a woken attempt in the run's recorded cwd,
    and `--this-project` alone does the project check.
  - `"none"`: `allowance`.

  `place` is declared per route because one command can have forms that differ. A test runs each
  route's minimal request and fails on a `usage` refusal, which catches a wrong declaration.
- `ROUTES satisfies readonly Route[]`, in the contract. The engine's `routes.ts` gives each a
  `where`, and fails the build unless the commands in `ROUTES` and the keys of `NOT_SERVED` together
  cover `CommandName`.
- `STATUS satisfies Record<RefusalCode | ParticipantCode | InboxCode | ApiCode, number>`.
- `ApiRequest<"POST", "runs">` is derived from the table's `as const` fields, so the request types
  and `GET /api` can't drift from what the server accepts.
- A test spies on `loadWorkflowFile` and fails when a `process` route calls it.

### The server

- `awf serve [--port {n}] [--origin {url}]... [--new-token] [--json]`. The port is 7420 by default,
  and 0 picks one; a port in use is a usage refusal naming `--port`. It runs until interrupted, as a
  dev server does, and prints the URL and token once, or one `{v, url, token, project}` line with
  `--json`.
- It listens on `127.0.0.1` only and has no `--host`. The guide says to use `127.0.0.1` rather than
  `localhost`, which some clients resolve to `::1` first.
- **Token.** 32 random bytes with an `awf_` prefix, made once in `~/.awf/serve/token` with mode
  `0600` and kept across restarts, so a frontend's `.env` keeps working; `--new-token` replaces it.
  It is sent as `Authorization: Bearer {token}`, or as `?token=` on a stream request only, which is
  what `EventSource` can send. It is compared in constant time against the file, re-read when the
  file changes, so `--new-token` reaches every server running. Every response carries
  `Referrer-Policy: no-referrer`.
- **Host.** Only `127.0.0.1:{port}` and `localhost:{port}`; any other is `403 forbidden-host`. The
  guide's Vite proxy example sets `changeOrigin: true`, so a proxied request carries the server's
  host.
- **CORS.** An `Origin` of `http://localhost:{any}` or `http://127.0.0.1:{any}` is allowed, as is
  each `--origin`; any other is `403 forbidden-origin`. Preflight answers `OPTIONS`, allowing
  `Authorization`, `Content-Type` and `Last-Event-ID`.
- **In process.** `runOperatorCli(words, {cwd, home, environment, stdout, stderr, stdin, signal:
  request.signal})`. stdout is the document. stderr is dropped: it holds progress, and the sentence
  a refusal's `error` repeats.
- **The inbox page.** `awf inbox --json` prints one item per line, the one command that doesn't
  print one document. The route collects them into `InboxPageJson {v: 1, items, cursor?}`, where
  `cursor` is the last item's, or the `after` given when nothing is new. Items print only on
  success, so a page is all items or a refusal. This is the server's one change to a body, and it is
  defined in the contract beside `InboxItemJson`. A first read without `after` is the whole history,
  as the command gives it. `open` is a snapshot with no cursors, so `open` on a stream is a `400`,
  as the CLI refuses `--open` with `--wait`.
- **Child.** `Bun.spawn([...awfCommand, …words])` with the command line and environment `serve`
  hands it; `AWF_ENGINE` means the child never hands over. An aborted request kills a running
  `emit` child. A `--detach` child is never killed: it may be making or launching the run, and a run
  left with no attempt under a generated id would be made again by a retry. Only its response is
  dropped.
- A thrown error is `500 internal-error`, and the server goes on.

### Streams

- **Pages, for logs.** Loop on `logs {run} --json --after {cursor} --wait 30s`. A page with events
  goes out as a default SSE message (`data:` the `LogsJson`, `id:` its cursor), so
  `EventSource.onmessage` gets it. The stream starts from `Last-Event-ID`, else `?after`, else the
  last page as the plain GET returns it. It ends with `event: end` once the head says `final` and
  the page has no `more.newer`, so a reconnect to an ended run still gets every page after its
  cursor first. While the run is neither running nor final, the loop sleeps 2 s between reads,
  since `--wait` returns at once then.
- A failed plain run is final, so after `POST …/attempts` the page opens a new stream; the guide
  says so.
- **Items, for the inbox.** The same loop over `inbox … --after {cursor} --wait 30s`, one message
  per item, each with its cursor as `id`. It never ends on its own: the project's inbox outlives any
  one run, and a page following one run closes that run's inbox stream when its log stream ends.
- A browser holds six HTTP/1.1 connections per origin, and more open streams stall a page's plain
  requests. So a page follows one run's log and the inbox, and polls `GET /api/runs` for the rest;
  the guide says so.
- A comment line every 15 s keeps proxies open, and `server.timeout(request, 0)` lifts Bun's idle
  limit for the stream alone.
- Each subscriber runs its own loop. Ten open streams cost ten pollers, which is fine on one
  machine; sharing one per run waits until it is measured as needed.

### `awf run --detach`

- `awf run {file} --detach [--id {id}] [run options] [-- argv]` loads the workflow and runs
  `prepare` on the argv in this process, so a refusal (`file`, `prepare`, `no-id`, `id`,
  `other-args`) is said here, exit 2. It then makes and records the run as `awf run` would, and
  launches the first attempt detached in its project through `detachedLaunch`, with that attempt's
  `--timeout` and `--from-stage`.
- It prints `RunStartedJson {v: 1, ok, ref, dir, did, error?}`. `did` is `started` (a new run),
  `exists` (an event run already there, woken), `continued` (a next attempt), or, with `ok: false`,
  `launch-failed` or `stuck`: the words `StartResult` uses for the same outcomes. It is a document,
  not a refusal, because the run is kept and the page needs its `ref` to follow or retry it. Exit 0
  when `ok`, 1 otherwise, as `emit` exits on a failed launch.
- A retry is `POST …/attempts`. `--detach` records `file` in `run.json`, as a run started with
  `args` does, because a failed launch leaves no attempt to read the file from.
- `prepare` runs twice: here to check, and in the attempt, as ADR 0016 has every attempt do. The
  help says so, for a `prepare` with side effects.
- **Continue by ref.** With `--continue` and no `--id`, the word is a run: `{workflow}/{id}`, or an
  `{id}` only one workflow has, as `awf reply` takes it, continued from its last attempt's file.
  With `--id`, the word is a file, as today. Whether the word exists as a path never decides it,
  since `w/id` is a valid relative path. It works without `--detach` too.
- The attempt has no terminal: a coordinator's questions go to the inbox only, as for an event run,
  and its progress is in `awf logs`.
- `--detach` with `--here` or `--workspace origin` is refused. A workflow with events already
  starts detached; for it `--detach` only makes `awf run` print `RunStartedJson`.
- [[run-in-background]]'s `--bg` becomes `--detach` plus its progress tab and caller fork, not a
  second flag.

Alternatives rejected:

- **One endpoint that runs any argv** (`POST /api/commands/{name}` with `{argv}`): complete by
  construction, but a page would build flag strings and parse exit codes, and every flag becomes
  HTTP surface.
- **Handwritten handlers over the engine's functions** (`viewRun`, `listRunEntries`): the commands'
  parsing, defaults and refusals would be copied and drift. The argv between table and command is
  internal, so a command can later expose a typed core for its route with nothing visible changing.
- **Fields as code**, each route an `argv(request)` function: quicker to write, but `GET /api`
  couldn't list fields, no request type could be exported, and every flag would be mapped by hand
  twice.
- **Build on `agentswf/client`**: the client holds the workflow value it starts, so the server would
  import workflow files, and the client has no runs list and no logs.
- **Every route as a child `awf`**: simplest, but 75 ms per poll and one process per open stream.
- **`inbox --json` changed to print one document**: it breaks the line-per-item stream its `--wait`
  readers rely on, to save one bounded collecting step.
- **WebSockets**: nothing here is two-way on one connection. SSE reconnects and resumes by itself,
  needs no library and passes through proxies.
- **A token per start**: a little safer, and it breaks every frontend's `.env` at each restart.
- **No token, Origin and Host checks only**: stops other sites, but not another user on the machine
  or a process that isn't the operator's.

## To measure

- M1. Whether a generator such as `ts-json-schema-generator` makes JSON Schemas from the document
  types in `contract/src/records.ts` unchanged. If it does, `GET /api/openapi.json` is a follow-up
  with no upkeep. Not yet run.
- M2. Whether an agent builds a working page from the guide page and `GET /api` alone. See
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

- Q1. **No version in the URL** (2026-11-26): routes are `/api/…`. Each body carries its
  document's `v`, as the CLI's does, and the routes change with the package, as the commands do.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. The CLI learns what a page needs

Outcome: from the CLI, a run of any workflow starts or continues in the background and says where
it is. A run is continued, or sent one of its workflow's events, by its ref alone, and its head says
whether anything will go on by itself. `--this-project` keeps any command to the project it is
given.

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
- `final` is true for a completed run and false for a parked event run, in the list, in
  `runs {run}` and in `logs`.
- `awf run {workflow}/{id} --continue` continues a run started from another directory, and
  `awf run w/id --id x --continue` still reads `w/id` as a file.
- `awf runs {ref} --this-project` is `no-run` for a run only another project has, which
  `awf runs {ref}` finds. `awf run {file} --this-project` and `awf emit --target {file}
  --this-project` are `outside-project` for an event workflow in a subfolder with its own `.awf`,
  while a plain workflow there that doesn't give `file` runs. `awf run {run} --continue
  --this-project` is `no-run` for another project's run.
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
  command prints. A missing token is 401, and a wrong `Host` or `Origin` is 403. A preflight from
  `localhost:5173` passes. A missing run is 404 with the command's refusal. A file or sandbox spec
  outside the project, by symlink included, is 403. A `wake` with nothing due is 409.
- `POST /api/runs` on a fake launch answers 202 with `RunStartedJson`, and no response carries an
  absolute URL.
- `GET /api/runs/{ref}` for a run only another project has is 404, though `awf runs {ref}` without
  `--this-project` finds it.
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
- A completed run's stream ends with `end`, and a reconnect from an old cursor gets every later page
  before `end`. A parked run's stream stays open past 30 s, which also proves the idle limit lifted.
- `open` with `Accept: text/event-stream` is a 400.
- An aborted request ends its `logs` wait within one poll: the test's clock sees no further sleep.
- An inbox stream gets a question as it is asked, and the answer after `POST …/replies`.

### 4. Types, guide, help, changelog, status

Outcome: an agent given the guide page builds a frontend without reading awf's source.

Execution:

- [ ] Plan: settle the guide's outline and the typecheck fixture.
- [ ] Implement: the work below.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Work:

- `agentswf/api`, with a typecheck file under a DOM-only tsconfig without Bun types that imports it,
  as a Vite frontend would.
- `site/guide/http.md`, under the site's writing rules: starting the server, the token, a curl for
  each kind of route, a stream in ten lines of browser code, the Vite proxy, the status table, the
  six-connection limit, and what isn't there yet (stop, workflow list). Written to be pasted into
  an agent's prompt.
- CHANGELOG under Unreleased; `docs/status.md`; [[run-in-background]] built on `--detach`; todos
  for `awf serve --ui`, listing workflow files, and `open -p` over HTTP.

Done when:

- `bun run check` passes and the site builds.
- M2 has been run once and its findings fixed in the guide or the API.

## Verification

Automated:

- [ ] `src/http/routes.test.ts`, `src/http/server.test.ts`, the task 1 tests
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] M2, the outcome itself. Give a fresh codex agent on a cheap model, in an empty folder, only
  `site/guide/http.md` and the output of `GET /api`. Ask for one HTML file that lists the runs,
  follows one's log live and answers an open question. Run it against `examples/quick-check` and a
  workflow with a coordinator. Record what it got wrong and fix the guide or the API, not the
  agent's page. Cost: one codex session and two cheap runs.
- [ ] M3, with five live runs.

## Review record

### Refinement, 2026-11-25 to 2026-11-26

Eight rounds of fresh read-only subagents, design and facts against the code; the last found no
blocking issues. What changed the design:

- **Seam.** Fields declared, not coded; argv between table and command kept internal; status read
  from the document, not the exit code; `unreachable` kept one 503, as a retry is right for all of
  it.
- **CLI first.** Continue and emit by ref, not by a page-supplied file; `--detach` passing the
  attempt's flags and recording `file` in `run.json` for a retry; `RunStartedJson` a document with
  the client's outcome words, not new refusal codes; continue-by-ref grammar settled by `--id`;
  `final` on the head and each list row, since a missing `next` can't end a stream.
- **Projects.** `serve` takes no `--cwd`, as hand-over goes by the shell's directory; the served
  project is `projectOf`'s, made when missing; `--this-project` confines refs, and `run` and
  `emit --target` refuse a workflow kept in another project, so the operator gets the check too;
  `place` three-valued per route and checked by a test.
- **Routes.** Agents named in the body, since an address holds `/`; `POST /api/events` for an event
  that may start a run; `workspace: origin` refused; `tick`, `open -p` and `serve` not served.
- **Prefix readiness** (several folders weighed both ways): an opaque base URL, relative paths, no
  `Location` header and no absolute URL.
- **Browser.** Published types in a pure `agentswf/api`, as `agentswf/client` drags the engine into a
  browser's type check; `?token=` on streams only, with `Referrer-Policy`; realpath confinement of
  the file and sandbox spec; Bun's idle timeout lifted per stream; one log stream plus the inbox per
  page, for the six-connection limit; a `--detach` child never killed on abort.

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
