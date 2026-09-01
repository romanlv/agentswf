---
id: "001"
title: Run a minimum multi-agent review workflow
summary: Prove that the engine can run parallel review agents and compose accepted structured results.
type: story
status: ready
depends_on: []
---

# Run a minimum multi-agent review workflow

This story includes the interface corrections, control plane, harness connection, and executable
workflow needed for the first end-to-end proof. The implementation order comes from
[`foundation.md`](../foundation.md#12-migration), but every prerequisite is stated concretely below.

## Outcome

Run a small workflow in the shape of [`examples/review-loop.ts`](../../examples/review-loop.ts):
open multiple coding agents, collect accepted structured results, and return a composed review result.  Ensure that different harnesses, involved in the same workflow
This is the first end-to-end proof of the engine's core technology.

## Scope

In scope:

- opening more than one logical agent;
- running independent review turns concurrently;
- accepting and passing structured results back to the workflow;
- a focused automated proof plus the minimum live evaluation needed to verify the harness path.

Out of scope:

- reviewer-to-reviewer messaging and additional review rounds;
- checkpoints or human adjudication;
- journal replay, remote execution, and a general workflow catalogue;
- implementing every capability shown by the example.

## Context and evidence

- Fact: [`examples/review-loop.ts`](../../examples/review-loop.ts) is typechecked documentation of
  the author interface, not an executable workflow today.
- Constraint: [`foundation.md`](../foundation.md#12-migration) requires the minimum engine, result
  gate, and local control plane to exist before the first workflow executes.
- Constraint: the accepted result must use an invocation-scoped capability and settle atomically.
- Fact: [`docs/findings/e2-return-channel.md`](../findings/e2-return-channel.md) establishes that
  result delivery is feasible under the measured conditions; the engine path remains unproved.
- Decision: the first proof ends after one parallel round. It verifies dispatch, isolation,
  structured return, and composition; it does not claim to prove convergence or adjudication.

## Code map

### Author interface

- Path: `packages/contract/src/workflow/`
- Relevance: defines the workflow-facing agent, parallel, and result shapes.

### Review example

- Path: `examples/review-loop.ts`
- Relevance: describes the target shape and contains capabilities intentionally excluded here.

### Harness seam

- Path: `packages/harness/src/adapter.ts`
- Relevance: designed engine-to-session interface; not yet the current experiment driver.

### Harness implementations

- Path: `packages/harness/src/adapters/`
- Relevance: existing pane and direct-process behavior to map during refinement.

### Result prototype

- Path: `packages/engine/src/result-layer.ts`
- Relevance: current acceptance behavior; Task 2 must replace check-then-write settlement.

### Run records

- Paths: `packages/contract/src/records.ts`, `packages/engine/src/run-dir.ts`
- Relevance: existing format and engine-owned I/O that implementation must preserve or
  deliberately revise.

### Prior evidence

- Paths: `experiments/_archive/`, `docs/findings/e2-return-channel.md`
- Relevance: prototype and measured delivery behavior; evidence is frozen.

### Existing focused tests

- `packages/engine/src/cli.test.ts` exercises result parsing and field-level rejection messages.
- `packages/engine/src/run-dir.test.ts` exercises result persistence and first-result behavior in
  the current single-writer implementation.
- `packages/harness/src/adapters/direct-process.test.ts` exercises environment injection,
  continuation, usage extraction, failures, and process timeout.
- `packages/harness/src/adapters/herdr.test.ts` exercises pane lifecycle, environment injection,
  liveness, retries, transcript reads, and cleanup.
- `packages/harness/src/testing/fake.ts` is the current fake driver; it must move to the production
  adapter seam rather than becoming a second engine seam.

## Proposed design

Build the result path, harness connection, and minimum engine as independently verified modules,
then compose them in one fake-backed workflow before running live agents.

The workflow proves only a single parallel review round. It must not introduce messaging,
checkpoints, or unrelated public interfaces merely to reproduce the full example.

Implementation may make local interface corrections needed to preserve the decisions in this
story. It must stop for user review before changing an author-facing semantic, a public run-record
format, a package seam, or the stated scope. Do not layer a workaround over an interface known to
be wrong.

### Decisions

- Deadline semantics: use an absolute deadline, not an adapter-local duration. Operations in this
  slice are agent activation, agent turns, nudges, compaction, child workflow calls, signal waits,
  and parallel collection. A turn that reaches its deadline resolves as `timed-out`; it is not
  `unanswered`, `failed`, or `cancelled`. Other waits reject with one exported, machine-readable
  deadline error after cancelling work they own. `steps.sleep` is already bounded by its requested
  duration. Local lookups and atomic state changes are not waits and do not need workflow deadlines.
- Capability storage: the bearer capability is 32 random bytes encoded as base64url and exists
  only in engine memory and the bound agent process environment. Public records contain operation
  identity and redacted rejection categories, never the capability or a recoverable derivative.
  Engine restart invalidates open capabilities in this minimum implementation.
- Result transport: one newline-delimited JSON request and response per connection over an
  engine-owned Unix-domain socket. The engine creates the socket in a private directory and removes
  it on shutdown. This story supports the current POSIX environment; Windows transport is not
  promised and no hypothetical transport interface is added for it.
- Result binding: the agent process receives `WF_ENDPOINT`, `WF_OPERATION`, and `WF_CAPABILITY` in
  its environment. The model runs `wf result` without supplying any of them. The request carries
  protocol version, operation id, capability, and raw JSON so wrong-operation capabilities can be
  distinguished from unknown ones.
- Harness seam: the engine uses only `AgentSessionAdapter`. Refactor the production pane and
  headless behavior around that interface. Keep the old `AgentSessionDriver` surface only as a
  narrow compatibility wrapper for frozen experiments, with no engine imports and no duplicate
  lifecycle logic.
- Runner seam: export one one-shot `runWorkflow(definition, args, options)` function from the
  engine. Options inject the run root and `AgentRuntimeConfig`; the function owns control-plane
  startup and shutdown and returns `{ runId, value, usage }`. Do not add an operator command or a
  long-lived engine class in this story.
- Review proof: open `correctness` and `maintainability` reviewers over the same small TypeScript
  fixture. Each returns `{ lens, summary, findings }`; `lens` is constrained to its assigned value.
  Compose results in input order with a blocking-finding count. This makes missing, swapped, or
  malformed results observable without messaging.
- Live target: run the two-agent proof once through Herdr panes, using one Claude subscription
  session and one Codex subscription session. Allow at most one nudge per reviewer, use a five-minute
  deadline per turn and a ten-minute workflow deadline, and do not fall back to a metered headless
  backend. Record actual usage or its absence rather than assuming subscription cost is zero.


Alternatives rejected:

- Implement the full example in one pass — it crosses later stage gates and would hide which capability the first end-to-end test actually proves.

## Tasks at a glance

- [ ] 1. Finish the executable interfaces
- [ ] 2. Create secure result slots
- [ ] 3. Put result submission behind the control plane
- [ ] 4. Connect the harness adapters
- [ ] 5. Implement the minimum workflow runner
- [ ] 6. Prove two-agent review with fakes
- [ ] 7. Verify with one bounded live evaluation

## Open questions

None.

## Task execution rule

Process Tasks 1–7 strictly in order. Every task has its own five-step checklist:

1. Plan the cleanest architecture for that task from the current code and evidence.
2. Implement only that coherent slice with focused tests.
3. Have two read-only subagents review its actual diff and test output: one for architecture and
   scope, one for correctness and proof.
4. Resolve or explicitly disposition every material finding, with targeted re-review after a
   material design change.
5. Run the task's focused verification and satisfy its `Done when` list.

Do not check a task in `Tasks at a glance` or start the next task until all five steps are complete.
Record planning decisions and verification output in `Implementation notes`, and record review
findings under that task in `Review record`. Add adjacent deliverables to `docs/stories/todo/`
rather than expanding this story.

## Task details

### 1. Finish the executable interfaces

Outcome: the author and harness interfaces state the semantics the engine will implement, without
publishing later capabilities.

Execution:

- [ ] Plan the exact author and harness interface changes, compare credible type shapes, and record
  why the selected interfaces are smaller and place engine identity at the correct seam.
- [ ] Implement only these interface corrections and their focused type-level tests.
- [ ] Obtain architecture/scope and correctness/proof subagent reviews of Task 1's diff and test
  output.
- [ ] Resolve every material finding and request targeted re-review after any interface change.
- [ ] Run Task 1's focused checks and satisfy every `Done when` item before starting Task 2.

Work:

- Add the absolute deadline and `timed-out` semantics listed in **Decisions** to the relevant
  workflow types in `packages/contract/src/workflow/`.
- Change `HarnessTurn.result` to a harness-local outcome containing terminal state, result evidence,
  session reference, and native usage samples. The engine adds agent key, call path, operation id,
  resolved execution, and aggregate usage.
- Pass an engine-created operation binding into `HarnessSession.start`; adapters must not invent
  engine identity or result authority.
- Remove the public journal arm from `ReplayPolicy`. Keep checkpoints and public fork operations
  out of this runtime, but model checkpoints as a distinct admission-barrier primitive rather than
  a signal. A native fork capability flag may exist only on the harness side; add no public fork
  operation.
- State that accepted-result settlement is atomic and first-valid-result-wins.
- Update all three examples for changed required fields while preserving their workflow-only
  imports. Do not implement messaging, checkpoints, replay, or fork execution.

Done when:

- The six interface defects listed in `foundation.md` section 7 are closed in types and comments.
- All examples pass `bunx tsc --noEmit` without importing the engine or harness.

### 2. Create secure result slots

Outcome: the engine can open exactly one result slot for an operation and settle it once.

Execution:

- [ ] Plan the result-slot module, its minimal interface, state ownership, atomic transition,
  capability lifecycle, persistence order, failure modes, and concurrency proof before coding.
- [ ] Implement only the result-slot slice and its focused tests.
- [ ] Obtain architecture/scope and correctness/security subagent reviews of Task 2's diff and test
  output.
- [ ] Resolve every material finding and re-review any changed settlement or capability semantics.
- [ ] Run Task 2's focused checks and satisfy every `Done when` item before starting Task 3.

Work:

- Add an engine-owned slot module keyed by the capability and bound to one operation id, schema,
  semantic check, and deadline.
- Generate capabilities with `crypto.randomBytes(32)` and base64url encoding; inject generation in
  focused tests so rejection cases are deterministic.
- Replace `writeAccepted` with atomic exclusive creation. Validate first, then attempt settlement;
  only the exclusive-create winner records an accepted attempt.
- Preserve rejected attempts and field-level schema errors.
- Return stable rejection codes for `unknown-capability`, `wrong-operation`, `expired-capability`,
  and `closed-capability`; never log the submitted capability.

Done when:

- Focused tests prove first-settlement-wins under concurrent submissions.
- Tests reject wrong, stale, closed, and cross-operation capabilities without changing the result.
- A test proves no public record or diagnostic contains the bearer capability.

### 3. Put result submission behind the control plane

Outcome: `wf result` submits to the engine without reading or writing the run directory.

Execution:

- [ ] Plan the wire shapes, framing, endpoint lifecycle, request limits, CLI behavior, and package
  ownership; compare credible protocol shapes before fixing the interface.
- [ ] Implement only the control-plane and `cli-agent` slice with focused contract, endpoint, CLI,
  and boundary tests.
- [ ] Obtain architecture/scope and correctness/security subagent reviews of Task 3's diff and test
  output.
- [ ] Resolve every material finding and re-review any wire or package-seam change.
- [ ] Run Task 3's focused checks and satisfy every `Done when` item before starting Task 4.

Work:

- Add `@wf/contract/wire` with runtime-decodable, versioned result-submit request and response
  shapes matching **Decisions**.
- Add the Unix-socket endpoint in `engine`; enforce one JSON line request, one JSON line response,
  bounded request size, private socket-directory permissions, and cleanup on normal shutdown.
- Move the agent-facing command to `cli-agent`; it compiles against `contract` and talks only to
  the endpoint.
- Accept JSON from exactly one command argument or standard input; both, neither, and empty input
  are usage errors before a request is sent.

Done when:

- CLI tests exercise the endpoint and retain the current useful schema-error behavior.
- Boundary checks prove `cli-agent` does not import the engine or perform run-directory I/O.
- Endpoint tests reject malformed or oversized frames and verify socket cleanup.

### 4. Connect the harness adapters

Outcome: an activated harness session receives the result command and operation capability without
putting the capability in model-visible prompts.

Execution:

- [ ] Plan how pane, headless, fake, and frozen-experiment compatibility share implementation while
  exposing only `AgentSessionAdapter` to the engine; reject pass-through or duplicate seams.
- [ ] Implement only the adapter slice with focused conformance, binding, liveness, and cleanup
  tests.
- [ ] Obtain architecture/compatibility and correctness/failure-path subagent reviews of Task 4's
  diff and test output.
- [ ] Resolve every material finding and re-review any adapter-interface or compatibility change.
- [ ] Run Task 4's focused checks and satisfy every `Done when` item before starting Task 5.

Work:

- Implement pane, headless, and fake `AgentSessionAdapter` adapters. Share the existing harness
  command table, process runner, usage readers, and Herdr translation rather than copying them.
- Bind each started turn to the endpoint, operation id, and capability supplied by the engine.
- Reconcile harness completion with accepted engine data: accepted data yields `answered`; a settled
  harness with an open slot yields `unanswered`; blocked and timed-out remain distinct.
- Preserve the old driver factories as compatibility wrappers around the refactored implementation
  only where frozen experiments still import them.
- Keep pane and headless selection in engine configuration rather than workflow definitions.

Done when:

- Adapter conformance tests cover pane, headless, and fake adapters through `AgentSessionAdapter`.
- A test proves a delayed command from one turn cannot settle the next turn on the same agent.
- The engine imports no `AgentSessionDriver`, and compatibility wrappers contain no lifecycle or
  result-acceptance implementation of their own.

### 5. Implement the minimum workflow runner

Outcome: a caller can execute a workflow through the one-shot `runWorkflow` interface defined in
**Decisions**.

Execution:

- [ ] Plan the runner module, its one-shot interface, ownership and cleanup order, alias resolution,
  queueing, parallel ordering, and injected dependencies; compare against a long-lived engine class.
- [ ] Implement only the minimum runner slice and its fake-backed focused tests.
- [ ] Obtain architecture/scope and correctness/concurrency subagent reviews of Task 5's diff and
  test output.
- [ ] Resolve every material finding and re-review any runner-interface or ownership change.
- [ ] Run Task 5's focused checks and satisfy every `Done when` item before starting Task 6.

Work:

- Implement only the workflow context used here: `agents.open`, `AgentRef.run`, `parallel`, `usage`,
  and `log`. Other context members fail immediately with an explicit not-implemented error if the
  existing interface requires them to be present.
- Resolve runtime aliases once per logical agent and queue at most one operation at a time per
  agent.
- Create, bind, await, and close result slots through the engine-owned modules from Tasks 2–4.
- Start the control plane before dispatch, close agents and the endpoint in `finally`, and return
  structured workflow data rather than requiring callers to inspect the run directory.

Done when:

- Engine tests execute a small workflow entirely through fake adapters.
- Parallel operations preserve input order in their returned results and cannot cross-settle.
- Timeout and adapter failure still close the endpoint and any activated sessions.

### 6. Prove two-agent review with fakes

Outcome: an executable one-round review opens two agents concurrently and composes their accepted
structured findings into one workflow result.

Execution:

- [ ] Plan the smallest fixture, schemas, prompts, and composition assertions that prove two-agent
  isolation without messaging or adjudication.
- [ ] Implement only the executable workflow, fake scripts, and end-to-end focused tests.
- [ ] Obtain architecture/scope and correctness/proof subagent reviews of Task 6's diff and test
  output.
- [ ] Resolve every material finding and re-review any change that broadens the workflow proof.
- [ ] Run Task 6's focused checks and satisfy every `Done when` item before starting Task 7.

Work:

- Add the two-lens fixture, schemas, and composition described in **Decisions**.
- Implement the workflow using only `@wf/contract/workflow`.
- Script the fake adapters to submit distinct valid results through the same control-plane path as
  a live agent.

Done when:

- The end-to-end test observes two in-flight agents, accepts both results, and returns the expected
  composition.
- Missing, malformed, timed-out, and blocked outcomes are explicit rather than successful data.

### 7. Verify with one bounded live evaluation

Outcome: the production pane adapter runs the same one-round workflow with two real harnesses
through the production result path.

Execution:

- [ ] Plan the bounded evaluation from the verified code: prerequisites, exact commands, expected
  evidence, deadlines, nudge limit, cleanup, and stop conditions. Do not improvise during the run.
- [ ] Implement only the opt-in evaluation setup and dry-run checks; keep it outside `bun test`.
- [ ] Obtain architecture/scope and correctness/evidence subagent reviews of Task 7's evaluation
  diff, dry-run output, and bounds before spending a live run.
- [ ] Resolve every material finding and repeat dry-run checks after changes.
- [ ] Run the bounded live evaluation once, record exact evidence, and satisfy every `Done when`
  item before story-level verification.

Work:

- Verify Herdr, Claude, and Codex are available and authenticated for subscription-backed pane use.
- Record the fixed harnesses, pane backend, deadlines, one-nudge limit, and no-metered-fallback rule
  from **Decisions** before running it.
- Run an opt-in `*.eval.ts`; do not add live execution to `bun test`.
- Capture enough evidence to distinguish harness completion, accepted result delivery, and usage.

Done when:

- The live run returns one correctness result and one maintainability result in input order within
  the recorded bounds.
- Any failure is recorded as a specific substrate or implementation gap, not hidden by retries.

## Verification

Automated:

- [ ] Focused tests prove parallel agents cannot cross-settle one another's result slots.
- [ ] Focused test proves the workflow composes the accepted structured results.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] Run the minimum workflow with explicit prerequisites, harnesses, expected result, timeout,
  and cost bound recorded before execution.

## Review record

Record reviews after each task, before starting the next one.

### Task 1 — Executable interfaces

- Architecture and scope: Not run yet.
- Correctness and proof: Not run yet.

### Task 2 — Secure result slots

- Architecture and scope: Not run yet.
- Correctness and proof: Not run yet.

### Task 3 — Control plane

- Architecture and scope: Not run yet.
- Correctness and proof: Not run yet.

### Task 4 — Harness adapters

- Architecture and scope: Not run yet.
- Correctness and proof: Not run yet.

### Task 5 — Workflow runner

- Architecture and scope: Not run yet.
- Correctness and proof: Not run yet.

### Task 6 — Fake-backed review

- Architecture and scope: Not run yet.
- Correctness and proof: Not run yet.

### Task 7 — Live evaluation

- Architecture and scope: Not run yet.
- Correctness and proof: Not run yet.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

- No implementation has started.
- If a decision above proves technically false, record the evidence here before changing the
  story or broadening scope.

## Human review

- [ ] Every task in `Tasks at a glance` is complete and all story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the workflow outcome, final
  architecture, task-level subagent findings and dispositions, exact automated and live results,
  meaningful deviations, and remaining risks to the user.
- [ ] Record the user's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its planning when needed,
  implementation, subagent review, finding resolution, and focused verification.
- [ ] Only after explicit approval, mark this story `done` and update `Stories at a glance`.
