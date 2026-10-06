---
id: "026"
title: A workflow says where each pane agent appears, and which panes stay
summary: "`agents.open` and `fork` take `layout` (a new tab, in the run's workspace, a named one, a named session or the operator's own, or beside another agent's pane) and `keepPane`; panes open at open, a relaunch keeps its place, a kept pane outlives its run, and marks find what a dead run left in any session."
type: story
status: in-progress
priority: P2
epic: observability
discovered_in: "Herdr layout policy, 2026-10-06"
depends_on: ["024"]
---

# A workflow says where each pane agent appears, and which panes stay

## Outcome

The design is [[pane-layout]]; this story builds it. A workflow says, per agent, where its pane goes
and whether it stays when the agent is done:

```ts
const lead = await workflow.agents.open({
  key: "lead",
  runtime: "claude",
  layout: { workspace: "origin", tab: "review" },
  keepPane: "on-failure",
});
const security = await lead.fork({ key: "security", layout: { beside: "lead", side: "right" } });
```

Without `layout`, an agent is placed as today. With it, the operator can watch an agent where they
are working, put a lead and its reviewers in one tab, and read a pane that failed.

## How it works

```
 engine (workflow-runner)                       Herdr run host (harness)
 ─────────────────────────                      ───────────────────────────────────────
 open/fork: refuse what the spec fixes          activate: place the pane now
   (beside self, share, names, headless,          new tab:  session → workspace → tab create
    sandbox), compare a reopen as written          beside:   split the target's pane, or fall back
 activation.layout ─────────────────────────▶      one queue per session for every change
 LogicalAgent.close: keep? from keepPane      first operation: harness starts in that pane
   and the last outcome ───── close({keep}) ─▶  close: close the pane, or release and keep it
 run end: close agents, then the host           run end: close the panes it made and did not keep
 output.json `panes`, closing block ◀── pane()  marks v2: every pane, its terminal, kept or not
```

The engine owns what the workflow's code fixes: refusals, reopen and fork rules, and whether an
agent's pane is kept. The Herdr host owns where a pane lands and why it fell back, and never fails an
agent over it. The operator runtime owns sessions: it starts an `awf-…` session a workflow names,
resolves `"origin"`, and keeps the marks.

## Scope

In scope: everything [[pane-layout]] lists under "What changes elsewhere".

Out of scope: what that design lists under "Not in this design"; placing a sandbox's watch tab.

## Code map

- `packages/contract/src/workflow/agents.ts` — `AgentOpenSpec`, `AgentForkSpec`: gain `layout`,
  `keepPane`. `records.ts` — `output.json` gains `panes`.
- `packages/harness/src/adapter.ts` — `HarnessActivation.layout`, `HarnessSession.close`'s keep, a
  session's `pane()` report.
- `packages/harness/src/adapters/herdr.ts` — `openTopology`, `launchPane`, `relaunchAt`,
  `closePane`, host `close`: pane at activation, pane close, in-place relaunch, keep.
- `packages/harness/src/adapters/herdr-layout.ts` (new) — sessions, workspaces, beside, size check,
  fallback, labels.
- `packages/engine/src/workflow-runner.ts` — validation, reopen, fork, keep decision, run end.
- `packages/engine/src/operator-runtime.ts`, `herdr-run-session.ts`, `herdr-workspace-marks.ts` —
  named sessions, origin, marks v2, sweep.
- `packages/engine/src/workflow-testing/host.ts` — records layout and keep as written.
- `docs/workflow-api.md`, ADR 0008.

## Tasks at a glance

- [x] 1. The author surface: `layout` and `keepPane` refused, compared and passed as the design says
- [x] 2. Panes placed at open in the run session: tabs, `beside`, fallbacks, in-place relaunch
- [x] 3. `keepPane`: a done agent's pane kept with its harness released
- [x] 4. Named sessions, named workspaces and `"origin"`
- [ ] 5. Marks version 2: every pane a run made, swept in any session
- [ ] 6. Records and output: `output.json` `panes`, fallbacks and kept panes in the closing block

## Open questions

None. The design's Q1–Q4 are decided.

## Task execution rule

One task at a time: plan, implement with focused tests, review by two read-only subagents
(architecture and scope; correctness and proof), resolve, verify, then check it off.

## Task details

### 1. The author surface

Work: contract types; engine refusals at open and fork; reopen compares as written; a fork does not
inherit; `HarnessActivation.layout`; the testing host records both; `workflow-api.md`.

Done when: engine tests cover each refusal, reopen and fork rule, and the activation carries the
layout.

### 2. Panes placed at open in the run session

Work: the Herdr host places a pane at activation; a tab or a split beside a key, by `share`; the
size check against `pane layout`; fallbacks with reasons; panes labelled; agents closed by `pane
close`; a relaunch splits the old pane and closes it; one queue per session.

Done when: Herdr host tests drive each placement and fallback through the fake Herdr, and a live
probe confirms the split arithmetic.

### 3. `keepPane`

Work: the engine decides keep from the last outcome; `session.close(reason, { keep })`; the host
interrupts and settles a working harness, else closes it; the channel is revoked; the run's end
closes only the panes not kept and leaves a workspace that holds one.

Done when: engine and host tests cover never, on-failure and always, and the release paths.

### 4. Named sessions, named workspaces and `"origin"`

Work: the operator runtime resolves a named session (an `awf-…` one started), checks version, and
falls back; a named workspace is found by label or made under a lock; `"origin"` is resolved from
`--here` or `HERDR_PANE_ID` with the ancestor check, by socket, version and the pane's workspace;
tabs there are labelled `{tab} · {run id}`, and the withheld variables emptied.

Done when: tests cover each resolution and fallback, and a live run places a pane in `"origin"`.

### 5. Marks version 2

Work: a mark names each pane with session, id, terminal id and kept; it outlives its run while it
names a kept pane; the sweep reads every session's marks and closes a dead run's panes.

Done when: sweep tests cover v1 and v2 marks, kept panes, gone sessions and repeated pane ids.

### 6. Records and output

Work: `output.json` gains `panes`; the closing block lists fallbacks and kept panes once each.

Done when: a run test asserts the record and the output lines.

## Verification

Automated:

- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run check`

Live:

- [ ] A workflow with the design's example layout, run from a Herdr pane: lead in `"origin"`, two
  reviewers stacked right of it, one kept; then the sweep after killing a run.

## Review record

### Task 1

- Architecture and scope: no blocker. The session-name rule moved from `herdr-run-session.ts` into
  the pure `pane-layout.ts`, so the runner no longer loads the run session's code. A fork's layout
  is cloned. An unreachable run-sandbox check is gone. The API doc names where a fallen-back pane
  goes. Kept by choice: `HarnessActivation.keepPane`, documented as record-only; `layoutFallback`
  reason text on the testing surface, the same text task 6 records; `keepsPane`, used in task 3;
  the docs, true once the branch merges whole.
- Correctness and proof: a layout given with an `undefined` field didn't reopen as one without it,
  so layouts are now stored without undefined fields. `workspace: { name }` refuses other fields. A
  fork's `beside` target is taken when `fork` is called, as an open's is. That made a wait cycle
  impossible, so the cycle check went. Added tests for a headless fork and a sandboxed agent
  refused, a fork re-attached with another layout, and `beside` the caller or a sandboxed agent.

### Task 2

- Architecture and scope: no blocker. `PanePlacement` moved to the contract (`records.ts`), where
  task 6 records it, with its workspace type `PaneWorkspace` shared with `PaneLayout`; it gained
  `kept`/`notKept` in task 3. A box's panes report no placement. A root tab's label is cut at 32.
  The run's end is queued and keep-aware (task 3). Left to their tasks: screens per session and a
  key registry across them (task 4); an inventory of every pane made, watch and root included
  (task 5).
- Correctness and proof: a relaunch whose split or old-pane close failed could leave a harness in
  a pane nothing tracked. Now an old pane that won't close stays the agent's, for its close to
  retry, and a start that fails clears `current` even if its pane won't close. A placement checks
  its deadline once it leaves the queue. `workspace create` and `pane rename` are bounded by the
  command timeout. Added tests: a pane never run closes with its agent; a failed first start
  places a new pane, beside its target, and runs; a relaunch whose split fails closes the old
  pane, and the agent runs no more.

### Task 3

- Architecture and scope, correctness and proof (one reviewer, both lenses):
  - An `on-failure` agent whose operation the run's end cancelled was not kept: its outcome was
    recorded after its close read it. `stopOperations` now records the stop's kind first; a test
    covers it, and fails without the fix.
  - The host's close could be skipped when an agent's keep release outlasted the 5s cleanup grace.
    The release now waits at most 3s, and the grace path starts the host's close.
  - A cancel left an agent that may be kept merely interrupted until the run's end. It is now
    released at the cancel, and closed if it won't settle; a released one is not sent a second
    Escape, which opens codex's history.
  - `keep` says whether it kept, so a report never claims a keep the screen didn't make.
  - Kept by choice: a successful `set` counts as the last operation, answered.

### Task 4

- Architecture and scope, correctness and proof (one reviewer, both lenses):
  - A real run's label (`awf {workflow} {id} #{n}`) fills 32 characters, so `{run} {tab}` lost
    the tab. A tab in a shared workspace is now `{tab} · {run id}`, and the design says so.
  - A close failing in another session was dropped. It now fails the host's close, which can try
    again; a test covers it.
  - A `beside` split into another session's screen now checks that screen is still open, and that
    the target's pane is still in it.
  - A named workspace made without a pane is closed again.
  - A stale lock is moved aside before it is removed, so two waiters never both take it; the
    wait is 5s.
  - Panes outside the run session were unmarked until task 5, which lands with this.
  - Deviation, recorded in the design: `"origin"` is resolved once a run, at its first use, not
    as the run starts; a run that never uses it never asks Herdr.
  - Unproven by tests, left to the live check: an `awf-…` session started for a layout.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Record the human's approval or requested changes here.
