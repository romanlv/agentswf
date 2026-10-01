---
id: "016"
title: Fork an agent so new agents start from what it knows, from the cache
summary: "agent.fork({ key }) opens a new agent on a copy of the agent's session, taken by the harness's own fork with no model call; claude and pi forks read the parent's context from the provider's cache, with or without compaction first."
type: story
status: draft
discovered_in: "story 015, the operator's review, 2026-10-01"
depends_on: []
---

# Fork an agent so new agents start from what it knows, from the cache

## Outcome

A workflow has one agent understand a task, then starts other agents from that understanding:

```ts
const worker = await workflow.agents.open({ key: "worker", runtime: "claude" });
await worker.run({ prompt: "Read the ticket and its doc, and plan the change.", schema: PLAN });
await worker.compact({ id: "planned", prompt: "Keep the plan and why; drop the exploration.", deadline });

const [security, tests] = await Promise.all([
  worker.fork({ key: "security" }),
  worker.fork({ key: "tests", placement: "headless", metered: true }),
]);
```

Each fork knows what the worker knew when it was forked, without re-reading the ticket, and its
first request reads that context from the provider's cache instead of paying for it again. That
holds with or without compacting first. The worker goes on, and neither sees what the other does
next.

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
  - Codex's fork pays its parent's context once, then caches its own. Only an ephemeral fork
    hits, and that needs a codex agent living on one app-server
    ([`codex-app-server-agent`](todo/codex-app-server-agent.md)).
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

- Codex forks that hit the cache: an ephemeral fork outlives no process
  ([`codex-app-server-agent`](todo/codex-app-server-agent.md)).
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

- [ ] 1. Each turn of a headless claude or pi agent charges what that turn cost
- [ ] 2. A headless claude agent forks, end to end
- [ ] 3. Forks in panes and across placements: claude and codex
- [ ] 4. Headless codex and pi fork
- [ ] 5. A fork whose home differs from its parent's: sandboxes and codex's skills home
- [ ] 6. A live eval of forks on every harness and placement, with and without compaction

Each slice from 2 on lands its seam with the code that uses it, as ADR 0001 asks of anything that
returns to the surface.

## Open questions

### 2. A headless claude agent forks

- Approve ADR 0009. It publishes `AgentRef.fork` and `AgentForkSpec`, so it is settled before code.

### 2, 6. Skills

- A claude fork given skills gets a fresh copy in a directory of its own (ADR 0004). If the copy's
  path reaches its prompt, the fork's prefix differs from its parent's and misses. The eval
  measures it. If it misses, the fork reuses its parent's copy, which is the same skills at the
  same point.

### 5. A fork whose home differs

- A parent in a private sandbox: its forks would share that sandbox. The alternative is refusing
  them, since the sandbox was private. Proposed: share it, since the fork's working directory is
  inside.

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

### 1. Each turn of a headless claude or pi agent charges what that turn cost

Outcome: a headless claude agent's operations each charge what their own turns cost, not the
session's total so far (F9). A pi agent's turn charges all its requests, not the last one's.

Work:

- The headless backend keeps the session's last running total. A turn's charge is the new total
  less that one, and the first baseline is the session's last `cost-state` row.
- pi's `readCharge` sums the turn's `turn_end` costs.

Done when:

- `direct-process` tests charge each of these by the difference:
  - two turns;
  - a nudge;
  - a compaction;
  - a session resumed from before the run;
  - a total that drops, which charges the new total rather than a negative.
- A live headless claude run with two turns and a compaction charges each near its own tokens'
  list price.

### 2. A headless claude agent forks, end to end

Outcome: a workflow forks a headless claude agent, and runs both; a workflow's test scripts the
fork.

Work:

- `AgentForkSpec` and `AgentRef.fork`, once ADR 0009 is approved.
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
  - idempotency and conflict by key, a fork racing an open of its key included;
  - a fork of a fork, and a fork refused before its own first turn;
  - usage attribution with copied rows, the zeroed row after compaction included (F8).
- `awf test` passes `examples/fork`.
- A live run forks once and checks that the fork plan printed `num_turns` 0 and that the fork's
  transcript gained no request before its first turn.

### 3. Forks in panes and across placements: claude and codex

Outcome: a pane agent forks into a pane or a headless agent, and a headless agent into a pane.

Work:

- `interactiveResume` for claude and codex; the Herdr adapter launches a continued agent with it.
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
- The eval reads each fork's first request from its usage. Claude and pi must read most of the
  parent's prefix from the cache; codex's is recorded, not asserted. The questions are about text
  codex was actually shown.
- `docs/testing.md` gets its cost.

Done when:

- The eval passes, and `fork-cache.md` cites its run.

## Verification

Automated:

- [ ] The tests named under each task.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run check`

Manual or live evaluation:

- [ ] `tests/fork.eval.ts`, on the cheapest models: about a dollar of haiku with the rest on
  subscriptions.

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
- [ ] Expensive interface, record-format, and stage-gate decisions are settled: ADR 0009 awaits
  approval.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome.
- [ ] Record the human's explicit approval or requested changes here.
