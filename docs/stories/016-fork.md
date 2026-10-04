---
id: "016"
title: Fork an agent so new agents start from what it knows, from the cache
summary: "agent.fork({ key }) opens a new agent on a copy of the agent's session, taken by the harness's own fork with no model call; claude and pi forks read the parent's context from the provider's cache, with or without compaction first."
type: story
status: done
discovered_in: "story 015, the operator's review, 2026-10-01"
depends_on: []
---

# Fork an agent so new agents start from what it knows, from the cache

## Outcome

A workflow has one agent understand a task, then starts other agents from that understanding:

```ts
const worker = await workflow.agents.open({ key: "worker", runtime: "claude" });
await worker.run({ prompt: "Read the ticket and its doc, and plan the change.", schema: PLAN });
await worker.compact({ prompt: "Keep the plan and why; drop the exploration." });

const [security, tests] = await Promise.all([
  worker.fork({ key: "security" }),
  worker.fork({ key: "tests", placement: "headless", metered: true }),
]);
```

Each fork knows what the worker knew when it was forked, without re-reading the ticket, and its
first request reads that context from the provider's cache instead of paying for it again. That
holds with or without compacting first. The worker goes on, and neither sees what the other does
next.

Questions from the review, 2026-10-01:

- **Can a fork go from a pane to headless, and back?** Yes; a fork may name its own placement.
  - **Claude:** a pane worker's headless fork read 60,377 tokens from the cache, the same as its
    pane fork (F2). A headless worker forked into a pane reads only part of it: 26,454 read and
    17,502 written (task 3).
  - **Codex:** both directions work, and hit the cache under the parent's session id (F10).
  - **pi:** forks into a pane once pi runs in one
    ([story 017](017-pi-pane-agent.md)).
- **What is `compact`'s `id` for?** Only idempotency: a second `compact` with the same id returns
  the first one's outcome instead of compacting again, and a different spec under it is refused.
  `run` generates its id when none is given and defaults its deadline to the workflow's. `compact`
  required both, which is why the call read badly. It now takes `run`'s defaults:
  `compact({ prompt })`, with `timeoutMs`, `deadline` and `id` optional (ADR 0007, amended in the
  review of story 015).
- **Is the context size exposed?** Not to a workflow. Each harness logs it:
  - per request, as that request's input tokens;
  - claude's `compact_boundary` also records the tokens before and after.

  awf reads both only after the run, for spend. Showing it on an operation's outcome, a fork's and a
  compaction's included, is [`context-size`](todo/context-size.md). ADR 0007 left the same question
  open for compaction.

Today the only way to hand context on is a prompt the workflow writes, or a fresh agent rebuilding
it with its tools. The operator's ticket workflow opens reviewers cold beside an implementer that
already knows the change.

## How it works

```text
 workflow                        engine                         harness
 ────────                        ──────                         ───────
 worker.run(plan) ─────────────► turn 1 ──────────────────────► session W
 worker.fork({ key: "tests" }) ► fork, after turn 1 ───────────► fork W, no model call ─► session T
                                 open "tests" on T             (claude: /cost with --fork-session;
                                                                codex: app-server thread/fork;
                                                                pi: rpc --fork, keeping W's id)
 tests.run(…) ─────────────────► turn 1 of "tests" ───────────► resume T: the first request reads
                                                                W's prefix from the cache
 worker.run(…) ────────────────► turn 2 of "worker" ──────────► resume W; T never sees it
```

- **The copy is taken when the fork is asked for.** A fork queues after the agent's earlier
  operations, as a compaction does. It runs the harness's own fork with no model call, so its
  point is fixed then, not when the fork's first turn runs
  ([F7](../findings/fork-cache.md#f7--a-fork-with-no-model-call)). The new agent's first operation
  resumes that session.
- **A fork is an agent like any other.** It has its own key, result channel, turns, compactions,
  forks and usage. It is opened in the parent's working directory and sandbox, with its harness,
  model and skills. It may take a different placement: a pane worker can fork headless reviewers
  and still hit the cache (F2). Its `instructions` go with its first turn.
- **Cache, by harness** (measured, [`fork-cache.md`](../findings/fork-cache.md)):
  - Claude forks hit in every placement, because claude resends its recorded system prompt.
  - pi's fork hits only when it keeps its parent's session id, which is its provider's cache
    key, so awf forks it into a session directory of the fork's own under that id.
  - Codex's fork hits once its rollout carries its parent's session id, the key codex caches by
    (F10; found after closing, below).
- **After compaction**, a fork reads the system prompt and tools from the cache and writes the
  summary once, which compaction made small (F3).
- **Usage.** A fork's session file begins with its parent's rows (claude, pi) or refers to them
  (codex); the run-end read already gives copied rows to the parent, which opened first (F8). The
  fork itself calls no model and has no operation record.

## Scope

In scope:

- `AgentRef.fork(spec)` and `AgentForkSpec` in `contract`.
- The harness's own fork, with no model call, on claude, codex and pi; continuing a forked
  session headless (all three) and in a pane (claude, codex).
- A fork whose harness home differs from its parent's: a sandboxed agent, and codex given skills
  on the host. Its session's files are carried into its own home. Until that task lands, such a
  fork is refused, so no session is ever left in a home another agent's usage is read from.
- Claude's printed cost read as the turn's, not the session's running total (F9). A fork's first
  turn would otherwise charge its parent's whole session again; headless claude's later turns do
  so already. pi's, which counts one request of a turn, read as the whole turn's.
- Forks in `agentswf/testing`, and a live eval on every harness and placement, with and without
  compaction, that checks the fork answers from its parent's context and reads the cache where
  the findings say it does.

Out of scope:

- Cursor: its CLI has no fork; its TUI's "Fork Chat" is unmeasured.
- Forking at an earlier point than now (codex `lastTurnId`, claude message uuids).
- A fork with another model, sandbox or set of skills.
- Warming the cache at a compacted fork point so siblings share the summary: one summary per child
  is the whole loss.

## Context and evidence

- Fact: every number above is in [`findings/fork-cache.md`](../findings/fork-cache.md), F1–F9,
  measured 2026-10-01 with the research behind it (claude's prompt-caching docs; codex's
  `prompt_cache_key` in `core/src/client.rs`; pi's `sdk.js`).
- Fact: a fork of a compacted session answers from the compacted context on claude, codex and pi
  ([C10](../findings/native-compaction.md)).
- Fact: run-end usage claims each request key once, for the first agent read, in the order agents
  opened (`packages/engine/src/run-usage.ts`, `settleUsage`).
- Constraint: foundation §7 and §10 deferred fork until E7's cost split was settled, and ADR 0001
  removed its capability flag. [ADR 0009](../adr/0009-a-fork-is-a-new-agent-on-a-copy-of-the-session.md)
  replaces the deferral with the measured split; no flag comes back.
- Constraint: `contract` stays pure; the fork's native mechanics live in `harness`, the logical
  agent in `engine` (foundation §7's row for fork).
- Assumption: claude's `/cost` stays a local command that writes the forked session without
  calling the model. The live eval catches it if not.
- Assumption: pi on an Anthropic model hits on a default fork, as claude does. Not measured; the
  session-id fork is used for every pi provider, which costs nothing where it is not needed.

## Code map

### contract

- `packages/contract/src/workflow/agents.ts`: `AgentRef` gains `fork`; add `AgentForkSpec`.
- `deadlines.typecheck.ts` and the API samples test: a fork needs no deadline.

### harness

- `src/spec.ts`, `HarnessSpec`:
  - `forkSession?(sessionId, context)`: the fork with no model call, and how to read the new
    session's ref (and, for claude, its running cost) out of its output.
  - `interactiveResume(sessionId, model, launchArgs)` for claude and codex panes.
  - `sessionFiles(home, ref, cwd)`: the files a session is made of, to carry into another home.
    Claude: the transcript and its subagent directory. Codex: the fork's rollout and every rollout
    its `history_base` chain names. pi: the file.
  - pi's `resumeTurn` must take a session file path as well as an id.
- `src/adapter.ts`: `HarnessSession.fork(deadline)` returns a `NativeFork`, a harness-package
  type the engine passes on unread, and `HarnessActivation.continues?: NativeFork` names the
  session a new agent resumes instead of starting one. Activation refuses one whose harness is not
  the agent's.
- `src/session-core.ts`: `fork` queues like `compact` (after a finishing turn) and refuses before
  the first turn; a session activated with `continues` starts with that ref.
- `src/adapters/direct-process.ts`: runs the fork plan through the occupant, as a turn would. The
  first turn of a continued session resumes it and still carries the instructions.
- `src/adapters/herdr.ts`: a pane parent's fork runs the same headless plan once the pane has
  settled. A continued pane agent launches with `interactiveResume`.
- `src/usage/pi.ts`: a fork is read by its file's path. Its id is its parent's, and the lookup by
  id never reaches `sessions/awf-forks/`, two levels below the root (measured, F6).
- `readCharge` and the headless backend: claude's charge becomes the running total less the
  session's previous one. The first baseline is the session's last `cost-state` row, which covers
  a session resumed from before the run and a fork, whose copy carries its parent's. pi's sums
  every `turn_end` of the turn.

### engine

- `src/workflow-runner.ts`:
  - `fork` reserves the key in the run's agents at once, as `openAgent` does, so two forks or a
    fork and an open of one key never build two agents. The native fork queues in the parent's
    operation chain; the child is opened after that slot ends, so its pane or sandbox never holds
    the parent's queue.
  - `WorkflowContext` opens the child through `openHostAgent` or `openSandboxedAgent`, with the
    parent's identity and `continues`.
  - An existing key is checked against the parent and the spec.
  - The progress view gets a fork line.
- `src/sandboxes.ts` and `src/sandbox-homes.ts`: a fork in a sandbox is seated in its parent's,
  with the session's files copied into its home before it is admitted.
- `src/workflow-testing/`: the fake session forks, a fork is scripted by its own key like any
  agent, and `OpenedAgent.forkedFrom` names the parent and how many of its turns came before.

### Checked and unchanged

- `src/run-usage.ts`: copied rows are claimed by the parent already, since a parent always opens
  first and must have had a turn to fork.
- `wf`, `sandbox` providers, `lab`: nothing forks there.

## Proposed design

```ts
export interface AgentForkSpec extends PlacementChoice {
  /** The new agent's key in this run. */
  key: AgentKey;
  /** Given with its first turn; it already knows what this agent was told. */
  instructions?: string;
  labels?: JsonObject;
}

export interface AgentRef {
  // …
  /**
   * Opens a new agent on a copy of this agent's session, taken after its earlier operations: it
   * starts knowing what this agent knew then, and from then on neither sees the other's turns. It
   * has this agent's harness, model, working directory, sandbox and skills, and this agent's
   * placement unless it names one. Rejects before this agent's first turn and where the harness
   * cannot fork. The same key with the same parent and spec returns the same agent.
   */
  fork(spec: AgentForkSpec): Promise<AgentRef>;
}
```

- **No deadline or id.** The fork is bounded by the workflow scope, as `agents.open` is by
  default, and the key is its idempotency. Opening takes seconds.
- **The seam.**
  - `HarnessSession.fork(deadline): Promise<NativeFork>`, where `NativeFork` is opaque to the
    engine; it carries the new session's ref and, for claude, the cost its fork printed.
  - `HarnessActivation.continues?: NativeFork`. The engine passes it back unread, so the harness
    owns everything native about a fork.
- **Failure.** Each failure rejects `fork`, the way `agents.open` rejects:
  - a harness with no `forkSession`;
  - a parent that has not had its own first turn, checked once any finishing turn has ended. A fork
    that has not run cannot be forked: its instructions are not in its session yet;
  - a pane parent whose harness never named its session;
  - a parent with a harness home of its own, until task 5;
  - a fork plan that exits without a new session;
  - a parent that was stopped or closed.

  Nothing is left behind: a forked session no agent opened is a file the run never reads. A child
  that fails to open after its session was forked is reported as `agents.open` reports one.
- **Where pi's fork lives.** It is `sessions/awf-forks/{uuid}/` in the home the fork runs with:
  under the root, so the usage reader's root check holds, and two levels down, so pi's lookup by
  id never finds it. The parent's id is reused there, so the provider's cache key is the parent's.
  The fork's ref is its file's path, which `pi --session` takes and the reader resolves.
- **A fork answers through its own channel.** Its copied context holds the parent's `wf` commands,
  with the parent's launcher path and call ids. Every turn's prompt names the fork's own launcher,
  so a fork that follows it answers correctly. One that reuses the parent's command reaches the
  parent's socket. The control plane refuses that result, since the call is not that agent's. But
  it first records the session that sent it as the parent's. That would make the parent claim the
  fork's usage at run end. So a session the harness reports for a fork is dropped from its
  parent's reported sessions. The engine compares those ids for equality only and never reads
  them.
- **A pane parent's fork** runs the same headless fork plan once the pane has settled, and only
  once the parent's session reads as closed where the harness's usage reader can tell (codex), so
  the copy holds the parent's last turn. The session is the one the pane's harness named to Herdr.
  The id the agent reported through `wf` is never used for it, since that would carry native
  identity back across the seam.

Alternatives rejected:

- `agents.open({ key, from: worker })`. It makes the open spec carry a runtime the fork may not
  change, and loses the ordering in the parent's queue that `worker.fork` states.
- Forking lazily, at the child's first turn. The parent may have moved on by then, so the fork
  would see turns after the point it was asked for. Holding the parent's queue until the child's
  first turn deadlocks a workflow that runs the parent first.
- Copying session files to fork. That is the harness's format, and a fork the harness makes
  survives its format changing. Files are copied only between homes, where no harness command can
  reach.
- A codex fork on `exec fork` with the child's first prompt. It runs a turn to make the fork, so
  the fork point is not fixed.
- A capability flag. Rejected for the same reason as in ADR 0001, and not needed: every harness
  that forks, forks.

## Tasks at a glance

- [x] 1. Each headless claude or pi turn charges what it cost
- [x] 2. A headless claude agent forks, end to end
- [x] 3. Forks in panes and across placements: claude and codex
- [x] 4. Headless codex and pi fork
- [x] 5. A fork whose home differs from its parent's: sandboxes and codex's skills home
- [x] 6. A live eval of forks on every harness and placement, with and without compaction

Each slice from 2 on lands its seam with the code that uses it, as ADR 0001 asks of anything that
returns to the surface.

## Open questions

None. Decided by the operator, 2026-10-03:

- **ADR 0009** is approved, so `AgentRef.fork` and `AgentForkSpec` are settled before code.
- **A parent in a private sandbox:** its forks share that sandbox, as forks on the host share the
  machine.
- **Skills:** a fork uses its parent's copy, not a fresh one (ADR 0004 would give it its own). Its
  context is its parent's, skills included, so the prefix and the cache stay its parent's.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

Every task runs the same checklist:

- [ ] Plan.
- [ ] Implement.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve.
- [ ] Verify.

### 1. Each headless claude or pi turn charges what it cost

`compact` taking `run`'s defaults was planned here; the review of story 015 asked for it, and it
shipped there (ADR 0007, amended).

Outcome:
- A headless claude agent's operations each charge what their own turns cost, not the session's
  total so far (F9).
- A pi agent's turn charges all its requests, not the last one's.

Work:

- The headless backend keeps the session's last running total. A turn's charge is the new total
  less that one. A new session's first baseline is nothing; a fork's is the total its fork printed
  (task 2).
- pi's `readCharge` sums the turn's `turn_end` costs.

Done when:

- `direct-process` tests charge each of these by the difference:
  - two turns;
  - a nudge;
  - a compaction;
  - a resume that started a session of its own, which charges all it printed;
  - a total that drops, which charges the new total rather than a negative.
- A live headless claude run with two turns and a compaction charges each near its own tokens'
  list price.

### 2. A headless claude agent forks, end to end

Outcome: a workflow forks a headless claude agent, and runs both; a workflow's test scripts the
fork.

Work:

- `AgentForkSpec` and `AgentRef.fork` (ADR 0009).
- A fork uses its parent's skills copy; the engine copies none for it.
- `HarnessSpec.forkSession` for claude, `HarnessSession.fork`, `HarnessActivation.continues`. A
  continued session's first turn resumes it and carries the fork's instructions, and its ref seeds
  the sessions the core has seen.
- The engine: the key reserved at call time, the native fork in the parent's queue, the child opened
  after it; the progress line; and every refusal above.
- The fake host's fork and `OpenedAgent.forkedFrom`.
- `examples/fork` with its test; `docs/design/README.md`; foundation's rows; `status.md`.

Done when:

- Engine tests cover:
  - the fork point: a turn enqueued before the fork is in it, one after is not;
  - a fork's result through its own channel accepted; one sent through the parent's refused, and
    its session not counted as the parent's;
  - idempotency and conflict by key, a fork racing an open of its key included;
  - a fork of a fork, and a fork refused before its own first turn;
  - usage attribution with copied rows, the zeroed row after compaction included (F8).
- `awf test` passes `examples/fork`.
- A live run forks once and checks that the fork plan printed `num_turns` 0 and that the fork's
  transcript gained no request before its first turn.

### 3. Forks in panes and across placements: claude and codex

Outcome: a pane agent forks into a pane or a headless agent, and a headless agent into a pane.

Work:

- `interactiveResume` for claude and codex, and for pi (`pi --session {fork file}`) once
  [story 017](017-pi-pane-agent.md) runs pi in panes; the Herdr adapter launches a continued
  agent with it.
- `forkSession` for codex (app-server `thread/fork`).
- A pane parent's fork, after it settles, on the session its harness named.

Done when:

- Adapter tests cover:
  - a pane launched on `interactiveResume`;
  - a pane parent's fork waiting out its turn;
  - a refusal when the pane named no session.
- `examples/fork` runs live with a pane worker.

### 4. Headless codex and pi fork

Outcome: headless codex and pi agents fork, pi keeping its parent's cache key.

Work:

- pi's `forkSession` (rpc `--fork` into `sessions/awf-forks/{uuid}/` under the parent's id), its
  `resumeTurn` on a path, and its reader.
- Codex's headless continuation is the `exec resume` it already has.

Done when:

- Fixtures from the F7 probes pass.
- pi's reader test has a parent and two forks sharing its id, with the fork directory listed
  first: each read finds only its own file.

### 5. A fork whose home differs from its parent's

Outcome: a sandboxed agent forks into its sandbox, and codex given skills on the host forks, each
fork's session in its own home.

Work:

- `HarnessSpec.sessionFiles`, including codex's `history_base` chain.
- The parent's session files are copied into the fork's home before it is admitted, and the native
  fork runs there, through the fork's occupant. So nothing is added to the parent's home, whose
  every session is read as the parent's.

Done when:

- Sandbox tests with the fake provider pass.
- A live srt run forks a sandboxed claude and codex agent, each answering from its parent's
  context.

### 6. A live eval of forks on every harness and placement

Outcome: `tests/fork.eval.ts` runs `examples/fork` on:
- claude headless and in a pane, and across a placement change;
- codex headless and in a pane;
- pi headless.

Each runs with and without compaction.

Work:

- The parent reads a document, which is then removed, and learns one more fact after the fork. Each
  fork must answer from the document, and must not know the later fact.
- Every fork's answer must arrive as an accepted result through its own channel, with a structured
  schema, so a fork that reached for its parent's `wf` command fails the eval. The parent's next
  answer must arrive through its own channel too.
- The eval reads each fork's first request from its usage. Claude and pi must read most of the
  parent's prefix from the cache; codex's is recorded, not asserted. The questions are about text
  codex was actually shown.
- `docs/testing.md` gets its cost.

Done when:

- The eval passes, and `fork-cache.md` cites its run.

## Verification

Automated:

- [x] The tests named under each task.
- [x] `bun test`
- [x] `bunx tsc --noEmit`
- [x] `bun run check`

Manual or live evaluation:

- [x] `tests/fork.eval.ts`: all twelve cases passed, about $1.40 at list prices on sonnet 5.5,
  gpt-6-luna and gpt-5.6-terra, the headless claude's share billed per token.

## Review record

### Design, 2026-10-01

- Architecture and scope. One blocking finding: pi's lookup by id could return a fork's file for
  its parent. Forks now live two levels down and are read by path (measured). The should-fixes:
  - **Concurrent forks of one key:** the key is reserved at call time.
  - **Opening a child inside the parent's queue:** it is opened after the parent's slot.
  - **ADR 0001's "same change":** the tasks are cut by vertical slice.
  - **Homes that differ:** refused until task 5, which forks in the child's home.
  - **A pane fork missing the last turn:** it waits for the session to settle, and refuses with
    no named session.
  - **An unrun fork's instructions:** it cannot be forked until its own first turn.
  - **`NativeFork`:** a harness type, checked against the agent's harness.

  It also suspected claude restores a running cost from shared state. It does not: the total is in
  the session's own `cost-state` rows.
- Correctness and proof. It confirmed every figure against the raw files. It corrected:
  - F4: the system prompt is about 17.8k, and the forks read 7–17k of it.
  - F2: only a pane parent was tried.
  - F3's breakpoint wording.
  - F8: after compaction claude copies from the boundary on.
  - C1's printed cost.

  It added to the proof plan:
  - forks must answer without the file;
  - the fork point is checked live;
  - `/cost` is checked to stay out of the model;
  - task 1's live check includes a compaction.

  It found pi's charge counts one request of a turn, now in task 1. The evidence is archived in
  `experiments/_archive/f-fork-cache/`. pi's whole recipe was then measured as one: 800 / 30,208.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled: ADR 0009, approved
  2026-10-03.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

### After closing, 2026-10-04: codex forks hit the cache

- The operator questioned codex's miss. A resumed codex thread keys its cache by its rollout's
  `session_meta.session_id`, which a fork sets to its own id and codex's subagents to the root's
  (F10). Codex's `forkSession` now rewrites the fork's to its parent's once the app-server has
  exited (`inheritCodexSessionId`), replacing the rollout rather than writing through it, and only
  where it is a file of its own under the agent's home.
- Usage told a subagent from such a fork by `session_id` alone, which would have read the fork's
  spend as its parent's; a subagent's `source` is an object, a fork's a string.
- `tests/fork.eval.ts` now asserts the cache share for codex too. Live: codex 0.97 in a pane, 0.90
  headless, 0.97 and 0.94 compacted; both srt-sandboxed cases read 19,968 of ~22k.
- `codex-app-server-agent`, a todo whose only reason was this miss, is removed.

### Task 6, 2026-10-03

- `tests/fork.eval.ts` runs `examples/fork` on twelve cases: claude in a pane and headless, across
  a placement change both ways, each with and without compaction where the story asks; codex in a
  pane and headless, with and without; pi headless, with and without.
- **The facts are in the parent's prompt, not a document it reads and loses.** A fork answers
  without running anything, and nothing but its copied context holds the codename, which is what a
  removed document was to prove.
- **The cache is read per operation, not per request**: the run record keeps no request alone. A
  claude or pi fork's first turn must read at least half its prompt from the cache. Codex's is
  recorded, not asserted, and its share is high only because the turn's later requests hit codex's
  own cache (F4).
- Live: all twelve passed, ~$1.40 at list prices; pi's two once its login was renewed. First-turn cache shares: claude
  0.98 in a pane, headless and pane to headless, 0.80 headless to pane and pane compacted, 0.71
  headless compacted; codex 0.55–0.92; pi 0.91, and 0.98 compacted.

### Task 5, 2026-10-03

- **The fork point is fixed by a copy.** When the parent has a harness home of its own (a
  sandbox, the run's sandbox, or codex given skills on the host), the engine hands
  `HarnessSession.fork` a `SessionCopy` directory in the run directory. In the parent's queue, after
  any finishing turn, the harness copies the session's files there, as `HarnessSpec.sessionFiles`
  names them by their paths in the home: claude's transcript and subagents', codex's rollout and
  its `forked_from_id` chain, pi's file. It answers a `NativeFork` marked `copied`.
- **The child is seated where its parent is**: in the parent's sandbox, its private one too
  (`RunSandboxes.seat` `joins`, refused once that sandbox closed), or for codex on the host in a
  home of its own with the same skills. The copy is placed in its staged home before it moves into
  place, never over a seeded file, then removed.
- **The fork is made in the child's home, through its own place**, as it is activated, bounded by
  a minute of its own. So nothing is added to the parent's home, whose every session is read as the
  parent's. The child's home holds the parent's session too, whose requests the parent, read
  first, has claimed already.
- `HarnessActivation.home` names the agent's harness home, and `TurnContext.home` gives it to a
  plan: pi's fork finds its parent and writes its fork there. Docker mounts `homes/` at the same
  path inside, so host paths hold in a box.
- Copying out of a home a sandboxed agent can write: every directory on the path is checked for a
  link, and each file is opened without following one and taken only as a regular file with one
  link, so a link swapped in after the check, a FIFO or a hard link are refused.
- **Skills deviation:** a fork in a home of its own gets its own copy of its parent's skills,
  since one home's files are not another's; ADR 0009's note says so.
- **A claude pane in a sandbox names no session to Herdr either**, live, so claude gained the
  lookup codex has: the transcript in the agent's directory since its launch holding the
  operation's id. Both read the agent's own home.
- Live, under srt: claude-headless+sandbox, codex-headless+sandbox, codex+sandbox, claude+sandbox
  and claude-headless>pane+sandbox all passed. The parent's home kept only its own session, the
  fork's held the copy and its own; claude's headless fork read 16,097 from the cache and wrote
  481. pi in a sandbox waits on pi's login with the rest of pi.
- Review: nothing blocking. Fixed: pi's fork in another home, the copy race (no-follow open), the
  overwrite, the activation fork's bound, the copy left behind, a closed parent sandbox, the
  accounting comment.

### Task 4, 2026-10-03

- pi's `forkSession`: a turnless rpc fork of the parent's file into
  `sessions/awf-forks/{uuid}/`, keeping the parent's id, its provider's cache key (F6, F7). Its ref
  is the new file's path, from `get_state`'s `sessionFile`. Finding the parent's file from an id
  reads pi's sessions, so `forkSession` may answer a promise.
- pi's resume, compaction and pane launch take `--session {path}` for a fork, whose id is its
  parent's. A session the plan names, or on a failure the one resumed, wins over the id pi
  prints, which for a fork is the parent's and would point the next turn at it.
- pi's `interactiveResume` landed here, with the fork it continues (moved from task 3).
- Codex's headless fork shipped with task 3, on the app-server fork and the `exec resume` it had.
- A sandboxed headless agent refuses to fork in the harness too, until task 5: its session is in
  the sandbox's home. Task 5 must not write a fork into the parent's home, whose `homeSessions`
  are all read as the parent's.
- The F7 probes' `get_state` row was archived truncated, without `sessionFile`, so the pi plan is
  tested against the shape pi's rpc mode writes (`rpc-mode.js`), not a recording.
- Review: one blocking finding, a failed fork resume could fall back to the parent's printed id;
  fixed and tested. The live run must check: the fork's path from `get_state`; its first request
  reads the cache; `pi:compact` compacts the same file; a pane parent forks from the path Herdr
  names; the parent's id still resolves to its own file afterwards.
- Live, once pi's expired login was renewed (2026-10-03; [[expired-login]] records the failure
  mode): pi, pi>pane, pi-pane, pi-pane>headless, pi:compact and pi+sandbox all passed. Each fork
  is a file under `sessions/awf-forks/{uuid}/` keeping its parent's id, and its first turn read
  0.91 of its prompt from the cache, 0.97 compacted. pi in a sandbox read nothing from the cache,
  its parent no more than its fork: a sandbox matter, not a fork's.
- **A pi fork answers under its parent's id**, which its `wf` launcher reports, so a fork's record
  drops any session its parent has, unless its own harness saw it.

### Task 3, 2026-10-03

- `interactiveResume` for claude and codex, derived from their `interactive` launch; codex's
  `forkSession` on its app-server (`thread/fork`, stdin held until answered), which also gives
  headless codex its fork, continued by the `exec resume` it had. One `adapters/fork.ts` runs a
  fork plan for both hosts.
- A pane parent is forked beside its pane, without the credentials a pane is kept from, once its
  agent has settled and, where the usage reader can tell (codex), its session's last turn is
  written. A pane agent continues a fork by launching on it; a harness with no
  `interactiveResume` refuses one.
- **Deviation: a codex pane's session is found by its operation's id.** Live, Herdr named no
  session for an awf-started codex pane, as E8 found under its shared daemon. So
  `HarnessSpec.findSession` (codex) reads the rollouts started in the agent's directory since its
  pane launched and takes the earliest that holds the operation id every prompt carries. It is the
  harness reading its own files, and nothing native crosses the seam; the id the agent reports
  through `wf` is still never used.
- The session core tells "its harness never named its session" from "before its first turn", and
  a failed turn no longer counts as the agent's own first: it may not have reached the session.
- **pi's `interactiveResume` moves to task 4**, with the pi fork it would continue.
- **Claude panes, fixed here at the operator's request.** Claude Code 2.1.288 shows a prompt of
  more than about three lines that Herdr pastes as `<pasted_content>`, and sonnet will not act on
  instructions with no words of the operator's outside the paste: every claude pane agent, the
  compaction eval's too, ended unanswered. Measured live: one, two and three-line prompts ran, an
  eight-line one was refused. Now a harness that `pastesQuoted` (claude) has a prompt of several
  lines typed with `herdr pane send-text`, then a line of its own, "Do what the text above asks.",
  submits it as one message. Checked live with 8 lines, 5.8 KB, a prompt starting with `/` and one
  holding `@path`. It covers awf's panes and the calling session; `/compact` stays one line.
- Live, `examples/fork` passed every case: claude, claude>headless, claude-headless>pane,
  claude:compact, codex, codex>headless, codex-headless>pane, codex-headless:compact. Claude's
  forks' first requests: pane to pane 42,699 read / 1,127 written, pane to headless 42,682 /
  1,501, headless to pane 26,454 / 17,502 (recorded in F2), compacted 27,175 / 18,233.
  `tests/compaction.eval.ts claude codex` passed after the prompt change.
- Review (both lenses): nothing blocking. Fixed: the failed-turn rule above; the codex lookup
  reads only day directories since the launch and matches the directory and start time, so an
  operator's earlier session is never taken; `pastesQuoted` a flag with the line in Herdr's
  protocol; tests for the open-session wait and the codex lookup. Accepted: a prompt that fails
  after it was typed leaves its text in the box, and the pane is closed with the failed
  operation; in the calling session it stays in the operator's box.

### Task 2, 2026-10-03

- Built as designed: `AgentForkSpec` and `AgentRef.fork` in contract; `NativeFork`,
  `HarnessSession.fork`, `HarnessActivation.continues` and claude's `forkSession` in harness; in
  the engine the key is reserved at call time, the native fork queues in the parent's operations
  and the child opens after it, on its parent's copy of its skills. The progress log prints
  `↳ {fork} forked from {parent}` once the copy is made.
- `forkSession` takes the new session's id from the backend, as a headless turn takes its hint, so
  claude writes the copy where awf chose.
- **A fork that was not made frees its key.** A rejected native fork, as before the parent's first
  turn, removes the reservation, so the same key may be forked once the parent has run. A child
  that fails to open after its fork was made keeps its key, as an `agents.open` that failed does.
- **The native fork is bounded by a minute of its own**, inside the workflow's deadline: it asks
  no model, and an unbounded one would hold the parent's queue.
- **A fork whose harness printed no total charges its first turn nothing** rather than its parent's
  spend; later turns charge their difference as usual.
- **The instructions go with the first turn, not a compaction**, a forked session's too.
- **Refusals, in order:** the calling session; a parent with a harness home of its own (a sandbox,
  a run sandbox, or codex given skills on the host), until task 5; a host with no fork (cursor,
  panes, and headless codex and pi until tasks 3 and 4); the parent closed; and, in the harness,
  before the parent's own first turn.
- **Deviation, until task 3:** a fork into a pane is refused by the pane host after the native fork
  ran, since the engine does not know what a host continues. The copy is a session file nothing
  reads, in the parent's claude home.
- `metered` is consent per agent: a fork naming a placement names its own `metered`; one naming
  neither keeps its parent's.
- The fake adapter forks where told to, names a session on every turn as a real harness does, and
  continues a forked session; the workflow-testing host forks headless agents whose harness forks.
- Live: `examples/fork` with `claude-headless claude-headless:compact` on sonnet 5.5, 28 s, about
  $0.36 at list prices. Both forks recalled the parent's vault code and not the gate code told
  after; both workers recalled both. Each fork's transcript holds its parent's rows, then its own
  first request, with nothing between: the fork asked no model. The plain fork's first request read
  26,445 tokens from the cache and wrote 979 (F1); the compacted one read 12,191 and wrote 16,120,
  the summary (F3). Each fork charged only its own: $0.019 and $0.076, from its parent's total at
  the fork. The review fixes after that run (the bound, the freed key, the unknown baseline) were
  checked by tests only.
- Reviews (architecture and scope; correctness and proof): nothing blocking. Fixed: the freed key,
  the bound, the unknown baseline, instructions after a compaction, the close race, a test for the
  home refusal, a sharper usage test, a progress line only once forked, `deadlines.typecheck.ts`.
  Recorded: the pane deviation above. The "parent's channel" test proves what a fork can actually
  reach, a call id from its copied context, which the control plane refuses.

### Task 1, 2026-10-03

- Claude's printed total is read by a reader of its own, `HarnessSpec.readCostTotal`, so both
  readers stay pure and the running total lives with the activation that owns the session.
  `readCharge` keeps meaning the turn's, which pi and cursor print.
- **The first baseline is not read from the session's `cost-state` rows.** No headless path resumes
  a session its backend did not start: `session-core` learns its ref only from an outcome. The one
  that will, a fork, prints its parent's total when it is made (F7, F9), so `NativeFork` carries it
  and task 2 seeds the baseline from that. Nothing reads claude's transcript for cost.
- A resume that comes back under another session id is a new session, charged all it printed.
- A total below the last is charged whole, not as a negative.
- Differences are rounded to a billionth of a dollar, to keep subtraction's float noise out of the
  records.
- pi prints a `turn_end` per model request and replays none on a resume (its json mode writes
  only live events), so a prompt's charge is their sum.
- Live: `tests/compaction.eval.ts claude-headless` on sonnet 5.5, a turn, a compaction and a recall.
  Claude's running totals were 0.0730, 0.0933 and 0.1657. The three operations charged 0.0730,
  0.0203 and 0.0724, which sum to the session's 0.1657; the old reading summed the totals to 0.332.
  awf's own list-price estimate for the run was 0.145, about 12% under claude's, a gap that
  predates this change.
- Review (one agent, both lenses): nothing blocking. Fixed: a resume that started a new session,
  the float noise, `readCharge`'s comment, and this baseline decision. Accepted: an outcome the
  engine discards after it moved the total loses that cost, where the old reading re-charged it;
  those paths close the session.

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Set the story status to `awaiting-human-review` and present the outcome.
- [x] Record the human's explicit approval or requested changes here: approved by the operator,
  2026-10-04, and merged into main.
