---
id: "014"
title: Run a workflow from inside the session you are in
summary: "From a claude, codex, pi or cursor session in a Herdr pane, the operator starts a workflow with a command; the run starts outside the session's sandbox, takes the calling session over as one of its agents, opens any others it needs, and hands the session back when it ends."
type: story
status: awaiting-human-review
discovered_in: "conversation, 2026-09-30; experiments/e8-attach"
depends_on: []
---

# Run a workflow from inside the session you are in

## Outcome

The operator is working in an interactive agent session — claude, codex, pi or cursor — in a Herdr
pane. They invoke a command there and a workflow starts: `!awf run --here review-loop.ts`, a
generic `/awf-run review-loop.ts`, or a command made for one workflow, such as `/review-loop`,
that already names the workflow and its arguments. The session they invoke it from, the calling
session, becomes one of the workflow's agents. The workflow sends it turns and reads its answers
through `wf result` like any other agent's. It also opens other agents the usual way, in their own
panes or headless. When the workflow ends, the calling session is handed back to the operator with
its context intact, plus a last message saying how the run ended. When the calling session cannot
be driven, the command says why and what to do instead, and nothing starts.

Why: a long, scripted procedure, such as review then fix then re-review then summarize, can then
run on demand inside the session that already holds the context, instead of starting cold in a new
pane. The operator writes the procedure once as a workflow and calls it when they need it.

## How it works

```text
 calling session (claude/codex/pi/cursor)              new Herdr tab, outside any sandbox
 ─────────────────────────────────────────              ──────────────────────────────────
 /review-loop  or  /awf-run review-loop.ts
   └─ agent runs `awf run --here …` ──── herdr ────►  awf run review-loop.ts --session {code}
        prints: reply with {code}, end turn              │  progress view, as `awf run` today
 agent replies "{code}", turn ends                       ▼
                                          finds the one pane showing {code}, waits for it to settle
 ◄──────────── herdr agent prompt ─────── turn 1: "[workflow review-loop] …"
 agent works, runs `{run}/bin/wf result …` ─ socket ─► result accepted, validated
 ◄──────────── herdr agent prompt ─────── turn 2 …     (other agents in their own tabs)
 ◄──────────── herdr agent prompt ─────── "[workflow ended: answered] control is yours"
```

- **The command only starts the run.** It runs in the agent's shell, so it lives in the agent's
  sandbox, where it cannot write `~/.awf/runs` and, under codex's default sandbox, cannot reach
  Herdr. It asks Herdr to open a tab and run `awf run` there. A process Herdr starts runs outside
  the agent's sandbox. That tab is also where the run's progress view goes.
- **The run finds the pane by a code, not by environment.** Under codex, tools run in one shared
  daemon, so `$HERDR_PANE_ID` names whichever pane started it and Herdr's own session record can
  be wrong (E8). The command prints a one-time code and asks the agent to reply with it. The run
  takes the one pane whose screen shows it. Zero or several matches is a refusal.
- **The session is driven like a pane agent, but never owned.** Turns are delivered with Herdr's
  prompt and settled-state wait, and answered through the same result socket, schema validation
  and deadlines. The engine never starts, closes, compacts or kills that pane. A turn pushed while
  the session is busy is queued by every harness tested (E8).
- **The operator can take control back.** Esc on a driven turn leaves the session idle with no
  answer, which looks like an agent that forgot to answer. The run must not nudge it then. An
  interrupted turn settles `cancelled`, and the workflow decides what follows.

## Scope

In scope:

- The in-session command, `awf run --here`.
- A generic skill or slash-command file per harness that invokes it, and a command made for one
  workflow with its workflow and arguments fixed.
- A clear refusal, before anything starts, when the calling session cannot be driven: it is not in
  a Herdr pane, its harness is not supported, its sandbox cannot reach Herdr, or no pane shows the
  code. Each refusal says what to do instead.
- A run started for a session: its own Herdr tab, the session found by code, a deadline as usual.
- The calling session as one agent of the workflow, under a key the workflow names, with its turns
  answered through `wf result`.
- Interrupt and hand-back behaviour, and the final message.
- Accounting for the session's turns within the run only.
- Live evaluation on claude, codex, pi and cursor.

Out of scope:

- Sessions not in a Herdr pane, including the desktop apps, IDEs and plain terminals. Each needs
  another delivery channel: claude's Stop hook or messaging socket, pi's extension API, codex
  hooks. They are a follow-up todo; until then `--here` refuses there, as above.
- Driving any session but the calling one, including another pane's session.
- Resuming a workflow after the session restarts.
- More than one run driving a calling session at once.

## Context and evidence

- Fact: driving a session the engine did not start works. All four harnesses answered four
  dependent steps correctly through a `wf` named by absolute path. Context and prompt cache stayed
  warm, and a step pushed during a busy turn was queued
  ([E8](../../experiments/e8-attach/README.md)).
- Fact: under codex's default `workspace-write` sandbox, a command cannot connect to any local
  socket, Unix or TCP, inside or outside its workspace. With `sandbox_workspace_write.network_access`
  it can (E8). So `wf result` and the in-session command need that setting, or an escalation the
  operator approves. The engine itself starts codex with `danger-full-access`
  (`packages/harness/src/spec.ts`).
- Fact: `herdr agent prompt` can exit 0 having delivered nothing; delivery is confirmed by the
  transcript or the result, never the return value (foundation, E7).
- Constraint: [`composition.md`](../design/composition.md) makes a session the engine did not
  start an outside participant only: it never answers `result`, and "the engine has no operation
  through which to run an outside session". This story reverses that for the operator's own
  session and needs an ADR first.
- Fact: a pane agent already keeps one pane for all its operations, each prompted once the agent
  has settled ([ADR 0008](../adr/0008-a-pane-agent-continues-in-its-pane.md)), which is how a
  calling session is driven. What differs is that the engine never closes it.
- Decision (2026-10-01): the flag is `--here` and the concept is the calling session.
  `AgentDirectory.attach(key)` already means finding an agent the run opened, and Herdr's `attach`
  means the opposite direction, so neither is called "attach".
- Assumption: the operator's own approval covers the in-session command. E8 was started by an
  agent, so Claude Code's auto-mode classifier refused it. When the operator invokes the command,
  that refusal should not apply, but the harness's own sandbox still does. This is unverified.
- Assumption: pi and cursor under their own sandboxes behave like codex. Untested; E8 ran them
  unsandboxed.

## Code map

### contract

- Paths and symbols: `packages/contract/src/workflow/agents.ts` — `AgentDirectory`,
  `AgentOpenSpec`, `AgentPlacement`, `TurnOutcome`.
- Relevance: `AgentDirectory` gains `caller({ key })` and `AgentExecution` gains `caller?: true`
  (ADR 0010), landing with their implementation in task 2; `testWorkflow` gains a scripted
  caller.

### harness

- Paths and symbols: `packages/harness/src/adapters/herdr.ts` — `createHerdrRunHostFactory`,
  `openRun`, the pane adapter's `activate` and `execute`, `closeCurrentPane`;
  `packages/harness/src/spec.ts` — per-harness argv and session environment.
- Relevance: the pane adapter opens a pane per operation and closes it after. A session found by
  code needs a backend that delivers into a pane it does not own, never closes it, and reads an
  interrupt as `cancelled`.

### engine

- Paths and symbols: `packages/engine/src/operator-cli.ts` — `awf run` argument parsing;
  `operator-runtime.ts` — composition root; `agent-launcher.ts` — `installAgentLauncher`;
  `run-usage.ts` — the end-of-run spend read.
- Relevance: a run started with a session code; a launcher the session calls by absolute path,
  as pane agents already do; spend read only from the session's turns since the run started.

### wf

- Checked: `packages/wf/src/cli.ts` needs no change. The launcher supplies `--at`, and a calling
  session runs it by path.

## Proposed design

Settle the seam on paper first (task 1), because the contract type and the turn outcome on
interrupt are expensive to change later. The likely shape:

- **Command.** `awf run --here {workflow} [args]` in the agent's shell. It creates the code and
  asks Herdr to run `awf run {workflow} --session {code}` in a new tab of the caller's workspace,
  found from Herdr's own reply, not the environment. It prints the code and the instruction to
  reply with it. Before asking Herdr for anything, it checks that it can drive the calling
  session: a Herdr pane, a supported harness, Herdr reachable from its sandbox. Otherwise it
  refuses with the reason and the fix; under codex the fix names
  `sandbox_workspace_write.network_access`. The run refuses the same way when no pane, or more
  than one, shows the code.
- **Commands.** A generic skill or slash-command file per harness wraps `awf run --here`. A
  command for one workflow is the same file with the workflow and its arguments fixed, so the
  operator types `/review-loop` and nothing else.
- **Workflow surface.** `agents.caller({ key })` returns the session as an `AgentRef` under the
  key the workflow names, or `null` when the run has none; the ADR lists where its behaviour
  differs from an opened agent's.
- **Backend.** A Herdr backend for one found pane. It delivers each operation with `agent prompt`,
  confirms delivery by the result or the transcript, never closes the pane, and settles a turn
  whose screen shows the harness's interrupt marker as `cancelled`, without a nudge.
- **Hand-back.** When the run ends, however it ends, the session receives one final message with
  the outcome and the run directory. The pane is then the operator's again.

Alternatives rejected:

- The in-session command runs the engine itself — under codex the engine would inherit the
  sandbox and could reach neither Herdr nor `~/.awf/runs` (E8's first run).
- Find the pane from `$HERDR_PANE_ID` or Herdr's `agent_session` — both wrong under codex's
  shared daemon (E8).
- Pull loop: the session runs a blocking `wf next` — bounded by each harness's shell timeout, and
  the session stops at every end of turn unless a hook keeps it going. Kept as the fallback for
  sessions outside Herdr.
- Branch the session and drive the copy headlessly — re-pays context (foundation, E-series) and
  leaves the operator's pane out of date.

## Tasks at a glance

- [x] 1. ADR and design: the calling session as an agent, and its contract surface
- [x] 2. A Herdr backend that drives a found pane it does not own
- [x] 3. `awf run --here` and `--session`, its refusals, and the command files
- [x] 4. Interrupt, hand-back, and accounting for the session's turns only
- [x] 5. Live evaluation on claude, codex, pi and cursor

## Open questions

### 1. ADR and design

Settled in [ADR 0010](../adr/0010-the-calling-session-is-an-agent.md), approved 2026-10-01:

- The workflow calls `agents.caller({ key })`. It gets an ordinary `AgentRef` under a key it
  names, or `null` when the run has none. A reserved key, a new placement and a runnable
  participant were rejected.
- A workflow declares nothing. `caller()` returning `null` is the check.
- No instructions turn: the caller is not opened, so what it needs goes in its turn prompts.
- Also settled there: `compact` on the caller fails, `agents.stop` hands it back early, an
  operator interrupt settles `cancelled` and is never nudged, and `--here` is an `awf` command
  (task 3's last question).

### 2. Backend

- Interrupt markers: read for claude, codex and pi, as a line starting with the marker after the
  turn's own prompt (E8's follow-up); cursor's cannot be read, so its unanswered caller turns are
  not nudged by default.
- Typing into the pane mid-step: still not measured; ADR 0010 lists it.
- The code scan: kept across all agent panes, once a second, since the caller's workspace is not
  known before the pane is (codex's environment can name another). It found the pane within a
  few seconds live.

### 3. Command

- Codex's `network_access`: both. `--here` checks Herdr is reachable and refuses with codex's own
  advice (`HarnessSpec.localSockets`); the README says it too.
- Command files: the docs show the template. One skill, `awf-run`, serves every harness that reads
  skills; a per-workflow command is that skill renamed with the workflow fixed. `awf` writes none.
- ~~Is the command an operator `awf` command or an agent `wf` command?~~ `awf`: it starts a run,
  which is operator authority (ADR 0010).

### 4. Accounting

- One window: from the host's first prompt to the session (not the operation's delivery, which
  comes before the host waits out the operator's turn) to the run's own end. The operator's turns
  between steps still count; ADR 0010 says so.

### 5. Live evaluation

- None open.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. ADR and design: the calling session as an agent

Outcome: an accepted ADR and updated design docs say when a session the engine did not start may
be driven as an agent, how a workflow names it, and how its turns settle.

Execution:

- [x] Plan: read foundation's run host and operation-pane rules, `composition.md`, ADR 0001 and
  0005, and E8; list the contract options with what each costs to change later.
- [x] Implement: write the ADR; update `composition.md`, `docs/design/README.md` and foundation
  where they state the opposite; add the contract type only if the ADR settles it.
- [x] Review: architecture and scope, correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: the docs agree with each other and with E8; `bun run check` passes if contract
  changed.

Work:

- The ADR, the design doc edits, and answers to task 1's open questions.

Done when:

- The human has approved the ADR.

### 2. A Herdr backend that drives a found pane it does not own

Outcome: the engine runs turns against a pane named by code and settles them like any pane
agent's, without ever closing or killing it.

Execution:

- [x] Plan: inspect the pane adapter and its fake Herdr; settle the backend seam and its tests.
- [x] Implement: code lookup, delivery, settled-state wait, result confirmation, interrupt
  outcome, no close.
- [x] Review: architecture and scope, correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: focused tests against the fake Herdr, including zero, one and two panes showing the
  code, a turn pushed while busy, and an interrupt.

Work:

- The backend in `harness`, wired in `operator-runtime.ts`.

Done when:

- A workflow test drives a scripted found pane through answered, queued-while-busy and
  interrupted turns.

### 3. `awf run --here` and `--session`

Outcome: the operator types one command in their session, and the run starts in its own tab and
takes the calling session over, or the command refuses with the reason and the fix.

Execution:

- [x] Plan: argument shape, the Herdr calls, what the command prints, each refusal's message,
  the per-harness wrappers.
- [x] Implement: the two flags, the checks and refusals, the launcher by path, the generic and
  per-workflow command files.
- [x] Review: architecture and scope, correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: CLI tests for each refusal before anything starts (not in Herdr, unsupported
  harness, Herdr unreachable) and for a run whose code no pane shows.

Work:

- `operator-cli.ts`, a skill folder, generic and per-workflow command files for claude, codex, pi
  and cursor.

Done when:

- `awf run --here examples/quick-check/…` takes over the calling session under the fake Herdr,
  and each refusal prints its reason and fix with no run directory left behind.

### 4. Interrupt, hand-back, accounting

Outcome: the operator can stop a driven turn and get the pane back, every run ends with a final
message, and spend counts only the run's turns.

Execution:

- [x] Plan: settle the turn outcome on interrupt and the accounting window from task 1.
- [x] Implement: hand-back message on every run outcome, the bounded spend read.
- [x] Review: architecture and scope, correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: tests for answered, failed, timed-out and cancelled runs, and a session with turns
  before the run.

Work:

- Backend and `run-usage.ts` changes.

Done when:

- Each run outcome leaves the pane idle with one final message, and its spend excludes earlier
  turns.

### 5. Live evaluation

Outcome: a cheap live check proves the whole path on each harness.

Execution:

- [x] Plan: an eval workflow with dependent steps, a busy push and an interrupt; its cost.
- [x] Implement: the `*.eval.ts`.
- [x] Review: architecture and scope, correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: it passes on claude, codex, pi and cursor; record the cost in `docs/testing.md`.

Work:

- The eval, and E8's open measurements: a long step, typing mid-step, pi and cursor sandboxes.

Done when:

- The eval passes on all four harnesses.

## Verification

Automated:

- [x] Backend tests against a stubbed Herdr: code lookup (none, one, two, unsupported), settle
  before prompting, the operator's interrupt, the host's own interrupt only while its prompt is
  outstanding, no close, no compaction.
- [x] A workflow test with the session as a scripted agent.
- [x] `bun test`
- [x] `bunx tsc --noEmit`
- [x] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [x] The task 5 eval on claude, codex, pi and cursor; subscription sessions in panes, cheap
  models for codex, pi and cursor.

## Review record

### Tasks 2–5 (one review of the whole change)

- Architecture and scope, 12 findings:
  - Accepted and fixed: one run per session enforced with a mark per pane under the run root;
    the ADR's spend-window line; the contract doc and ADR now list five differences (failed
    turns too, and the nudge default); unit tests for the caller window, pi caller billing and
    placement routing; `findCallerPane` and `CallerSearch` unexported; codex's sandbox advice moved
    to `HarnessSpec.localSockets`; the E9 citation; `TestOptions.caller.harness` typed; a long
    comment wrapped; the hand-back's wording holds whether or not the workflow took the session;
    `leftFinishing` says why it exists beside `stopFinishing`.
  - Kept: the CLI's own short-timeout Herdr config beside the runtime's, which configures the
    run's agents, not one-off commands.
- Correctness and proof, 6 findings plus 2 hand-back gaps:
  - Fixed: an Esc could reach the operator's turn after a failed or stalled prompt, so the
    outstanding prompt is now numbered, cleared when its turn ends, and re-checked after the status
    read; a stalled prompt that runs out its deadline is interrupted. The spend window opened at
    delivery, before the host waited out the operator's turn, so it now starts at the host's first
    prompt (`HarnessSession.promptedAt`). The interrupt's Herdr calls are bounded at 2 s, under the
    release grace. A marker quoted mid-line no longer counts. `--here` loads and prepares the
    workflow before any tab opens, and a refused `--session` brings its tab forward. The hand-back
    names `output.json` only once it is written.
  - Accepted: a second Ctrl-C stops awf at once, without the hand-back, as it skips the rest of
    cleanup; an answered turn still finishing as the run ends counts only to the run's end.

### Task 1

- Architecture and scope: 11 findings, all accepted into ADR 0010. Cancel and timeout on a caller
  turn send one interrupt and leave the agent usable; `caller` rejects outside the root scope;
  the four behaviours that differ from an opened agent are listed, not denied; `caller?: true`
  marks the record; stop's single hand-back; the scripted caller in `testWorkflow`; an agent can
  start `--here` itself, accepted as a risk; the story's surface and code map follow the ADR;
  composition says "not an outside participant"; the hand-back is not an operation; `attach` on
  the caller's key.
- Correctness and proof: 9 findings, all accepted. Herdr starting the run outside the sandbox is
  marked unmeasured and needs Herdr reachable; the hand-back is promised only for ends the engine
  survives; an interrupt counts only when its marker follows this turn's prompt, and is
  conditional per harness; no stop-finishing Esc on the caller; a separate backend with no close;
  `agents.stop` is unbuilt; pi billing and the codex session id come from the session, not
  `execution.model` or Herdr's `agent_session`; the shell-timeout and cache claims are narrowed.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

- **Contract.** `AgentDirectory.caller({ key })` and `CallerSpec`; `AgentExecution.caller?: true`.
  No record version change: the field is optional.
- **Harness.** `adapters/herdr-caller.ts`: the code search over every agent pane, the caller host
  (a session adapter with no close, no compaction, and an interrupt only for its own outstanding
  prompt), `handBack`, `startInNewTab`, `herdrReachable`, `focusTab`. `HarnessSpec.interrupted` and
  `localSockets`. The placement host routes `execution.caller` to a third side. Session core gained
  `leftFinishing` and `promptedAt`.
- **Engine.** `agents.caller` and `attach` for its key; the caller is never closed after a failed,
  cancelled or timed-out turn; the default nudge is off where the interrupt cannot be read; the
  spend window. The CLI's `--here` checks, loads the workflow, opens a tab in the caller's
  workspace and prints the code; `--session` finds the pane, marks it driven, runs, and hands back.
- **Testing surface.** `testWorkflow`'s `caller: { harness }` and `reply.interrupted()`.
- **Assets.** `packages/engine/skills/awf-run/SKILL.md`; `examples/calling-session` with its test;
  `tests/calling-session.eval.ts` with `tests/fixtures/caller-steps.ts`.
- **Measured** (E8's follow-up in its README): each harness's interrupt marker, the prompt staying
  on screen, codex's `CODEX_SESSION_ID`, and claude refusing a standalone `sleep`.
- **Live, by hand:** pi and claude ran `examples/calling-session` end to end from a pane; codex in
  its default sandbox was refused, naming `network_access`.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
