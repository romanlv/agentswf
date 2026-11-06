---
id: "043"
title: "Every --json command says why it failed, as a document"
summary: "With --json, stdout always ends with one document: the result, or a refusal {v, code, error} whose code comes from one table shared with agentswf/client; a test across every command keeps it so."
type: story
status: awaiting-human-review
depends_on: ["040"]
---

# Every --json command says why it failed, as a document

## Outcome

A program that runs `awf {command} --json` reads one document from stdout whatever happened.
When the command worked, the document is its result. When it failed, the document is a refusal,
`{"v": …, "code": …, "error": …}`, whose `code` comes from a table the contract publishes. The
exit codes stay as they are, and stderr stays for people.

The refusal codes are the words `agentswf/client` throws as `ClientError.code`, so a program
reaching runs by the CLI and one using the client handle the same failure the same way.

A test runs every `--json` command into the failures its help documents and checks that each
prints a refusal. A new `--json` command without rows, or a documented failure that goes silent,
fails `bun test`, not a host in production.

**Why now.** On 2026-11-05 awf-chat moved its replies to a run's code from the deprecated
`awf send --event-id` to `awf emit {run} {key}:reply`, the replacement the deprecation names.
`send --json` printed `{"v":2,"code":"not-found",…}` for a run that isn't there. `emit --json`
prints nothing on stdout and a line on stderr. So the host had to read the exit code and parse
stderr, and still can't tell "no such run" from "the workflow won't load": both exit 1. The
replacement offered less than what it replaced, and nothing said so until an agent ran into it.
The datadog watcher's `awf-issues.md`, outside this repository, records it. The `--json`
outputs are what hosts are built on. Fixing them now, while agents.wf is in evaluation, costs a
story. After that, it costs a deprecation cycle per command.

## How it works

```text
awf {command} … --json
        │
        ├─ worked ─────────▶ stdout: {"v":1, …the command's result…}             exit 0
        │
        └─ failed ─────────▶ stdout: {"v":1, "code":"no-run", "error":"no run review-mr/7 here…"}
                             stderr: awf: no run review-mr/7 here…   (unchanged, for people)
                             exit 1, 2 or 3, as the command's help says, unchanged
```

**One document, always last.** A command that prints lines, as `awf inbox --json` does, ends
with its refusal as the last line. A reader takes the last line, as awf-chat already does.

**`code` means refused.** A document with `code` is a refusal, and no result has `code`. A reader
checks for it first, then reads the result. The exit code doesn't tell them apart: `emit` exits 1
with a full result when the run's attempt didn't launch.

**One `v` per command.** A refusal carries its command's `v`, the same number as the command's
results, and both move together under the rule `awf.md` already states.

**One set of words.** A code means the same thing in every command that prints it, and the client
throws the same word for the same failure.

**Usage errors too.** `awf emit --json` with no run named prints `{"code":"usage",…}` and exits 2.
`--json` anywhere in the argv before `--` counts, even when the rest can't be parsed.

## Scope

In scope:

- The rule, in the JSON section of `site/reference/awf.md`, and in each `--json` help line.
- `RefusalJson` and the code table in `contract`, with `InboxErrorJson` and
  `ParticipantResultJson`'s refusal folded into it.
- Every `--json` command brought into line: `emit`, `runs`, `logs`, `tick`, `run`, `allowance`;
  the usage errors and exit 3 of `reply`, `send` and `inbox`; and a broken install's
  `no-engine`.
- The holder commands on the shared words: `not-found` → `no-run`, `bad-cursor` → `cursor`, and
  `reply`/`send`'s success without `code`.
- Whether the client's `start` meets any failure `awf run` refuses with `not-started` (task 4:
  it meets none).
- A test across every `--json` command that runs it into each failure it documents.
- awf-chat on the new outputs: `toCode`, `holderCommand`, `inbox`, `parseLine`, `watch.ts`, and
  the `delivered` matches in `presenter.ts` and `ledger.ts`.

Out of scope:

- Human output without `--json`: unchanged.
- A Bun too old to run awf, and an unknown command: refused on stderr before any command runs,
  so before any `--json` is read as a command's.
- Exit codes: unchanged. A host may keep reading them.
- `wfa`'s refusals: the agent's wire has its own envelope and codes, and already reports every
  failure.
- An older engine a project installs. The global `awf` hands over to it, and it prints what it
  always printed. A host still treats an empty stdout as a failure it can only read from stderr.
- New result fields for any command.

## Context and evidence

- Fact: probed 2026-11-05 against the working tree, in an empty folder:

  | Command | Failure | stdout | exit |
  | --- | --- | --- | --- |
  | `reply`, `send` | no such run | `{"v":2,"code":"not-found",…}` | 1 |
  | `inbox` | no such run, bad cursor | `{"v":1,"code":"not-found" \| "bad-cursor",…}` | 1 |
  | `reply` | usage | nothing | 2 |
  | `emit` | no such run, file not found | nothing | 1 |
  | `emit` | usage | nothing | 2 |
  | `runs {run}`, `logs {run}` | no such run | nothing | 1 |
  | `tick`, `runs`, `allowance` | usage | nothing | 2 |
  | `run` | workflow file not found | nothing | 2 |

  The holder commands kept the rule because a host was built on them first; the rest never had
  it.
- Fact: `reply` and `send` exit 3 through `failed` in `run-commands.ts` when the run's files
  can't be read or the run doesn't answer, with a line on stderr only.
- Fact: `emit-command.ts` prints every failure as `awf: {message}` on stderr and returns 1, or 2
  for an `EmitError`. It has done so since `478d7fa` (039 task 7). Not a regression; the rule was
  never written.
- Fact: `emit` exits 1 with a full `EmitResultJson` for `launch-failed`, and that result has an
  `error` field. Neither the exit code nor `error` tells a refusal from a result.
- Fact: `ParticipantResultJson` uses `code` for success too: `{v: 2, code: "delivered", id}`.
- Fact: the code sets disagree. `PARTICIPANT_CODES` and `INBOX_CODES` in `contract/src/wire.ts`
  say `not-found` and `bad-cursor`; `ClientErrorCode` in `contract/src/client.ts` says `no-run`
  and `cursor`.
- Fact: `awf run --json` prints the run's `out.json` once a run exists, failed or not. Before
  that it fails with no run and prints nothing: a file that isn't a workflow or names a run, a
  workflow that won't load or refuses its arguments (`loadAndPrepare`), a `--run-root` holding
  the sandboxes folder, a `--session` that can't be taken, Ctrl-C before the start, and a claimed
  run discarded before its agents started.
- Fact: a broken project install isn't handed over; the command's own engine check refuses it
  with `EngineRefused`, which `no-engine` maps. `hand-over.ts` writes only a warning, before it
  hands over to another installed version. (The draft said it reported a broken install; task
  3 found it doesn't.)
- Fact: the JSON section of `site/reference/awf.md` describes `"v"` and nothing else. The helps
  for `runs`, `tick` and `allowance` say "--json prints one document", which a failure breaks.
- Constraint: `"v"` changes when a field is renamed or removed, and a renamed code counts: `stopped`
  → `peer-stopped` moved `reply`/`send` to 2. A refusal where nothing was printed changes no
  `v`.
- Constraint: beta, no compatibility: a better shape replaces the shipped one, with no shim.
- Assumption: no host but awf-chat reads these outputs. It matches `delivered` in
  `presenter.ts` and `ledger.ts`, `bad-cursor` in `watch.ts`, and `v === 1` for inbox items in
  `parseLine`.

## Code map

### contract

- `src/records.ts`: `ParticipantResultJson`, `InboxErrorJson`, `EmitResultJson`. They gain
  `RefusalJson<Code>`, and each command's output type becomes `Result | RefusalJson<…>`.
- `src/wire.ts`: `PARTICIPANT_CODES`, `INBOX_CODES`, renamed to the shared words.
- `src/client.ts`: `ClientErrorCode`, the client's share of the shared words.

### engine

- `src/emit-command.ts`: the two `out.stderr` returns; `printEmit`.
- `src/runs-command.ts`, `src/logs-command.ts`, `src/tick-command.ts`,
  `src/allowance-command.ts`: each command's failure returns.
- `src/operator-cli.ts`: `awf run`'s pre-run failures (`runNamed`, `loadAndPrepare`'s refusal,
  the run-root check, `takeCaller`, `cancelledBeforeStart`, `endUnstarted`); at dispatch, a net
  for an error a command throws.
- `src/run-commands.ts`: `failed`, exit 3 for the holder commands.
- `src/holder-command.ts` (`refused`), `src/inbox-command.ts` (`refuse`): the two helpers that
  print refusals today; they become the shared one.
- `src/client/index.ts`, `src/client/locate.ts`, `src/client/runs.ts`: map engine errors to
  `ClientError`. The CLI uses the same mapping.
- `src/help/*.txt`: each `--json` line; `reply.txt` covers `send`.
- Tests: `emit.test.ts`, `runs-command.test.ts`, `logs-command.test.ts`,
  `inbox-command.test.ts`, `operator-cli.test.ts`, `client/client.test.ts`. The guard sits
  beside `commands.test.ts`.

### site

- `site/reference/awf.md`: the JSON section, the code table, and each command's codes.
- `site/reference/client-api.md`: `ClientError`'s codes, now also the CLI's.

### Hosts

- `~/dev/braintrust/awf-chat/src/awf/cli-holder.ts`: `toCode` reads `emit`'s refusal;
  `holderCommand` and `inbox` read the renamed codes and the new success shape; `parseLine`'s
  `v`.
- `~/dev/braintrust/awf-chat/src/awf/watch.ts`: `bad-cursor` → `cursor`.
- `~/dev/braintrust/awf-chat/src/core/presenter.ts`, `src/core/ledger.ts`: match
  `code === "delivered"`; `HolderResult` in `src/core/ports.ts` takes the new success shape.

## Design

- **The rule.** With `--json`, stdout ends with exactly one JSON document: the result, or a
  `RefusalJson`. No `--json` command exits with nothing on stdout.
- **The shape.** `RefusalJson<Code> = { v; code: Code; error: string } & extras`. `error` is the
  sentence stderr prints, without `awf: `. A code with extra data declares it, as `ambiguous`
  does `choices`.
- **The discriminant.** `code` marks a refusal; no result carries it. `reply` and `send`'s
  success drops `code: "delivered"` and becomes `{v: 3, id}`, in the same `v` bump as the
  renames. `emit`'s `outcome: "refused"` stays a result: the run refused the event, the command
  did not fail.
- **`v`.** A refusal carries its command's `v`. `reply`/`send` go to 3, and `inbox` to 2,
  items and refusals alike. Every other command keeps its `v`.
- **The codes.** One table, each code with one meaning:

  | Code | Meaning | Printed by |
  | --- | --- | --- |
  | `usage` | the argv can't be parsed, or its options clash | every command |
  | `no-run` | no such run | `emit`, `runs`, `logs`, `reply`, `send`, `inbox`; client |
  | `ambiguous` | a run's id names runs of two workflows or projects | the run readers above |
  | `id` | a run or event id the grammar refuses | `emit` and the run readers; client |
  | `file` | the workflow file is missing, doesn't load, or doesn't export it | `emit`, `run`; client |
  | `event` | an event name or data the workflow doesn't take, or it takes none | `emit`; client |
  | `prepare` | the workflow refuses its arguments or options | `run`, `emit`; client |
  | `other-args` | a run there, started with other args or options | `run --id`; client |
  | `no-id` | a start naming no run | `run`; client |
  | `not-started` | no attempt started: Ctrl-C, a session not taken, a claim discarded, or a run running, completed or gone | `run` |
  | `unreachable` | the run's files can't be read, or it doesn't answer | `emit`, `runs`, `logs`, `inbox`, `reply`, `send` |
  | `cursor` | a cursor or handle made for another run or filter | `logs`, `inbox`; client |
  | `no-engine`, `other-engine` | the project's `agentswf` missing or another version | `emit`, the run readers, `run`; client |
  | `project` | a workflow in no project | `emit`; client |
  | `internal-error` | a failure that isn't the caller's, such as an I/O error; `error` says what | `emit`, then every command |

  Plus the participant codes only `reply` and `send` have: `no-participant`, `ended`,
  `ambiguous`, `peer-stopped` and the rest of `PARTICIPANT_CODES`. Each command's help lists the
  codes it prints. Task plans may find a failure the table lacks; it gets a row, not a
  command-local word.
- **One mapping.** The function that turns an engine error into a `ClientError` code also gives
  the CLI's refusal code, so the CLI and the client can't drift.
- **The guard.** A table-driven test lists every `--json` command and, for each, a failing argv
  per documented failure. It checks that the last stdout line parses as a `RefusalJson` whose
  `code` is in that command's set. A second check compares the table with `commands.ts`, so a
  new `--json` command can't be left out. Task 1 writes it whole, with a list of rows known to
  print nothing; each later task empties its rows from the list, and the last removes it.

Alternatives rejected:

- Fix `emit` only. The next host is written against another command and meets the same thing;
  the rule has to be stated and enforced, not repaired one command at a time.
- Refusals on stderr as JSON. Hosts read stdout for `--json`, and stderr holds deprecation lines
  and other notes. Two streams to parse is the problem this story removes.
- The reason in the exit code alone. Exit codes are coarse by design: 1 covers no run, a workflow
  that won't load, and a failed launch.
- A JSON stream with a separate error event. One last document is what hosts read today, and a
  stream adds a format for no reader.
- A fake `out.json` when `awf run` makes no run. The reader keeps one shape but gets a run id
  `awf runs` can't find, a spend of zero, and an ending no run had.
- A `v` of its own for `RefusalJson`. A command's output would then carry two version numbers,
  and a reader would track both.
- Telling refusals apart by `"code" in doc && doc.code !== "delivered"`. Every reader would carry
  `reply`/`send`'s exception, for a `v` bump those commands take anyway.

## Tasks at a glance

- [x] 1. The contract, the code table, the shared mapping, the reference, and the guard
- [x] 2. `emit` refuses as a document, and awf-chat's `toCode` reads it
- [x] 3. `runs`, `logs`, `tick`, `allowance`, every usage error, and a broken install
- [x] 4. `awf run` refuses when no run comes of it
- [x] 5. The holder commands on the shared words, and awf-chat with them

## Open questions

- Q6. `awf run --id {id} --json` for a workflow with events opens its run and prints a text line,
  `dd-case/k: started`, not a document, on success and on a failed launch (exit 1) alike: the one
  `--json` call left without one. Options: a result of its own, close to `awf emit`'s
  (`{v: 1, ok, ref, created, did, why?, error?}`), a new format; refusing `--json` there as
  `usage`, as `--here` is; or recording it as the rule's one exception. Its refusals are
  documents already. Raised in task 4; to settle before the branch merges, as the reference
  states the rule.

Decided with the human on 2026-11-05:

- Q1. `no-run` replaces `not-found`.
- Q2. A usage error is a refusal, `usage`; `--json` anywhere in the argv counts (before `--`,
  task 3).
- Q3. `awf run --json` refuses when no run comes of it, with `file`, `prepare`, `usage` or
  `not-started`, rather than printing an `out.json` with no run behind it.
- Q4. `code` marks a refusal, and no result carries it; `reply`/`send`'s success drops
  `code: "delivered"`.
- Q5. A refusal carries its command's `v`.

## To measure

None.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. The contract, the code table, the shared mapping, the reference, and the guard

Outcome: the contract publishes `RefusalJson` and the code table, the client throws through the
shared mapping, the reference states the rule, and the guard runs with every silent row listed.

Execution:

- [x] Plan: where the codes live (`wire.ts` or `records.ts`); each command's code set; the
  guard's rows, one per failure in the probe table and each help's exit line.
- [x] Implement: the types; the mapping, used by the client first; the JSON section and code
  table in `awf.md`; the guard and its known-silent list.
- [x] Review: architecture and scope; correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: `bun test`, `bunx tsc --noEmit`; the client's tests pass unchanged; the guard
  passes with the list, and fails when a row is taken off it.

Done when:

- The client throws the same codes through the shared mapping, the reference states the rule,
  and the guard names every row that still prints nothing.

### 2. `emit` refuses as a document

Outcome: `awf emit --json` prints a refusal for every failure, in both forms, and awf-chat's
`toCode` reads it.

Execution:

- [x] Plan: every failure path of `emitEvent`, `emitToRun` and the argv parse, and its code.
- [x] Implement: the refusals and `emit.txt`; awf-chat's `CliHolder.toCode`, reading `code`
  instead of stderr, and its test.
- [x] Review: architecture and scope; correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: `emit.test.ts` covers each code; `emit`'s rows leave the guard's list; awf-chat's
  `bun run check` and `bun test` pass.

Done when:

- Each documented failure of `awf emit --json` prints its refusal, and awf-chat no longer parses
  stderr.

### 3. `runs`, `logs`, `tick`, `allowance`, usage errors, and a broken install

Outcome: these commands refuse as documents; every usage error does, each command printing its
own; a broken install prints `no-engine` with `--json`.

Execution:

- [x] Plan: each command's failure paths and codes; how dispatch knows `--json` before parsing.
- [x] Implement: the refusals and each help's `--json` line; a broken install's rows; whether
  `tick`'s exit 1, which prints its result, needs anything.
- [x] Review: architecture and scope; correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: each command's test covers its codes; their rows leave the guard's list.

Done when:

- Every row of the probe table but `run`'s and the holder commands' shows a document.

### 4. `awf run` refuses when no run comes of it

Outcome: each pre-run failure of `awf run --json` prints a refusal.

Execution:

- [x] Plan: map each failure under "Context and evidence" to `file`, `prepare`, `usage` or
  `not-started`; which of them the client's `start` can meet.
- [x] Implement: the refusals in `operator-cli.ts`, `run.txt`; `openEventRun`'s other-args and
  `panesChanged` refusals in `emit.ts` as `other-args`, not the default `event`; rows for
  `prepare` and `not-started`.
- [x] Review: architecture and scope; correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: the guard covers each code `run` prints but `unreachable`, `project` and
  `internal-error`, and a `--session` not taken; a run that does start and fails still prints its
  `out.json`; `run`'s rows leave the guard's list.

Done when:

- `awf run --json` prints a document whether or not a run came of it, but for Q6.

### 5. The holder commands on the shared words

Outcome: `reply`, `send` and `inbox` print the shared codes and refuse on exit 2 and 3; their
`v` moves; awf-chat reads them; the guard's list is gone.

Execution:

- [x] Plan: the renames, the success shape, the `v` bumps, and every awf-chat match on them.
- [x] Implement: `not-found` → `no-run`, `bad-cursor` → `cursor`, `unreachable` from `failed`,
  `reply`/`send` success `{v: 3, id}`, `inbox` `v: 2`; `reply.txt`, `inbox.txt`, `awf.md`'s
  JSON section and `#reply` section; `InboxErrorJson` and `ParticipantResultJson`'s refusal folded
  into `RefusalJson` (`INBOX_CODES` keeps only what isn't shared); the sentence on stderr with
  `--json` too; the client's `inbox` throwing any client code `awf inbox` refuses with, not only
  `cursor`; a row for a run that doesn't answer; awf-chat's `HolderResult`, `holderCommand`,
  `inbox`, `parseLine`, `watch.ts`, `presenter.ts`, `ledger.ts` and its fixtures.
- [x] Review: architecture and scope; correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: the guard passes with no list; deleting one refusal from any command fails it;
  awf-chat's `bun run check` and `bun test` pass.

Done when:

- The guard fails for a command with a silent failure, and for a `--json` command missing from
  its table.

## Verification

Automated:

- [x] The guard: every `--json` command, every documented failure, a refusal on stdout's last line.
- [x] `bun test`: 2818 pass, 0 fail
- [x] `bunx tsc --noEmit`
- [x] `bun run scripts/check-boundaries.ts`, and the site's `bun run build`
- [x] awf-chat: `bun run check` and `bun test`, 50 pass.

Manual or live evaluation:

- [x] The probe in "Context and evidence", rerun through the real `awf` in an empty folder: a
  refusal in every row, each exit as before. Free.
- [ ] A Slack reply in a datadog-watcher thread to a case run that's gone shows awf-chat's ⚠️ with
  the `no-run` refusal. Free. Not yet run: awf-chat links main's contract, so it waits for the
  merge.

## Review record

### Task 1

- Architecture and scope: per-command sets (guard and reference, types per task); the CLI's code
  through the mapping (`printRefusal` takes the error); `refusalCode` returns any `RefusalCode`;
  `ClientErrorCode` a checked union; `choices` on `RefusalJson`; missing rows added (`emit` with no
  events, `logs` handle, `no-participant`, exit 3 by a run of an earlier format) and the rest
  named with their tasks; stderr checked; the story's table synced with the reference's; glosses
  matched across `records.ts`, `awf.md` and `client-api.md`; the `v` paragraph reordered; task 4
  and 5 checklists take the fold, `INBOX_CODES`, the client's `inbox` mapping and the hand-over
  test. Kept: `client-api.md` keeps its table, as it says when the client throws each word, a
  fact of its own. Merge gate recorded for the reference text.
- Correctness and proof: `RunNotFound` → `no-run` was wrong for a malformed or ambiguous ref,
  fixed by its code; `emit.ts`'s other-args refusals defaulting to `event` moved to task 4; rows
  pin their failure by what the command says; per-command sets; `v` per row; a minimal
  environment; unique names, and every `PENDING` entry a row. No behaviour change in the client's
  tests; `RunNotFound` can't reach the client's `asClientError` raw today.

### Task 2

- Architecture and scope: `emit` printing `unreachable` for a run of an earlier format, now in
  its help, the reference and a guard row; `internal` added to the reference and the story's
  table, and renamed `internal-error`, `wfa`'s word for the same idea; awf-chat's stderr
  fallback, dropped against the story's own out-of-scope line, put back for an engine a project
  pins from before; `internal-error` and `unreachable` throw in awf-chat, as a failure to reach
  the run rather than a refused reply; the comments on `COMMAND_ONLY` and `printRefusal`
  clarified. Kept: wrapping all of `loadWorkflowFile`, simpler than wrapping only its `import`.
- Correctness and proof: every failure path enumerated and probed with the right code and an
  unchanged exit. Coverage added for `unreachable` and a malformed ref's `id`. `prepare`,
  `ambiguous`, `no-engine` and `other-engine` were probed by the reviewer and come through
  `refusalCode` from error classes whose own tests cover them; no `--json` assertion each.
  `project` is only `targetProject`'s, which the loader's engine check precedes; kept in the help
  as the code that path would print.

### Task 3

- Architecture and scope: both deviations kept (each command prints its own usage; the
  hand-over unchanged) and the story's four lines about the hand-over corrected; `--json` read
  by one helper, `asksJson`, up to `--`, at every site; `JSON_VERSION` keyed by the `--json`
  commands only and tied to each result type by `satisfies`, so task 5's bumps fail `tsc` there;
  `awf tick`'s exit 1 with its result named in the reference and its help; `internal-error`
  listed for every command; the net writes the stack to stderr. A Bun too old and an unknown
  command put out of scope: they are refused before any command reads its `--json`. Kept:
  `awf runs {run}`'s net `v` is the list's, as `runs` catches everything after parsing itself.
- Correctness and proof: `runs`' usage `v` read from argv before the parse, not from how far it
  got, with a row; the net skips its refusal when the command already printed; the guard checks
  one document (one value, or `inbox`'s lines with only the last coded); rows for `ambiguous` and
  `id` from `runs` and `logs`. Kept: the net test's `readAllowance` stub, so no change of order
  ever asks a real harness.

### Task 4

- Architecture and scope: the guard's failed-run test hit a stale resolver for a folder already
  imported from, so it got a project of its own; the cycle `run-prepare` → `refusals` → `emit`
  → `run-prepare` removed, `run-prepare` reading `EngineRefused` and `RunRefused` itself;
  `prepare` only for the workflow's own refusal of its argv, anything else `internal-error`; the
  client's `not-started` left out, its stale lines corrected; `not-started` and `id` glossed the
  same in the contract, the reference and the story; `RunTaken`'s doubled comment. Raised as Q6:
  `awf run --id` on a workflow with events prints text. Kept: `--here --json` a usage error;
  `openEventRun`'s `RunTaken` exiting 1 on a race, as before.
- Correctness and proof: a continue given arguments to a workflow with events is `other-args`, as
  a plain one's; a failed `recordProject` is `internal-error`, not `project`; rows for `no-run`,
  `other-args` and `not-started` from `--continue`. Not rows: `unreachable`, `project`,
  `internal-error` and a `--session` not taken, each from an error class or a path whose own
  tests cover it.

### Task 5

- Architecture and scope: the coordinator socket's answer kept apart from the published output,
  as `HolderWireAnswer`, so a live run started before keeps answering; the skill
  `awf-coordinator`, which told agents a success says `delivered`, the people guide and the
  testing API's doc corrected; `messaging.ts`'s `Exclude` of a word gone; per-command code sets
  read by the guard from each help, the note on published per-command types amended; the
  deprecated `send --event-id` printing `awf emit`'s result recorded in the reference; awf-chat's
  readers taking one set of failures, and its type naming an older engine's `delivered`. Kept:
  awf-chat reads an older engine's output too, as the story's out-of-scope line leaves that to a
  host; `docs/design/messaging.md` keeps the words of its time, a design record. Left for the
  human: `agentswf/testing`'s `ParticipantOutcome` still says `{ code: "delivered", id }`, not
  `--json` output; its doc no longer claims to match it.
- Correctness and proof: rows for a run that doesn't answer, `reply` and `send`, through a socket
  that closes unanswered; the deprecated path's events read failing as the run's files do,
  `unreachable`, exit 3; awf-chat's thrown refusal never an empty message; the reference says
  `awf inbox` prints nothing when it reads nothing. The guard bites with no list: deleting the
  refusal from `inbox` or `reply` fails rows.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled: Q1–Q5.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

### Task 1

- The codes live in `contract/src/records.ts` as `REFUSAL_CODES`, beside the `--json` result
  types they refuse in place of; `wire.ts` stays the agent's wire. `ClientErrorCode` is an
  `Extract` of `RefusalCode`, so the client can't throw a word the table lacks. `RefusalJson` takes
  the code set and the command's `v` as parameters.
- `no-id` and `other-args` are in the table: the client throws them, and one set of words was the
  point. No command prints them.
- `unreachable` and `cursor` cover `runs` and `logs` too: their helps already promise exit 3 when
  the run's files can't be read, and `logs` exits 1 for a cursor or handle that doesn't fit.
- The mapping is `engine/src/refusals.ts`: `refusalCode` reads the code an engine error carries
  (`EmitError`, `EngineRefused`, `RunNotFound`) or gives `RunUnreadable` `unreachable`;
  `asClientError` wraps what is a client code; `printRefusal` takes the error and the command's
  word for an error with no code, so the CLI's code comes from the same mapping. It is a module of
  its own because `client/locate.ts` and `client/index.ts` both need it and `index.ts` imports
  `locate.ts`.
- `RunNotFound` carries its code: `no-run`, `id` for a ref no run could have, `ambiguous` for one
  naming runs of two workflows or projects. `ambiguous` joins the table: the participant's word
  already meant "a name that fits more than one", and a refusal may carry `choices`.
- `ClientErrorCode` is a plain union checked to sit within `RefusalCode`, so a word missing from
  the table fails to compile at the declaration.
- Per-command code sets live in each command's help, which the guard reads a row's code from, and
  the reference's "Printed by" column. The published types take the union, `RefusalCode` with the
  participant's or the inbox's: a tuple per command would be a second list to keep (task 5).
- The guard is `engine/src/json-refusals.test.ts`, through `runOperatorCli` in-process, so
  dispatch is under test too. Each row pins the failure it names by what the command says, the
  `v` its refusal carries, and that stderr still says it. Its `PENDING` list holds rows that
  don't conform yet, silent or on an old word; a listed row that conforms fails, so the list can't
  go stale. A comment names the failures that aren't rows yet and the task each waits for.
- Merge gate, for awf-chat too: its changes stay uncommitted in its working tree until this
  branch reaches main, which its `@agentswf/contract` links.
- Merge gate: the reference states the rule from task 1, so the branch reaches main only once
  task 5 makes it true; `docs` and `site` deploy from main.

### Task 2

- `loadWorkflowFile` throws `WorkflowFileError`, code `file`, for anything but `EngineRefused`,
  and `emitToRun`'s two plain errors about a run's file are one too. A class of its own, not
  `EmitError("file")`: `emit` exits 2 for an `EmitError`, and a file that won't load stays 1.
- `internal-error` joins the table: the rule leaves no `--json` failure without a document, and
  an I/O error isn't the caller's. It is `printRefusal`'s fallback, never a caller's mistake's,
  which gets an error class `refusalCode` reads.
- awf-chat's `toCode` reads the refusal first, as `code` marks one, and keeps reading stderr only
  for an empty stdout from an engine before this story.

### Task 3

- Each command prints its own usage refusal, as only it knows its usage text and `v`;
  dispatch catches only what a command throws, as `internal-error` unless the error has a code,
  and not when the command printed already. `asksJson` reads `--json` up to `--`.
- A broken install needs no hand-over change: the command's engine check refuses it, and
  `no-engine` comes through the mapping. Rows prove it for `emit`, `runs` and `logs`; `inbox`,
  `reply` and `run` wait for their tasks.
- `awf tick`'s exit 1 keeps printing its result: the runs it did wake, the others still woken. A
  reason per project would be a new field, out of scope. A throw midway loses the list gathered
  so far, as it did before, now as `internal-error`.

### Task 4

- `RunRefused` takes a code at every throw site, as `RunNotFound` does: `id`, `no-run`,
  `other-args`, `prepare`, `unreachable` or `not-started`. `loadAndPrepare` returns each refusal
  with its code, and `awf run` prints it.
- `not-started` means no attempt started: besides Ctrl-C, a session not taken and a claim given
  up, a continue of a run that is running, completed, or whose folder is gone. `error` says which.
- The client's `start` never throws `not-started`: it takes no session and no Ctrl-C, its claim
  is the detached attempt's, and a launch that fails is its `launch-failed` result. So
  `ClientErrorCode` doesn't gain it.
- `--here` with `--json` is a usage error: `--here` prints what the calling agent does next, and
  no document.
- awf-lab is a host in this repository, missed by the story's assumption that awf-chat was the
  only one. Its runner already took a document without the record's version as no record, so a
  refusal from `awf run` is none; its test runner parsed stdout itself, and now reads it as the
  runner does. `awfAllowance` took any `v: 1` as a report, a refusal included; it checks `code`
  first now.
- Two tests wrote a workflow file into a folder Bun had already imported from, which its resolver
  then doesn't see: the guard's failed-run test, and `tests/operator-cli.test.ts`'s refused
  continue, which passed or failed by what ran before it. Each writes its file first, or into a
  folder of its own.

### Task 5

- The run's coordinator socket keeps its answer, now `HolderWireAnswer` in `wire.ts`, at wire
  version as it was: `awf reply` and `awf send` map it to the published `{v: 3, id}` or a refusal,
  so a run started under the old commands still answers the new.
- `PARTICIPANT_CODES` lost `not-found`, the shared `no-run`; `INBOX_CODES` keeps `no-participant`
  only; `InboxErrorJson` became `InboxRefusalJson`, `RefusalJson` at `v` 2.
- With `--json`, the holder commands write the sentence on stderr too, as every other command does.
- awf-chat reads the new shapes and an older engine's: `v` 1 or 2 inbox items, `cursor` or
  `bad-cursor`, a success with or without `"code": "delivered"`, and stderr for an empty stdout,
  as an engine a project pins prints what it printed. `usage`, `unreachable` and
  `internal-error` are thrown, as awf's or the run's reach failing, not a refusal of the message.

## Human review

- [x] Every task is complete and story-level verification passes, but the Slack check, after the
  merge.
- [x] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
