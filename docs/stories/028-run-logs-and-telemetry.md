---
id: "028"
title: An agent sees what a run is doing, from the command line
summary: "`awf runs` and `awf logs` read a running or finished run as bounded, structured output with a cursor, so an agent can watch another agent's run; the run's events are span-shaped, ready for the OTel export in story 030."
type: story
status: draft
priority: P1
epic: observability
discovered_in: "implement-ticket flow.ts live runs, AIRS-1515, 2026-10-02"
depends_on: ["018", "021"]
---

# An agent sees what a run is doing, from the command line

Direction settled 2026-10-11. Reviewed the same day in several rounds of subagents (architecture, the
record against the code, the CLI for an agent, OTel, then design and consistency), whose findings
are folded into "Decisions" and "Found in review"; the code map and tasks follow them.

## Outcome

An agent that started a run, or is asked about one, can find out from the command line what the
run is doing and what each of its agents is doing. It learns which stage the run is in, which
agents are working and on what, what changed since it last looked, and why something stopped. It
gets this without grepping `~/.claude/projects` or `~/.codex/sessions` and without reading the
progress block meant for a person. An operator gets the same view, rendered for a terminal.

Why now: during the first live implement-ticket run, the only view was the progress block and the
workflow's log lines.

- To see what headless codex was doing in review round 3, someone had to find the run, read the
  call dir for the prompt, and grep for codex's rollout file by the session id from the process
  list.
- To see why the worker stopped, someone had to find and read its claude session file the same way.
- The calling session in the review workflow (story 027) waits on `awf run` and sees nothing until
  the run ends.

**The reader is an agent first.** That changes what "good" means compared with `docker compose
logs`:

- **Bounded.** A default that fits in a tool result. A long run never floods the context.
- **Structured.** `--json` gives one document per call, with stable fields. Text is a rendering of
  the same events, not a second format.
- **Incremental.** Every answer carries a cursor, and `--after {cursor}` returns only what is new.
  An agent polls cheaply instead of rereading the run.
- **Waits without blocking forever.** `-f` is a person's feature. An agent needs "return when
  something new happens or after N seconds", so a single tool call can wait.
- **Findable.** `awf run` names the run before any agent starts, so the agent that started it can
  attach; others find it in a list.

Words used below:

- **Attempt:** one `awf run` of a run; `--continue` adds another.
- **Operation:** one thing delivered to an agent: a turn, with its nudges, or a compaction, with
  its `operationId`.
- **Check-in:** an agent saying it is still waiting on something (`wf waiting`), within its
  operation's deadline (story 021).
- **Calling session:** the agent session that started `awf run` (ADR 0010, story 027).
- **Call path:** where a workflow sits when one workflow calls another. `workflow.call` is not
  built, so today it is always empty.

## What exists today

Checked 2026-10-10.

- **No persisted event log.** `RunProgress` (`engine/src/run-progress.ts`) is in memory. On disk:
  - `turns.jsonl` has one line per turn that settled without throwing (a turn that throws is never
    written), with no start event and no spend;
  - each call's `liveness.jsonl` is bounded and labelled "optional diagnostics";
  - `stages/{stage}.json` is written when a stage ends;
  - `output.json` holds per-turn spend in `usage[].spend` and per-stage cost in
    `accounting.byStage`, but only after the run ends.
- **Workflow `log` lines go only to stderr** (`progress-view.ts`) and are lost once the run ends.
- **No read command.** The operator CLI has `run`, `test`, `allowance` and `--version`. `wf` has
  only `wf result` and `wf waiting`, both of them writes. `awf run --json` prints the
  `OutputRecord` only at the end. Nothing reads with an offset or cursor.
- **Native sessions are known by id, not path.** `NativeSessionRef {harness, id}` is on turns and
  usage; a stage keeps `{agent, harness, session}`. A headless agent's id is learnt only when its
  process exits (`direct-process.ts:229-235`) for claude and codex (awf chooses pi's id at launch), so
  nothing can find their files during their first turn.
  `HarnessSpec.sessionFiles(home, session, cwd)` resolves the files for all four harnesses, but only
  fork uses it.
- **Usage is read once, after the host closes** (`run-usage.ts`). Nothing reads it live.
- **No OTel anywhere**, not even a dependency.
- **Finding a run.** The run dir is `{cwd}/.awf/runs/{workflow}/{id}`. A generated id sorts by time
  (`YYYYMMDD-HHMM-xxxx`), but `--id` takes any id. `run.json` records `created`. No variable or
  command names "the latest run" or "my run".

## What others do

From the clones in `~/dev/ref-repos`, read 2026-10-10. Paths are relative to each repo.

| | Own record | OTel | Logs command | Agent activity from |
| --- | --- | --- | --- | --- |
| Archon | `logs/{runId}.jsonl` + DB events | none | `workflow logs --follow --format jsonl\|text`, by byte offset, ends when the run does | SDK stream events, wrapped as-is in `{attemptId, seq, observedAt, event}` |
| Smithers | SQLite journal, deduped by source seq | export, GenAI names; deterministic trace id per run so a resume stays in one trace | `runs logs --after N --limit --follow`, prints a "continue from" hint | in-process model calls |
| Conductor | event pub/sub → `events.jsonl` | optional export: `invoke_workflow`/`invoke_agent`/`execute_tool`; passes `TRACEPARENT` so vendor spans nest | `replay` of the events file, a fleet TUI | SDK events |
| Bernstein | hash-chained `journal.jsonl` | a projection of the journal, off unless an endpoint is set | `logs tail -f`, newest file only, no interleaving | claude `stream-json` through a wrapper that writes a log, usage sidecar and heartbeat |
| pi-crew | `events.jsonl` per run + per agent | metrics only, a hand-written exporter | inline transcript pane, read from disk | child `pi` JSON stream |
| odw (xz1220) | `events.jsonl`, `status.json` | none | `logs --follow`, SSE dashboard | also reads Claude Code's own workflow journals |
| agent-orchestrator | SQLite + change log → SSE | none | — | claude/codex hooks; stores the hook's `transcript_path` |

What they agree on:

- **The engine's own record is the truth, and OTel is at most an export of it.** Conductor,
  Smithers and Bernstein install no exporter at all when no endpoint is set, and never let it fail
  a run.
- **A cursor beats a tail.** Archon and Smithers read by offset or sequence number, render only
  whole lines, and stop when the run is terminal. Bernstein's newest-file tail is the one to avoid.
- **Vendor events are kept as they came**, with engine fields beside them (Archon).
- **Each row carries only its own spend**, and roll-ups say they are roll-ups (Archon).

Nobody built what awf needs most: a reader meant for another agent. All of the logs commands are
for a person at a terminal.

## What the harnesses export

From official docs and the codex and pi sources, 2026-10-10.

| Harness | OTel export | Per-request usage | Tool calls | Lag and loss | Takes `TRACEPARENT` |
| --- | --- | --- | --- | --- | --- |
| claude | logs and metrics; traces in beta (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`); OTLP or console, no file | `claude_code.api_request`, with `prompt.id` and `session.id` | `tool_result`/`tool_decision`; arguments only with `OTEL_LOG_TOOL_DETAILS=1` | batched every 5 s for logs and traces, 60 s for metrics; lost on kill; silent on failure | `-p` only, not in a pane |
| codex | `[otel]` logs, traces and metrics; OTLP only. **Metrics default to Statsig** | `codex.sse_event` with completed usage, `codex.turn_cost` | `codex.tool_result`, with arguments in the log copy by default | batched; loss on kill not measured | `codex exec` only, not the TUI |
| pi | nothing. `packages/telemetry` is a span contract with a conformance kit and no exporter | — | — | — | — |
| cursor | enterprise, server-side, team-wide; no traces | yes, server-side | counts only | about a minute | no |

GenAI semantic conventions now live in their own repo, and all of it is still at "Development".
`invoke_workflow` fits an attempt and `invoke_agent` fits a turn. `@opentelemetry/*` does not list Bun
as a supported runtime. A dependency-free writer for OTLP JSON is small: hex ids, nanosecond
timestamps as strings, and a `fetch` to `/v1/traces`.

So harness OTel is a **live activity feed** for claude and codex only. It cannot be the source of
truth for usage, and in a pane it cannot nest under awf's trace. The session files cover all four
harnesses in both placements; cursor in a pane is the exception, and it writes no usage.

## Decisions

Settled with the operator on 2026-10-11, then revised in review the same day.

### Q1. The run's record: `turns.jsonl` grows into the run's event log

No second recorder. `turns.jsonl` is already a stream of events with a `kind` (`"turn" |
"compact"`), and it keeps its name. It gains the kinds that are not on disk today:

| Kind                               | Carries                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attempt-started`, `attempt-ended` | the attempt; its outcome at the end                                                                                                                                                                                                                                                       |
| `stage-started`, `stage-ended`     | the stage; its outcome at the end. A reused stage writes only `stage-ended`, with `source: "reused"`, and a provided one with `source: "provided"`                                                                                                                                        |
| `operation-started`                | written at delivery: the turn line's fields (`TURN_OPERATION_FIELDS`) but `settledAt`, `of: "turn"` or `"compact"`, and the call path; its `sessions` name the native session if it is known                                                                                              |
| `turn`, `compact`                  | the operation's end, as today, plus the call path                                                                                                                                                                                                                                         |
| `operation-failed`                 | the turn line's fields, `of`, the call path, and the error                                                                                                                                                                                                                                |
| `session-known`                    | the native session, when it is learnt late, with what it belongs to: the `operationId` for a headless codex turn, from `thread.started`; the agent for a fork, once the fork resolves                                                                                                     |
| `agent-opened`, `agent-stopped`    | the agent key, call path and harness; `caller: true` for the calling session. `agent-opened` also has the agent's home and working directory, under which a sandboxed agent's native files are found                                                                                      |
| `agent-forked`                     | the agent; `from`, the agent it was copied from, which is the calling session's key whenever its parent is the calling session, or `null` if the run never opened the calling session; and `after`, the `operationId` it was copied after, `null` when its parent ran nothing in this run |
| `log`, `warning`                   | the text, a log line's fields, and the stage it came from                                                                                                                                                                                                                                 |
| `decision-asked`, `decision-ended` | `decision`, its number in the order asked within the attempt, and the stage; when asked, its key, alias, provider and resolved model; at the end its outcome (`answered`, `failed`, `timed-out`, `cancelled`) and the error when it did not answer                                        |

`awf logs` also publishes `activity`, read from native files, which is never written to the log.

- An operation starts when it is delivered, so the span's start is `deliveredAt`. The native session
  on `operation-started`, or on a later `session-known`, is what lets a reader find a headless
  agent's file during its first turn.
- An operation can fail before it is delivered, so an `operation-failed` may have no
  `operation-started` before it.
- `--json` publishes these kinds under the same names. `turn` and `compact` stay the end of an
  operation, so a turn line is not renamed and readers of today's lines keep working.
- The call path is a new field on turn lines too; `TURN_OPERATION_FIELDS` (`records.ts:375-384`)
  leaves it out today.

**Observation, never continuation authority.** `--continue` still reads only `run.json`, the
attempt files and the stage files ([[0011-a-run-continues-from-its-stages]]). Where the event log
and those files disagree, the files win. The log adds no journal.

**How lines are read and versioned:**

- A new `readEvents` reads every kind, and `readTurns` becomes `readEvents` kept to `turn` and
  `compact` lines, so `run-prepare.ts` and the tests that read it see what they see today.
- Turn lines stay at version 1 and gain the call path as an optional field. Each new kind has its
  own version, and every reader skips the kinds it does not know. The line is a discriminated union
  in `contract/records`, with one guard that every reader uses.
- A line that does not parse is skipped, never fatal. A torn last line, once the next attempt
  closes it, is such a line.
- An older awf continuing a run written by this one reads every line as a turn, and its
  "interrupted in {stage}" may come out wrong. One awf is installed per machine, so this is
  accepted, not guarded.
- A line's position is its line number in the file. Lines are only appended, so it never changes,
  and no sequence number is stored.

**Span-shaped, with no ids stored.** Each event records its kind, its time and the
keys that place it: the attempt, the stage, the `operationId`, the decision. A start and its end
carry the same keys. The tree is read off those keys, so no span id is written ("nothing that can
be read off them is stored", ADR 0011), and none is published in `--json`. The `operationId` is a
random UUID, drawn once and recorded; 030 hashes its own span ids from the keys.

| Span | Parent | Key |
| --- | --- | --- |
| attempt | none | attempt number |
| stage | attempt | stage name |
| operation | stage, or attempt | `operationId` |
| decision | stage, or attempt | `decision` |

- **The run is not a span.** Any run can be continued again (ADR 0011), so it never has an end.
  A run is the attempts that share its id.
- **An agent is not a span.** It outlives its stages, so it is an attribute on each operation
  (agent key and call path), and agent opened and stopped are point events.
- **A nested call is not a span** until `workflow.call` is built; the call path is an attribute.
- **A fork is a link** from its first operation to the operation in `after`, not a parent; with no
  `after`, no link.
- **A parallel group has no span.** Its operations overlap in time under the same parent.
- **The calling session's operations** ([[0010-the-calling-session-is-an-agent]]) are marked as the
  caller's, by `caller: true` on its `agent-opened`. A fork of the calling session is not the
  caller: it is an agent the run opened, as the code already treats it, and its `from` says where
  it came from.
- **Log lines and warnings** are point events under the stage they came from, or the attempt.

What stays where it is:

- **`stages/{stage}.json`** holds the stage's result, which `--continue` reuses.
- **Each call's `liveness.jsonl`** keeps every check-in and phase change. `awf runs {ref}` reads only
  the latest phase from it, and `awf logs` does not merge it.

### Q2. What an agent is doing: its native session files, translated on read

A reader per harness in `harness`, beside the usage readers, turns native rows into one activity
shape: message, tool call and its outcome, background task, compaction. The shape is a type in
`contract/records`, because `awf logs --json` publishes it. A reader runs when `awf logs` is called,
reads from a byte offset, and stops at the last complete line. Nothing runs in the background and
nothing is copied into the run dir.

**Only the run's own activity.**

- For an agent the run opened, a reader shows rows from its first delivery, or its fork point, to
  its stop. Rows between operations are the run's too: a pane agent that goes on editing after
  `wf result`, a background task that outlives its turn. They carry `operation: null`.
- A fork's rows start at the fork point; its file begins with the history it copied.
- The calling session ([[0010-the-calling-session-is-an-agent]]) shows only rows inside the run's
  operations: the rest of its file is the operator's own conversation. Anything the operator types
  during a turn the run drives is inside that window and is shown. Spend's window is wider: ADR 0010
  counts from the run's first prompt to the end of its work.

**Common credential shapes are masked, best-effort.** Tool arguments come from command lines,
which can hold tokens. Every reader masks values shaped like credentials (`Authorization:`
headers, `*_KEY=`, `*_TOKEN=`, bearer and API-key patterns) in everything `awf logs` prints. That
is not a guarantee: the real protection is the cut at about 120 characters. `--full` prints the
native text with only that masking, and says so in its first line.

**A headless agent's session is known from launch.** Today a headless claude or codex agent's id
is learnt only when its process exits, so its first turn, the usual reviewer's only turn, could not
be read while it runs. This story fixes that:

- claude: the first headless turn passes `--session-id {uuid}`, as `forkSession` already does
  (`harness/src/harnesses/claude.ts:138-146`) and as pi's adapter does at launch
  (`harnesses/pi.ts:36-48`);
- codex: its `thread.started` line is read from stdout as it streams (`harnesses/codex.ts:105-106`), not
  after exit (`direct-process.ts:231`).

Coverage, per harness:

| Harness | Pane | Headless |
| --- | --- | --- |
| claude | live, including subagent files | live |
| codex | live, following its fork chain | live |
| pi | live | live |
| cursor | nothing | at the end of each turn, from awf's usage sidecar; its `store.db` cannot be read from an offset |

There are no links in the run dir. `awf runs {ref} --json` lists each agent's native files,
resolved when read through `HarnessSpec.sessionFiles` against the agent's home and working
directory: for a sandboxed agent, its sandbox home and its working directory inside the sandbox.

Harness OTel ingest is not taken: it covers claude and codex only, lags, and loses its buffer on
kill.

### Q3. Two commands: `awf runs` and `awf logs`

**`awf run` names the run before any agent starts.**

- In a terminal, the progress block's header gains the run's reference, so it is stated once.
- When stderr is not a terminal, as when an agent runs it, the first line is:

  ```text
  awf: review/20261011-0912-4c1e started · watch: awf logs review/20261011-0912-4c1e --wait 90
  ```

  The reference there is always `{workflow}/{id}`, never a path, and `watch:` repeats `--cwd` and
  `--run-root` when `awf run` was given them.

- Under `--here`, the run's stderr is in a Herdr tab the calling agent cannot see, so the command
  in the calling session prints that line itself. The id is chosen before the tab opens. `--bg`
  ([[run-in-background]]) will do the same.

The prefix `awf: {workflow}/{id} started` is stable, since it is the one machine route to the
reference. What follows it is a hint for a reader and may change. That
line is how the session that started a run knows which one is its own. A variable cannot flow
back to its parent shell, and "latest" is wrong as soon as two runs overlap.

**A run reference** is `{workflow}/{id}`, or a bare `{id}` when only one workflow here has it. A
path is not taken: `review/20261011-0912-4c1e` would read as both. Both commands take `--cwd` and `--run-root` as `awf run` does. `awf run {ref}`,
where `{ref}` is not a file but names a run, answers `did you mean: awf runs {ref}`.

**With no run named,** the commands take the run with the newest `created` in `run.json` under the
run root, across workflows. If several runs are still going, they answer for that one and add
`note: 2 runs running; also review/20261011-0915-aa01`, and the JSON says `ambiguous: true`. The
first line of every answer names the run it is about.

**A run's state** is read from `run.json` and its attempt files, never from the event log, so a run
written by an older awf still lists. It is one of:

- `running`: its last attempt is open, and its process is alive;
- `interrupted`: its last attempt is open, but its process is gone, the word `run-prepare.ts`
  already uses;
- an ended attempt's outcome: `completed`, `stopped`, `failed`, `timed-out` or `cancelled`.

The process check is the one `claimAttempt` already makes (`isLive`, `runs.ts:228`, called from
`attemptRefusal` at `:261`, which `claimAttempt` calls at `:314`), so `awf runs` and `--continue` never disagree about a run. It runs `ps` on the reader's
machine (`runs.ts:562-564`), which today answers the same for "gone" and "`ps` failed". The probe
becomes three-valued: alive, gone, unknown. Unknown, as in a sandbox that blocks `ps`, shows as
`running (unchecked, last event {time})`, and `--wait` keeps waiting until its timeout.

A stage shows as `running`, `reused` from an earlier attempt, or its recorded outcome: `succeeded`,
`stopped` or `failed`.

**The commands:**

- `awf runs [--all] [--cwd {dir}] [--run-root {dir}] [--json]` lists the newest 20 runs here by
  `created`: reference, state, start, duration, and cost once known. It ends with
  `… 57 older (--all)` when there are more. Listing reads one `run.json` and one attempt file per
  run, which is fine at the scale of a project's runs.
- `awf runs {ref} [--cwd {dir}] [--run-root {dir}] [--json]` is one run in depth: its attempts, the
  stages of the last one, each agent's phase and last activity, the outcome, the spend once known,
  and each agent's native files in `--json`.
- `awf logs [{ref}] [@{handle}] [--agent {key}] [--stage {name}] [--after {cursor}] [--limit N] [--wait {s} | --follow] [--full] [--cwd {dir}] [--run-root {dir}] [--json]`.

**Bounds.**

- With no `--after`, `awf logs` shows the run's header line and the last 40 events.
- With `--after`, it pages forward, oldest first, from the cursor. When the page fills before the
  newest event, the cursor marks the page's end, `more.newer` is true, and `next` leaves out
  `--wait`, so nothing is skipped.
- An argument is cut at about 120 characters with `…`.
- The header says what was left out: `(showing 40 of 812; raise --limit for more)`.
- Each line starts with a handle, such as `@e217` or `@a3.1f4c`, that names its source and its
  place in that source, so it never shifts between reads. `awf logs {ref} @a3.1f4c --full` prints
  that one event's text. A handle's encoding is opaque. In text, `@` is a prefix that needs no
  quoting in a shell; the JSON handle has no `@`.
- Within one read, lines from the event log and the native files are merged by time. A native line
  written late can arrive in a later read with an earlier time than lines already shown.
- A native file is named by its session and its place in that session, never by directory listing
  or time. Sessions are numbered by their line in the event log, from the `operation-started` and
  `session-known` lines. Within a session, a file is keyed by
  what its content says: a claude subagent file by the subagent id its parent transcript names, a
  codex file by its place in the fork chain. A late file therefore never renumbers the others.

M2 settles the numbers.

**Trailers.** Every answer of `awf logs` and `awf runs {ref}` ends with what to do next. The list
ends with `… {n} older (--all)` when there are more, and `--full` with nothing.

| Command | Run state | Trailer |
| --- | --- | --- |
| `awf logs` | running, new events | `next: awf logs {ref} --after {cursor} --wait 90` |
| `awf logs` | running, nothing new | `nothing new in {s}s · running, stage {stage} · next: …` |
| `awf logs` | ended | `run ended: {outcome} in {duration} · result: awf runs {ref}` |
| `awf logs` | interrupted | `run interrupted · continue: {the continue command}` |
| `awf runs {ref}` | running | `next: awf logs {ref} --after {cursor} --wait 90` |
| `awf runs {ref}` | ended | `records: {run dir} (report.md, output.json)`, then `see: awf logs {ref} …` when it failed |
| `awf runs {ref}` | interrupted | `continue: {the continue command}` |

`next` repeats `--agent`, `--stage`, `--cwd` and `--run-root` as given. The continue command is the line
`continueCommand` already prints (`attempt-view.ts:307-342`). It takes a whole `RunCommand`, so the
reader rebuilds one from `run.json` (`argv`, `cwd`) and the last attempt's `file` and
`flags.fromStage`, with no stop. Once a run has ended there is no `next`, which would invite more polling.

**The cursor is opaque.** It holds the event log's position and a byte offset for each native file
read, and never moves past a torn last line. Files are named by their index among the run's
sessions, which keeps the token short: a few hundred bytes for eight agents. It is versioned, and
callers copy it back and never compute it. Text and `--json` carry the same cursor and the same
`next`.

**`--wait {s}`** returns on the first new event, about a second after it so a burst comes back as
one page, or at the timeout. The default is 0, the maximum 300. The skill teaches `--wait 90`,
which fits claude's two-minute command default. It bounds one read; waiting for a run to end is
`awf wait`'s ([[run-in-background]]). `--follow` is the same read in a loop, for a person, and
prints a line per event; `--follow --json` is a usage error.

**Exit codes.** Claude Code shows a non-zero exit as an error, which agents tend to retry.

- 0: any read that worked, whether it found new events, nothing new, a run that has ended, or no
  runs here at all.
  What happened is in the trailer and the JSON.
- 1: no such run, or a cursor or handle that does not fit the run.
- 2: a usage error.
- 3: the run's files could not be read.

Neither command reports the run's outcome in its exit code.

**JSON.** One document per call:

```json
{
  "v": 1,
  "run": { "ref": "review/20261011-0912-4c1e", "state": "running", "checked": true, "stage": "fix", "ambiguous": false },
  "events": [
    { "handle": "a3.1e02", "at": "2026-10-11T09:26:31.402Z", "kind": "activity",
      "operation": "…", "agent": "fixer", "stage": "fix", "activity": { "type": "tool", "tool": "Bash", "exit": 0 } },
    { "handle": "e216", "at": "2026-10-11T09:27:02.004Z", "kind": "turn",
      "operation": "…", "agent": "fixer", "stage": "fix", "outcome": "answered" }
  ],
  "cursor": "c1.…",
  "more": { "older": true },
  "next": ["awf", "logs", "review/20261011-0912-4c1e", "--after", "c1.…", "--wait", "90"]
}
```

- Every event names the keys that place it: the stage, the agent, and the `operation` it belongs
  to, `null` for activity between operations. The published kinds are the table's, plus
  `activity`.
- `run.state` is one of `running`, `interrupted`, `completed`, `stopped`, `failed`, `timed-out`,
  `cancelled`; `checked: false` marks a `running` whose process could not be probed.
- `more.older` says events before this page exist; `more.newer`, that the page stopped before the
  newest event.
- A reader ignores kinds and fields it does not know. `v` changes only when something is renamed or
  removed.
- Once the run has ended, `next` is absent and `run` gains `duration`; `run.state` is the outcome.
- Times are always ISO.
- In `awf runs {ref} --json`, best-effort fields sit under `live: {phase, lastActivity, observedAt}`,
  so the split between durable and best-effort is in the structure.
- The envelope's types live in `contract/records`.

**The skill.** `awf-run` gains a few lines:

- The run prints `watch: awf logs {ref} --wait 90` first. Run it in the foreground to see what the
  run is doing.
- Each answer ends with what to do next; run exactly the `next:` command to get only what is new.
  Stop at `run ended`.
- Under claude, `run_in_background` already reports the end, so check in, don't poll in a loop.
- Name your own run by its printed reference, never by "latest".
- Use `--agent {key}` to follow one agent, and `--full` only on one handle.

Reads through `wf` from inside a run are out of scope: an agent knowing about its peers belongs to
messaging.

### Q4. OTel export: story 030

The export, meaning the translation to OTLP JSON and sending it to an endpoint, is
[[030-otel-export]]. This story keeps what makes that export mechanical: the span-shaped record
and the keys that place each event (Q1).

### Q5. Activity, not content, by default

Each line names the tool and a short argument, or says "message, 412 chars". `--full` shows the
text of one event. The native files hold everything anyway, so this only decides what fills a
reader's context. Credentials are masked either way (Q2).

### Q6. `operator-run-observation` is folded in

That todo asked for a status command and structured progress for scripts and other hosts, and Q3
answers both. Its constraints carry over:

- Run state is engine-owned and portable. Herdr workspace, tab, pane and session ids are never
  portable state; they may appear only as diagnostics.
- Durable fields (stage, agent key, outcome, times) are kept apart from best-effort ones (phase,
  last activity) by the `live` object.
- `awf run`'s result on stdout is unchanged. Progress stays on stderr.

### Q7. No `telemetry` package

Foundation §8 extracted a `telemetry` package at two producers and two consumers. This story brings
the second producer and 030 another consumer, so that trigger fired. No package follows: what a
package buys is control over who may import it, and nothing needs that. The activity readers sit
beside the usage readers in `harness`, and the types in `contract`. Foundation §8 and §10 now say
so (2026-10-11).

### Q8. One story, nothing cut

The review suggested splitting this story into the record with `awf runs` first and `awf logs`
second, and cutting `--follow` and the newest-run default. The operator kept one story and both
features (2026-10-11).

## The commands, by use case

The exact fields and encodings get settled in the design; these outputs show what each one
answers.

### 1. An agent started a run and wants to know what it is doing

The calling session ran `awf run review.ts` in the background (story 027). Its output starts:

```text
awf: review/20261011-0912-4c1e started · watch: awf logs review/20261011-0912-4c1e --wait 90
```

Later it checks in:

```text
$ awf runs review/20261011-0912-4c1e
review/20261011-0912-4c1e  running  stage fix  14m02s
  stage review   succeeded  6m40s
    review:claude    answered  3 turns  6m12s
    review:codex     answered  2 turns  5m55s
  stage fix      running    7m22s
    fixer            working   turn 2   1m10s  last: tool Edit src/run-usage.ts (09:26:12)
next: awf logs review/20261011-0912-4c1e --after c1.Xk3 --wait 90
```

### 2. Wait for something new without rereading the run

```text
$ awf logs review/20261011-0912-4c1e --after c1.Xk3 --wait 90
review/20261011-0912-4c1e  completed
@a3.1e02 09:26:31 fix  fixer  tool Bash  bun test packages/engine  → exit 0
@a3.1f4c 09:26:58 fix  fixer  message  412 chars
@e216 09:27:02 fix  fixer  turn ended  answered  1m48s
@e217 09:27:02 attempt 1 ended  completed
run ended: completed in 14m40s · result: awf runs review/20261011-0912-4c1e
```

With nothing new in 90 s:

```text
review/20261011-0912-4c1e  running  stage fix
nothing new in 90s · running, stage fix · next: awf logs review/20261011-0912-4c1e --after c1.Xk3 --wait 90
```

### 3. See what one agent did

The case from AIRS-1515: what was headless codex doing in review round 3, while it ran?

```text
$ awf logs implement-ticket/20261002-1410-77ab --agent review:codex --limit 5
implement-ticket/20261002-1410-77ab  running  stage review
(showing 5 of 17 for review:codex; raise --limit for more)
@e88 14:44:05 review  review:codex  turn started  label "round 3"
@a5.0c12 14:44:09 review  review:codex  tool shell  rg -n "readUntilSettled" packages
@a5.31e0 14:45:40 review  review:codex  tool shell  bun test run-usage  → exit 1
@a5.4a77 14:47:12 review  review:codex  message  1,904 chars
@a5.52b9 14:48:01 review  review:codex  tool shell  bun test run-usage  …
next: awf logs implement-ticket/20261002-1410-77ab --agent review:codex --after c1.p0Q --wait 90
```

### 4. Read what an agent actually said

```text
$ awf logs implement-ticket/20261002-1410-77ab @a5.4a77 --full
@a5.4a77 14:47:12 review  review:codex  message
  The double count comes from readUntilSettled: an operation owns rows from deliveredAt …
```

### 5. Why did the run stop?

```text
$ awf runs implement-ticket/20261010-1702-9a0b
implement-ticket/20261010-1702-9a0b  failed  stage review  1h02m  $21.40
  …
    worker           failed    turn 6  timed out after 30m  last: background task "bun run eval" (17:58:40)
reason: turn deadline exceeded (worker, turn 6)
records: .awf/runs/implement-ticket/20261010-1702-9a0b (report.md, output.json)
see: awf logs implement-ticket/20261010-1702-9a0b --agent worker --limit 30
```

### 6. A run whose process was killed

```text
$ awf runs review/20261009-2210-0c4d
review/20261009-2210-0c4d  interrupted  stage fix  last event 22:41:07
    fixer            was working   turn 3  last: tool Bash bun test (22:41:02)
continue: awf run review.ts --continue 20261009-2210-0c4d
```

### 7. A run waiting on a decision or a person

```text
$ awf runs feature-delivery/20261011-1015-3e9a
feature-delivery/20261011-1015-3e9a  running  stage plan  6m10s
    planner          waiting   turn 1  "waiting for CI" since 10:16 (check-in due 10:26)
    decision "merge?"  asked 10:19, open
next: awf logs feature-delivery/20261011-1015-3e9a --after c1.Aa0 --wait 90
```

### 8. A continued run, eight fix agents in parallel

```text
$ awf runs review/20261011-1130-5b7e
review/20261011-1130-5b7e  running  attempt 2 (from stage fix)  3m12s
  attempt 1  interrupted in fix  14m02s
  attempt 2
    stage review   reused
    stage fix      running
      fix:lens-1 … fix:lens-8   8 agents: 6 answered, 2 working
      fixer            working   turn 1
next: awf logs review/20261011-1130-5b7e --after c1.Ff9 --wait 90
```

`awf logs` reads across attempts: they append to the same log, so one position covers them.

### 9. List the runs here

```text
$ awf runs
review/20261011-1130-5b7e            running      10-11 11:30  3m12s
review/20261011-0912-4c1e            completed    10-11 09:12  14m40s  $6.10
implement-ticket/20261010-1702-9a0b  failed       10-10 17:02  1h02m   $21.40
review/20261009-2210-0c4d            interrupted  10-09 22:10  31m05s
```

Runs started from another directory are read with `--cwd {dir}` or `--run-root {dir}`, as
`awf run` writes them.

### 10. The operator watches in a terminal

```text
$ awf logs --follow
```

The same lines as example 2, one per event, until the run ends.

### 11. Find an agent's native file

```text
$ awf runs review/20261011-0912-4c1e --json | jq '.agents[] | select(.key=="fixer") | .sessions'
[{ "harness": "claude", "id": "edb45a92-…", "files": ["/Users/…/.claude/projects/…/edb45a92-….jsonl"] }]
```

### 12. Mistakes

```text
$ awf logs 20261008-0000-ffff
no run 20261008-0000-ffff under .awf/runs; runs here: awf runs        (exit 1)
$ awf logs review/20261011-0912-4c1e --after c1.zzz
cursor c1.zzz does not fit this run; start again: awf logs review/20261011-0912-4c1e   (exit 1)
$ awf runs
no runs under .awf/runs; started elsewhere? awf runs --cwd {dir}         (exit 0)
```

## Found in review

Facts the design rests on, from reading the code. Each one becomes part of a task.

- **Torn lines.** `endTurnsLine` runs in `startWorkflow` (`workflow-runner.ts:329`), after the
  attempt is claimed (`run-prepare.ts:135-136`). An "attempt started" written at the claim would be
  glued onto a torn last line and lost with it. Close the torn line right after `claimAttempt`.
- **`readTurns` has no filter today.** It returns every parsed line (`runs.ts:414-416`, through
  `jsonl.ts:43-55`), and `run-prepare.ts:150-153` takes the stage from the last line.
- **A turn that throws** is caught at `workflow-runner.ts:1847-1854` and `:1902-1909`, which only
  update the progress view; `recordTurn` runs on success only (`:1978`). The catch has to write
  `operation-failed`, with the `operationId`.
- **The operation's id** is created at `:2219` in `executeWaitingOperation`, after
  `progress.turnStarted`, and at `:2340` for a compaction, inside the calls those catches wrap;
  `executeOperation` can throw before it (`:2207-2208`). Draw it in the turn and compaction
  wrappers before `progress.turnStarted` (`:1847`, `:1902`) and pass it in, so the catch has it.
  The `operation-started` line is written from the `delivered` callback below.
- **Delivery** is stamped in three places in `operation-liveness.ts` (`:139`, `:251`, `:297`),
  which one `delivered` callback on `superviseOperation` covers, and in the compaction path
  (`workflow-runner.ts:2397`), which does not go through it and writes its own.
- **Log lines and warnings share `onLog`.** Log lines go through `:798`, and warnings through
  `:373`, `:518`, `:1079`, `:1186`, `:1459`, and the stage summary's (`summaryOf`, `:2638`, from
  `:896` and `:915`). `:373` reports a failed `turns.jsonl` write through it. Keep log and warning
  separate, and send a failed write's warning to stderr only, or it would try to write itself. The
  sandbox path drops `fields` (`:396`).
- **Fork and stop** hang on the `RunProgress` calls (`run-progress.ts:63`, `:68`;
  `workflow-runner.ts:1060-1068`, and the fork at `:1559`). Stop has what its event needs. Fork does
  not: `agentForked(spec.key, from)` has only the two keys, so the `operationId` it was copied
  after is set where the fork is taken in the parent's queue. The fork's `from` is the constant
  `CALLING` (`:298`) whenever its parent is the calling session, however asked (`:1491-1492`); the
  writer maps it to the caller's key, or to `null` when the run never opened the caller. **Decisions** have no `RunProgress` call. `decision-asked` is
  written where `RunDecisions` prepares a call and takes its slot (`decisions/directory.ts:138-140`),
  which gives its number, key, alias, provider and model; `decision-ended` where that call settles
  its slot. Not from `decisions.records()` (`workflow-runner.ts:527`), which runs only as the
  attempt settles.
- **One writer.** `claimAttempt` refuses a second live attempt (`runs.ts:261`, `:314`), and
  appends go out in call order (`jsonl.ts:6-15`).
- **Liveness is checked on one machine.** `isLive` (`runs.ts:228-245`) relies on `ps -o lstart`
  (`:562-564`), which returns nothing both when the process is gone and when `ps` fails.
- **Native files.** `sessionFiles` gives paths relative to the agent's home, so a sandboxed agent's
  home and working directory are resolved first. Codex's in-place rewrite keeps a line's length, so
  byte offsets hold (`usage/codex.ts:163-167`).

## To measure

- **M1.** Read each harness's session file while its agent works: partial lines, write latency,
  rotation, codex's fork chain, claude's subagent files. Check that `--session-id` and streaming
  `thread.started` give the id at launch.
- **M2.** How large the event log and a page get on the implement-ticket run, in events and bytes,
  to set the default limits.
- **M3.** How each harness's agent waits on a command: codex's shell timeout and yield in
  particular, against `--wait 90`.

## Scope

In scope:

- The event log: new kinds on `turns.jsonl`, typed in `contract/records`, span-shaped and keyed,
  with no ids stored, written by the engine; `readEvents`, with `readTurns` a filter over it.
- Workflow `log` lines and engine warnings written to it as well as to stderr.
- Run state read from `run.json` and the attempts, with a three-valued process probe.
- A headless agent's session known from launch, for claude and codex.
- Per-harness activity readers in `harness`, returning a `contract` type, windowed to the run's
  own activity, with common credential shapes masked.
- `awf run`'s run reference on stderr; `awf runs` and `awf logs`, with run references, handles,
  cursors, bounds, trailers, `--wait`, `--follow`, `--full` and `--json`.
- The `awf-run` skill teaching an agent to watch a run.

Out of scope:

- The OTel export: [[030-otel-export]].
- Live usage and spend limits during a turn ([[live-spend-limits]]). A run's spend shows only once
  the run has accounted it.
- Harness OTel ingest.
- Reads through `wf` from inside a run: messaging and agent awareness.
- Paging back with `--before`, merging `liveness.jsonl` into logs, a `--mine` filter by calling
  session, and `--follow --json`.
- Links to native files in the run dir.
- A web or TUI dashboard.
- Context size ([[context-size]]). It reads from the same activity readers, so it should follow
  this story.
- Changes to accounting or `output.json`.

## Code map

- `packages/contract/src/records.ts`: `TurnRecord` and `TURN_OPERATION_FIELDS` (`:375-396`); the
  event line union and its guard, the activity type and the `--json` envelope go beside them.
- `packages/engine/src/runs.ts`: `appendEvent` replaces `appendTurn` (`:404`); `readTurns`
  (`:414-416`) becomes a filter over `readEvents`; `isLive` and `processStart` (`:228`, `:562`)
  get the three-valued probe, while `here.ts:206-214` and `herdr-workspace-marks.ts:184` keep a
  two-valued answer.
- `packages/engine/src/jsonl.ts`: checked, no change; appends go out in call order.
- `packages/engine/src/run-prepare.ts`: closes the torn line and writes `attempt-started` right
  after `claimAttempt` (`:135-136`); reads the last stage through `readTurns` (`:150-153`).
- `packages/engine/src/attempt-output.ts`: `attempt-ended`, before `endAttempt`, since an ended
  attempt lets the next one append.
- `packages/engine/src/workflow-runner.ts`: the writer for the other kinds. The turn and compaction
  wrappers, `recordTurn`, `executeWaitingOperation`, the compaction's id and delivery, which does
  not go through `superviseOperation`; `onLog` and the warnings; agent open, stop and fork, and the
  calling session's open.
- `packages/engine/src/stage-ledger.ts`: stages entered, reused and provided (`:150`, `:184`).
- `packages/engine/src/operation-liveness.ts`: one `delivered` callback on `superviseOperation`,
  for its three stamps (`:139`, `:251`, `:297`).
- `packages/engine/src/run-progress.ts`: `agentOpened`, `agentForked`, `agentStopped`; checked, its
  view does not change.
- `packages/engine/src/decisions/directory.ts`: `decision-asked` where a call takes its slot
  (`:138-140`), `decision-ended` where it settles it (`:271`).
- `packages/engine/src/run-usage.ts`: an agent's home and working directory (`AccountedAgent`,
  `:26-32`), which reach disk only in `output.json` today, so `agent-opened` carries them.
- `packages/harness/src/command.ts`, `harnesses/define.ts`, `harnesses/codex.ts`,
  `adapters/direct-process.ts`, `session-core.ts`: a stdout line hook (today only
  `holdStdinUntil` has one, `command.ts:22-40`, `:149`) so codex's `thread.started` is read as it
  streams; claude's first headless turn takes `--session-id` (`harnesses/claude.ts:73`).
- `packages/harness/src/activity/`, new, beside `usage/`: one reader per harness, from a byte offset,
  windowed and masked; `HarnessSpec.sessionFiles` (`harnesses/define.ts:144`) finds the files.
- `packages/engine/src/operator-cli.ts`: dispatches `runs` and `logs` as it does `allowance`
  (`:114-117`); `awf run {ref}` answers `did you mean`; the `started` line where stderr is not a
  terminal (`:96-103`), once `claimNext` has named the run (`:228-234`). New `runs-command.ts` and
  `logs-command.ts` beside `allowance-command.ts`.
- `packages/engine/src/attempt-view.ts`: `continueCommand` (`:307-342`), which also needs the stages
  entered; the reader rebuilds them, and the `RunCommand`, from `run.json` and the stage files.
- Read only: each call's `liveness.jsonl` for an agent's latest phase, and `output.json`'s
  accounting for a run's cost.
- `packages/engine/src/progress-view.ts`, `here.ts`: the run's reference in the header, and the
  `started` line under `--here`.
- `packages/engine/src/workflow-testing/index.ts`: its `onLog` takes log lines and warnings
  together (`:234`), and it runs a real run dir, so the new lines are written there too.
- `packages/engine/skills/awf-run/SKILL.md`: how to watch a run.
- `packages/lab`: checked, reads `output.json` only; no change.
- Tests that read `turns.jsonl` today: `stages.test.ts`, `workflow-runner.test.ts`,
  `jsonl.test.ts` and `tests/operator-cli.test.ts`.

Line numbers are main's on 2026-10-11 and drift; the symbols are what to look for.

## Tasks at a glance

- [ ] 1. The event line in `contract`, `readEvents`, and `attempt-started` after the torn line closes
- [ ] 2. The engine writes stages, operations, agents, logs and decisions
- [ ] 3. A headless claude or codex agent's session is known from launch
- [ ] 4. Activity readers for the four harnesses, windowed and masked, on fixtures recorded in M1
- [ ] 5. Reading a run: references, state with the three-valued probe, cursors and handles
- [ ] 6. `awf runs`, the list and one run, with `--json` and trailers
- [ ] 7. `awf logs`, with `--wait`, `--follow`, `--full` and `--json`
- [ ] 8. `awf run`'s `started` line and `did you mean`, the `awf-run` skill, and live checks M2, M3

Done when:

1. A log written by today's awf reads the same through `readTurns`; a line of an unknown kind or
   version and a line that does not parse are skipped; an attempt started after a torn line keeps
   its first line; a run whose log holds every new kind, a torn line and a line that contradicts
   the stage files continues from the stage files, with the same "interrupted in {stage}".
2. A fake-harness run with stages, a reused and a provided stage, parallel agents, a sandboxed
   agent, a fork of the calling session, a turn that throws before and after delivery, a
   compaction and a decision writes the lines in the table, with keys that rebuild the span tree; a
   failed write's warning reaches stderr only; a workflow log line keeps its fields.
3. `operation-started` names the session on a claude headless turn; codex's `session-known` is
   written before its process exits; fixture streams prove both.
4. Each reader turns files recorded during M1 into activity rows, resumes from an offset without
   repeating or losing a row, stops at a torn last line, follows codex's fork chain and claude's
   subagent files, holds its offsets across codex's in-place rewrite, keeps the calling session's
   rows to the run's operations, and masks the credential shapes in Q2.
5. Every reference form resolves or fails as Q3 says; a probe that fails reads as `running` with
   `checked: false`; `--continue` and the reader agree on every state in a table test; a native
   file that appears late renumbers no handle; a cursor never moves past a torn line.
6. Examples 1, 5, 6, 7, 8, 9, 11 and 12 render from fixture run dirs, as text and as JSON, with the
   best-effort fields under `live` and a sandboxed agent's files under its sandbox home.
7. Examples 2, 3, 4, 10 and 12 render; paging with `--after` returns every event once across a long
   run; `--wait` returns on a new line and at its timeout; each exit code has a case, and
   `--follow --json` is a usage error.
8. A live implement-ticket or review run, watched by an agent from the `started` line with
   `awf logs --wait 90`, records M2's sizes and M3's waits; the defaults are confirmed or revised.

## Related

- [[030-otel-export]]: the export of this story's event log.
- [[018-workflow-stages]]: stages, and cost per stage.
- [[021-turn-liveness-and-limits]]: liveness phases and check-ins.
- [[027-caller-fork]]: the calling session that waits on a run, the first reader of this story.
- [[run-in-background]]: `awf wait` and `--bg`. `--wait` here bounds one read and never waits for a
  run to end.
- [[live-spend-limits]], [[context-size]].
- [[0011-a-run-continues-from-its-stages]]: why the event log is never read to continue.
- [[reading]]: the GenAI conventions and the harness OTel exports.
