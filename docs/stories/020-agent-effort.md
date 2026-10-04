---
id: "020"
title: An agent runs at the effort its workflow names, and its record says which
summary: "A workflow names an agent's reasoning effort, as it names its model, and may change it for one turn; each harness is launched or switched to it, a harness that cannot is refused with its reason, and every operation records the effort it ran at."
type: story
status: draft
priority: P0
epic: agent-config
discovered_in: "story 008, match first; the first live loop, 2026-10-01"
depends_on: []
---

# An agent runs at the effort its workflow names, and its record says which

## Outcome

A workflow says how hard an agent thinks, as it says which model it is, and can change that for
one turn: a reviewer at `high`, its summary turn at `low`. The effort is part of the agent's
execution, so it is in `output.json` beside the model, on the agent and on every operation, and
two runs that differ in effort are told apart by their records.

An agent that names no effort is no longer silently run at the effort of whatever launched it.
Claude Code's `CLAUDE_EFFORT` stops leaking into the agents a session launches, and where awf can
read the effort a harness actually used, the record says it.

Why now: awf neither sets nor records effort, and it changes an agent's time, cost and answers as
much as its model does.

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
workflow                          engine                         harness
--------                          ------                         -------
open({ runtime: {                 execution = { harness, model,  claude  --effort high
  alias: "codex",                   placement, effort: "high" }  codex   -c model_reasoning_effort="high"
  effort: "high" } })        ──▶  checked against the harness's  pi      --thinking high
                                  levels; refused if unknown     cursor  --model 'm[effort=high]'

agent.run({ prompt,               the operation's execution      headless: the flag on this turn's
  effort: "low" })           ──▶  is the agent's, effort "low"   resume. pane: the harness's own
                                                                 command before the prompt; back
                                                                 to the agent's effort after
```

- **The agent's effort** is chosen when it is opened, with its runtime. An alias may name one, as
  `deep: { harness: "claude", model: "opus", effort: "high" }` would, and the agent may set it over
  the alias's, as it sets its placement.
- **A turn's effort** applies to that turn only, and the next turn that names none runs at the
  agent's. It is part of the turn's spec, so reusing a turn id with another effort is refused, as
  another prompt is.
- **The levels are the harness's own words**, not an awf scale. claude's `max` and codex's `xhigh`
  are not the same thing, and a mapping would record what the workflow wrote rather than what ran.
  Each harness definition lists its levels, and an effort outside them is refused at `open` or at
  the turn, before anything runs.
- **A harness that cannot change effort mid-session**, in a pane or headless, has that capability
  absent with its reason (story 019's `defineHarness`), and a turn that asks for it is refused with
  that reason.
- **The record:** `AgentExecution` gains `effort`. It shows up in `output.json` wherever an
  execution already does: on each operation (`OperationRecord.execution`, the turn's effort when
  it named one) and in `byAgent`. Absent means awf did not set one; the harness's own config chose.

The case people will ask about first: **what does an agent that names no effort get?** Today it
gets the operator's config, plus the launching session's `CLAUDE_EFFORT`. Under this proposal it
gets the operator's config only: awf strips `CLAUDE_EFFORT` like the other calling-session
variables, and records `effort` absent. A sandboxed agent's fresh home has no config, so it gets the
harness default; the stopgap that copies the host's codex effort into a contained trial goes away,
because the lab names effort instead. Open question 2 asks whether absent should instead pin a
default.

## Scope

In scope:

- `effort` on the runtime an agent is opened with, on an alias, on a fork, and on a turn
  (`enqueue`, `run`).
- Launching each of claude, codex, pi and cursor at an effort, headless and in a pane.
- Changing effort for one turn, where the harness can; refused with its reason where it can't.
- Recording effort on every operation and agent in `output.json`.
- Not inheriting `CLAUDE_EFFORT` from a calling session.
- The lab names effort for:
  - its variants' agents;
  - its judges (`--panel`);
  - its proposer (`--proposer`).

  Its contained-codex stopgap is removed.

Out of scope:

- Decision models (Jev): their effort is a provider parameter, not a harness's; a todo if needed.
- The caller session of `awf run --here` (ADR 0010): the operator chose its effort, and awf does
  not change it. A turn naming effort on the caller is refused.
- An awf-wide effort scale, or choosing effort automatically.
- Permission mode ([[agent-permission-mode]]), which may sit beside `effort` later and follows the
  same shape.

## Context and evidence

- Fact: the CLIs, 2026-10-04:

  | Harness | Version | At launch |
  | --- | --- | --- |
  | claude | 2.1.289 | `--effort {low, medium, high, xhigh, max}` |
  | codex | 0.160.0 | `-c model_reasoning_effort="{level}"` |
  | pi | 0.87.1 | `--thinking {off, minimal, low, medium, high, xhigh, max}`, or `--model {m}:{level}` |
  | cursor | 2026.10.01 | parameterised models only: `--model '{m}[effort=high]'` |

  - Mid-session in a TUI: claude has `/effort`; codex picks effort under `/model`. Nothing else is
    known for pi or cursor.
  - codex's own levels depend on the model.
- Fact: a headless turn after the first is a new process resuming the session
  (`resumeTurn`, `packages/harness/src/harnesses/*.ts`). So a per-turn effort there is a flag on
  that turn's plan, if the harness honours a flag on resume. That has to be measured.
- Fact: `OperationRecord.execution` is already "resolved execution for this operation"
  (`packages/contract/src/workflow/agents.ts`). A turn's effort fits there without a new field.
- Fact: the stopgap `hostReasoningEffort` and the codex config it writes are in
  `packages/lab/src/review/lab/execute.ts`.
- Constraint: `ExecutionConfig`, `ExecutionRequirements`, `AgentForkSpec`, the turn specs and the
  record formats are published types (`AGENTS.md`, "The rule that matters"). They are settled here
  before code.
- Constraint: a capability is built or absent with a reason; tsc enforces it (story 019).
- Assumption: claude's `--effort` beats `CLAUDE_EFFORT` and its settings. Unverified.
- Assumption: the effort a harness actually used is readable after the turn:
  - codex's rollout logs a `turn_context` with `effort`;
  - claude's and pi's session files are unchecked.

## Code map

### `packages/contract`

- `src/workflow/agents.ts`:
  - `RuntimeTarget`, `ExecutionRequirements`, `ExecutionConfig` and `AgentExecution` gain
    `effort?: string`;
  - so do `AgentForkSpec` and the turn specs (`EnqueuedTurnBase`, `AgentRunBase`);
  - `OperationRecord` needs no new field.
- `src/records.ts`: `RunAccounting.byAgent[].execution` carries it with no change.

### `packages/harness`

- `src/harnesses/define.ts`:
  - `TurnContext` gains `effort`;
  - `interactive` and `interactiveResume` take it;
  - a new optional capability changes effort in a pane (a `compactPane`-like plan: the prompts to
    type, and the screen that confirms them);
  - the harness's levels become a required field.
- `src/harnesses/{claude,codex,pi,cursor}.ts`: each plan adds its flag:
  - codex: a `-c` that must come before `exec`'s prompt;
  - cursor: rewrites `--model`.
- `src/adapters/direct-process.ts`, `src/adapters/herdr.ts`: these pass the turn's effort into the
  plan. herdr types the switch before a turn whose effort differs from the pane's current one,
  then switches back.
- `CLAUDE.callingSessionEnv`: add `CLAUDE_EFFORT`.

### `packages/engine`

- `src/workflow-runner.ts`:
  - alias resolution merges `effort` as an agent-owned field;
  - reattach compares it;
  - a turn's effort is checked against the harness's levels and written into the operation's
    execution.
- `src/operator-aliases.ts`: unchanged, as the aliases name no effort (open question 3).
- `src/workflow-testing/`: scripted agents record the effort they were asked for, so a workflow's
  test can check it.

### `packages/lab`

- `src/review/lab/execute.ts`: remove `hostReasoningEffort` and the config it writes.
- `src/review/lab/cli.ts`: `--proposer` and `--panel` accept `harness/model:effort`, as pi's model
  shorthand does.
- `src/review/lab/loop/propose.workflow.ts` and `src/review/judge/judge.workflow.ts`: pass it to
  `open`.
- A scorer's or variant's identity includes its agents' efforts. Where the identity is a hash, the
  hash changes for existing records; that needs checking.

### Checked, no change

- `src/accounting`: effort doesn't change pricing; tokens already split out `reasoning`.
- `packages/wf`: an agent does not set its own effort.

## Proposed design

### The contract change

Effort is set in two places in `packages/contract/src/workflow/agents.ts`: on the agent, when the
workflow opens it, and on a turn, while the run goes on. All of these types are published, so this
section is what task 2 settles before any code.

**On the agent:**

```ts
/** A harness's own level name, such as claude's `max` or codex's `xhigh`; see `HarnessSpec.effort`. */
export type Effort = string;

export type RuntimeTarget = {
  harness: HarnessKind;
  model: string;
  /** A default an alias gives; the agent may set its own over it. */
  effort?: Effort;
};

export type ExecutionRequirements = PlacementChoice & {
  alias: RuntimeAliasName;
  harness?: HarnessKind;
  model?: string;
  /** Agent-owned, like `placement`: it replaces the alias's effort rather than having to match it. */
  effort?: Effort;
};

// ExecutionConfig = RuntimeTarget & PlacementChoice, so it gains `effort` with RuntimeTarget, and
// AgentExecution, what an agent and each operation record, gains it with ExecutionConfig.

export interface AgentForkSpec extends PlacementChoice {
  key: AgentKey;
  instructions?: string;
  labels?: JsonObject;
  /** Absent, the fork keeps its parent's agent effort, not the effort of the parent's last turn. */
  effort?: Effort;
}
```

```ts
const reviewer = await agents.open({
  key: "reviewer",
  runtime: { alias: "codex", effort: "high" },
});
```

**During the run, for one turn:**

```ts
interface EnqueuedTurnBase extends AgentTurnBase {
  id: TurnId;
  /** This turn only; the next turn that names none runs at the agent's effort. */
  effort?: Effort;
}

interface AgentRunBase {
  // ...id, prompt, deadline, timeoutMs, label, nudge, as today
  /** This turn only, its nudge included. Part of the turn's spec: a reused id with another effort is refused. */
  effort?: Effort;
}
```

```ts
const findings = await reviewer.run({ prompt: review, schema: Findings });           // high
const summary = await reviewer.run({ prompt: "Summarise.", effort: "low" });          // low, once
const recheck = await reviewer.run({ prompt: "Check the fixes." });                   // high again
```

A turn's effort does not carry over. The turns after it run at the agent's effort, which is fixed
when the agent is opened, as `AgentRef.execution` is today. To run several turns low, each one names
`low`. There is no call that changes the agent's effort for the rest of the run. Open question 2
asks whether there should be.

**In the records:** nothing new is added. `OperationRecord.execution` is already "resolved execution
for this operation", so a turn's effort is written there; `byAgent[].execution` holds the agent's.
In `output.json`, an operation looks like this:

```json
{ "agent": "reviewer", "operationId": "…",
  "execution": { "harness": "codex", "model": "gpt-6.1-sol", "placement": "pane", "effort": "low" } }
```

**Not changed:**

- `CompactSpec`: a compaction runs at the agent's effort.
- `AgentDirectory.attach`: it takes a `RuntimeSelection`, so it gains `effort` as a constraint with
  the rest.
- `caller`: a turn on the caller that names an effort is refused.
- `wf`: an agent does not set its own effort; the workflow does.

**In the harness package**, not the contract: `HarnessSpec` gains the levels the harness takes
(`effort: readonly string[]`), plus the plan that switches a pane's effort, or that capability
absent with its reason.

### How it runs

`effort` is an optional string on the runtime and on a turn:

- it is validated against the levels the agent's harness definition lists;
- it is passed by each harness's own flag at launch and on a headless resume;
- in a pane, a turn whose effort differs is switched by the harness's own command, then switched
  back;
- it is recorded in the operation's `execution`.

Invariants:

- An operation's recorded `effort` is the one awf launched or switched it to. awf never records an
  effort it did not set as if it had.
- An effort the harness doesn't know is refused before any process starts, quoting the harness's
  levels.
- A per-turn effort a harness can't apply is refused with the definition's absent reason. It never
  silently runs at the agent's effort.
- A fork keeps its parent's effort unless its spec names one.
- Reopening an agent: an `effort` left out constrains nothing; one given must match.

Alternatives rejected:

- **An awf scale (`low`/`medium`/`high`) mapped per harness.** Portable across harnesses, but the
  levels don't line up, and the record would say what was asked rather than what ran.
- **Effort only in launch arguments, through skills-like `launchArgs`.** Nothing would record it,
  and nothing could change it per turn.
- **Pinning effort in the model string, as cursor and pi allow.** It would hide effort inside
  `model`, so `byModel` would split one model in two.

## Tasks at a glance

- [ ] 1. Measure each harness's effort: levels, flag on launch and on resume, the pane command and
  its screen, what wins over config, and where the used effort is logged
- [ ] 2. Settle and add `effort` to the contract and the records; refuse unknown levels
- [ ] 3. Each harness launches at its agent's effort, headless and in a pane; `CLAUDE_EFFORT` not
  inherited
- [ ] 4. A turn runs at its own effort where the harness can, and is refused with the reason where
  it can't
- [ ] 5. The lab names effort for variants, judges and the proposer; the stopgap is removed

## Open questions

### 1. Measure

- Does each harness honour its flag on a resumed headless turn, or does a resume keep the
  session's first effort? This decides whether headless per-turn effort is free or absent.
- In a pane, what confirms a switch on screen? claude's `/effort {level}` and codex's `/model`
  picker are known to exist; pi's and cursor's in-session commands are not.
- Cursor: is effort only for parameterised models? If so, a cursor agent on another model has
  effort absent, and is refused.
- Precedence: does `--effort` beat `CLAUDE_EFFORT` and settings? Does codex's `-c` beat a
  profile?

### 2. Contract

- **Absent effort: inherit or pin?** The proposal keeps today's behaviour minus `CLAUDE_EFFORT`:
  the operator's config chooses, and the record says `effort` absent.
  - The alternative pins the harness's documented default, so a run is the same on any machine.
    Then the record is never empty, but awf has to know each harness's default and follow it as
    it changes.
  - Recommendation: inherit, and record the used effort in a separate `observed` field where the
    harness logs it. That stays honest without awf tracking defaults.
- Is `effort` agent-owned (an alias's is a default the agent can change, like placement) or
  alias-owned (a constraint, like model)? The proposal says agent-owned: the same model at two
  efforts is the common case, and an alias per pair multiplies aliases.
- **Should a turn's effort stay for the turns after it?** The proposal says no: a turn's effort is
  for that turn only, and the agent's effort is fixed when it is opened.
  - Why: a turn's spec then says everything about the turn. A turn that is replayed, or continued
    from a stage ([story 018](018-workflow-stages.md)), runs at the effort it was recorded with,
    whatever ran before it.
  - The cost: a workflow that wants every turn after some point at `low` has to name `low` on each
    of them.
  - The alternative is a call that changes the agent's own effort, `reviewer.setEffort("low")`, and
    that its record shows from then on. The agent's execution would then change over the run, so
    `byAgent[].execution` would need an effort per span of turns, or the last one.
  - Recommendation: keep effort per turn now. A setter can be added later without breaking
    anything, and taking one back would break workflows.

### 3. Harnesses

- Should the installed aliases (`claude`, `codex`) name an effort? The proposal says no, as they
  would then override every operator's config.
- A pane switched for one turn and back costs two TUI commands per turn. Is switching back eager
  (after the turn) or lazy (before the next turn that differs)? Lazy is cheaper. Eager leaves the
  pane in the agent's own state for an operator who looks at it.

### 5. Lab

- How does an existing scorer's or variant's identity change when effort joins it? Old records
  ran at an unrecorded effort, so they should not match a new identity that names one.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. Measure each harness's effort

Outcome: the facts above are measured per harness, recorded in a finding, and open questions 1 are
answered.

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
  - resume headless at another level;
  - switch in a pane, and capture the screen that confirms it;
  - precedence over its config and environment.

Done when:

- Every open question under 1 has an answer or a reason it can't be had.

### 2. Settle the contract and the records

Outcome: `effort` is in the published types and records, with its refusals, and documented.

Execution:

- [ ] Plan: settle open questions 2 with the operator before editing types.
- [ ] Implement: contract types; the engine's alias merge, reattach rule and level check; the
  workflow-testing surface records it.
- [ ] Review: architecture/scope and correctness/proof subagents on the diff.
- [ ] Resolve: disposition findings.
- [ ] Verify: `bun test`, `bunx tsc --noEmit`, boundaries.

Work:

- `effort` on the runtime, fork and turn specs and the execution record. Unknown levels are
  refused at `open` and at the turn.

Done when:

- A workflow test opens an agent at an effort and runs a turn at another. The operations record
  both, and an unknown level is refused before any agent runs.

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

### 4. A turn's own effort

Outcome: `agent.run({ effort })` runs that turn at that effort, then the agent returns to its own.
A harness that can't do this is refused with its reason.

Execution:

- [ ] Plan: the pane switch capability's shape in `define.ts`; switching back eagerly or lazily
  (open question 3).
- [ ] Implement: headless per-turn flag; pane switch; absent reasons.
- [ ] Review: two subagents.
- [ ] Resolve: disposition findings.
- [ ] Verify: adapter tests for switch and switch-back; a live pane check on claude and codex.

Done when:

- A live two-turn run at two efforts logs both, in a pane and headless, on each harness that can.

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

- [ ] Workflow tests: effort on open, alias, fork and turn; refusals for an unknown level and an
  absent capability.
- [ ] Harness plan tests: each harness's flag at launch and on resume.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] Per harness, headless and in a pane: launch at a level and change it for one turn; the
  harness's own log agrees with `output.json`. Cheap models, a few cents a harness.

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
