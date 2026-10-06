---
id: "024"
title: A run's agents open in a Herdr session of their own
summary: "Pane agents open in a headless Herdr session awf starts and owns (`awf` by default), not the operator's, so they set off no notifications there; `awf run` says where they are and when one is stuck, and the session starts from a minimal environment, is restarted when Herdr updates, and drops workspaces no live run owns."
type: story
status: draft
priority: P2
epic: observability
discovered_in: "Herdr notifications from runs, 2026-10-05"
depends_on: []
---

# A run's agents open in a Herdr session of their own

## Outcome

A run's pane agents no longer open in the operator's Herdr session. They open in a session awf
starts and owns, `awf` unless `AWF_HERDR_SESSION` names another, running headless with nobody
attached. An agent finishing or waiting there plays no sound and shows no toast, and the operator's
sidebar holds only their own work.

Muting the noise must not hide the signal. `awf run` says where its agents are, once, as the first
opens, and shows an agent that is blocked on a prompt in its stage
list, since no sound will. The session is awf's to look after: it starts from a minimal environment,
not from whichever shell happened to start it, it is restarted when Herdr updates and nothing is
running in it, and workspaces left by runs that died are closed.

Choosing the session in a config file, per machine, project or workflow, is
[[025-operator-config]]; this story works with `AWF_HERDR_SESSION` alone.

## How it works

```
 operator's Herdr session                       run session "awf": headless, nobody attached
 ┌──────────────────────────────┐               ┌────────────────────────────────────────┐
 │ operator's own panes         │               │ workspace "awf run implement-ticket a1" │
 │ awf run --here tab ────────────── drives ─────▶  tab reviewer (claude)                │
 │ caller pane (ADR 0010)       │               │  tab fixer (codex)                     │
 └──────────────────────────────┘               └────────────────────────────────────────┘
   callerSession():                               runSession():
   owner of $HERDR_SOCKET_PATH                    AWF_HERDR_SESSION else "awf"; valid name;
                                                  started if down (awf, awf-* only);
                                                  restarted if stale and empty; orphans closed
```

**Two sessions, two questions.** awf asks Herdr two things that today get one answer. Where is the
session that called it, for `awf run --here`? That is the session owning `$HERDR_SOCKET_PATH`, and
it stays the operator's: the caller's pane and the `--here` run's own tab stay beside them. Where
do the run's agents open? That is the run session, which moves.

**awf starts the session, and only its own.** Herdr's API commands do not start a server; against
one that is down they fail `server_not_running`. Before the first pane opens, awf lists the
sessions. If its session is down, awf starts `herdr --session {name} server` detached, so it
outlives this run for the next, and waits until it answers. A session is awf's by its name: `awf`,
or `awf-` and more. The session is shared, so which run created it is not knowable and does not
matter. awf never starts another name: one that is down may be an operator's stopped session with a
saved layout, and bringing that back headless is not awf's call.

**Quiet by construction.** Herdr's sounds and toasts are made by an attached client from that
client's own config; a session nobody is attached to makes none. awf also starts its server with a
config of its own (`HERDR_CONFIG_PATH`, `~/.awf/herdr/config.toml`: toasts off, sound off), so that
whatever the server itself decides is quiet too (M1), and the attach command awf prints sets
`HERDR_DISABLE_SOUND=1`, so watching a run stays quiet as well.

**The server starts from a minimal environment.** A pane's shell inherits its server's environment.
A server that outlives runs would hand the first run's shell (its tokens, its direnv exports, a
project's `node_modules/.bin` on `PATH`) to every later run of every project. So the server starts
from an allowlist, `HOME USER LOGNAME SHELL TERM LANG LC_* TMPDIR` and a system `PATH`, and each
pane's shell builds its own environment from the operator's login files, as a new terminal does.

**The question people ask first: why not mute it in Herdr?** Herdr 0.9 has no per-workspace mute; its
sound and toast settings are per server or per client, and muting by agent kind would mute the
operator's own claude too. Nor can awf hide its agents from Herdr: it needs Herdr's reading of their
screens to know a turn ended.

## Scope

In scope:

- `callerSession()` and `runSession()` in place of `herdrSession()`; pane agents, sandbox watch tabs
  and `awf allowance`'s usage screen open in the run session; the caller and the `--here` tab stay.
- Starting the run session when down, only an `awf` or `awf-*` name; its quiet Herdr config; its
  minimal environment.
- A name check: `^[a-z0-9][a-z0-9-]{0,31}$`, for `AWF_HERDR_SESSION` too.
- `awf run` output: where the agents are, once, as the first pane agent opens; a pane agent blocked
  on a prompt, in the stage list; the first time awf starts the session, how to stop it.
- Restarting the session when its server's version differs from the CLI's and no workspace is open
  in it; otherwise saying so once.
- Closing `awf run` workspaces in the session whose run is not live.
- `AWF_HERDR_SESSION` reaching a `--here` run's inner `awf run`.

Out of scope:

- Choosing the session per project or workflow, and any config file: [[025-operator-config]].
- Stopping the session. It outlives runs on purpose; stopping it when one run closes would kill a
  concurrent run's agents. `herdr session stop awf` ends it, and awf says so the first time.
- Isolating one run's unsandboxed agents from another's in the same session. Any unsandboxed pane
  agent can drive every pane in its session through `$HERDR_SOCKET_PATH`; today that is the
  operator's own session, so one `awf` session is a narrowing, not a new reach. Sandboxed agents
  have no Herdr socket (srt `allowUnixSockets: []`, no docker mount).
- Layout of agents inside the session ([[herdr-layout-policy]]).

## Context and evidence

Herdr, checked 2026-10-05 against its docs (v0.9.3) and the installed 0.9.1:

- Fact: no per-workspace or per-pane notification setting. `[ui.toast] delivery`, `[ui.sound]
  enabled` and `HERDR_DISABLE_SOUND` are global; `[ui.sound.agents]` keys by agent kind. Sound plays
  through the attached client. A named session is its own server, sharing the one config file.
- Fact: Herdr finds an agent's process in a pane and reads its state from the screen through a
  detection manifest. The integration hooks for claude, codex and cursor
  (`~/.claude/hooks/herdr-agent-state.sh` and siblings) report only a session reference, for
  restore; they do not cause the notifications.
- Fact: `herdr --session {name} server` ran headless with its socket, client socket and log under
  `~/.config/herdr/sessions/{name}`, and `workspace list` answered. Against a session that is down,
  API commands exit 1 with `server_not_running`. The probe session was stopped and deleted.
- Fact: `HERDR_SESSION` picks the session for a `herdr` command without `--session`; awf passes
  `--session` on every call (`createHerdrCommands`).
- Fact: the operator's machine has toasts off and sound on by default.

awf today:

- `herdrSession()` (`packages/engine/src/operator-runtime.ts`): `AWF_HERDR_SESSION`, else the
  session owning `$HERDR_SOCKET_PATH` from `herdr session list --json`, else `default`. Its callers
  mean two things: `installOperatorRuntime()` and `allowanceReader()` mean the run's agents;
  `here.ts` (`runHere`, `showOwnTab`, `findCaller`) and `tests/calling-session.eval.ts` mean the caller.
- `installOperatorRuntime()` resolves the session at the first pane's `openRun`, so an all-headless
  run never calls Herdr. It builds `accounting` from `panes("default")`; accounting reads finished
  sessions' files and needs no session (`createSessionAccounting` in `herdr.ts`).
- Tabs take the Herdr server's environment, not the caller's shell (`createHerdrRunHostFactory`'s
  comment); `emptyEnvironment` clears `WITHHELD_ENVIRONMENT` in each workspace. So an
  `AWF_HERDR_SESSION` set in the operator's shell does not reach the `--here` tab's inner `awf run`
  unless passed.
- The progress view shows agent-reported waiting (`progress-view.ts`); a turn ends `blocked` when
  Herdr reads an approval prompt on screen. Whether a blocked pane shows before its turn ends is M4.
- `awf run --session {code}` already means the `--here` reply code (`run-command.ts`); this story
  adds no flag, so no third meaning of "session".

## Code map

### `packages/engine/src/operator-runtime.ts`

- `herdrSession()` becomes `callerSession(run, environment)`, the lookup without
  `AWF_HERDR_SESSION` and without the `default` fallback, and `runSession(name, deps)`, which
  ensures the session and returns its name.
- `installOperatorRuntime()` and `allowanceReader()` call `runSession`. `accounting` no longer names
  a session.
- Its comment, "Falling back to `default` would put the agents in a session nobody is looking at",
  is about a socket no session owns; it moves with the lookup to `callerSession`.

### A new `packages/engine/src/herdr-run-session.ts`

- The session's life: the name check, list, start with the minimal environment and the quiet
  config at `~/.awf/herdr/config.toml` (`machine.ts` owns `~/.awf`), the wait, the version check and restart,
  closing orphan workspaces. `start` and `run` are injected, so tests start nothing.

### `packages/engine/src/here.ts`

- `runHere()`, `showOwnTab()`, `findCaller()` call `callerSession()`. `runHere` passes
  `AWF_HERDR_SESSION`, when set, into the inner run's tab with `--env`.

### `packages/engine/src/progress-view.ts` and `operator-cli.ts`

- The agents' location, once; a blocked pane agent in the stage list; the
  first-start line.

### `packages/harness/src/adapters/herdr.ts`

- Checked: takes a `HerdrConfig` with a session name and needs no change for the move. A blocked
  state before the turn ends (M4) may need the adapter to report it, on top of story 023's changes
  to this file, merged 2026-10-06.

### Tests and docs

- `operator-runtime.test.ts` "agents open in the Herdr session awf runs in, unless
  AWF_HERDR_SESSION names one" splits in two; the test passing `AWF_HERDR_SESSION: "wf-lab"`.
- `tests/operator-cli.test.ts` `awf run --here`: `inHerdr` sets `AWF_HERDR_SESSION: "default"` to
  stand in for the caller lookup; it gives a socket and a session list instead.
- `tests/calling-session.eval.ts`: `callerSession()`. `tests/minimum-review.eval.ts` pins its own
  preflight session; checked, unaffected.
- `docs/status.md` ("Pane agents open in the Herdr session `awf run` is started from") and
  `docs/testing.md` if the evals' Herdr prerequisites change.

## Proposed design

### `runSession`

1. Check the name against `^[a-z0-9][a-z0-9-]{0,31}$`; refuse otherwise. Herdr makes
   `sessions/{name}` from it, a leading `-` would read as an option, and a long one overflows the
   socket path.
2. `herdr session list --json`. Running: go to 5.
3. Down, and named `awf` or `awf-…`: write `~/.awf/herdr/config.toml` if absent, and start
   `herdr --session {name} server` detached, standard streams to nothing, unreferenced, from
   `$HOME`, with the allowlisted environment and `HERDR_CONFIG_PATH` pointing at it. Down and any
   other name: refuse, naming `herdr --session {name} server`
   for the operator to run if they want it.
4. Poll `workspace list` every 200 ms for up to 10 s. A start that lost a race to a concurrent run
   fails to bind; the poll finds the winner's server (M2). Not answering: the attempt fails before
   any agent opens, naming the session, its server log and `herdr session attach {name}`.
5. Version: the server's (`herdr status server`) against the CLI's (`herdr --version`). Different,
   an `awf` or `awf-…` session, and no workspace open: stop and start it, back to 3. Different otherwise: one
   line saying so and how to restart; carry on (M3).
6. Orphans: each `awf run …` workspace whose run is not live, by the run's mark (the pid and process
   start time `runs.ts` already keeps), is closed. A workspace whose run can't be found is left
   alone and named.

The name is the whole ownership rule: no record of who started the session, which a shared session
could not keep true anyway. An operator who names their own session in `AWF_HERDR_SESSION` keeps it
running themselves.

The quiet config holds only what makes noise: `[ui.toast] delivery = "off"` and `[ui.sound]
enabled = false`. Everything else is Herdr's default, since a headless server draws nothing. awf
writes it once and never overwrites it, so an operator may edit it.

### The environment

The server starts with `HOME USER LOGNAME SHELL TERM LANG LC_* TMPDIR` from the operator's, and
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`. A pane's shell is the operator's login shell, which reads
their profile and sets their `PATH`, so a harness on that `PATH` is found as in a new terminal (M5).
Nothing from the invoking shell crosses: not its tokens, not its project's `PATH`.

Today's panes inherit the operator's own Herdr server's environment, started from whatever terminal
started Herdr; this is narrower than that, and the same for every run.

### Output

When its first pane agent opens, `awf run` prints one line above the progress, where it stays as
the stage list redraws; not in the closing block, since the workspace closes with the run:

```
agents   herdr session awf · workspace "awf run implement-ticket a1" · HERDR_DISABLE_SOUND=1 herdr session attach awf
```

The first time awf starts the session, one more line: `started herdr session awf, headless; stop it
with herdr session stop awf`. A pane agent that Herdr reads as blocked shows in the stage list as
`blocked · {agent} · herdr session attach awf`, while it is blocked if the adapter can say so (M4),
else when its turn ends `blocked`. Each fact is said once, as the rest of `awf run`'s output does.

### `--here`

The caller's pane and the run's tab are found and opened in `callerSession()`, as now. The inner
`awf run` in that tab gets `AWF_HERDR_SESSION` by `--env` when the outer shell had it, so the
operator's choice reaches the run whose agents it places.

Alternatives rejected:

- Mute in Herdr: global or per agent kind only.
- Strip `HERDR_*` from agents so Herdr misses them: Herdr finds agents by process, and awf needs its
  detection.
- Start any session that is down: may revive an operator's stopped session headless.
- The server inheriting the starting shell's environment, less a denylist: what a denylist misses
  (`GH_TOKEN`, `AWS_*`, `SSH_AUTH_SOCK`, a project's `bin/`) persists into every later run.
- Stop the session when the run closes: kills a concurrent run's agents.
- A session per run: a server per run, and nothing to attach to between them.

## Tasks at a glance

- [x] 1. Agents open in a session awf owns and starts (M1 by ear outstanding)
- [x] 2. `awf run` says where the agents are, and which is blocked
- [ ] 3. The session is kept: restarted on a Herdr update, orphans closed

## Open questions

None. Decided 2026-10-06: one `awf` session by default, quiet when awf creates it; awf starts only
sessions named `awf` or `awf-…`, since a shared session's creator is not knowable.

## To measure

- **M1** (task 1). Agents finishing and blocked in a headless session nobody is attached to, on
  0.9.1: no sound or toast in the operator's session or anywhere. Then attached with
  `HERDR_DISABLE_SOUND=1`: still no sound. Whether the server's own config (toasts off, sound off)
  changes anything, or only the client's does; if it changes nothing, the quiet config is dropped.
- **M2** (task 1). Two `awf run`s starting the same stopped session at once: what the second
  `server` does, and whether the poll settles it.
- **M3** (task 3). After `herdr update` with the session running: what `herdr status server` reports,
  and whether the adapter's `HERDR_VERSION` check or a pane command fails first.
- **M4** (task 2). Whether the adapter can read a pane agent as blocked while its turn is still
  open, from what Herdr reports, without a change to `herdr.ts`.
- **M5** (task 1). In a server started with the minimal environment, each harness (claude, codex,
  pi, cursor) is found on the pane shell's `PATH`, and its login works.
- **M6** (task 2). `herdr session attach awf` from inside a Herdr pane and from a plain terminal:
  which works and how it looks, to pick what the output line suggests.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. Agents open in a session awf owns and starts

Outcome: `awf run` from the operator's session opens its pane agents in `awf`, started if down from
a minimal environment; the `--here` caller and tab stay where they are; `AWF_HERDR_SESSION` names
another session and reaches a `--here` run.

Execution:

- [x] Plan: inspect the relevant code and tests, settle the cleanest module, interface, seam,
  invariants, failure behavior, and focused proof, and record material alternatives before coding.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: have two read-only subagents review this task's actual diff and test output—one for
  architecture and scope, one for correctness and proof.
- [x] Resolve: fix or explicitly disposition every material finding; request targeted re-review
  when a fix changes the selected architecture.
- [x] Verify: run this task's focused checks and satisfy every `Done when` item before checking the
  task in `Tasks at a glance` or starting the next task.

Work:

- `callerSession()`, `runSession()` steps 1 to 4, the quiet config, the environment; every caller moved to
  the one it means; `accounting` free of a session; `--here` passing `AWF_HERDR_SESSION`.
- `docs/status.md`.

Done when:

- Unit tests: a bad name is refused; a running session is used without a start; a stopped `awf`
  or `awf-…` session is started with exactly the allowlisted environment and `HERDR_CONFIG_PATH`
  at the quiet config, written if absent and kept if present, and used once it answers; a stopped
  session of any other name is refused with the command to start it; one that never answers fails
  the attempt before any agent opens; the caller lookup ignores `AWF_HERDR_SESSION`; the `--here`
  tab gets `AWF_HERDR_SESSION` when set.
- The `--here` CLI tests pass with a socket and a session list in place of the override.
- Live, once: `awf run` with one claude pane agent from the operator's session opens it in `awf`;
  M1, M2 and M5 answered.

### 2. `awf run` says where the agents are, and which is blocked

Outcome: the operator reads where to watch, in the run's output, and sees a
blocked pane agent without a sound.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- The `agents` line, the first-start line, the blocked line, per M4 and M6.

Done when:

- Progress-view tests: the `agents` line once; the first-start line only when awf started the
  session; a blocked pane agent in the stage list, naming the session while the run is on.

### 3. The session is kept: restarted on a Herdr update, orphans closed

Outcome: an updated Herdr does not leave runs on a stale server, and a run that died leaves no
workspace behind for long.

Execution:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

Work:

- `runSession()` steps 5 and 6.

Done when:

- Unit tests: a stale, empty, awf-created session is restarted; a stale one with a workspace open,
  or not named `awf…`, is named once and used; a workspace whose run is not live is closed, one whose run
  is live is kept, one whose run can't be found is named and kept.
- M3 answered.

Tasks are checkpoints, not a file-by-file edit script. The implementation agent may adjust the
implementation without changing their outcomes, order, or the story's scope.

## Verification

Automated:

- [ ] The focused tests under each task.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`
- [ ] `bun run check`

Manual or live evaluation:

- [ ] Task 1's live run: one claude pane agent on a cheap model, a few cents at list prices; needs
  Herdr 0.9.1 and a claude login. M1 by ear and by the operator's sidebar.
- [ ] `tests/calling-session.eval.ts`: the caller is found in the operator's session while the run's
  agents open in `awf` (`docs/testing.md` has its cost).

## Review record

### Design review, 2026-10-05

Three read-only reviews of the combined draft (then one story with the config). Taken here:
architecture: split the session from the config; `accounting`'s `panes("default")`; `--here` not
passing `AWF_HERDR_SESSION`; the minimal environment. Security: validate the name; start only
sessions awf owns, by name (decided with the operator); the server's environment by allowlist; one session's cross-run reach (scoped
out, with why). Operator experience: blocked agents must still be seen; say where to watch in the
closing block; say once that the session exists; stale server after an update; orphan workspaces.

### Task 1

- Architecture and scope: seam and callers right, boundaries ok. Fixed: the unused `startServer`
  runtime option removed; `HERDR_CONFIG_PATH` unset in the run's panes (`PANE_WITHHELD_ENVIRONMENT`),
  so a `herdr` an agent starts reads the operator's config; `DEFAULT_RUN_SESSION` unexported; the
  name checked when the runtime installs, before any stage spends, and by `--here` in the caller's
  shell before a tab opens. Kept: `started` stays in the closure until task 2 needs it.
- Correctness and proof: fixed: `HERDR_HOME` and `XDG_*` kept in the server's environment, or the
  server and awf's calls look in two places; the log named from the listed `session_dir`;
  `callerSession` says a failed list's own error; a failed spawn is said at once, not after the
  wait; a session listed running is polled until it answers; each poll's timeout fits the 10 s; the
  quiet config linked in whole. Tests added: a failed start, `herdr` not on `PATH`, a pane agent
  failing before any workspace, one list for concurrent agents and a retry from a later host, the
  failed caller list. Kept: both racers say `started` (M2); a server dying mid-run is task 3's.

### Task 2

- Architecture and scope: the callback seam, `describeRunSession`'s home and the deviation held.
  Fixed: a teller that throws fails no agent; the final frame names no session, its workspace
  closed; the story's Output and Done when amended to the deviation; the ordering `placed` relies on
  said. Kept: the blocked suffix names only the session, the full command being in the `agents`
  line; `herdrSession` threaded through the view's helpers.
- Correctness and proof: fixed: a session ready after the run ended (a cancel while it starts)
  writes nothing under the closing block, `watchProgress` ignoring `log` and `placedIn` once
  stopped; the calling session gets no hint. Tests added: told once across two pane agents, never
  for a failed start, once on the retry; a blocked agent in an open stage's line; the log path for
  headless and calling agents; the CLI line inside Herdr.

### Task 3

- Architecture and scope:
- Correctness and proof:

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [ ] Evidence and research support the proposed design. (M1 to M6 open.)
- [x] Expensive interface, record-format, and stage-gate decisions are settled. (No published type
  or record changes.)
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

### Task 1, 2026-10-06

- `herdr-run-session.ts` holds `runSessionName` (the default and the name check), `ensureRunSession`
  (steps 2 to 4) and `serverEnvironment`. `ensureRunSession` returns `{ name, started }`, `started`
  for task 2's first-start line. `operator-runtime.ts` makes it ready once per runtime
  (`runSessionOnce`), at the first pane agent, so an all-headless run never asks Herdr and a bad
  `AWF_HERDR_SESSION` refuses only a run with a pane agent; a failure is not kept.
- `herdr` is found on the operator's `PATH` and started by absolute path, as the server's own `PATH`
  is the system one. `callerSession` refuses outside a pane rather than guessing `default`.
- `accounting` is `createSessionAccounting` itself, now exported by the harness, not a factory built
  for session `default`. `startInNewTab` takes `env`, passed as `herdr tab create --env`.
- M2, live: two `ensureRunSession("awf-probe")` at once left one server; both returned in 214 ms,
  each saying `started` (it can't tell it lost the race; task 2's line may then show twice).
- M5, live: the server's environment was exactly the allowlist and `HERDR_CONFIG_PATH`. A pane's
  login shell found claude, codex, pi and cursor-agent on its own `PATH`, with no `*TOKEN*` variable;
  claude (claude.ai) and codex (ChatGPT) read logged in from it. cursor's login unchecked (keychain).
  Panes inherit `HERDR_CONFIG_PATH`, so a `herdr` client started inside one reads the quiet config.
- Live run: `bun awf run examples/quick-check/workflow.ts -- claude` from the operator's session
  started `awf` and opened the agent there; nothing in the operator's workspaces; right twice, 15 s,
  ~$0.13 at list prices on the subscription. M1 awaits the operator's ear.
- `bun test`: 1551 pass, 0 fail after the review fixes; `bun run check` clean.

### Task 2, 2026-10-06

- The runtime tells `onRunSession` once, when the first pane agent's session is ready; `awf run`
  logs `describeRunSession`'s lines above the progress and tells the view the session's name
  (`placedIn`), which a blocked pane agent's line then names: `✗ blocked: {reason} · herdr session
  attach awf`, in the stage list and in the log.
- M4: no adapter change. Herdr reading a pane as blocked settles the turn at once as `blocked`
  (`settleAgent`), so the turn's end is the moment it is blocked.
- M6, live: `herdr session attach awf` inside a Herdr pane fails, "nested herdr is disabled by
  default", and Herdr 0.9 has no session switch inside a client. When awf runs in a Herdr pane the
  line adds "from a terminal outside Herdr".
- Deviation: the `agents` line is not repeated in the closing block. The run's workspace closes
  with the run (checked live: `awf` held no workspace after it), so there it would point at nothing;
  the log line stays above the redrawn progress.
- Live: the line printed as designed. That run's claude turn ended `unanswered`, the model
  declining a prompt Claude Code showed as `<pasted_content>`; the first run's was pasted too and
  answered. Not this story's: `a053a7a` dropped story 016's typed submit for multi-line claude
  prompts, while `docs/status.md` still says they are typed.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
- `bun test`: 1555 pass, 0 fail after the review fixes; `bun run check` clean.
