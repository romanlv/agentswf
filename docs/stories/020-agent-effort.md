---
id: "020"
title: An agent runs at the effort and model its workflow sets, and switches them mid-run
summary: "A workflow opens an agent at a reasoning effort, as at a model, and can switch either later in the same session with configure; each harness is launched or switched by its own flag or command, a harness that cannot is refused with its reason, and every operation records the settings it ran at."
type: story
status: draft
priority: P0
epic: agent-config
discovered_in: "story 008, match first; the first live loop, 2026-10-01"
depends_on: []
---

# An agent runs at the effort and model its workflow sets, and switches them mid-run

## Outcome

A workflow says how hard an agent thinks, as it says which model it is. It can switch either one
later without losing the session: a reviewer opened at `high` is switched to `low` for a summary, or
moved from a cheap model to a strong one once the work gets hard, as a person does with claude's
`/effort` or codex's `/model`. Effort is part of the agent's execution, so `output.json` records it
beside the model on every operation, and two runs that differ in effort can be told apart.

An agent that names no effort runs at its harness's default, as it would without awf, and its
record says awf set none. It no longer picks up the effort of the Claude Code session that launched
it: `CLAUDE_EFFORT` stops leaking through.

Why now: awf neither sets nor records effort, and effort changes an agent's time, cost and answers
as much as its model does.

- In story 008, every judge ran at an effort nobody chose:
  - headless claude took `CLAUDE_EFFORT=medium` from the session that launched `awf-lab`;
  - codex read `model_reasoning_effort` from the operator's `~/.codex/config.toml`;
  - pi read `defaultThinkingLevel` from `~/.pi/agent/settings.json`.
- The first live loop (data repository, `reports/2026-10-01-first-live-loop.md`) hit it twice:
  - contained codex ran at its fresh home's default, `low`, and wrote near-empty reviews;
  - the proposer, the step that should think hardest, could not be given high effort
    ([[loop-next]]).

## How it works

```
workflow                          engine                          harness
--------                          ------                          -------
open({ runtime: {                 execution = { harness, model,   claude  --effort high
  alias: "codex",                   placement, effort: "high" }   codex   -c model_reasoning_effort="high"
  effort: "high" } })        ──▶  checked against the harness's   pi      --thinking high
                                  levels; refused if unknown      cursor  --model '{m}[effort=high]'

agent.configure({                 queued like a turn; the agent's headless: the next resume carries
  effort: "low" })           ──▶  execution is "low" from here    the new flags. pane: the harness's
                                  on, and each later operation    own command (/effort, /model),
                                  records it                      confirmed on screen
```

- **At open.** An agent's effort is chosen with its runtime when it is opened. Absent, awf passes
  nothing and the harness uses its default.
- **`configure`.** It switches the agent's model, effort or both from that point on. It is an
  operation in the agent's queue, like `compact`: it runs after the turns enqueued before it, has an
  id that makes a repeat harmless, and is recorded. It changes the session the agent already has,
  so the context stays.
- **No per-turn effort.** A one-off is `configure`, the turn, then `configure` back. There is one
  mechanism to build and measure per harness, and the turn specs don't change.
- **The levels are the harness's own words**, not an awf scale: claude's `max` and codex's `xhigh`
  are not the same thing. Each harness definition lists its levels, and an effort outside them is
  refused before anything runs.
- **Same harness only.** `configure` changes model and effort, never the harness. Another harness
  is a new agent.
- **A harness that can't switch** in a pane or headless has `configure` marked absent there, with
  its reason (story 019's `defineHarness`). A `configure` asking for it is refused with that
  reason. The agent can still be opened at any effort.
- **The record.** `AgentExecution` gains `effort`. Each operation's `execution` is the settings it
  ran at, so a `configure` shows as the point where they change. The agent's `byAgent[].execution`
  is what it was opened at.

The case people will ask about first: **what does switching the model cost?** The new model has no
prompt cache for this session, so the next turn reads the whole context again at full price. The
new model's context window may also be smaller than the session already is. awf doesn't refuse
either; it refuses only what the harness itself refuses. The cost shows up in the next turn's spend,
split by model as `byModel` already does.

## Scope

In scope:

- `effort` on the runtime an agent is opened with, and on a fork.
- `AgentRef.configure({ model?, effort? })`: switching the session's model and effort, headless and
  in a pane, on claude, codex, pi and cursor where each can; refused with its reason where it can't.
- Launching each harness at an effort, headless and in a pane, on the host and in a sandbox.
- Recording effort on every operation and agent in `output.json`.
- Not inheriting `CLAUDE_EFFORT` from a calling session.
- The lab names effort for:
  - its variants' agents;
  - its judges (`--panel`);
  - its proposer (`--proposer`).

  Its contained-codex stopgap is removed.

Out of scope:

- Per-turn effort on `run` and `enqueue`. It can be added later as a shorthand for `configure`
  without breaking anything.
- Switching harness, placement, sandbox or skills mid-run.
- Permission mode ([[agent-permission-mode]]). It is the next setting `configure` would take, so its
  todo should build on this.
- Decision models (Jev): their effort is a provider parameter, not a harness's.
- The caller session of `awf run --here` (ADR 0010): the operator chose its settings, and
  `configure` on it is refused.
- An awf-wide effort scale, or choosing effort automatically.

## Context and evidence

- Fact: the CLIs, 2026-10-04:

  | Harness | Version | At launch |
  | --- | --- | --- |
  | claude | 2.1.289 | `--effort {low, medium, high, xhigh, max}` |
  | codex | 0.160.0 | `-c model_reasoning_effort="{level}"` |
  | pi | 0.87.1 | `--thinking {off, minimal, low, medium, high, xhigh, max}`, or `--model {m}:{level}` |
  | cursor | 2026.10.01 | parameterised models only: `--model '{m}[effort=high]'` |

  - Mid-session in a TUI: claude has `/model` and `/effort`; codex picks model and effort under
    `/model`. pi's and cursor's are unchecked.
  - codex's own levels depend on the model.
- Fact: a headless turn after the first is a new process resuming the session (`resumeTurn` in
  `packages/harness/src/harnesses/*.ts`). A headless `configure` is therefore flags on the next
  resume, provided the harness honours them on a resume.
- Fact: `OperationRecord.execution` is already "resolved execution for this operation"
  (`packages/contract/src/workflow/agents.ts`). Settings that change during a run fit there without
  a new field.
- Fact: `AgentRef.execution` is documented as "fixed for this logical agent". `configure` changes
  that promise.
- Fact: the stopgap `hostReasoningEffort`, and the codex config it writes, is in
  `packages/lab/src/review/lab/execute.ts`.
- Constraint: `ExecutionConfig`, `ExecutionRequirements`, `AgentForkSpec`, `AgentRef` and the
  record formats are published types (`AGENTS.md`, "The rule that matters"). This story settles them
  before any code.
- Constraint: a capability is built or absent with a reason, and tsc enforces it (story 019).

## Code map

### `packages/contract`

- `src/workflow/agents.ts`:
  - `RuntimeTarget`, `ExecutionRequirements` and `AgentForkSpec` gain `effort?: Effort`;
    `ExecutionConfig` and `AgentExecution` gain it through `RuntimeTarget`;
  - `ConfigureSpec` and `AgentRef.configure` are new;
  - `AgentRef.execution` becomes the agent's current settings;
  - `OperationRecord` needs no new field.
- `src/records.ts`: `RunAccounting.byAgent[].execution` carries effort with no change.

### `packages/harness`

- `src/harnesses/define.ts`:
  - `TurnContext` gains `effort`;
  - `interactive` and `interactiveResume` take it;
  - a required field lists the harness's effort levels;
  - a new optional capability switches a pane's model and effort, shaped like `compactPane`: the
    text to type and the screen that confirms it.
- `src/harnesses/{claude,codex,pi,cursor}.ts`: each plan adds its flag at launch and on resume:
  - codex: a `-c` placed before `exec`'s prompt;
  - cursor: rewrites `--model`.
- `src/adapters/direct-process.ts`: the next resume uses the agent's current settings.
- `src/adapters/herdr.ts`: a `configure` types the switch into the pane and waits for its screen.
- `CLAUDE.callingSessionEnv`: add `CLAUDE_EFFORT`.

### `packages/engine`

- `src/workflow-runner.ts`:
  - alias resolution merges `effort` as an agent-owned field;
  - reattach compares it;
  - `configure` is queued and recorded like `compact`, and checked against the harness's levels
    and capabilities;
  - later operations take the new settings.
- `src/operator-aliases.ts`: unchanged; the installed aliases name no effort.
- `src/workflow-testing/`: a scripted agent records its settings, `configure` included, so a
  workflow's test can check them.

### `packages/lab`

- `src/review/lab/execute.ts`: remove `hostReasoningEffort` and the config it writes.
- `src/review/lab/cli.ts`: `--proposer` and `--panel` accept `harness/model:effort`, as pi's model
  shorthand does.
- `src/review/lab/loop/propose.workflow.ts` and `src/review/judge/judge.workflow.ts`: pass it to
  `open`.
- A scorer's or variant's identity includes its agents' efforts (open question 5).

### Checked, no change

- `src/accounting`: effort doesn't change pricing, tokens already split out `reasoning`, and
  `byModel` already splits an agent whose model changed.
- `packages/wf`: an agent doesn't change its own settings; the workflow does.

## Proposed design

### The contract change

All of these types are published, so this section is what task 2 settles before any code.

**At open:**

```ts
/** A harness's own level name, such as claude's `max` or codex's `xhigh`; see `HarnessSpec.effort`. */
export type Effort = string;

export type RuntimeTarget = {
  harness: HarnessKind;
  model: string;
  /** Absent, awf passes none and the harness uses its default. */
  effort?: Effort;
};

export type ExecutionRequirements = PlacementChoice & {
  alias: RuntimeAliasName;
  harness?: HarnessKind;
  model?: string;
  /** Agent-owned, like `placement`: it replaces an alias's effort rather than having to match it. */
  effort?: Effort;
};

export interface AgentForkSpec extends PlacementChoice {
  key: AgentKey;
  instructions?: string;
  labels?: JsonObject;
  /** Absent, the fork takes its parent's current effort. */
  effort?: Effort;
}
```

**During the run:**

```ts
export interface ConfigureSpec {
  /** Idempotency key scoped to this agent. Generated when omitted. */
  id?: string;
  /** Another model of the same harness. */
  model?: string;
  effort?: Effort;
  deadline?: AbsoluteDeadline;
  timeoutMs?: number;
}

export interface AgentRef extends ParticipantRef {
  /** The agent's settings now: as opened, then as the last settled `configure` left them. */
  readonly execution: AgentExecution;
  /**
   * Switches this session's model or effort after the earlier operations; the context is kept.
   * Answered with the settings now in force. Refused where the harness can't switch, with why.
   */
  configure(spec: ConfigureSpec): Promise<TurnOutcome<AgentExecution>>;
  // ...enqueue, run, compact, fork, as today
}
```

```ts
const reviewer = await agents.open({ key: "reviewer", runtime: { alias: "codex", effort: "high" } });
const findings = await reviewer.run({ prompt: review, schema: Findings });   // high
await reviewer.configure({ effort: "low" });
const summary = await reviewer.run({ prompt: "Summarise." });                // low
const recheck = await reviewer.run({ prompt: "Check the fixes." });          // still low
```

**In the records:** nothing new is added. Each operation's `execution` holds the settings it ran
at:

```json
{ "agent": "reviewer", "operationId": "…",
  "execution": { "harness": "codex", "model": "gpt-6.1-sol", "placement": "pane", "effort": "low" } }
```

**Not changed:** the turn specs, `CompactSpec`, `wf`. `attach` takes a `RuntimeSelection`, so it
gains `effort` as a constraint, compared with the agent as it was opened.

### How it runs

- **At open**, each harness's flag goes into its launch, in a pane and headless, on the host and in
  a sandbox.
- **Headless**, `configure` runs no process. It settles once the new settings are valid, and the
  next resume carries them.
- **In a pane**, `configure` types the harness's own command and settles when the screen confirms
  it.

Invariants:

- An operation records the settings awf launched or switched it to. awf never records a setting it
  did not set or confirm.
- An effort or model the harness doesn't accept is refused before any process starts, quoting the
  harness's levels.
- A `configure` the harness can't do is refused with the definition's absent reason. It never
  silently leaves the old settings in force.
- A pane `configure` whose confirmation never shows settles `failed`, and the agent's settings are
  unknown. It is closed, as a pane is after a failed turn, so nothing later runs at a setting nobody
  can name.

Alternatives rejected:

- **Effort on each turn (`run({ effort })`).** It was in the first draft. It is two mechanisms,
  where a pane needs a switch and a switch back for every such turn, and it changes the turn specs.
  `configure` covers it with one.
- **An awf scale (`low`/`medium`/`high`) mapped per harness.** Portable, but the levels don't line
  up, and the record would say what was asked rather than what ran.
- **Effort inside the model string, as cursor and pi allow.** `byModel` would split one model in
  two.
- **Effort only in launch arguments, like skills' `launchArgs`.** Nothing would record it, and
  nothing could switch it.

## Tasks at a glance

- [ ] 1. Measure each harness: effort levels; effort and model at launch and on a resume; the pane
  commands and the screens that confirm them; precedence over config
- [ ] 2. Settle and add `effort` and `configure` to the contract and the records; refuse what a
  harness doesn't accept
- [ ] 3. Each harness launches at its agent's effort, headless and in a pane; `CLAUDE_EFFORT` not
  inherited
- [ ] 4. `configure` switches model and effort mid-session, headless and in a pane, where the
  harness can
- [ ] 5. The lab names effort for variants, judges and the proposer; the stopgap is removed

## To measure

What task 1 finds out by running each harness. These are not decisions; a capability that can't be
shown is absent with its reason.

- Does each harness honour `--model` and its effort flag on a resumed headless turn, or does a
  resume keep the session's first settings?
- In a pane, which command switches model and effort, and what on screen confirms it? claude's
  `/model` and `/effort` and codex's `/model` picker exist; pi's and cursor's are unchecked.
- Cursor: is effort only for parameterised models? If so, a cursor agent on another model has
  effort absent.
- Precedence: does `--effort` beat `CLAUDE_EFFORT` and claude's settings? Does codex's `-c` beat a
  profile?
- Where each harness logs the model and effort it actually used, so task 3's live check can read
  them back. codex's rollout logs `effort` in its `turn_context`; claude's and pi's session files
  are unchecked.

## Open questions

Decisions for the operator, grouped by the task they block.

### 2. Contract

- **What to call `configure`.** It is a verb on `AgentRef`, beside `run`, `compact` and `fork`.
  Permission mode would be its next setting.
  - `configure({ effort: "low" })`: plain, but it reads like setup before the agent starts, not a
    switch in the middle of a run.
  - `set({ effort: "low" })`: the shortest, and it stays right for future settings. It doesn't say
    that it waits in the queue behind earlier turns.
  - `switchTo({ model: "opus" })`: says most clearly that the same session moves to new settings,
    as the harnesses' own `/model` does. It reads oddly for a permission mode.
  - `use({ model: "opus" })`: reads well in a workflow, but "use" says little about what changes.
  - Recommendation: `set`. Its doc comment carries the queue order, which applies to every verb on
    `AgentRef` anyway.
- **Can an agent set its own effort over its alias's?** The proposal says yes, as it can its
  placement. The same model at two efforts is the common case, and making it a constraint, like
  `model`, means an alias for every model and effort pair.

### 5. Lab

- How does an existing scorer's or variant's identity change when effort joins it? Old records ran
  at an unrecorded effort, so they should not match a new identity that names one.

### Decided

- **Absent effort:** awf passes none, and the harness uses its default; the record says `effort`
  absent. Installed aliases name no effort (operator, 2026-10-04).
- **Switching mid-run is its own operation, not part of a prompt or a turn**, and it covers model as
  well as effort (operator, 2026-10-04).

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. Measure each harness

Outcome: the facts above are measured per harness, recorded in a finding, and every item under "To measure"
has an answer.

Execution:

- [ ] Plan: list each probe and its cheapest model; probes run on codex where the harness allows
  it, and briefly on the others.
- [ ] Implement: run the probes; record them in `docs/findings/agent-effort.md`.
- [ ] Review: one subagent checks each claim against its probe's output.
- [ ] Resolve: disposition every gap; a capability that can't be shown is absent.
- [ ] Verify: every row of the table is measured or marked unknown.

Work:

- For each harness:
  - its levels for the models awf runs;
  - launch at a level, headless and in a pane, and read the level back from its logs;
  - resume headless at another level and another model;
  - switch model and effort in a pane, and capture the screen that confirms it;
  - precedence over its config and environment.

Done when:

- Every item under "To measure" has an answer or a reason it can't be had.

### 2. Settle the contract and the records

Outcome: `effort` and `configure` are in the published types and records, with their refusals,
and documented.

Execution:

- [ ] Plan: settle open questions 2 with the operator before editing types.
- [ ] Implement: contract types; the engine's alias merge, reattach rule and level check; the
  workflow-testing surface records it.
- [ ] Review: architecture/scope and correctness/proof subagents on the diff.
- [ ] Resolve: disposition findings.
- [ ] Verify: `bun test`, `bunx tsc --noEmit`, boundaries.

Work:

- `effort` on the runtime, the fork spec and the execution record; `ConfigureSpec` and
  `AgentRef.configure`, queued and recorded like `compact`. Unknown levels are refused at `open`
  and at `configure`.

Done when:

- A workflow test opens an agent at an effort, runs a turn, configures another effort and model,
  and runs two more. The operations record each setting where it took effect, and an unknown level
  is refused before any agent runs.

### 3. Launch at the agent's effort

Outcome: every harness starts at its agent's effort, headless and in a pane, sandboxed or not.

Execution:

- [ ] Plan: per-harness flags from task 1's finding.
- [ ] Implement: plans in each harness file; `CLAUDE_EFFORT` in `callingSessionEnv`.
- [ ] Review: two subagents.
- [ ] Resolve: disposition findings.
- [ ] Verify: plan tests per harness; a cheap live check per harness reads the effort back.

Done when:

- A live run of each harness, headless and in a pane, logs the effort it was given.

### 4. `configure` switches the session

Outcome: `configure` switches model and effort in the agent's session, which keeps its context,
headless and in a pane. A harness that can't is refused with its reason.

Execution:

- [ ] Plan: the pane switch capability's shape in `define.ts`, from task 1's screens.
- [ ] Implement: headless settings carried to the next resume; the pane switch and its
  confirmation; absent reasons.
- [ ] Review: two subagents.
- [ ] Resolve: disposition findings.
- [ ] Verify: adapter tests for a switch and a failed confirmation; a live pane check on claude and
  codex.

Done when:

- A live run switches effort and then model between turns, in a pane and headless, on each harness
  that can. The harness's own log agrees with `output.json`, and the second turn still knows what
  the first was told.

### 5. The lab names effort

Outcome: a variant's, judge's and proposer's effort is chosen and recorded, never inherited.

Execution:

- [ ] Plan: settle open question 5; the `harness/model:effort` syntax.
- [ ] Implement: CLI parsing, the proposer and judge workflows, identities; remove the stopgap.
- [ ] Review: two subagents.
- [ ] Resolve: disposition findings.
- [ ] Verify: lab tests; one contained codex trial at `high` logs `high`.

Done when:

- `awf-lab loop --proposer codex/{model}:high` runs its proposer at high, and its record says so.

## Verification

Automated:

- [ ] Workflow tests: effort on open, alias and fork; `configure` in order with turns, idempotent
  by id; refusals for an unknown level, another harness, the caller, and an absent capability.
- [ ] Harness plan tests: each harness's flag at launch and on resume.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] Per harness, headless and in a pane: launch at a level, then `configure` another effort and
  model; the harness's own log agrees with `output.json`. Cheap models, a few cents a harness.

## Review record

### Task 1

### Task 2

### Task 3

### Task 4

### Task 5

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [ ] Evidence and research support the proposed design: task 1 measures it.
- [ ] Expensive interface, record-format, and stage-gate decisions are settled: open questions 2.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
