---
id: "001"
title: Run a minimum multi-agent review workflow
summary: Prove that the engine can run parallel review agents and compose accepted structured results.
type: story
status: in-progress
depends_on: []
---

# Run a minimum multi-agent review workflow

## Outcome

Run [`examples/review-loop.ts`](../../examples/review-loop.ts) through `awf run`, open Claude and
Codex as visible sibling panes in one Herdr tab, accept their isolated structured results, and
return one ordered review result.

This is the first usable end-to-end proof of the engine. The symmetric Herdr path has passed its
bounded live run; human review is what remains.

## Current status

All eight tasks are implemented and the story has run end to end on live Claude and Codex
subscription sessions. Only human review remains.

The live runs found three defects, each invisible to a stubbed Herdr. The first run hit two: a trust
prompt that wraps in a half-width pane, and a prompt discarded by an agent that has just dismissed a
modal. Fixing the first made the third reachable — an agent pane never received the run's
environment, so the return channel was off its PATH. Task 7 records them.

Task 4 removed the two places where an ambiguous Herdr observation decided something
([`herdr.ts`](../../packages/harness/src/adapters/herdr.ts), `createHerdrRunHostFactory`): a stalled
prompt observation no longer settles the operation, and lifecycle state no longer authorizes
continuation — the production host refuses a second operation on an agent outright. Both are
deletions rather than new machinery; the measurement work that would let continuation return is in
[`herdr-pane-settlement.md`](todo/herdr-pane-settlement.md).

Committed foundation: `ee0df49` (`feat: add multi-agent review workflow foundation`). At that
commit, `bun test` passed 281 tests, `bun run ts-check` passed, the boundary checker passed, and
`git diff --check` passed. These are progress results, not final story acceptance.

This file was condensed on 2026-09-17. The per-task review record and implementation notes it
dropped remain the acceptance evidence for Tasks 1–3 and are recoverable with
`git show ee0df49:docs/stories/001-multi-agent-review.md`.

## Tasks at a glance

- [x] 1. Finish the executable interfaces
- [x] 2. Create secure result slots
- [x] 3. Put result submission behind the control plane
- [x] 4. Make Herdr settlement and continuation safe
- [x] 5. Reverify the minimum workflow runner
- [x] 6. Reverify the fake-backed two-agent review
- [x] 7. Run one bounded live evaluation
- [x] 8. Accept the operator-runnable review workflow
- [ ] Human review

## Design decisions

### Task 4 — Native settlement

Research and measurement answered the design question: Herdr lifecycle state is useful operator
telemetry, but it is not proof that a particular prompt has finished.

- `herdr agent prompt --help` (0.8.2) states it plainly: the wait "does not track turns: if the
  agent is already working, that active turn's completion may match". It also documents that a
  submission is **accepted** before the 5000 ms state-change window, and that failing that window
  returns `agent_prompt_stalled`.
- [Herdr's automation documentation](https://github.com/herdrdev/herdr/blob/master/skills/herdr/SKILL.md)
  says the same at the skill level; lifecycle classification still comes from screen manifests even
  where Claude and Codex report native session identity.
- Historical Herdr issues documented [`idle` during visible work](https://github.com/herdrdev/herdr/issues/2682),
  [false prompt stalls](https://github.com/herdrdev/herdr/issues/2690), and
  [stale `working` after completion](https://github.com/herdrdev/herdr/issues/198).
- The local Herdr 0.8.2 probe on 2026-09-17 observed the normal `idle → working → done` sequence for
  a bounded Codex turn. It proves the happy path only.

Decided:

- Only an accepted structured result settles the author-facing operation successfully. That was
  already true — `reconcile` in [`workflow-runner.ts`](../../packages/engine/src/workflow-runner.ts)
  answers from the result slot and nothing else — so Task 4 did not change it.
- `agent_prompt_stalled` never settles and never resends. The submission was already accepted when
  Herdr reports it, so the prompt may be running: the host waits out the operation deadline instead,
  which leaves the result slot open, keeps the engine's result race alive, and arms no nudge.
- Lifecycle state authorizes no continuation. The production host refuses a second operation on an
  agent rather than resuming a session whose previous pane may still be live.
- `idle` and `done` still map to native `completed`, which the engine reads as `unanswered` when no
  result arrived. That is the advisory quiet observation, correctly named at the contract seam, and
  it is what arms the single measured nudge (E2 recovered 4 of 4 silent turns). `AgentRef.run()` now
  applies that recovery by default; `nudge: false` is the explicit opt-out.

Deferred to [`herdr-pane-settlement.md`](todo/herdr-pane-settlement.md), because nothing in this
story exercises them and each is a measurement problem rather than a code one: verified pane
release, a concurrent identity observer, provider-level lifecycle classification, and the pane
continuation that depends on all three.

## Scope

In scope:

- two logical review agents running concurrently;
- one run-owned Herdr workspace and tab with visible sibling operation panes;
- a private engine-owned socket for each agent and one result slot for each operation;
- structured result acceptance through the engine control plane;
- ordered composition, inspection, deadlines, cancellation, and cleanup;
- fake-backed proof and one explicit bounded live evaluation;
- `awf run <workflow> -- <arguments>` as the operator entry point.


Out of scope:

- reviewer-to-reviewer messaging or additional review rounds;
- checkpoints, human adjudication inside the workflow, or journal replay;
- remote execution, a workflow catalogue, or a topology DSL;
- hostile same-UID isolation;
- general operator event streaming or a status daemon.

## Architecture

### Ownership

- `packages/contract` owns pure workflow, wire, schema, and record types.
- `packages/harness` owns the run host, provider commands, pane lifecycle, native observation, and
  usage extraction.
- `packages/engine` owns run directories, result slots, the control plane, workflow execution, and
  operator loading.
- `packages/cli-agent` owns the in-session `wf result` client and imports only contract code.
- `examples/` uses only `@wf/contract/workflow`.

### Execution model

- One engine run opens one `AgentRunHost`.
- The production host owns one Herdr workspace and tab.
- Every distinct operation receives a fresh sibling pane; every agent receives a socket of its own
  and a launcher that points at it.
- Initial delivery and an optional nudge belong to the same operation, pane, and result slot.
- A logical agent takes one operation. The production host refuses a second one, because nothing it
  can observe proves the first pane released; that is why the story's workflow is one turn per
  reviewer plus an optional nudge.
- Result acceptance and native release are separate. Accepted data decides the workflow value; the
  pane is closed independently and the run's workspace close is the backstop.
- The engine sees logical agents and redacted snapshots, never Herdr identifiers or provider
  session references.

### Result path

- The engine opens one Unix socket per agent, in a directory of its own under a root no agent can
  list, and installs beside it a launcher carrying that socket's path.
- The agent is told the launcher's path and its call id in the prompt, and nothing else. Nothing
  secret has to survive the trip into a pane, because the connection is what says who is answering.
- `wf result <call-id>` sends one bounded, versioned JSON request over that socket.
- The engine validates first, then atomically accepts at most one result.
- A submission naming a call the connecting agent does not own is refused, so the call id travelling
  in prompts, records, snapshots and diagnostics costs nothing.

### Deadlines

- The operator supplies an absolute workflow deadline. Author operations inherit the current scope
  unless they request a narrower absolute deadline or relative `timeoutMs`; the engine resolves an
  absolute deadline before crossing into the harness.
- A turn reaching its deadline is `timed-out`; it is not `unanswered` or implicitly successful.
- `awf run --timeout` supplies the enclosing workflow deadline, with a ten-minute default and a
  fixed five-second shutdown grace.
- Cleanup and release are bounded separately so accepted data does not leave native work running
  indefinitely.

### Threat model

A socket per agent prevents stale or accidental cross-settlement among cooperative peers. It does
not sandbox hostile processes owned by the same local user: every agent runs as the engine's own
user, so one that goes hunting for a sibling's socket finds it. The broader permissions design is in
[`permissions.md`](../design/permissions.md).

## Code map

- `packages/contract/src/workflow/` — workflow author surface and executable descriptor.
- `packages/contract/src/wire.ts` — versioned result-submission messages.
- `packages/harness/src/adapter.ts` — engine-facing run-host contract.
- `packages/harness/src/adapters/herdr.ts` — the symmetric production run host, plus the
  isolated-pane adapter; `herdr-protocol.ts` and `herdr-startup.ts` hold what both share, and
  `herdr-legacy.ts` the legacy adapter kept for frozen compatibility.
- `packages/engine/src/result-slots.ts` — agent-bound atomic settlement.
- `packages/engine/src/control-plane.ts` — one private result socket per agent.
- `packages/engine/src/workflow-runner.ts` — one-run ownership and workflow execution.
- `packages/engine/src/operator-cli.ts` — trusted `awf run` entry point.
- `packages/cli-agent/` — in-session `wf result` command.
- `examples/minimum-review.ts` — the review workflow itself: lenses, lens-bound schemas, composition.
- `examples/review-loop.ts` — reviewer configuration and the operator-runnable default export.
- `tests/minimum-review.eval.ts` — explicit spending live evaluation.

## Task execution rule

Process the remaining tasks strictly in order. For each task:

1. Recheck the cleanest architecture against current code and evidence.
2. Implement only that coherent slice with focused tests.
3. Obtain two read-only subagent reviews: architecture/scope and correctness/proof.
4. Resolve every material finding and request targeted re-review after a material change.
5. Run focused verification and satisfy the task's acceptance criteria.

Do not check a task or begin the next one until all five steps are complete. Put adjacent
deliverables in [`todo/`](todo/) instead of broadening this story.

## Task details

### 1. Finish the executable interfaces — complete

Delivered one run-host seam, exact workload constraints, inherited author deadlines with resolved
absolute engine deadlines, atomic acceptance,
explicit result/native-release separation, quarantine, full-run authority redaction, and a smaller
author surface without backend placement or funding identity.

Architecture and correctness reviews converged after removing per-agent backend routing, keeping
native references inside the harness, making quarantine continuation-denying, and covering
activation and shutdown races. Type-level tests cover the interface constraints.

### 2. Create secure result slots — complete

Delivered an engine-owned registry with random operation capabilities, schema and semantic
validation, atomic exclusive settlement, stable tombstones, active expiry, rejected-attempt audit,
and run-lifetime secret redaction.

Focused concurrency and security tests prove first-valid-result wins and reject unknown, wrong,
expired, closed, stale, and cross-operation capabilities without changing the accepted result or
leaking authority.

### 3. Put result submission behind the control plane — complete

Delivered the versioned contract wire shape, bounded Unix-socket endpoint, and contract-only
`wf result` client. The endpoint bounds connections, frame size, idle time, and total client
lifetime; shutdown stops admission and drains accepted handlers before deleting the socket.

Focused tests cover malformed and oversized frames, split writes, client timeouts, stdin bounds,
schema diagnostics, socket cleanup, executable symlinks, and package-boundary bypass attempts.

### 4. Make Herdr settlement and continuation safe — complete

Two deletions in `createHerdrRunHostFactory`, both in
[`herdr.ts`](../../packages/harness/src/adapters/herdr.ts):

- [x] A stalled prompt observation no longer produces an outcome. The host waits out the remaining
  operation deadline, abortable, and returns `timed-out` on expiry or `cancelled` on release. An
  aborted or cancelled command returns `cancelled` before any classification. Only
  `agent_prompt_stalled` is classified. E3 (`experiments/_archive/e3/pool.ts`) confirms the code
  reaches raw error text at all; it matched that text with `includes`, which this host must not,
  because its prompt argv carries workflow-authored words.
- [x] Continuation authority is gone. `continuationReady`, `continuationRef` and the resume launch
  were removed; a second operation on an agent fails closed. The isolated-pane and legacy adapters
  in the same file are untouched — they are frozen compatibility surfaces.
- [x] Focused regressions: both stall shapes (parsed envelope, and stderr-carried, which is the
  shape `herdr()`'s `stderr || stdout` preference actually produces), release during the wait, a
  non-stall prompt failure, a nudge staying in its pane while the next operation is refused, and
  blocked/unknown states keeping their own outcome.


Not done, deliberately: verified pane release after close, and the concurrent identity observer.
Both were written, reviewed and reverted — see the review record.

### 5. Reverify the minimum workflow runner — complete

The runner provides `startWorkflow`, `runWorkflow`, inspection, stopping, logical queues, alias
resolution, structured parallelism, result/native joins, deadlines, usage, and ordered cleanup. Its
previous architecture and concurrency reviews converged.

Rechecked against the final Task 4 semantics: no runner change was required. A stalled operation now
stays pending inside the harness, so `observeTurnAndResult` keeps racing the result slot against the
operation deadline exactly as before, and `slots.close` is not reached early. The `completed`
→ `unanswered` mapping and the single nudge are unchanged.

Out of scope here: the runner builds operation prompts through `describe()`, which drops the
constraints the validator enforces. That is tracked in
[`schema-in-prompt.md`](todo/schema-in-prompt.md) and is not fixed by this task.

### 6. Reverify the fake-backed two-agent review — complete

The workflow opens correctness and maintainability reviewers concurrently, defines its result with
TypeBox, binds each accepted schema to its lens, and composes them in input order. AWF structurally
checks the schema against its supported JSON Schema subset and retains its measured validation and
error behavior. Reverse-order acceptance belongs to the fake adapter
script in `tests/minimum-review.test.ts`, not to the workflow; it exists so that composition order is
proved independent of arrival order. `defineReviewWorkflow` — the path `awf run` takes — throws on
any incomplete review, so through the operator entry point an incomplete outcome is a run failure
rather than composed data.

Two gaps closed:

- [x] `failed` and `cancelled` lens outcomes were typed but untested. All four incomplete outcomes
  are now covered by one table-driven case.
- [x] The concurrency test asserted a fixed order for `workflow.usage()`. Usage is charged in
  reservation order, which races between two parallel turns, so the assertion failed roughly one run
  in five. Composition order is the workflow's promise and stays asserted; usage is now compared per
  agent. Confirmed stable over six consecutive full runs.

### 7. Run one bounded live evaluation — complete

Run on 2026-09-18 against Herdr 0.8.2, Claude Code 2.1.276 on a claude.ai subscription, and
codex-cli 0.154.0 on a ChatGPT login. No metered credential was present and none was used.

Three defects surfaced, none of them reachable from a stubbed Herdr. The first run hit the first
and the third; the second only became visible once Codex got far enough to use the return channel:

- **The trust prompt wraps.** `workspaceTrustKeys` matched the startup block with `includes` on the
  raw screen, but Herdr renders that block into the pane's own width and this host's panes are
  half-width. Codex's question broke across two lines, the handshake did not fire, and the agent
  failed to start while sitting on a dialog it was waiting to have answered. Matching a
  single-spaced rendering fixes it; the same latent break existed for Claude at a narrower width.
- **The agent's pane never received the run's environment.** `--env` was passed to
  `workspace create` only, and every agent runs in a `pane split`, which launches its own process.
  So the return-channel `wf` was off the agent's PATH and the metered credentials the run promises
  to withhold were never actually cleared there. The same arguments now go to both. That fix has
  since been superseded: the return channel no longer rides in the environment at all — the agent
  is given a launcher path in its prompt, and the socket behind it is the authority.
- **A prompt submitted into a just-dismissed modal is lost.** After the trust handshake
  `agent wait --until idle` returns in about 200 ms with `interactive_ready: true`, but the agent's
  terminal UI is not accepting input yet: the prompt is typed and discarded, Herdr answers
  `agent_prompt_stalled`, and the pane then sits idle for the rest of the operation. Over
  concurrent two-agent starts, Claude Code lost the prompt in one of two runs with no settling and
  in none of three with two seconds of it. Recovering after the fact was considered and rejected;
  [`herdr-pane-settlement.md`](todo/herdr-pane-settlement.md) holds the reasoning and the variants.

After those three, six consecutive live runs passed — four evaluations, one traced diagnostic run
and the Task 8 operator command — in 57 s to 218 s. Both reviews completed in lens order every
time, Claude found the fixture's real division-by-zero defect, each pane closed once its result was
accepted, the workspace closed, and the repository fingerprint was unchanged.

What the run did not produce: usage. `usageSamples` was zero for both agents on every run, so the
pane path reports no tokens. The one bounded observation that would buy it is already scoped in
[`herdr-pane-settlement.md`](todo/herdr-pane-settlement.md).

### 8. Accept the operator-runnable review workflow — complete

The executable descriptor, trusted local loader, `awf run`, timeout flag, optional target argument,
artifact retention, and review workflow already existed; their previous acceptance was reset
because the production topology was asymmetric and later settlement remained unsafe.

Rechecked against the accepted host: the loader and operator seam needed no change. The fake-backed
command path in `tests/operator-cli.test.ts` covers ordered reviews through the engine, alias drift,
argument and module errors, non-JSON results, runtime-install versus workflow-body failures,
retention reporting, cleanup failure, control characters in targets, interruption exit status, and
an incomplete review failing rather than reporting success. Examples still import only
`@wf/contract/workflow`.

The live half ran on 2026-09-18:
`bun run awf run --timeout 10m examples/review-loop.ts -- examples/fixtures/review-target.ts`.
It exited zero with both reviews completed, retained its artifacts under `.awf/runs/`, left no
Herdr workspace behind, and left the working tree byte-identical. `installOperatorRuntime` builds
the same host as the evaluator, so it carries the Task 7 fixes without its own change.

## Verification

Automated acceptance, run on 2026-09-18:

- [x] Focused Herdr adapter tests — settlement, continuation, and the Task 7 trust-wrap,
  pane-environment and settle regressions — `bun test packages/harness/src/adapters/herdr.test.ts`,
  45 pass.
- [x] Focused fake-backed review tests — `bun test tests/minimum-review.test.ts`, 5 pass.
- [x] Focused `awf run` loader and command tests — `bun test tests/operator-cli.test.ts`, 15 pass.
- [x] `bun test` — 295 pass, 0 fail, 854 expect() across 32 files; repeated six times for the
  usage-order flake fixed in Task 6.
- [x] `bun run ts-check`.
- [x] `bun run scripts/check-boundaries.ts`.
- [x] `git diff --check`.

Live acceptance, run on 2026-09-18 on Claude and Codex subscription sessions:

- [x] `bun tests/minimum-review.eval.ts --dry-run` — eleven preflight checks, all green, including
  both subscription logins and the absence of any metered credential.
- [x] `WF_LIVE_EVAL=1 bun tests/minimum-review.eval.ts` — both reviews completed in lens order on
  all four runs, in 218 s, 80 s, 78 s and 57 s; `assertCompletedReviews`, `assertNativeEvidence`
  and the repository fingerprint all held, and artifacts were retained.
- [x] `bun run awf run --timeout 10m examples/review-loop.ts -- examples/fixtures/review-target.ts`
  — exit zero, both reviews completed, artifacts under `.awf/runs/`.
- [x] Cleanup — `herdr workspace list` shows no run workspace after either command, and the
  working tree hashed identically before and after.
Live evidence distinguishes result acceptance, pane close, timeout and failure, but not cost:
every live turn reported `usageSamples: 0`. That gap is a remaining risk, not an open acceptance
item.

## Review record

Task 4 went through two review rounds with two independent read-only subagents each time, against
the diff, the story, and the package constraints. Both reviewers rejected the first implementation;
the second round was a targeted re-review of the rework.

### First round — the implementation was wrong

- **Settling on a stall armed the nudge.** Returning `completed` made the engine fire its one nudge
  into an agent that may be mid-turn — the duplicate delivery this task exists to prevent.
- **Settling on a stall closed the result slot.** Worse than the nudge: `slots.close` ran about five
  seconds into a three-hundred-second operation, so the agent's genuine `wf result` would have been
  rejected and reported as `unanswered`. Only the second reviewer traced this.
- **Verified pane release wedged the host.** A close acknowledgement followed by `pane get` had no
  release grace and no retry path: one stderr line hides the JSON envelope Herdr answers with, after
  which the pane could never be closed and `host.close()` threw even once the workspace had closed.
  Reverted to [`herdr-pane-settlement.md`](todo/herdr-pane-settlement.md).
- **Narrowing continuation instead of removing it reopened a hole.** A provider session reference is
  stable across turns, so reference equality alone could not tell a clean previous turn from one
  rewritten to `timed-out`. This is why continuation is refused outright rather than narrowed.
- **`timeout` was too broad a code** to mean "delivered but unobserved"; only `agent_prompt_stalled`
  is classified.
- **Tests that could not observe their own claims.** The nudge resend happens one layer up in the
  engine, and the first stall test counted only commands issued inside one `session.start`.

### Second round — the rework

Accepted:

- **The raw-code fallback matched a message that merely names the code.** The rule was already
  written three lines above it, and this host's prompt argv carries workflow-authored text — the
  reviewers in this very story are told about `agent_prompt_stalled`, so a usage error echoing the
  prompt back would have read as a stall. Now a whole-string or code-field match only, with a
  regression proving a fatal error that quotes the code still fails at once.
- **An operation that never started consumed its agent.** `hasExecuted` was set before the pane
  existed, so a failed `pane split` permanently refused every later operation — and said so in
  language about continuation evidence that no longer meant anything. It is set after the agent
  starts, the refusal says what the host actually refuses, and a regression covers it.
- **A minutes-long wait pinned the event loop.** `abortableDelay` was written for a two-second
  retry backoff; its timer is now unref'd and clamped, matching the engine's own scheduler.
- **Four tests passed for the wrong reason.** The stall tests could not distinguish waiting from
  returning immediately (they now assert elapsed time); the stderr-shape test existed only to
  exercise the loose match that was removed; the blocked/unknown test's continuation half had become
  unconditional and is now a state-mapping test; the non-stall failure now asserts its diagnostic
  survives.

Rejected, with the reason:

- **"The wait observes nothing, so a decisive native failure costs the whole deadline."** True, and
  deliberate: preferring to wait over killing a possibly-live agent is the point. Observing during
  the wait is the identity-observer work this story defers. The outcome now names the stall so the
  operator is not left guessing.
- **"Usage is dropped on the stall path."** Also true, and the reviewer is right that this is the
  host's longest turn. One bounded pane read would buy both the usage sample and the decisive-failure
  signal above — recorded as one item in the todo rather than added here.
- **"Refuse a second operation on the capability surface instead of failing the operation."** That
  publishes a flag for a constraint that disappears when the identity observer lands, and the engine
  has no consumer for it. `AgentRef.compact` is likewise still stubbed, so the compact path the
  reviewer flagged is unreachable and fails closed the same way.
- **"`pane_not_found` is an unverified string literal."** It was verified against the installed
  Herdr 0.8.2 before the code was written. The check was reverted for the wedge and layering
  findings, not this one.

### Third round — the live run reviewed the code

Two subagent rounds had accepted a host that could not deliver a prompt. Every Task 7 defect sat in
a path the stub could not reach: the trust screen's rendered width, the environment of a process
Herdr launches, and a terminal UI's readiness after a modal. The tests were not weak so much as
aimed at the adapter's decisions rather than at Herdr's rendering, process launch and input
timing. The stubs answered whatever the adapter asked, so they could only ever confirm it.

The suite now carries a model of Herdr 0.8.2 instead
([`testing/herdr-cli.ts`](../../packages/harness/src/testing/herdr-cli.ts)): panes have a width and
the startup block wraps to it, a split sees only its own `--env`, and an agent whose block was just
answered discards a prompt submitted too early. `herdr-contract.test.ts` runs the production host
against it, and reverting any of the three fixes fails it. What the model cannot catch is Herdr
changing underneath it, so the evaluation's free dry run now reads the two behaviours the host
parses back out of `--help` and fails there rather than in a live run.

Reviewing the fixes themselves then found two defects in them, both accepted:

- **The settle could spend the deadline it was protecting.** With less time left than the settling
  window, the handshake slept out the remainder and then reported `timed-out` against an agent that
  was trusted and idle — closing its pane and failing an operation that previously would have been
  prompted. It now hands the agent back unslept and lets the caller's deadline check decide.
- **The delay timer was unref'd.** That was written for a two-second retry backoff and now also
  covers a whole-deadline stall wait. The adapters are exported for standalone use, where an
  awaited delay is the only work outstanding, so an unref'd timer lets the runtime exit under the
  caller. Both exits from the promise dispose of the timer, so referencing it leaks nothing.

## Historical evidence

- The fake-backed workflow and control-plane path have passed repeatedly. Previous reviews found
  and fixed settlement races, escaped authority, cleanup retry, queue reuse, ordering, and loader
  security defects.
- A pre-reset live run completed both providers and accepted both results, showing the basic path is
  feasible. It does not accept the current design because that topology later became asymmetric.
- Two pre-reset runs, `awf-minimum-review-Du89Pi` and `-msrKbu`, showed a late native state and a
  stalled prompt respectively. Both run directories were temporary and have been purged, so those
  figures cannot be re-derived. Task 7 re-measured on live agents instead, and the stall reproduced.
- A full-tree run was cancelled after Claude delegated to several expensive subagents. The workflow
  now instructs reviewers not to delegate, but prompt policy is not treated as enforcement.
- The user rejected the earlier Claude-pane/Codex-headless topology. The production design now
  requires symmetric sibling panes and no headless fallback.

## Remaining risks and follow-ups

- Agent processes have broad local authority. This story states the cooperative-peer boundary but
  does not deliver OS-level sandboxing.
- Herdr 0.8.2 passes pane environment as command arguments, so anything the host put there would be
  locally observable during pane creation. Nothing the return channel needs goes there any more, but
  a run's other environment still crosses that way.
- Executable workflow modules are trusted local code and run with operator authority.
- Prompt-level no-delegation guidance cannot prevent a provider from spawning subagents.
- A pane agent takes one operation. Multi-turn pane workflows are unavailable until verified release
  and an identity observer exist; a second operation fails closed rather than resuming unsafely.
- The pane path reports no usage. Live turns settle correctly but cost nothing observable, so spend
  cannot be bounded from a run's own evidence.
- A status daemon, stable event stream, and author-facing layout policy remain deliberately
  deferred.

Tracked adjacent stories:

- [`herdr-pane-settlement.md`](todo/herdr-pane-settlement.md) — verified pane release, the identity
  observer, and the pane continuation that depends on both.
- [`pane-agent-start-readiness.md`](todo/pane-agent-start-readiness.md) — durable redacted start
  diagnostics.
- [`herdr-layout-policy.md`](todo/herdr-layout-policy.md) — operator control over tabs and panes.
- [`operator-run-observation.md`](todo/operator-run-observation.md) — operator progress and status.
- [`live-eval-disclosure.md`](todo/live-eval-disclosure.md) — explicit live-evaluation disclosure.
- [`schema-in-prompt.md`](todo/schema-in-prompt.md) — send the schema, not a rendering of it.

## Human review

- [ ] Every task and story-level verification item is complete.
- [ ] Set status to `awaiting-human-review` and present the final architecture, exact automated and
  live evidence, review findings, deviations, and remaining risks.
- [ ] Record the user's explicit approval or requested changes.
- [ ] If changes are requested, return to the affected task and repeat its planning, implementation,
  subagent review, finding resolution, and testing.
- [ ] Only after explicit approval, mark the story `done` and update Stories at a glance.
