---
id: "027"
title: A run forks the session that started it
summary: "`agents.forkCaller({ key, … })` opens an agent on a copy of the session `awf run` was started from, on the model its files show, or answers `null`; the session waits on the run, or was handed over with `--here`, and its context is never spent on the work."
type: story
status: awaiting-human-review
priority: P2
epic: authoring
discovered_in: "agent/workflows/review, the fixer beside the run (2026-10-06)"
depends_on: ["014", "016", "026"]
---

# A run forks the session that started it

## Outcome

An agent session runs a workflow as an ordinary command and waits for it, and the workflow opens an
agent that starts knowing what that session knows, without spending its context on the work:

```ts
const fixer =
  (await workflow.agents.forkCaller({ key: "fixer", layout: { workspace: "origin" } })) ??
  (await workflow.agents.open({ key: "fixer", runtime: "claude" }));
await fixer.run({ prompt: "Fix the findings in findings.json." });
```

The review workflow's use: the main session runs `/wf:review`, which runs `awf run`; the fixer, a
fork of the main session, fixes the findings in its own pane, and the main session reads the run's
presented result as the command's output. Messaging stays for asynchronous work, and the
non-blocking version is [[run-in-background]].

## How it works

```text
main session (claude)
  └─ tool call: awf run review.ts            CLAUDE_CODE_SESSION_ID=s1 in its environment
       └─ awf: the session that started it = { claude, s1 }, its file written seconds ago
            agents.forkCaller({ key: "fixer" })
              → s1's file: its directory and its last request's model
              → claude -p --resume s1 --fork-session (no model call)
              → fixer opens on the copy, on that model, where its layout says
       ← the presented result, as the tool call's output
```

- **Asked for, never assumed.** A workflow that does not call `forkCaller` never touches the
  session, so an eval or a lab case started from an agent's shell behaves as before. `caller()` is
  unchanged: only the session `--here` handed over, else `null`.
- **Found from awf's own environment.** `awf run` is the session's child, and each harness sets its
  session variable in its tool calls' shells. The run takes the one whose session file was written
  in the last few minutes: a variable a terminal, tmux or Herdr server inherited long ago names a
  session gone quiet, and is not taken. Under `--here` the id comes from `--here`'s own shell,
  passed to the run's tab.
- **The fork** is ADR 0009's: a new agent on a copy taken now, which holds the session up to the tool
  call that started the run. It needs no turn of the run's first. It runs on the model the session's
  last request ran on and in the directory its file records. It is the run's agent: awf's launch
  flags, its layout, the operator's skills.
- **Two relations to one session.** The calling session is the one that started the run, waiting on
  `awf run` or handed over with `--here`. `forkCaller` needs only that it exists; `caller()`, the
  session as an agent of the run, needs it handed over, since a session waiting on a tool call
  cannot take a prompt, and answers `null` otherwise, as today. Under `--here`, `forkCaller` takes
  its copy in the caller's queue, after the run's turns to it, so `caller().fork()` is the same
  copy at the same point.
- **Spend.** A fork's requests count from when it was made, so what it copied stays the session's.

## Scope

In scope: `agents.forkCaller`; finding the session from `awf run`'s environment, and from `--here`;
the liveness check; the fork, in a pane or headless, on the host or into the run's sandbox by copy;
the model and directory read; the spend window; the `testWorkflow` option; the `awf-run` skill saying how each harness waits on a long command; the lab
withholding the session variables from the runs it starts; ADR 0010's amendment and
`workflow-api.md`.

Out of scope: [[run-in-background]] (`--bg`, `awf wait`, the progress tab and `beside: "run"`);
the review workflow itself, outside this repository, whose `tab.ts --fork` can then go; an operator
typing into the fork while it works ([[attended-agent]]).

## Context and evidence

- Fact: claude's Bash tool sets `CLAUDE_CODE_SESSION_ID`, and each row of its session file records
  `cwd` (checked 2026-10-06, 2.1.292). Codex sets `CODEX_SESSION_ID`, pi `PI_SESSION_ID`, cursor
  `CURSOR_CONVERSATION_ID`; the `wf` launcher already reads them as the session's (story 002).
- Fact: a long blocking command is the harness's to wait on. Claude's Bash tool stops at 10 minutes,
  so a longer run goes through `run_in_background`, which reports back; codex polls a background
  terminal; pi's bash tool has no timeout unless given one; cursor's `is_background` reports back
  (2026-10-06, from the installed bundles). A harness that kills the command kills the run, which
  ends as any killed run does: no hand-back, its record as far as it got, its kept panes left.
- Fact: as the session's child, the run is in the session's sandbox. Under codex's default sandbox
  it cannot reach Herdr, so pane agents fail; the advice for `network_access` already exists, and
  `--here` starts the run outside it.
- Fact: pi's usage reader keeps the provider apart from the model; pi's models are written
  `provider/model`. Cursor's reader finds only awf's own headless turns, so an operator's cursor
  chat names no model (review of the first build, 2026-10-06).
- Fact: no record names what a fork came from; only `testWorkflow`'s `forkedFrom` does. Nothing in
  `output.json` or usage changes.
- Constraint: ADR 0009, a fork's copied rows stay its parent's; ADR 0010, a workflow's behaviour
  must not change quietly when a session appears, which is why this is a call and not a `caller()`
  that stops answering `null`.

## Proposed design

- **Contract.** `AgentDirectory.forkCaller(spec: AgentForkSpec): Promise<AgentRef | null>`, root
  scope only, as `caller` is. `null` when the run has no session to fork; the reason is in the run's
  output.
- **Engine, finding it.** Without `--here`, the operator runtime reads each harness's session
  variable from awf's own environment and keeps those whose session file the harness finds and was
  written within the last 10 minutes. One left: that is the session. None: `null`. More than one:
  the most recently written. Under `--here`, the id `--here` passed. No guard against a fork
  re-running the command it was copied mid-way through until M4 shows one does: a guard keyed on
  being a fork would stop a fork's own sub-workflow from forking it.
- **Harness, the fork.** One function, with no Herdr in it, forks a found session: the session file
  by its id, read once, for its directory and its last request's model (`provider/model` for pi);
  then the harness's `forkSession` there, or the session copied into the run's sandbox. A session
  whose files name no model, as an operator's cursor chat's do not, is none to fork: `null`, so
  `forkCaller(…) ?? open(…)` falls back. Under `--here` the pane is settled first. A fork the run
  closes on is stopped.
- **Runner.** The fork is opened as any fork is, with the session as a parent that has no key:
  `forkedFrom` is the caller. Its execution has no `caller`, and takes the fork's model. `forkedAt`
  starts a fork's spend window. Under `--here`, `forkCaller` and `caller().fork()` queue the same
  copy behind the caller's operations.
- **Lab.** `awf-lab` withholds the harness session variables from the `awf run` it starts, so an
  eval started from an agent's shell never forks it.
- **Testing.** `testWorkflow`'s `caller: { harness, model?, here? }`: the session that started the
  run, handed over unless `here: false`, so `caller: { harness }` means what it does today. With
  `here: false`, `caller()` is `null` and `forkCaller` works; `agentOf(key).forkedFrom` is
  `{ caller: true, turns }`.

Alternatives rejected:

- `caller()` answering for a waiting session, its `run` rejecting: it changes what shipped
  workflows get, and `caller() ?? open()` breaks.
- One handle, `session.fork()` and `session.agent()`: the same behaviour, replacing the approved
  `caller()`, its example and tests.
- `open({ from: "caller" })`, forking where it can and opening where it can't: what the workflow
  gets would depend on how the run was started, the quiet change ADR 0010 rules out.
- A recursion marker on every fork of the session: it stops a fork's own sub-workflow from forking
  it, against a loop not yet shown to happen (M4).
- `agents.origin()`, a separate ref: two names for one session.
- Building on each harness's background mode: only claude and cursor tell the model when a command
  ends; awf's own `--bg` is [[run-in-background]].
- A model the fork names: a fork on another model misses its parent's cache (ADR 0009).

## To measure

- **M1.** Codex: with two codex panes on one daemon, the `CODEX_SESSION_ID` in each tool call's
  shell is that pane's own session.
- **M2.** Each harness forks a session mid-tool-call, whose last row is the call that started the
  run, and the fork resumes cleanly.
- **M3.** Claude: a fork run from another directory than the session's, given the one its file
  records, finds it.
- **M4.** A fork, given its first prompt, does not re-run the command it was copied mid-way through.
  If one does, a guard is designed then.
- **M5.** Inside the session's sandbox (claude's, codex's), the fork writes its session in the
  harness's home. Where it can't, the refusal names `--here`.
- **M6.** Claude: a session on a 1M-context model logs the model without `[1m]`, so its fork is
  launched at the default context; past 200K tokens its first turn may overflow.

## Code map

- `packages/contract/src/workflow/agents.ts` — `AgentDirectory.forkCaller`.
- `packages/engine/src/operator-runtime.ts` — the session from the environment and the liveness
  check; the variables withheld from agents.
- `packages/engine/src/here.ts` — `--here` passes the id; `--session` keeps it.
- `packages/harness/src/adapters/fork.ts` — finding and forking a session by id;
  `herdr-caller.ts` settles the pane first under `--here`; `harnesses/*.ts`, `launchModel`.
- `packages/harness/src/adapter.ts` — `NativeFork.model`; the host's found session.
- `packages/engine/src/workflow-runner.ts` — `forkCaller`, the parent with no key, the model, one
  queue with `caller().fork()`.
- `packages/engine/src/run-usage.ts` — `forkedAt`.
- `packages/lab/src/review/lab/runner.ts` — the variables withheld; `tests/lab-session-variables.test.ts`
  keeps its list the harnesses'.
- `packages/engine/skills/awf-run/SKILL.md` — how each harness waits on a long `awf run`.
- `packages/harness/src/testing/fake.ts`, `packages/engine/src/workflow-testing/`.

## Tasks at a glance

- [x] 1. Forking a found session in the harness: by id, model and directory from its file
- [x] 2. The session from `awf run`'s environment and from `--here`; `forkCaller`
- [x] 3. Testing surface, the lab, the `awf-run` skill, ADR 0010's amendment, `workflow-api.md`
- [ ] 4. Live: M1–M6 run on claude, codex and pi; two findings below wait on a decision

## Verification

Automated: `bun test`, 1656 pass, 0 fail; `bun run check`, Biome, tsc and the boundaries clean.

Live, 2026-10-06, claude 2.1.292 on `claude-opus-5-5`, from this repository's own working
session: `bun awf run examples/fork-caller/workflow.ts`, without `--here`, typed in a worktree while
the session's own directory was the main checkout.

- [x] M2: the fork, copied mid-way through the tool call that started the run, resumed cleanly.
- [x] M3: it found the session from another directory, the one its file records.
- [x] M4: it answered in one turn and did not run `awf run` again.
- [x] It said what the session was working on, in its own words, on the session's model; 34 s,
  ~$0.26 at list prices on the subscription, and again after the review's fixes, 16 s. Its spend was its own requests only, 748k tokens read
  from the cache and 12k written: the copied rows stayed the session's, and the cache held.

Live, 2026-10-07, each caller started in a Herdr pane at its harness's defaults, given a codename,
then told to run the example and wait:

- [x] codex 0.160.1, two sessions at once (HERON, OSPREY), on `gpt-6.1-sol`: each fork named its
  own session's codename, 14 s and 17 s. M1 passed.
- [x] pi 0.87.1 (KESTREL): the fork ran on `openai-codex/gpt-6-sol`, the provider kept, 12 s.
- [ ] M5: inside codex's default sandbox (`workspace-write`, no network) `awf run` stops before
  any fork, at its run lock's `ps` (`runs.ts`, `processStart`): `awf: EPERM: operation not
  permitted, posix_spawn 'ps'`. Every `awf run` does, fork or not. Codex then asked to run it outside
  the sandbox, its reviewer approved, and the run passed. The refusal names neither the sandbox nor
  `--here`.
- [ ] claude on `claude-opus-5-5[1m]` (WREN): the first turn's run answered `null`, "files … name no
  model". Claude writes a request's row only once its tool call ends, so during a session's first
  turn its file holds no assistant row at all; the second turn's run passed, 20 s. The same timing
  leaves the current turn's tool call out of every claude fork: the copy ends at the prompt.
- [x] M6: the session's rows say `claude-opus-5-5`, and its fork ran on that, at the default
  context, not 1M. Overflow past 200K tokens not run.


## Review record

- Design review of the `caller().fork()`-only draft: the session picked up silently (fixed by
  making forking a call), recursion (measured instead, M4), stale ids (the liveness check), the
  model read hanging on a waiting session (read once), the sandbox and timeouts (said here).
- Code review of the first build: pi's provider (`launchModel`), cursor (no model, so `null`), the
  fork's time budget, codex's id (M1).
- Code review of this build: under `--here`, `forkCaller` rejected where it should answer `null`,
  and skipped the scope checks; a fork was not stopped with the run; the home was read from the
  process, not the runtime's environment; cursor rejected. All fixed.
- Review before merge: `testWorkflow` rejected `forkCaller` for a session with no model where a run
  answers `null`; now both answer `null`. Tests added for the newest of two live sessions, a fork
  cancelled before it copies, and `forkCaller` re-attached under its key.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Record the human's approval or requested changes here.
