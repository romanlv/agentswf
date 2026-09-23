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

This is the first usable end-to-end proof of the engine.

## Where it stands

All eight tasks are implemented. The automated suite is green on the current code. The live runs
passed on 2026-09-18, but they ran before the return channel was redesigned on 2026-09-22 and before
the cleanup that followed it. So the live evidence below describes older code.

- [x] 1–8. Tasks implemented and reviewed (see [Tasks](#tasks)).
- [x] Automated verification on current code: 303 pass, 0 fail. Type check and boundary check are
  green.
- [x] Merged into `main`.
- [ ] Re-run live acceptance on `main`. This spends subscription usage.
- [ ] Set status to `awaiting-human-review` and present the story.
- [ ] Human approval, then mark `done` and update the
  [Stories at a glance](README.md#stories-at-a-glance) index.

## Scope

In scope:

- two logical review agents running concurrently;
- one run-owned Herdr workspace and tab, with a visible sibling pane for each operation;
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

### Execution model

- One engine run opens one `AgentRunHost`. The production host owns one Herdr workspace and tab.
- Every operation gets a fresh sibling pane. The first delivery and the optional nudge belong to the
  same operation, pane, and result slot.
- A logical agent takes one operation. The production host refuses a second one, because nothing it
  can observe proves that the first pane was released.
- Result acceptance and native release are separate. The accepted data decides the workflow value.
  The pane is closed independently, and closing the run's workspace is the backstop.
- The engine sees logical agents and redacted snapshots. It never sees Herdr identifiers or provider
  session references.

### Result path

- The engine opens one Unix socket per agent, each in a directory of its own, under a root that no
  agent can list. Beside the socket it installs a `wf` launcher that carries the socket's path.
- The prompt gives the agent only the launcher's path and its call id. The agent answers with
  `<launcher> result <call-id> '<json>'`.
- The connection identifies the agent, so no secret has to reach the pane. A submission that names a
  call the connecting agent does not own is refused.
- The engine validates each request first, then accepts at most one result, atomically.

### Settlement

Herdr lifecycle state is telemetry. It does not prove that a particular prompt has finished. Herdr
0.8.2's own `agent prompt --help` says that its wait "does not track turns". So:

- Only an accepted structured result settles an operation successfully. `reconcile` answers from the
  result slot and from nothing else.
- `agent_prompt_stalled` never settles and never resends. The prompt was already accepted, so the
  host waits out the operation deadline, and the result slot stays open.
- Herdr reporting `idle` or `done` maps to the native state `completed`. If no result has arrived,
  the engine reads that as `unanswered`, which arms the single measured nudge: E2 recovered 4 of 4
  silent turns this way. `nudge: false` turns it off.

### Deadlines

- `awf run --timeout` sets the enclosing workflow deadline. The default is ten minutes, with a fixed
  five-second shutdown grace. An operation inherits the enclosing deadline unless it asks for a
  narrower one. The engine resolves an absolute deadline before it calls into the harness.
- A turn that reaches its deadline is `timed-out`. It is not counted as `unanswered` or as a
  success.

### Threat model

A socket per agent prevents stale or accidental cross-settlement among cooperative peers. It does
not sandbox hostile processes. Every agent runs as the engine's own user, so an agent that goes
looking for a sibling's socket can find it. The broader design is in
[`permissions.md`](../design/permissions.md).

## Code map

- `packages/contract/src/workflow/` — the workflow author surface and executable descriptor.
- `packages/contract/src/wire.ts` — versioned result-submission messages.
- `packages/harness/src/adapter.ts` — the run-host contract the engine uses.
- `packages/harness/src/adapters/herdr.ts` — `createHerdrRunHostFactory`, the production run host.
  `herdr-protocol.ts` and `herdr-startup.ts` hold what it shares with the other Herdr adapters.
- `packages/harness/src/testing/herdr-cli.ts` — a model of Herdr 0.8.2 that
  `herdr-contract.test.ts` runs the production host against.
- `packages/engine/src/result-slots.ts` — agent-bound atomic settlement.
- `packages/engine/src/control-plane.ts` — one private result socket per agent.
- `packages/engine/src/agent-launcher.ts` — the per-agent `wf` launcher.
- `packages/engine/src/workflow-runner.ts` — ownership of one run, and workflow execution.
- `packages/engine/src/operator-cli.ts` — the trusted `awf run` entry point.
- `packages/cli-agent/` — the in-session `wf result` client.
- `examples/minimum-review.ts` — the review workflow: lenses, lens-bound schemas, composition.
- `examples/review-loop.ts` — reviewer configuration and the operator-runnable default export.
- `tests/minimum-review.eval.ts` — the live evaluation. It spends subscription usage.

## Tasks

1. **Executable interfaces.** One run-host seam, exact workload constraints, inherited deadlines
   resolved to absolute ones, separate handling of the result and the native release, quarantine,
   and an author surface with no backend placement.
2. **Result slots.** An engine-owned registry: schema and semantic validation, atomic exclusive
   settlement, tombstones, expiry, and an audit of rejected attempts.
3. **Control plane.** The versioned wire shape and a bounded Unix-socket endpoint. It bounds
   connections, frame size, and lifetime, and drains in-flight handlers on shutdown. The
   contract-only `wf result` client talks to it.
4. **Safe Herdr settlement.** A stalled prompt no longer settles an operation. Continuation was
   removed, and a second operation on an agent fails closed.
5. **Workflow runner.** Rechecked against Task 4. No change was needed.
6. **Fake-backed two-agent review.** Every incomplete lens outcome is covered, and the order of
   usage records is no longer asserted, because it races between parallel turns.
7. **Bounded live evaluation.** It found three defects that a stubbed Herdr could not reach:
   - the trust prompt wrapping in a half-width pane;
   - the split pane never receiving the run's environment, a problem the launcher has since removed;
   - a prompt lost when submitted too soon after a modal was dismissed.

   All three are now reproduced by the Herdr model in `testing/herdr-cli.ts`.
8. **Operator workflow.** `awf run` with a loader, a timeout, an optional target, and artifact
   retention. The operator seam needed no change.

The earlier per-task review record can be read with
`git show ee0df49:docs/stories/001-multi-agent-review.md` and the later history of this file.

### Design choices that review settled

- A stall must wait rather than settle. Settling armed a nudge into a possibly live agent and closed
  the result slot early, so a genuine result would have been rejected.
- Continuation is refused, not narrowed. A provider session reference is stable across turns, so
  reference equality cannot tell a clean turn from one that timed out.
- Only a whole-string or code-field match classifies `agent_prompt_stalled`. The prompt argv carries
  text written by the workflow, and that text can quote the code.
- A decisive native failure during a stall costs the whole deadline. That is deliberate:
  observing during the wait is the identity-observer work in
  [`herdr-pane-settlement.md`](todo/herdr-pane-settlement.md).

## Verification

Automated, on the current code (2026-09-22):

- [x] `bun test` — 303 pass, 0 fail.
- [x] Focused: `herdr.test.ts` 45, `herdr-contract.test.ts` 10, `tests/minimum-review.test.ts` 5,
  `tests/operator-cli.test.ts` 11. All pass.
- [x] `bun run ts-check` and `bun run scripts/check-boundaries.ts`.

Live, on subscription sessions. These are **stale**, because they ran before the 2026-09-22 return
channel redesign:

- [ ] `bun tests/minimum-review.eval.ts --dry-run`. The preflight checks include both subscription
  logins and confirm that no metered credential is present.
- [ ] `WF_LIVE_EVAL=1 bun tests/minimum-review.eval.ts`. Both reviews must complete in lens order,
  and the repository fingerprint must be unchanged.
- [ ] `bun run awf run --timeout 10m examples/review-loop.ts -- examples/fixtures/review-target.ts`.
  It should exit zero with its artifacts under `.awf/runs/`.
- [ ] Cleanup: `herdr workspace list` shows no run workspace, and the working tree is unchanged.

The last passing live runs were on 2026-09-18, using Herdr 0.8.2, Claude Code 2.1.276, and codex-cli
0.154.0: six in a row, taking 57 s to 218 s. Every one reported `usageSamples: 0`.

## Remaining risks

- The pane path reports no usage, so a run's own evidence cannot bound what it spends.
- A pane agent takes one operation. Multi-turn pane workflows wait on verified pane release and an
  identity observer.
- Agents have broad local authority. There is no OS-level sandbox, and telling reviewers not to
  delegate in the prompt is not enforcement.
- Herdr 0.8.2 passes pane environment as command arguments. The return channel no longer goes
  there, but the rest of a run's environment still does.
- Executable workflow modules are trusted local code and run with operator authority.

Follow-ups in [`todo/`](todo/):

- [`herdr-pane-settlement.md`](todo/herdr-pane-settlement.md) — verified release, the identity
  observer, pane continuation, and pane usage.
- [`pane-agent-start-readiness.md`](todo/pane-agent-start-readiness.md) — durable redacted start
  diagnostics.
- [`herdr-layout-policy.md`](todo/herdr-layout-policy.md) — operator control over tabs and panes.
- [`operator-run-observation.md`](todo/operator-run-observation.md) — operator progress and status.
- [`live-eval-disclosure.md`](todo/live-eval-disclosure.md) — explicit live-evaluation disclosure.
- [`schema-in-prompt.md`](todo/schema-in-prompt.md) — send the schema, not a rendering of it.

## Human review

Not started. Record approval or requested changes here.
