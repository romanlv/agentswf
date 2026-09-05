---
id: "001"
title: Run a minimum multi-agent review workflow
summary: Prove that the engine can run parallel review agents and compose accepted structured results.
type: story
status: in-progress
depends_on: []
---

# Run a minimum multi-agent review workflow

This story includes the interface corrections, control plane, harness connection, and executable
workflow needed for the first end-to-end proof. The implementation order comes from
[`foundation.md`](../foundation.md#12-migration), but every prerequisite is stated concretely below.

## Outcome

Run [`examples/review-loop.ts`](../../examples/review-loop.ts) through `awf run`: open multiple
coding agents, collect accepted structured results, and return a composed review result. This is
the first usable end-to-end proof of the engine's core technology.

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

- Fact: [`examples/review-loop.ts`](../../examples/review-loop.ts) now exports an executable workflow
  descriptor. Its production `awf run` acceptance remains open under Task 8.
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
- Relevance: defines the run-owned host interface used by the engine and implemented by the
  production Herdr host.

### Harness implementations

- Path: `packages/harness/src/adapters/`
- Relevance: existing pane and direct-process behavior to map during refinement.

### Result acceptance

- Paths: `packages/engine/src/result-slots.ts`, `packages/engine/src/result-validation.ts`
- Relevance: engine-owned capability settlement and candidate validation implemented by Task 2.

### Run records

- Paths: `packages/contract/src/records.ts`, `packages/engine/src/run-dir.ts`
- Relevance: existing format and engine-owned I/O that implementation must preserve or
  deliberately revise.

### Prior evidence

- Paths: `experiments/_archive/`, `docs/findings/e2-return-channel.md`
- Relevance: prototype and measured delivery behavior; evidence is frozen.

### Existing focused tests

- `packages/cli-agent/src/cli.test.ts` exercises result parsing, bounded standard input, and
  field-level rejection messages. It replaced the pre-implementation engine CLI test.
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
- Capability storage: the bearer capability is 32 random bytes encoded as base64url and exists in
  engine memory and the bound operation pane environment. Herdr can inject a distinct environment
  when splitting each pane; the run workspace and root pane start with every `WF_*` value cleared.
  Public records, diagnostics, later Herdr commands, snapshots, and model prompts contain operation
  identity and redacted rejection categories, never the capability or a recoverable derivative.
  Every issued capability remains in the redaction set for the complete run lifetime. Engine
  restart invalidates open capabilities in this minimum implementation. This is routing under the
  cooperative-peer threat model, not hostile same-UID isolation.
- Result transport: one newline-delimited JSON request and response per connection over an
  engine-owned Unix-domain socket. The engine creates the socket in a private directory and removes
  it on shutdown. This story supports the current POSIX environment; Windows transport is not
  promised and no hypothetical transport interface is added for it.
- Result binding: the agent process receives `WF_ENDPOINT`, `WF_OPERATION`, and `WF_CAPABILITY` in
  its environment. The model runs `wf result` without supplying any of them. The request carries
  protocol version, operation id, capability, and raw JSON so wrong-operation capabilities can be
  distinguished from unknown ones.
- Harness seam: the engine uses only `AgentRunHostFactory` and its run-owned host. Session adapters
  remain an internal harness mechanism for focused evidence and compatibility; they cannot select
  different production placement or lifecycle per logical peer. Keep the old `AgentSessionDriver`
  surface only as a narrow compatibility wrapper for frozen experiments, with no engine imports
  and no duplicate lifecycle logic.
- Runner seam: export one one-shot `runWorkflow(definition, args, options)` function from the
  engine as a convenience over a run handle with `result`, `inspect()`, and `stop()`. Options inject
  the run root, workload aliases, run host, and admission/accounting policy. The run host owns
  topology; the engine owns control-plane lifecycle and returns `{ runId, value, usage }`. Keep the
  programmatic interface independent of the operator command. Task 8 is not complete until the
  proven workflow can be invoked through `awf run` and both peers are inspectable through the same
  run state.
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

- [x] 1. Finish the executable interfaces
- [x] 2. Create secure result slots
- [x] 3. Put result submission behind the control plane
- [ ] 4. Connect the harness adapters
- [ ] 5. Implement the minimum workflow runner
- [ ] 6. Prove two-agent review with fakes
- [ ] 7. Verify with one bounded live evaluation
- [ ] 8. Make the review workflow operator-runnable

## Open questions

### Task 4 — Native settlement

Herdr has returned `idle` while an agent was still working. The current run host nevertheless maps
`idle` to native completion and makes a discovered session reference resumable. What independent
evidence can prove that a pane operation actually ended for both Claude and Codex? Until that is
answered, `idle` must not authorize continuation and Task 4 remains open.

This is an implementation question to resolve from provider evidence; it does not need user input.

## Design reset — symmetric execution foundation

The first operator implementation is not an acceptable foundation. It presents two peer reviewers
through different execution models: Claude runs in an isolated Herdr workspace while Codex runs as
a headless process. The split was introduced to recover Codex through `codex exec resume` after a
pane missed its result, but it leaks an adapter limitation into product behavior:

- only one reviewer is visible and directly inspectable in Herdr;
- topology and lifecycle differ for agents with the same logical role;
- the operator must reason about provider-specific settlement and continuation;
- the implementation incorrectly assumed result authority could be scoped only at workspace
  creation and therefore never tested Herdr's per-pane environment support;
- successful fake and fixture proofs do not establish a symmetric production execution model.

The live `.` review also showed that unconstrained reviewers may recursively delegate. The first
attempt launched four Claude background agents, three of which exceeded 150,000 tokens each before
the operator cancelled the run. A prompt-level no-delegation constraint prevented that behavior in
the next attempt, but this is workload policy, not a substitute for a sound execution host.

All Tasks 1–8 are reopened. Previous implementation and verification remain evidence, but none is
current acceptance evidence. Reprocess each task in order using the five-step task rule. The new
design must make logical peers symmetric in execution, inspection, continuation, authority,
deadline handling, cleanup, and evidence before Task 8 can be considered complete.

### Design evidence

The installed Herdr CLI supports `--env KEY=VALUE` on `pane split`, not only on workspace creation.
A disposable probe created one workspace and one tab with three panes. The root pane saw
`AWF_PROBE=base`; the two split panes independently saw `correctness` and `maintainability`. The
later splits did not change the existing pane's value. The probe workspace was closed afterward.
This invalidates the earlier workspace-only-environment assumption and makes sibling panes with
separate operation authority viable.

Current Codex CLI documentation confirms both interactive `codex resume <session-id>` and
non-interactive `codex exec resume`. Native continuation is therefore provider behavior that can
run inside a visible pane; it does not justify moving Codex outside Herdr. Claude continuation still
needs its own measured interactive proof before later-operation reuse is accepted.

### Interfaces considered

Three independent designs moved the seam outward from per-agent backend adapters:

- A minimal run handle: `start` returns `{ result, snapshot, stop }`, and one deep execution host
  owns topology, provider launch, authority, status, cancellation, cleanup, and evidence.
- A flexible host/provider composition: terminal-host adapters and provider adapters vary
  independently behind an engine-facing run host, with a revisioned event stream and placement
  profiles.
- A common-case host: `awf run` always creates one run-owned Herdr workspace/tab with two visible
  sibling panes, while workflow authors specify only logical reviewer and model requirements.

The selected direction combines the minimal external seam with the common-case topology and keeps
the flexible composition internal:

- one run-owned execution host is the engine-to-harness seam;
- one Herdr workspace and tab belong to a workflow run;
- each logical operation receives a sibling pane with its own one-use result authority;
- the initial delivery and its one nudge are attempts to settle the same logical operation, result
  slot, capability, and pane;
- a later distinct operation receives fresh authority and a fresh pane, resuming provider context
  only through a measured native continuation;
- result acceptance and native completion remain separate evidence; acceptance may complete the
  logical operation while native work is cancelled, drained, or quarantined within cleanup grace;
- both providers expose the same inspection, cancellation, deadline, cleanup, and evidence
  semantics even when their native commands differ;
- the run handle exposes a snapshot for operator progress. A public event stream, status daemon,
  stable pane credential broker, and author-facing topology DSL are rejected until evidence makes
  them necessary.

Architecture and correctness planning reviews converged after removing public backend selection,
separating funding policy, scoping the threat model, and distinguishing result readiness from
infrastructure release. This is the accepted Task 1 planning direction.

## Task execution rule

Process Tasks 1–8 strictly in order. Every task has its own five-step checklist:

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

- [x] Plan the exact author and harness interface changes, compare credible type shapes, and record
  why the selected interfaces are smaller and place engine identity at the correct seam.
- [x] Implement only these interface corrections and their focused type-level tests.
- [x] Obtain architecture/scope and correctness/proof subagent reviews of Task 1's diff and test
  output.
- [x] Resolve every material finding and request targeted re-review after any interface change.
- [x] Run Task 1's focused checks and satisfy every `Done when` item before starting Task 2.

Work:

- Preserve the already-proven absolute-deadline, local harness-outcome, no-journal, no-checkpoint,
  no-public-fork, and atomic first-valid-result semantics. Revalidate them against the new host
  seam rather than reverting them.
- Remove `BackendKind` from the author surface, runtime aliases, execution requirements, resolved
  agent identity, and usage execution. Terminal placement is one operator-owned run policy and may
  not vary by logical agent.
- Remove funding pool from agent execution identity. Keep harness, exact model, and model settings
  as author-constrainable workload facts; associate funding with injected run admission/accounting
  policy instead.
- Replace the engine-facing per-agent adapter registry with one run-host factory. A run host opens
  logical agents, returns a redacted immutable snapshot, and closes the complete run topology.
  Logical agents start operations; Herdr workspace/tab/pane ids and native session references stay
  inside the host implementation.
- State one-operation semantics explicitly: immutable operation id, schema, capability, pane, and
  overall deadline; initial and at-most-one nudge are delivery attempts on that same operation,
  with native usage aggregated into its operation record. `HarnessTurn.nudge` receives no fresh
  binding. Per-attempt durable records remain deferred unless later evidence requires them.
- Separate author-visible result readiness from internal infrastructure release. Durable
  acceptance, client acknowledgement, and native terminal/quarantined disposition are distinct.
  Later operations cannot advance until release is proven or continuation is failed closed.
- Replace boolean-only cancellation evidence with a native disposition that distinguishes a
  cancellation request, observed termination, and quarantine. Quarantine revokes authority,
  prevents continuation, attempts bounded termination, and remains visible in snapshot/error
  evidence.
- State the cooperative-peer threat model: per-pane capabilities prevent stale and accidental
  cross-settlement but do not confine hostile same-UID agents. Keep every run-issued capability in
  the redaction set for the full run lifetime. Do not claim prompt-level delegation guidance is
  enforcement.
- Update all three examples for the smaller runtime selection while preserving workflow-only
  imports. Do not add an event stream, status daemon, topology DSL, stable pane credential broker,
  messaging, checkpoints, replay, or fork execution.

Done when:

- The foundation and types expose one run host and cannot express asymmetric per-agent placement.
- Nudge cannot receive a second result binding, while a later distinct operation must receive
  fresh authority.
- Result readiness and infrastructure release cannot be confused by the harness interface.
- Checkpoints remain deliberately deferred until an admission-barrier primitive is designed for a
  later stage; they are not misrepresented as signals or added prematurely to the author surface.
- Focused type and conformance tests cover the new interface, and all examples pass
  `bun run ts-check` without importing the engine or harness.

### 2. Create secure result slots

Outcome: the engine can open exactly one result slot for an operation and settle it once.

Execution:

- [x] Plan the result-slot module, its minimal interface, state ownership, atomic transition,
  capability lifecycle, persistence order, failure modes, and concurrency proof before coding.
- [x] Implement only the result-slot slice and its focused tests.
- [x] Obtain architecture/scope and correctness/security subagent reviews of Task 2's diff and test
  output.
- [x] Resolve every material finding and re-review any changed settlement or capability semantics.
- [x] Run Task 2's focused checks and satisfy every `Done when` item before starting Task 3.

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

- [x] Plan the wire shapes, framing, endpoint lifecycle, request limits, CLI behavior, and package
  ownership; compare credible protocol shapes before fixing the interface.
- [x] Implement only the control-plane and `cli-agent` slice with focused contract, endpoint, CLI,
  and boundary tests.
- [x] Obtain architecture/scope and correctness/security subagent reviews of Task 3's diff and test
  output.
- [x] Resolve every material finding and re-review any wire or package-seam change.
- [x] Run Task 3's focused checks and satisfy every `Done when` item before starting Task 4.

Work:

- Add `@wf/contract/wire` with runtime-decodable, versioned result-submit request and response
  shapes matching **Decisions**.
- Add the Unix-socket endpoint in `engine`; enforce one JSON line request, one JSON line response,
  bounded request size, private socket-directory permissions, and cleanup on normal shutdown.
- Move the agent-facing command to `cli-agent`; it compiles against `contract` and talks only to
  the endpoint.
- Accept JSON from one command argument or, when no argument is supplied, standard input. Argument
  mode never reads standard input, so it remains usable when an inherited non-TTY stream is open;
  direct callers that explicitly provide both sources are rejected. Neither and empty input are
  usage errors before a request is sent.

Done when:

- CLI tests exercise the endpoint and retain the current useful schema-error behavior.
- Boundary checks prove `cli-agent` does not import the engine or perform run-directory I/O.
- Endpoint tests reject malformed or oversized frames and verify socket cleanup.

### 4. Connect the harness adapters

Outcome: one run-owned Herdr workspace and tab host every peer agent in visible sibling panes, with
operation authority confined to the pane that can use it and no provider-specific execution split.

Execution:

- [x] Plan the concrete run-host topology, operation-pane lifecycle, provider continuation,
  authority delivery, inspection, cancellation, and compatibility boundaries before coding.
- [x] Implement only the adapter slice with focused conformance, binding, liveness, and cleanup
  tests.
- [x] Obtain architecture/compatibility and correctness/failure-path subagent reviews of Task 4's
  diff and test output.
- [ ] Resolve the final-audit finding that ambiguous Herdr `idle` currently permits native
  completion and continuation; re-review the resulting evidence and behavior.
- [ ] Re-run Task 4's focused checks and satisfy every `Done when` item.

Work:

- Add one concrete Herdr run-host factory. `openRun` creates one workspace and its initial tab with
  every inherited `WF_*` value cleared. `openAgent` creates only logical state; it does not allocate
  a workspace, tab, or provider-specific backend.
- Allocate a fresh sibling pane for each distinct operation. Inject that operation's endpoint, id,
  and capability through `pane split --env`; start the selected provider interactively in that
  pane. Concurrent peers share the run tab but never authority.
- Keep the initial delivery and optional nudge in the same pane and native session because they are
  attempts to settle one operation. Before a later operation, close the prior pane, create a fresh
  capability-bound pane, and resume only from a provider session reference measured from Herdr.
  If a provider cannot supply or resume that reference, fail closed instead of silently replacing
  the session or moving it headless.
- Keep provider launch and resume commands in the existing harness specification table. Herdr owns
  topology and observation; the shared session core owns one-use binding checks, nudge rules,
  quarantine, and authority redaction. The engine sees only `AgentRunHost`.
- Serialize topology mutations, make run close stop admission before cancelling sessions, close the
  complete workspace once, and retain a retryable cleanup handle on failure. A cancelled or
  indeterminate pane cannot be continued.
- Preserve direct-process and isolated-pane adapters only for focused harness evidence and frozen
  experiment compatibility. The operator runtime must use the symmetric Herdr run host and cannot
  select those adapters per logical agent.

Done when:

- A host-level test proves two different harnesses occupy sibling panes in one workspace and tab,
  with distinct per-pane capabilities and neither capability on workspace creation.
- Tests prove nudge reuses its operation pane, a later operation uses a fresh pane and measured
  provider resume, and missing continuation evidence fails closed.
- Inspection, cancellation, activation races, and idempotent whole-workspace cleanup have focused
  failure-path coverage; no capability appears in snapshots or later Herdr commands.
- The operator runtime installs the Herdr run host directly. Engine code imports no legacy driver,
  direct-process adapter, isolated-workspace pane adapter, or Herdr topology primitive.

### 5. Implement the minimum workflow runner

Outcome: a caller can start, inspect, stop, or simply await one workflow run while the engine owns
result/native joins, logical queues, deadlines, and cleanup.

The implementation and prior reviews are retained, but acceptance is reopened because Task 4 may
change native settlement and release semantics. Re-run the runner proof after Task 4 closes.

Execution:

- [x] Plan the runner module, its run handle and one-shot convenience interface, ownership and
  cleanup order, result/native join, alias resolution,
  queueing, parallel ordering, and injected dependencies; compare against a long-lived engine class.
- [x] Implement only the minimum runner slice and its fake-backed focused tests.
- [x] Obtain architecture/scope and correctness/concurrency subagent reviews of Task 5's diff and
  test output.
- [x] Resolve every material finding and re-review any runner-interface or ownership change.
- [ ] Re-run Task 5's focused checks after Task 4 closes and revalidate every `Done when` item.

Work:

- Add `startWorkflow`, returning one run handle with `runId`, `result`, `inspect()`, and `stop()`.
  Keep `runWorkflow` as the one-shot convenience that starts and awaits this handle. Do not add a
  long-lived engine service, event stream, or status daemon.
- Implement only the workflow context used here: `agents.open`, `AgentRef.run`, `parallel`, `usage`,
  and `log`. Other context members fail immediately with an explicit not-implemented error if the
  existing interface requires them to be present.
- Resolve runtime aliases once per logical agent and queue at most one operation at a time per
  agent.
- Create, bind, await, and close result slots through the engine-owned modules from Tasks 2–4.
- Observe result settlement, native settlement, and the operation deadline concurrently. A valid
  accepted result wins the author-facing operation immediately, triggers bounded native release,
  and never waits for an otherwise long native deadline. Released native evidence may contribute
  usage; unresolved release quarantines the session and prevents its queue from continuing.
- Start the control plane before dispatch, close agents and the endpoint in `finally`, and return
  structured workflow data rather than requiring callers to inspect the run directory.

Done when:

- A handle test can inspect both peer agents while a run is active and stop the run through the
  same engine ownership path.
- A result accepted before native settlement triggers release and returns without waiting for the
  operation deadline; quarantine blocks a queued continuation.
- Engine tests execute a small workflow entirely through fake adapters.
- Parallel operations preserve input order in their returned results and cannot cross-settle.
- Timeout and adapter failure still close the endpoint and any activated sessions.

### 6. Prove two-agent review with fakes

Outcome: an executable one-round review opens two agents concurrently and composes their accepted
structured findings into one workflow result.

The fake-backed implementation and prior reviews are retained, but current acceptance waits for
Task 5's post-Task-4 re-verification.

Execution:

- [x] Plan the smallest fixture, schemas, prompts, and composition assertions that prove two-agent
  isolation without messaging or adjudication.
- [x] Implement only the executable workflow, fake scripts, and end-to-end focused tests.
- [x] Obtain architecture/scope and correctness/proof subagent reviews of Task 6's diff and test
  output.
- [x] Resolve every material finding and re-review any change that broadens the workflow proof.
- [ ] Re-run Task 6's focused checks after Task 5 closes and revalidate every `Done when` item.

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

Outcome: the production Herdr run host runs the same one-round workflow with two real harnesses in
visible sibling panes through the production result path.

Execution:

- [x] Plan the bounded evaluation from the verified code: prerequisites, exact commands, expected
  evidence, deadlines, nudge limit, cleanup, and stop conditions. Do not improvise during the run.
- [x] Implement only the opt-in evaluation setup and dry-run checks; keep it outside `bun test`.
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

### 8. Make the review workflow operator-runnable

Outcome: from a repository working directory, an operator can run
`awf run examples/review-loop.ts` and receive the structured multi-agent review plus the retained
artifact location. `--timeout <duration>` controls the run deadline; `-- <target>` optionally
narrows the default current-directory review.

Execution:

- [ ] Compare credible execution interfaces and choose the cleanest seam before editing code.
- [ ] Implement only the executable-workflow module contract, generic file runner, and runnable
  review workflow with focused tests.
- [ ] Obtain architecture/scope and correctness/security subagent reviews of Task 8's diff and test
  output.
- [ ] Resolve every material finding and re-review any changed public interface or loader behavior.
- [ ] Run Task 8's focused checks and satisfy every `Done when` item before story-level
  verification.

Work:

- Keep `runWorkflow(definition, args, options)` as the programmatic engine interface.
- Add a small pure executable-workflow descriptor to the author surface. Its `prepare` function
  maps workflow-specific command arguments into domain arguments; it does not construct adapters,
  carry execution timing, or choose provider integrations.
- Put the invocation working directory and one enforced absolute run deadline on `WorkflowContext`.
  Every wait still names an absolute deadline, but workflows take the enclosing bound directly from
  their context instead of passing it through domain arguments.
- Derive the run deadline from `awf run --timeout` with a ten-minute default. After expiry, allow a
  fixed five-second shutdown grace so pending activation or adapter cleanup cannot hang the
  operator. A configuration-file source is a possible future operator concern, not part of this
  task.
- Keep runtime aliases operator-owned. When a model is part of workflow behavior, declare an exact
  model constraint beside the alias in the workflow so alias drift fails rather than silently
  changing the review.
- Add the trusted operator command `awf run <local-workflow-file> -- [workflow arguments]` to the
  engine package. It loads exactly one explicit local module, validates its executable descriptor,
  installs operator-owned runtime aliases, calls `runWorkflow`, and prints machine-readable
  output. Install one symmetric Herdr run host: Claude and Codex use subscription-authenticated
  interactive sibling panes in the same run tab, with distinct per-operation authority and
  provider continuation measured behind the same host lifecycle. Do not add a headless fallback.
- Keep the in-session `wf result` command separate from the trusted `awf` operator command.
- Make `examples/review-loop.ts` the self-contained, bounded two-lens working-tree review. Do not
  claim the speculative GitLab publication, retained-agent, attachment, or compaction design is
  executable through the minimum runner.
- Retain run artifacts on success and failure. Treat the loaded workflow as trusted local code and
  state that it executes with the operator's authority.

Done when:

- A fake-backed command test runs `examples/review-loop.ts` through the same loader and engine path
  used by `awf run` and observes both ordered reviews.
- Invalid command arguments, missing files, malformed modules, preparation failures, unsupported
  runtime requests, and workflow failures are actionable and do not report success.
- The command can be invoked from the repository as
  `bun awf run examples/review-loop.ts`; `--timeout <duration>` changes the run deadline and
  `-- <target>` optionally narrows the target. The engine package publishes the shorter installed
  `awf` bin.
- `examples/` still imports only `@wf/contract/workflow`; the operator loader is the only narrowly
  audited computed-import exception.

## Verification

Automated:

- [ ] Focused tests prove parallel agents cannot cross-settle one another's result slots.
- [ ] Focused test proves the workflow composes the accepted structured results.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`
- [ ] Focused `awf run` command and loader tests
- [ ] Re-run `bun test`, `bunx tsc --noEmit`, and `bun run scripts/check-boundaries.ts` after Task 8

Manual or live evaluation:

- [ ] Run the minimum workflow with explicit prerequisites, harnesses, expected result, timeout,
  and cost bound recorded before execution.
- [ ] Run `awf run examples/review-loop.ts -- <target>` through the installed production runtime
  and retain its artifacts.

## Review record

Record reviews after each task, before starting the next one.

### Task 1 — Executable interfaces

- Reset planning review (2026-09-02): Architecture rejected layering run ownership over the
  per-agent adapter registry. It required one run-host factory, removal of public backend routing,
  separation of funding policy, host-owned native continuation, and same-operation nudge binding.
  Correctness clarified the cooperative-peer threat model and required distinct accepted,
  acknowledged, and released states; generation-bound continuation; operational quarantine;
  ordered endpoint shutdown; and full-run secret redaction. All planning findings were accepted and
  incorporated before implementation.
- Reset implementation review (2026-09-02): architecture and correctness initially blocked on
  native references crossing the harness seam, non-operational quarantine, current-operation-only
  redaction, late host acquisition and activation cleanup, stale cancellation tests, and obsolete
  asymmetric operator documentation. The implementation now keeps continuation references inside
  the harness, makes quarantine sticky and continuation-denying, redacts against every authority
  issued by the session/run, bounds nonconforming release, closes late hosts, and makes run-host
  shutdown await complete late-activation cleanup while closing active sessions concurrently.
  Focused regressions cover each race and both targeted re-reviews passed with no remaining
  material finding.
- The 2026-09-01 record below is historical evidence, not current acceptance. Its conclusion that
  nudges require fresh operation authority is explicitly superseded by the reset design.
- Architecture and scope: Initial review found that harness nudges lacked fresh operation bindings,
  native fork was advertised at the wrong granularity, and session identity echoed engine-owned
  execution. The interface now requires a binding per nudge, puts the inseparable fork capability
  and primitive on the activated harness/backend session, and returns only native session identity.
  Targeted re-review: clean.
- Correctness and proof: Initial review found that manual nudges could omit a deadline and that the
  fork flag could disagree with the optional primitive. Manual nudge options are now required; fork
  support is `false` or a capability containing its primitive. Negative type checks cover every
  bounded operation, operation bindings, both fork arms, and exclusion of engine identity from the
  harness outcome. Targeted re-review: clean.

### Task 2 — Secure result slots

- Architecture and scope: Initial review found concurrent open reservation, settlement/audit
  ordering, recoverable escaped-capability records, cross-slot capability redaction, and an exposed
  verification seam. Operation and capability identity are now reserved before persistence;
  submission and settlement share one accepted shape after audit reaches a final decision; every
  registry capability is forbidden/redacted on every path; and the module remains package-internal.
  Final targeted re-review: clean.
- Correctness and proof: Initial review found unstable expired tombstones, no active expiry,
  capability leaks through JSON keys/source/known rejection paths, and ambiguous post-link audit
  failure. Tombstones retain stable codes, deadlines actively expire slots, all candidate keys,
  values, raw/source/error fields and other slot capabilities are protected, and durable acceptance
  explicitly reports whether its audit attempt was recorded. Concurrency, rollback, delayed
  semantic validation, and audit ordering gained focused tests. Final targeted re-review: clean.

### Task 3 — Control plane

- Architecture and scope: Initial review found that the shell launcher resolved source relative to
  a package-manager symlink, all rejection codes incorrectly instructed the agent to change JSON,
  and the transport decision record contradicted the tested implementation. The command source is
  now the executable bin target and is exercised through a symlink; only `invalid-result` gives
  correction guidance; the Node-client/Bun-server EOF lifecycle and rejected Bun alternatives are
  recorded below. Targeted re-review: clean.
- Correctness and proof: Initial review found split-frame acceptance, authority-bearing decoder and
  CLI diagnostics, static-relative and dynamic boundary-check bypasses, unbounded connections and
  stdin, and a client timeout that did not close its socket. Both peers now validate the complete
  frame at EOF; diagnostics are generic or protect both authorities; boundary extraction covers
  static, dynamic, require, and relative cross-package imports; connection count, idle time, request,
  response, and streamed stdin are bounded; timeout destroys the client socket. Focused regression
  tests cover these paths. Targeted re-review: clean.

### Task 4 — Harness adapters

- Architecture and compatibility: Initial review rejected duplicate legacy lifecycles and the pane
  adapter's attempt to run headless stdin/EOF plans as interactive Herdr agents. Both legacy
  factories now translate shapes over the shared session core and native mechanics. Production
  pane execution uses only the confirmed interactive launch and explicitly refuses continuation
  until a measured interactive-resume primitive exists. Targeted re-review: clean.
- Correctness and failure paths: Initial review found missing post-execution deadline enforcement,
  incomplete cancellation quiescence, unretryable cleanup, reusable bindings, inherited authority
  during compaction, collapsed Herdr timeouts, and insufficient shared proof. The first re-review
  then found unsanitized close errors, lost start-timeout classification, and an inaccurate
  headless timeout diagnostic. The core and all three backends now enforce and test these paths;
  cleanup remains retryable and all operation authority is redacted from close failures. Final
  targeted re-review: clean.

### Task 5 — Workflow runner

- Architecture and scope: The reviews first found that reattachment did not consistently inherit
  the enclosing deadline, adapter declarations and unsupported identity fields were not fully
  enforced, settled owned failures could disappear, and nested `parallel` work could escape a
  successful parent scope. The runner now applies the earliest active deadline, validates adapter
  identity, rejects unsupported skills and execution settings, retains all owned work until scope
  settlement, and registers nested execution with its parent before returning. Final targeted
  re-review: clean.
- Correctness and proof: The reviews exercised accepted-result/native-timeout races, non-cooperative
  callbacks and cancellation, late async descendants, activation ownership, escaped authority in
  diagnostics, per-agent queue reuse after an indeterminate timeout, and concurrent cleanup retry.
  Engine-enforced native timeout now terminalizes the logical agent before its queue advances;
  close attempts are shared only while pending and owner cleanup retries a failed attempt. Focused
  regressions cover every finding. Final targeted re-review: clean.

### Task 6 — Fake-backed review

- Architecture and scope: Clean. The reusable workflow stays entirely on
  `@wf/contract/workflow`; runtime, fake, socket, and wire details live only in the root integration
  proof. The fixed lenses, stable fixture, lens-bound schemas, explicit incomplete outcomes, and
  blocking-only composition add no messaging, adjudication, or engine dependency and can be reused
  unchanged for the live evaluation.
- Correctness and proof: The initial review found that simultaneous fake submissions could finish in
  input order by coincidence, weakening the ordering proof. The test now establishes both native
  turns are in flight before submission, forces maintainability (input index 1) to be accepted
  first, records that reverse acceptance order, and separately asserts correctness-first composed
  order. Silence, invalid lens attribution on the initial turn and sole nudge, native timeout, and
  blockage remain explicit and contribute no successful blocking findings. Targeted re-review:
  clean.

### Task 7 — Live evaluation

- The entries below are pre-reset historical evidence. They do not satisfy the current Task 7,
  which requires the symmetric host and fresh bounded evidence after Task 4 closes.
- Architecture and scope: Initial review rejected a spend guard that existed only in the command
  wrapper, loose Claude authentication, successful handling of incomplete reviews, and evidence
  that ignored native nudge outcomes. The spending function now owns the opt-in gate, exact
  first-party subscription and pinned Herdr checks, record-only agent version evidence,
  ordered-completion gate, recursive native turn/nudge observation, standalone disposable CLI,
  repository fingerprint, and failure-artifact retention. Final pre-spend re-review approved
  exactly one live run.
- Correctness and evidence: Initial review independently found the opt-in, incomplete-result,
  metered-credential, infrastructure-version, repository-isolation, and nudge-evidence gaps.
  Focused regressions cover each gate; the final dry run passed every non-spending prerequisite.
  Final pre-spend re-review approved exactly one live run with no retry or fallback.
- Historical final architecture/evidence review: clean for the superseded topology. Native
  completion, accepted ordered results, composition, bounds, and cleanup satisfied that earlier
  evaluation, not the reset story outcome. The provider-specific trust coupling was classified as
  evaluator-only, deadline-bound, and fail-closed.
- Historical final correctness/evidence review: clean after the successful result, exact usage,
  cleanup, verification totals, and both failed live attempts were recorded. Subscription routing
  and no metered fallback were proved for that topology; provider billing cost was not inferred.

### Task 8 — Operator runner

- Architecture and scope, superseded: the initial review approved the executable-workflow
  descriptor, explicit trusted-file loader, operator-owned aliases, and separation between
  `awf run` and the in-agent `wf result` command. Its later Claude-pane/Codex-headless conclusion is
  rejected by the design reset above and is not current acceptance evidence. Task 8 must be reviewed
  again against the symmetric Herdr run host before it can converge.
- Correctness and security, superseded: Review findings covered strict JSON validation,
  incomplete-review exit behavior, signal cleanup, trusted-code disclosure, retained-artifact
  diagnostics, control characters, fail-closed subscription routing, and proof of the production
  Codex resume path.
  Accepted findings were fixed with focused regressions. The operator now refuses known metered
  credential variables, verifies Claude first-party and Codex ChatGPT authentication, clears those
  variables in both subprocess and pane environments, and tests fresh authority across
  `codex exec` and `codex exec resume`. That historical targeted review converged, but Task 8 still
  requires a fresh review and production invocation against the symmetric host.

## Readiness

- [ ] Outcome and boundaries are concrete.
- [ ] Relevant implementation, callers, and tests are mapped.
- [ ] Evidence and research support the proposed design.
- [ ] Expensive interface, record-format, and stage-gate decisions are settled.
- [ ] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope.

## Remaining risks

- Pane execution currently inherits the broad local authority documented in
  [`permissions.md`](../design/permissions.md). Codex runs with `danger-full-access` and approvals
  disabled; Claude receives Bash access. The successful proof bounded this authority to an
  evaluator-created disposable fixture, but a normal workflow runs in its supplied `cwd`.
  Constraining agent authority is the next design gate, not a claim made by this story.
- Herdr 0.8.2 accepts pane environment only as `--env KEY=VALUE` arguments. A one-turn result
  capability is therefore locally observable in the Herdr client argv during pane creation. The
  run host cannot close that confinement gap without a new Herdr environment transport; it limits
  the exposure to the one fresh operation pane and keeps the value out of workspace creation,
  records, diagnostics, subsequent commands, and prompts.
- Interactive pane settlement is not yet reliable evidence of model completion. Across the three
  post-trust-fix runs, one completed normally, one accepted both results but left Claude native
  state non-terminal until cancellation, and one failed with Claude `agent_prompt_stalled` while
  Codex reached its turn deadline. The adapter fails closed for explicit stalls and errors, but it
  does not yet fail closed for ambiguous `idle`. The retained evidence is under
  `awf-minimum-review-Du89Pi` and `awf-minimum-review-msrKbu`; measurement and classification work
  is captured in [`herdr-pane-settlement.md`](todo/herdr-pane-settlement.md). The broader measurement
  work is a follow-up, but Story 001 itself remains blocked until ambiguous `idle` cannot authorize
  completion or continuation.
- Result acceptance and native turn release are deliberately separate. An accepted result decides
  the author-facing value and immediately triggers bounded native release. Only a confirmed release
  permits the logical session to continue; timeout, rejection, or quarantine closes its queue.
  `Du89Pi` is retained historical evidence for this correction: both results were accepted by
  +140.024 s, but the rejected runner design kept the run open until the +300 s turn deadline.
- Executable workflow modules are trusted local code. Importing one runs it with the operator's
  filesystem and process authority; the command warns about this and does not claim sandboxing.

## Implementation notes

- Adjacent presentation work discovered during Task 7 is captured in
  [`herdr-layout-policy.md`](todo/herdr-layout-policy.md). Story 001 keeps its proven one-tab sibling
  layout; it does not add a speculative workflow-facing topology interface.
- The Task 8 audit captured the absent operator progress interface in
  [`operator-run-observation.md`](todo/operator-run-observation.md). The current story relies on its
  engine run handle and directly visible Herdr panes instead of adding a status daemon or event
  protocol.
- The blocked Task 7 launch exposed an ambiguous consent message; future disclosure metadata and
  acknowledgement are captured in [`live-eval-disclosure.md`](todo/live-eval-disclosure.md). Story
  001 still requires explicit approval for its exact fixture and provider destinations.
- Task 7 reset planning and setup (2026-09-02): run exactly the Task 6 definition with a five-minute
  initial-turn bound, ten-minute workflow/nudge bound, two subscription-authenticated reviewers,
  and at most one nudge each. The evaluator now installs the same symmetric production Herdr run
  host as the operator: one disposable run workspace/tab, two capability-isolated sibling panes,
  no provider-specific placement, and no headless or metered fallback. Preflight requires the
  managed Herdr environment and pinned Herdr version, records but never blocks agent CLI upgrades,
  verifies both subscription logins, compiles and smokes the in-agent `wf` command, and fingerprints
  the repository. The spending boundary still requires exact `WF_LIVE_EVAL=1`; any failure ends the
  single attempt and retains private evidence. Evidence distinguishes spontaneous native
  completion, confirmed release after accepted delivery, and quarantine. Only completion or a
  confirmed release is acceptable; blocked, timed-out, failed, quarantined, or unrequested
  cancellation is a failed evaluation.
- Task 6 reset planning and implementation (2026-09-02): keep the proof as one reusable
  `WorkflowDefinition` parameterized only by the two runtime selections. The two fixed lenses use
  separate schemas whose `lens` enum binds each result to its operation; `parallel` preserves lens
  order while the fake acceptance order is deliberately reversed. The fixture contains one small
  behavioral defect and one maintainability seam, enough to make the expected reports distinct.
  Completed and incomplete reviews form a discriminated result; missing, schema-rejected,
  timed-out, and blocked work cannot contribute findings or the blocking count. No messaging,
  adjudication, target-file I/O, additional rounds, or runtime construction belongs in this proof.
  The existing executable descriptor is retained for Task 8, but Task 6 tests only the reusable
  workflow through the engine and real result control plane.
- Task 6 reset review and verification (2026-09-02): architecture review found that using the
  workflow deadline for every phase erased the planned distinct initial-turn bound. Correctness
  review found that counting usage records did not prove preservation of native samples. The
  reusable definition now validates a configurable first-turn duration, derives its absolute
  deadline at dispatch, and caps it by the workflow deadline; nudge remains under the enclosing
  bound. The proof asserts the distinct and capped deadlines, exact ordered per-agent token totals,
  distinct operation identities, and equality between author-visible and engine-final usage.
  Both targeted re-reviews pass. The focused proof passes 5 tests with 25 assertions; the complete
  non-live suite passes 280 tests with 798 assertions. Type, boundary, and diff checks pass.
- Task 5 reset planning and implementation (2026-09-02): retained the existing one-run ownership,
  alias resolution, logical queues, structured parallel scope, and cleanup ordering, but corrected
  the result/native join that caused accepted reviews to wait for a long native deadline. The
  engine now observes result settlement, native settlement, and deadline concurrently. Accepted
  data triggers bounded release immediately; confirmed release contributes terminal usage, while
  unresolved release quarantines the session and blocks its queue. Added `startWorkflow` with
  `runId`, `result`, `inspect()`, and `stop()`; `runWorkflow` is its one-shot convenience. A
  long-lived engine object and public event service remain out of scope.
- Task 5 reset review and verification (2026-09-02): architecture review removed a harness-owned
  snapshot type from the public run handle and required agent cleanup to finish before the control
  plane closes. Correctness review found unbounded start/nudge acquisition, unowned activation and
  late-turn promises, cancellation gaps during host acquisition, native terminal states that could
  advance a queue, accepted-result/release races, a synchronous `openRun` cleanup leak, and an
  equal-deadline parallel race. The runner now applies the earliest enclosing deadline throughout,
  owns and releases late acquisitions exactly once, separates accepted data from confirmed native
  release, terminalizes every indeterminate session before queue reuse, drains accepted submissions
  even when acquisition rejects, and preserves the result endpoint through agent cleanup. Both
  targeted re-reviews pass. The final focused runner suite passes 44 tests with 131 assertions; the
  complete non-live suite passes 279 tests with 791 assertions. Type, boundary, and diff checks pass.
- Task 4 reset planning and implementation (2026-09-02): compared extending the isolated pane
  adapter, introducing a general terminal/provider plugin graph, and implementing the concrete host
  this story has evidence for. The selected host creates one neutral Herdr workspace/tab per run,
  then splits one capability-bound sibling pane per operation. Both Claude and Codex use interactive
  provider commands behind the same lifecycle; nudge remains in-pane, while a later operation closes
  the old pane and starts measured native resume in a fresh pane. Missing or non-terminal continuation
  evidence fails closed. The operator now installs this host directly; isolated-pane and headless
  adapters remain only as harness evidence and frozen compatibility. Host cleanup is retryable and
  closes the complete workspace. The initial focused host, adapter, conformance, and operator tests
  passed 45/45 with 141 assertions.
- Task 4 reset review and verification (2026-09-02): architecture review found that partial
  topology acquisition could hide a failed workspace rollback. Correctness/security review found
  that sibling authority could enter another agent's evidence and resume reference, failed
  continuation could be bypassed by another start, and cancellation racing success could restore
  resumability. Acquisition now surfaces both failures; the host filters all Herdr-derived evidence
  against the run-wide escaped-authority set; continuation is generation-bound and permanently
  latched closed after missing, blocked, unknown, cancelled, or late evidence; cancellation clears
  it after native work drains. Both targeted re-reviews pass. The final focused slice passes 57
  tests with 187 assertions; the complete non-live suite passes 267 tests with 757 assertions.
  Type, boundary, and diff checks pass.
- Task 3 reset planning (2026-09-02): retained the narrow versioned result-submit protocol and one
  engine-owned Unix-socket endpoint. Adding operator status, cancellation, topology, or an event
  stream here was rejected because this endpoint is untrusted operation input, while run inspection
  remains an in-process run-host concern in this story. HTTP framing adds unused surface; an
  explicit length prefix adds state without improving the single-request exchange; JSONL with peer
  write-side close remains the smallest strict frame. The CLI remains a contract-only client with
  no run-directory access. Argument mode deliberately does not inspect or consume inherited stdin;
  stdin is selected only when the JSON argument is absent.
- Task 3 reset implementation (2026-09-02): malformed or absent wire-version fields now differ
  from a well-formed unsupported version, and CLI diagnostic protection recognizes both Unicode
  and hexadecimal ASCII escapes. The existing endpoint, strict frame, bounded client, package
  boundary, and cleanup implementations otherwise remain the coherent slice. The focused wire,
  endpoint, client, CLI, and boundary suite initially passed 28 tests with 79 assertions.
- Task 3 reset review and verification (2026-09-02): correctness/security review found that
  endpoint close did not await an already-admitted submission and that client timeout was idle-only,
  allowing a dripping peer to extend it indefinitely. Close now ends admission, removes endpoint
  reachability, waits for admitted handlers, and only then releases its directory. The client has
  an independent absolute lifetime. Direct race tests cover both defects; both targeted re-reviews
  pass. The final focused suite passes 30 tests with 83 assertions; the complete non-live suite
  passes 258 tests with 707 assertions. Type, boundary, and diff checks pass.
- Task 2 reset planning and implementation (2026-09-02): retained the existing run-scoped
  `open`/`submit`/`close` registry and serialized per-slot settlement because the new host seam does
  not change ownership of validation or atomic persistence. The reset found one foundation
  violation: redaction discarded settled capabilities. The registry now protects every capability
  issued during the run, so later metadata, values, sources, semantic errors, and records cannot
  echo authority left in a closed or quarantined pane.
- Task 2 reset review and verification (2026-09-02): architecture and correctness/security review
  found that escaped capability text could enter slot metadata, a semantic callback could mutate a
  value after schema validation, and an expiry racing a semantic verdict needed a deterministic
  winner. Metadata checks now recognize ASCII escapes, semantic checks receive a clone, and the
  serialized post-semantic transition rechecks slot state and the complete run capability set
  before recording or publishing. Both targeted re-reviews passed. Focused result-slot tests pass
  16/16 with 62 assertions. The complete non-live suite passes 256 tests with 697 assertions;
  type, boundary, and diff checks pass.
- Task 1 reset implementation and verification (2026-09-02): removed backend and funding-pool
  selection from workload identity; installed one run-host factory; made initial delivery and nudge
  share operation id, capability, schema, and aggregated usage; hid native continuation references;
  and separated native settlement from released/quarantined disposition. The final non-live suite
  passed 254 tests with 689 assertions. `bun run ts-check`, boundary checks, and `git diff --check`
  passed. The first sandboxed socket run was invalid (`EPERM`); the same suite passed with local
  socket permission.
- Task 1 reset planning (2026-09-02): three independent interface designs compared a minimal
  run handle, a flexible terminal-host/provider composition, and a common-case two-pane host. All
  rejected per-agent backend adapters. The selected hybrid exposes one run-owned host while keeping
  Herdr and provider composition internal. A live Herdr probe proved per-pane environment values
  are isolated at shell creation within one shared tab, then removed its temporary workspace.
- Task 1 reset planning review: architecture required removing public `BackendKind`, moving funding
  pool into run admission/accounting policy, keeping harness/model/settings as workload facts,
  hiding native session references, and correcting nudge to reuse one operation binding. Correctness
  required separate accepted/acknowledged/released facts, generation-bound continuation, ordered
  run-host shutdown, full-run secret redaction, and an explicit cooperative-peer threat model.
  These findings are incorporated in `foundation.md` and Task 1's `Work`/`Done when` sections before
  implementation.
- Task 1 planning (2026-09-01): use an `AbsoluteDeadline` object containing Unix milliseconds
  rather than a duration or bare number, and require it at every author-facing wait. A single
  exported `DeadlineExceededError` with a stable `deadline-exceeded` code is the rejection shape
  for waits that do not have a terminal outcome. Agent turns retain outcomes and add `timed-out`.
- Task 1 planning: keep the public outcome engine-owned. The harness reports a smaller local
  outcome containing native terminal state, transcript evidence, session reference, and native
  usage samples. `HarnessSession.start` receives a separate engine-created operation binding;
  putting the binding on the author turn spec was rejected because it would leak engine authority
  across the package seam, and returning `TurnOutcome` from the harness was rejected because it
  makes adapters manufacture agent identity and aggregate accounting.
- Task 1 planning: remove journal replay rather than retaining a useless `never` policy. A signal
  explicitly suspends only its calling branch; checkpoints remain outside the author interface and
  are documented as a future engine admission barrier. Native fork remains harness-only as a
  declared adapter capability plus optional native primitive; no logical fork operation is added.
- Task 1 planning: accepted-result settlement remains an engine contract: validation precedes one
  atomic first-valid-result-wins transition. Task 1 states this invariant at the operation-binding
  seam; Task 2 will implement and prove it.
- Task 1 implementation (2026-09-01): added `AbsoluteDeadline`, the stable
  `DeadlineExceededError`, required deadlines across all author waits, distinct public and harness
  timeout outcomes, harness-local result evidence and native usage, engine bindings for initial and
  nudged turns, and per-session native fork capability. Removed journal replay from the public
  surface and updated all examples without widening their imports.
- Task 1 verification (2026-09-01): `bun test` passed 116 tests; `bunx tsc --noEmit` passed,
  including focused negative type checks; `bun run scripts/check-boundaries.ts` reported
  `boundaries ok`; `git diff --check` passed. Both targeted subagent re-reviews were clean.
- Task 2 planning (2026-09-01): use one run-scoped result-slot registry with the small interface
  `open`, `submit`, and `close`. Each slot owns its operation id, question, schema, semantic check,
  absolute deadline, capability tombstone, and a per-slot serialized settlement transition. A
  per-slot object with its own submission method was rejected because the control-plane server must
  look submissions up by bearer capability; a process-global registry was rejected because it
  obscures run ownership and cleanup.
- Task 2 planning: keep validation pure from persistence. Validation runs before entering the
  settlement transition; known invalid, wrong-operation, expired, and closed attempts are recorded
  as rejected. Valid contenders serialize at the slot, and only the winner of atomic exclusive
  result creation records an accepted attempt. Persistence failure leaves the slot open and records
  no false acceptance. Unknown capabilities cannot be attributed to a slot and are not persisted.
- Task 2 planning: replace result persistence with write-complete-then-atomically-link creation in
  the call directory. This avoids both check-then-write races and readers observing a partial JSON
  file. Capabilities are 32 random bytes encoded as base64url by default; clock and generator are
  injected only at registry construction for deterministic focused tests. Closed and expired slots
  remain as in-memory tombstones until the run registry is discarded, so rejection codes stay
  stable and restart still invalidates all capabilities.
- Task 2 implementation (2026-09-01): added the package-internal result-slot registry, automatic
  expiry and tombstones, 32-byte base64url capabilities, registry-wide authority leak prevention,
  and atomic complete-file result creation. Split candidate validation from persistence so the
  legacy CLI path and slots keep identical field-level schema and semantic errors.
- Task 2 implementation decision: `result.json` is authoritative once its atomic link succeeds.
  Accepted settlement waits until attempt append succeeds or fails and returns
  `attemptRecorded: false` for the latter; it never reports an already durable accepted result as
  rejected. This is the explicit degraded-I/O state because two separate public record files cannot
  be committed atomically without changing the public run-record format.
- Task 2 verification (2026-09-01): focused result-slot tests passed 13/13 and atomic run-directory
  tests passed 2/2. Full `bun test` passed 130 tests; `bunx tsc --noEmit`, boundary checks, and
  `git diff --check` passed. Final architecture and correctness/security re-reviews were clean.
- Task 3 research (2026-09-01): Context7 resolved Bun to `/oven-sh/bun/bun-v1.4.0`; the current
  docs and installed Bun 1.4.0 types confirm low-level `Bun.listen({ unix })` and
  `Bun.connect({ unix })`, per-socket data, half-close behavior, and listener `stop(true)`.
- Task 3 planning: add pure `@wf/contract/wire` decoders for version 1 result-submit requests and
  responses. The request is `{ version, operationId, capability, raw }`; the response is either
  accepted or a rejected/protocol-error code plus safe detail. Runtime decoders reject missing,
  extra, wrongly typed, empty, and unsupported-version fields. HTTP-over-Unix was rejected because
  it adds a second protocol and parsing surface to a one-message local exchange; a length-prefixed
  frame was rejected because the settled decision is one newline-delimited JSON request/response.
- Task 3 planning: the engine endpoint owns one mode-0700 temporary directory and socket, buffers
  exactly one complete newline-terminated request, caps requests at 1 MiB, submits through the
  Task 2 registry, writes one response line, closes active connections on shutdown, and removes its
  socket and directory idempotently. Malformed, extra-line, oversized, and internal-error responses
  are generic and never echo capability-bearing input.
- Task 3 planning: create `cli-agent` now that the wire seam is real. Its client imports only
  `@wf/contract/wire` plus the platform socket API; its command accepts JSON from exactly one
  argument or bounded non-TTY standard input before opening a connection. Remove the engine-linked
  agent CLI so there is one production result path. Extend the boundary checker to enforce
  contract-only imports, including relative and dynamic imports, and ban run-directory I/O in
  `cli-agent`.
- Task 3 implementation evidence: Bun 1.4.0's documented client half-close paths did not produce a
  usable request/response lifecycle in the real Unix-socket tests. `end(data)` prevented the client
  from receiving the response, while `write` plus `shutdown(true)` did not deliver the server's
  `end` event. The selected seam is therefore a Node `node:net` client calling
  `socket.end(outgoing)` and a Bun server waiting for peer write-side EOF before decoding the full
  request. The Bun server then sends exactly one response and closes. This preserves strict JSONL
  cardinality across fragmented input and is covered through the symlinked CLI, not merely a direct
  function call.
- Task 3 verification (2026-09-01): the focused control-plane, CLI, client, wire, boundary,
  result-slot, and run-directory suite passed 40 tests. Full `bun test` passed 142 tests with 316
  assertions; `bunx tsc --noEmit`, the boundary checker, and `git diff --check` passed. Final
  architecture/scope and correctness/security re-reviews were clean.
- Task 4 research (2026-09-01): Context7 resolved current Herdr documentation to
  `/herdrdev/herdr`. `workspace create` and pane creation accept environment only when the pane is
  created; `agent prompt` accepts text, wait states, and a timeout but no per-prompt environment.
  Herdr's `agent start` always launches the canonical harness executable plus supplied arguments.
  This matches the frozen E3 finding that a pooled pane cannot carry per-call identity.
- Task 4 capability limitation: direct inspection of Herdr 0.8.2 confirmed that workspace
  environment has no stdin or file input; `--env KEY=VALUE` is the only supported interface.
  Consequently the bound capability is briefly present in the Herdr client argv during workspace
  creation. This corrects the earlier environment-only confinement claim. The adapter regression
  pins that exposure to the create command and proves later Herdr commands do not receive it.
- Task 4 planning: one activated logical harness session may span several native processes, but
  each result-bearing operation gets a fresh OS process with only that operation's endpoint,
  operation id, and capability. Headless executes one confirmed native CLI process per operation.
  Reusing one interactive pane was rejected because process environments are immutable and a
  delayed command would otherwise retain or observe the wrong operation authority.
- Task 4 implementation evidence: the first pane implementation tried to start the existing
  headless/resume plans through Herdr's interactive `agent start` facade. Architecture review caught
  that those plans require stdin plus EOF (`claude -p`, `codex exec ... -`) and are not proven to
  remain promptable through `agent prompt`. That reinterpretation is rejected. Pane mode now uses
  only the measured interactive launch for one fresh capability-bound workspace and explicitly
  fails continuation. Safe pane continuation remains unavailable until a harness-specific
  interactive-resume primitive is designed and measured; it will not silently reuse stale
  authority or pretend a headless command is interactive.
- Task 4 planning: put queue/lifecycle mapping, fresh-binding enforcement, nudge serialization,
  status, deadline checks, evidence shaping, and cleanup in one package-internal session core.
  Pane, headless, and fake backends implement only native activation/turn mechanics behind that
  core. Compatibility factories for frozen experiments delegate to shared native command/Herdr
  primitives and remain outside the engine-facing adapter path; result acceptance stays entirely
  in the engine.
- Task 4 planning: scrub inherited `WF_ENDPOINT`, `WF_OPERATION`, and `WF_CAPABILITY` before every
  child process and add only the current binding for a result-bearing turn. Compaction receives no
  result authority. `deliver` remains an explicit unsupported operation until messaging defines
  delivery acknowledgement; silently treating a second prompt as delivered would contradict the
  measured lost-prompt evidence.
- Task 4 implementation: `createSessionAdapter` is the package-internal lifecycle module for
  deadline and status mapping, one-active-operation serialization, one-use operation bindings,
  outcome and cleanup-error redaction, cancellation, and retryable close. Headless, pane, and fake
  backends implement native mechanics behind it. The frozen driver factories translate their old
  shapes through the same core; only their measured legacy environment and retained-pane behavior
  remain distinct.
- Task 4 verification (2026-09-01): the focused adapter, binding, command, liveness, cancellation,
  timeout, redaction, and cleanup suite passed 46 tests. Full `bun test` passed 166 tests with 392
  assertions when run outside the filesystem sandbox required by its Unix-socket integration
  tests. `bunx tsc --noEmit`, the boundary checker, and `git diff --check` passed. Final
  architecture/compatibility and correctness/failure-path re-reviews were clean.
- Task 5 planning (2026-09-01): use one exported `runWorkflow` function as the ownership boundary,
  not a long-lived engine class. One invocation creates the run directory, result-slot registry,
  private control-plane endpoint, logical-agent registry, per-agent queues, and usage ledger. It
  closes all activated sessions before the endpoint and reports cleanup failures without skipping
  later cleanup. The public options inject only the run root, `AgentRuntimeConfig`, optional working
  directory, and an optional log sink; test-only state stays observable through adapters and the
  returned run id rather than widening the runtime API.
- Task 5 planning: resolve a runtime alias exactly once at `agents.open`, apply every supplied
  requirement as an exact constraint, and retain the resolved `AgentExecution` on the logical
  agent. Reopening a key reattaches only when supplied identity fields match. Each agent owns one
  failure-resilient promise tail, so `run` calls dispatch in enqueue order and a failed operation
  does not poison later queue entries. Author turn ids are idempotency keys, never filesystem paths;
  every initial turn and nudge receives a random engine operation id, a new result slot, and a new
  capability.
- Task 5 planning: append the measured `wf result` and JSON-shape instructions to the model prompt
  while keeping operation authority only in the adapter binding. Reconcile the native outcome with
  atomic slot settlement after native completion: any accepted value is `answered`; otherwise
  preserve blocked, timed-out, failed, and cancelled states, with a normally settled open slot
  becoming `unanswered`. A configured nudge remains inside the same per-agent queue entry but is a
  separately accounted operation. Reserve usage positions at dispatch so completion order cannot
  reorder `workflow.usage()`.
- Task 5 planning: implement `parallel` as a bounded worker pool that writes results by input index.
  Track agent operations in an async execution scope so a parallel deadline cancels work owned by
  that call before rejecting. All author-surface features outside `agents.open`, `AgentRef.run`,
  `parallel`, `usage`, and `log` reject with an explicit not-implemented error; accepting retention,
  recovery, messaging, child calls, steps, signals, enqueue, or compaction without their semantics
  was rejected as a misleading foundation.
- Task 5 implementation: `runWorkflow` owns the run directory, secure result slots, private control
  endpoint, logical agents, structured parallel scopes, usage ledger, and cleanup order for exactly
  one run. Runtime aliases are fixed at first open; non-empty skills and any execution settings are
  rejected until their semantics exist. Each turn and nudge gets fresh random operation authority.
  An engine-enforced native timeout terminalizes that logical agent, so a cancellation mechanism
  that cannot prove quiescence can never release its queue into the same native session.
- Task 5 verification (2026-09-01): the focused runner, result-slot, control-plane, binding, and fake
  suite passed 49 tests with 156 assertions. Full `bun test` passed 191 tests with 462 assertions.
  `bunx tsc --noEmit`, the boundary checker, and `git diff --check` passed. Final architecture/scope
  and correctness/security re-reviews were clean.
- Task 6 planning (2026-09-01): add one executable `examples/minimum-review.ts` definition that
  imports only `@wf/contract/workflow`, plus a small stable TypeScript target under
  `examples/fixtures/`. The workflow has exactly two fixed lenses, `correctness` then
  `maintainability`; runtime selections, working directory, target path, one initial-turn deadline,
  and the enclosing workflow/nudge deadline are data. Each lens gets a schema whose `lens` field is
  a single-value enum, so swapped or misattributed submissions fail at the result gate.
- Task 6 planning: return one ordered `ReviewOutcome` per lens. An accepted outcome carries
  `{ lens, summary, findings }`; every other agent outcome carries its exact kind and reason and
  contributes no blocking findings. Composition counts only accepted findings whose severity is
  `blocking`. This keeps missing, malformed, timed-out, blocked, failed, and cancelled work visible
  without adding messaging, adjudication, retries beyond the one configured nudge, or a new engine
  interface.
- Task 6 planning: place the cross-package proof in a root integration test so the reusable example
  remains on the author surface and the engine does not acquire a dependency on examples. A barrier
  in the fake script proves both native turns are in flight before either result is submitted; the
  fakes use their real operation bindings and Unix-socket control plane. Focused cases prove ordered
  composition, lens-schema rejection, silence, timeout, and blocked outcomes.
- Task 6 verification (2026-09-01): the focused end-to-end proof passed 4 tests with 17 assertions.
  Full `bun test` passed 195 tests with 479 assertions. `bunx tsc --noEmit`, the boundary checker,
  and `git diff --check` passed. Architecture/scope review was clean; correctness/proof re-review
  was clean after the completion-order regression was strengthened.
- Task 7 planning (2026-09-01): the only live command is
  `WF_LIVE_EVAL=1 bun tests/minimum-review.eval.ts`; the non-spending prerequisite command is
  `bun tests/minimum-review.eval.ts --dry-run`. The evaluator refuses to start agents without the
  opt-in variable and has no headless or metered backend. It runs the unchanged Task 6 workflow in a
  disposable copy of the fixture, with the source `wf` CLI exposed through an evaluation-only bin
  directory. The CLI is compiled into a self-contained disposable executable; no repository path is
  given to either reviewer, and a content fingerprint makes any repository change fail the proof.
- Task 7 planning: use Herdr 0.8.2 session `default`, Claude Code authenticated through claude.ai
  with model alias `sonnet` for correctness, and Codex CLI authenticated through ChatGPT with
  configured model `gpt-5.6-sol` for maintainability. Agent CLI versions are recorded but upgrades
  never block evaluation; Herdr remains pinned as the pane substrate. Both aliases use backend
  `pane` and pool `subscription`. The initial turns share an absolute five-minute deadline; the
  enclosing collection has an absolute ten-minute deadline and permits only the workflow's one
  configured nudge. There is no fallback and the live command is run once.
- Task 7 planning: expected evidence is two `completed` reviews in correctness/maintainability input
  order, accepted through the production result socket, plus elapsed time and the actual usage
  fields returned by each pane harness. Stop without retry on a failed prerequisite, workspace or
  agent-start failure, explicit incomplete result, deadline, or cleanup error. Successful runs close
  both Herdr workspaces and delete the disposable directory; failures still close through the runner
  but retain their temporary run records and report the path for diagnosis.
- Task 7 dry run (2026-09-01): `HERDR_ENV=1`, the default Herdr session, the fixture, executable
  source `wf` CLI, Claude subscription authentication, Codex ChatGPT authentication, and a real CLI
  import/usage smoke check all passed. No agent was started and no model turn was spent.
- Task 7 execution blocker (2026-09-01): the one approved command was submitted once but rejected
  before process creation by the execution approval layer. No Herdr workspace or live agent was
  created and no subscription quota was consumed. Explicit user approval is required because the
  disposable contents of `examples/fixtures/review-target.ts` will be sent to Anthropic Claude and
  OpenAI Codex, and both subscription accounts will be used. Do not retry or substitute another
  execution path without that approval.
- Task 7 live result (2026-09-01): after explicit approval, the recorded command ran exactly once
  with no retry or fallback. Herdr created workspaces `w1M` and `w1N`, but all five `agent.start`
  attempts per pane failed and no Claude or Codex launch was observed. No `wf result` attempt or
  accepted result exists; the workflow returned explicit incomplete correctness and maintainability
  outcomes. Both workspaces closed successfully about ten seconds after creation and are absent from
  the live workspace list. No model turn or token usage was observed. Run records and the disposable
  fixture were retained under
  `/var/folders/4g/s95glx9x6n71bq4hc08ly2gm0000gn/T/awf-minimum-review-J4rjad`.
- Task 7 diagnosis (2026-09-01): an isolated Herdr probe reproduced the failure as
  `invalid_agent_name`. The adapter generated names such as `wf-correctness-<UUID>`, while Herdr
  requires `[a-z][a-z0-9_-]{0,31}`. A valid short control name reached an idle Codex pane; the
  evaluator-shaped name was rejected before launch. This disproves the initial pane-readiness
  classification and does not establish a structured-result or composition failure.
- Task 7 startup fix: pane names now keep a normalized readable agent-key prefix and use a
  deterministic suffix derived from the engine-owned operation ID, never the capability. The
  adapter-level regression proves the Herdr grammar and proves that identical author key/turn pairs
  in concurrent invocations receive distinct names. Focused harness and conformance tests passed
  24/24; TypeScript and `git diff --check` passed. Architecture review found and prompted the
  engine-identity correction; targeted architecture and correctness/security re-reviews were clean.
  Remaining diagnostic work is captured in
  [`pane-agent-start-readiness.md`](todo/pane-agent-start-readiness.md).
- Task 7 agent-version decision (2026-09-01): Claude and Codex upgrades are assumed safe. Their
  installed versions remain recorded evidence, but version drift never blocks evaluation. Herdr is
  still pinned because its pane-control contract is infrastructure rather than an agent runtime.
- Task 7 second live result (2026-09-01): the explicitly authorized post-name-fix run created
  workspaces `w1P` and `w1Q` and launched both native CLIs, but each stopped at its directory-trust
  onboarding screen before `agent prompt`. No result attempt was submitted; both workspaces were
  cleaned up. Run `42399ab9-2522-422a-96cd-13e54ec2cc32` and its calls remain under
  `/var/folders/4g/s95glx9x6n71bq4hc08ly2gm0000gn/T/awf-minimum-review-nAoWjX`.
- Task 7 trust and diagnostic fix: evaluator-created disposable workspaces opt into a narrow
  provider-specific trust handshake. It accepts only the recognized Claude or Codex directory
  screen, sends the minimum selection keys before the absolute deadline, waits for readiness, and
  fails closed on any other blocked UI. Only exact `agent_pane_busy` remains retryable. Failed
  evaluations now atomically retain a private mode-0600 evidence snapshot without following a
  pre-existing symlink or persisting caught error text. Architecture and correctness/security
  reviews were clean after deadline, retry classification, and evidence-file findings were fixed.
- Task 7 successful live result (2026-09-01): the final trust-fixed run completed in 27,933 ms with
  run ID `0340ac90-f7d2-4465-bf8f-eb04455c97cf`. Claude `sonnet` completed the correctness turn and
  Codex `gpt-5.6-sol` completed the maintainability turn; both native outcomes were `done` with one
  usage sample and neither needed a nudge. The result gate accepted both structured reviews in
  input order. Correctness reported one blocking empty-input `NaN%` defect; maintainability reported
  one non-blocking duplicated-status-handling concern, for `blockingFindingCount: 1`. The run used
  subscription pane aliases with no metered fallback. The Claude engine usage record contains
  `tokens.cacheRead: 0`; the Codex record contains no token fields. These are recorded observations,
  not a zero-cost claim. The original successful evaluator deleted its disposable artifact
  directory, so this result is terminal-observed evidence rather than independently auditable
  retained evidence. The post-run Herdr workspace list contained no evaluation workspace. The
  evaluator now retains a private `evaluation.json`, run records, fixture, and compiled CLI on
  success and returns their path; a fresh bounded run is recorded below.
- Task 7 deviation: two authorized bounded runs failed before the successful proof—first on invalid
  Herdr names, then on provider directory-trust onboarding. Each failure was stopped without an
  automatic fallback, diagnosed from retained evidence, fixed with focused tests and two reviews,
  and followed by a fresh explicit execution decision. The final successful run used the originally
  bounded workflow, harnesses, models, deadlines, nudge limit, and subscription-only backend.
- Post-review evidence retention (2026-09-01): the evaluator now retains its private artifact root
  and writes `evaluation.json` on success rather than deleting the only auditable evidence. A fresh
  bounded run retained
  `/var/folders/4g/s95glx9x6n71bq4hc08ly2gm0000gn/T/awf-minimum-review-Du89Pi` with run ID
  `73dab36f-369b-4161-995a-6dc442fe7271`. Both structured reviews were accepted and their complete
  call, attempt, result, composition, and usage records are present. Claude submitted at +140.024 s,
  159.976 seconds before its five-minute deadline, but did not reach a native terminal state during
  the remaining interval; the strict gate cancelled it at +300 s and correctly failed the
  evaluation after 300,577 ms. An unchanged bounded
  rerun retained
  `/var/folders/4g/s95glx9x6n71bq4hc08ly2gm0000gn/T/awf-minimum-review-msrKbu` with run ID
  `0d4d55cd-31f9-445f-a50f-1752e580e63a`; Claude remained idle with Herdr
  `agent_prompt_stalled`, while Codex was cancelled at its +300 s turn deadline. No result was
  accepted in that rerun and no evaluation workspace leaked. Foundation section 7 already records
  that Herdr prompt delivery cannot be inferred from a return value; retrying the same authority
  could duplicate an ambiguously delivered prompt, so the adapter remains fail-closed and no third
  automatic rerun was made. The original 27,933 ms run remains the native-completion proof; the
  first post-review artifact is retained, auditable proof of both accepted results and composition.
- Final automated verification (2026-09-01): `bun test` passed 212 tests with 528 assertions,
  including the fake end-to-end workflow and all opt-in, subscription, completion, and evidence
  gates. `bunx tsc --noEmit`, `bun run scripts/check-boundaries.ts`, and `git diff --check` passed.
  The final dry run passed every prerequisite and Task 7's successful pane execution is recorded
  above.
- Post-review test hygiene: Bun 1.4.0 does not run Node `exit` hooks under `bun test`, so the first
  cleanup attempt was discarded after measurement showed 125 leaked roots. Current suites now own
  per-file temp trackers cleaned by `afterAll`; the frozen experiment tests retain their existing
  helper, which uses Bun's documented per-test `onTestFinished` hook. A measured full-suite run must
  leave the count of top-level `wf-*` temp roots unchanged.
- Task 8 planning (2026-09-01): compare a workflow-specific command, a registry/catalogue, and an
  explicit executable workflow module. The explicit module was selected because it keeps
  `runWorkflow` as the embeddable engine seam, gives each workflow local argument preparation, and
  lets one generic trusted operator hide loader, runtime, result-command installation, artifacts,
  cancellation, and cleanup without publishing a discovery or configuration system.
- Task 8 implementation: add a pure `ExecutableWorkflow` descriptor and strict runtime JSON guard;
  an audited explicit `.ts`/`.mts`/`.js`/`.mjs` loader; the `awf run` parser and lifecycle; and a
  bounded `review-loop` executable that reuses the minimum review definition. The engine package
  publishes `awf`; the root workspace exposes `bun run awf -- run ...`; examples still import only
  the author surface.
- Task 8 live diagnosis: the first operator run retained
  `/private/tmp/awf-operator-live/invocation-a746076b-c565-4ea4-8ed0-358e2ec16699` and failed
  explicitly because the Codex pane produced no accepted result and the pane adapter has no safe
  continuation primitive. Static evidence and the confirmed harness spec supported moving only
  Codex to headless execution with native resume; no blind retry or runtime fallback was added.
- Task 8 final live result (2026-09-01):
  `bun run awf -- run --timeout 10m --run-root /private/tmp/awf-operator-live-final examples/review-loop.ts -- examples/fixtures/review-target.ts`
  exited 0 in 28.5 seconds. Run `17305e5b-7af8-4e8b-b7d8-117996d94f6c` returned completed
  correctness and maintainability reviews in input order with zero blocking findings and retained
  artifacts under
  `/private/tmp/awf-operator-live-final/invocation-349fb1ce-1efa-4adc-b4fb-ca5de721dd69/17305e5b-7af8-4e8b-b7d8-117996d94f6c`.
  The post-run Herdr workspace list contained no `awf run` workspace.
- Task 8 final verification (2026-09-01): focused runtime and Herdr suites passed 31 tests with 86
  assertions. Repository-wide `bun test` passed 237 tests with 630 assertions; `bun run ts-check`,
  `bun run scripts/check-boundaries.ts`, and `git diff --check` passed. The first sandboxed full-test
  attempt was invalid because local Unix-socket binds returned `EPERM`; the identical suite passed
  outside that sandbox. Both final subagent reviews converged with no unresolved findings.
- Foundation reset (2026-09-01): user review rejected the asymmetric production topology. The first
  full-tree operator retry was cancelled and retained under
  `.awf/runs/invocation-ba128666-51c4-4a81-9ff2-658c77c6efee` after Herdr inspection showed Claude
  had launched four background review agents; three remaining forks had each consumed roughly
  150,000–162,000 tokens. A no-delegation instruction was added and proven in focused tests.
- Foundation reset live evidence: the second full-tree retry retained under
  `.awf/runs/invocation-7bc0f253-2ae3-40a9-8c6f-a94b99fbbf14` obeyed the no-delegation instruction.
  Herdr showed one Claude reviewer progressing directly from 2,800 tokens at 55 seconds to 27,200
  tokens at 5 minutes 10 seconds. The operator cancelled it after user review identified the deeper
  flaw: only Claude was visible in Herdr while the peer Codex reviewer used a different headless
  lifecycle. Both cancelled runs exited 130 and removed their temporary Herdr workspaces.
- Foundation reset decision: uncheck Tasks 1–8, story verification, and readiness. Re-audit every
  seam in order. Do not treat the existing Claude-pane/Codex-headless split as an acceptable final
  design or build further operator behavior on it.
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
