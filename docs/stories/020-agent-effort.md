---
id: "020"
title: An agent runs at the effort and model its workflow sets, and switches them mid-run
summary: "A workflow opens an agent at a reasoning effort, as at a model, and can switch either later in the same session with `set`; each harness is launched or switched by its own flag or command, a harness that cannot is refused with its reason, and every operation records the settings it ran at."
type: story
status: done
priority: P0
epic: agent-config
discovered_in: "story 008, match first; the first live loop, 2026-10-01"
depends_on: []
---

# An agent runs at the effort and model its workflow sets, and switches them mid-run

## Outcome

A workflow says how hard an agent thinks, as it says which model the agent is. It can switch
either later without losing the session, as a person does with claude's `/effort` or codex's
`/model`. Examples: a reviewer opened at `high` is switched to `low` for its summary; a cheap model
is swapped for a strong one once the work gets hard. `output.json` records the effort beside the
model on every operation, so two runs that differ in effort can be told apart.

An agent that names no effort runs at its harness's default, as it would without awf, and its
record says awf set none. It no longer picks up the effort of the Claude Code session that launched
it.

Why now: awf neither sets nor records effort, and effort changes an agent's time, cost and answers
as much as its model does.

- In story 008, every judge ran at an effort nobody chose:
  - headless claude ran at its own default for Sonnet, `medium`. The draft blamed the
    `CLAUDE_EFFORT=medium` a Claude Code session exports, but claude ignores that variable (M4);
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
  effort: "high" } })        ──▶  effort checked against the      pi      --thinking high
                                  harness's levels                cursor  none: the variant is the model

agent.set({                       queued like compact; from here  headless: the next resume carries
  effort: "low" })           ──▶  on the agent's execution says   the new flags. pane: the harness is
                                  "low", and so does each later   relaunched on its session at them
                                  operation's record
```

- **At open.** An agent's effort is chosen with its runtime when it is opened. An alias may name
  one as a default, and the workflow's own replaces it (Q1). If neither names one, awf passes no
  effort and the harness uses its default (Q2).
- **`set`** (Q3, Q4). It switches the agent's model, effort or both for every operation after it.
  It goes in the agent's queue like `compact`: it runs after the operations enqueued before it, its
  id makes a repeat harmless, and it is recorded. It changes the session the agent already has, so the
  context stays.
- **No per-turn effort.** A one-off is `set`, the turn, then `set` back. That keeps one mechanism to
  build and measure per harness, and the turn specs don't change.
- **The levels are the harness's own words**, not an awf scale: claude's `max` and codex's `xhigh`
  are not the same thing. Each harness definition lists its levels, and an effort outside them is
  refused before anything runs. A model is not checked ahead: an unknown one fails its next turn,
  as it does at open today.
- **Same harness only.** `set` changes model and effort, never the harness, placement or sandbox.
  Another harness means a new agent.
- **A harness that can't switch**, in a pane or headless, has that switch absent with its reason
  (story 019's `defineHarness`), and a `set` that needs it is refused with that reason. The agent
  can still be opened at any of its levels.
- **The record.** `AgentExecution` gains `effort`. Each operation's `execution` holds the settings
  it ran at, so a `set` shows as the point where they change.

The case people will ask about first: **what does switching the model cost?** The new model has no
prompt cache for this session, so the next turn reads the whole context again at full price. Its
context window may also be smaller than the session already is. awf refuses neither; it refuses only
what the harness refuses. The cost shows in the next turn's spend, which `byModel` already splits
by model.

## Scope

In scope:

- `effort` on an alias, on the runtime an agent is opened with, and on a fork.
- `AgentRef.set({ model?, effort? })`, headless and in a pane, on claude, codex, pi and cursor where
  each can; refused with its reason where it can't.
- Launching each harness at an effort, headless and in a pane, on the host and in a sandbox.
- Recording effort on every operation and agent in `output.json`.
- Withholding `CLAUDE_CODE_EFFORT_LEVEL`, which would beat `--effort` (M4), from agents.
- The lab names effort wherever it names a runtime (`harness/model:{effort}`), and its
  contained-codex stopgap is removed.
- [`workflow-api.md`](../workflow-api.md) and [`adding-a-harness.md`](../adding-a-harness.md)
  describe effort and `set`.

Out of scope:

- Per-turn effort on `run` and `enqueue`. It can be added later as a shorthand for `set` without
  breaking anything.
- Switching harness, placement, sandbox or skills mid-run.
- Permission mode ([[agent-permission-mode]]). It is the next setting `set` would take, so its todo
  should build on this.
- Decision models (Jev): their effort is a provider parameter, not a harness's.
- The caller session of `awf run --here` (ADR 0010): the operator chose its settings. `set` on it is
  refused, as `compact` fails on it.
- An awf-wide effort scale, or choosing effort automatically.

## Context and evidence

- Fact: the CLIs' launch flags, read from each one's `--help` on 2026-10-04:

  | Harness | Version | Effort at launch |
  | --- | --- | --- |
  | claude | 2.1.289 | `--effort {low, medium, high, xhigh, max}` |
  | codex | 0.160.0 | `-c model_reasoning_effort="{level}"`, a config override; the levels depend on the model |
  | pi | 0.87.1 | `--thinking {off, minimal, low, medium, high, xhigh, max}`, or `--model {m}:{level}` |
  | cursor | 2026.10.01 | none; a parameterised model takes `--model '{m}[effort=high]'` (M3 found the key differs per model and `effort` refused on every model tried; the flat `{model}-{level}` ids work) |

- Fact: a Claude Code session exports `CLAUDE_EFFORT` to the commands it runs, but claude itself
  ignores it. `CLAUDE_CODE_EFFORT_LEVEL` is the variable that beats `--effort` (M4).
- Fact: after the first turn, a headless turn is a new process resuming the session (`resumeTurn`
  in `packages/harness/src/harnesses/*.ts`). A headless `set` is therefore flags on the next resume,
  provided the harness honours them on a resume (M1).
- Fact: `OperationRecord.execution` is already the "resolved execution for this operation"
  (`packages/contract/src/workflow/agents.ts`). Settings that change during a run fit there without
  a new field.
- Fact: `AgentRef.execution` is documented as "fixed for this logical agent", and reopening an agent
  compares the whole stored execution (`assertCompatibleAgent` in
  `packages/engine/src/workflow-runner.ts`). `set` breaks both unless the agent's opened
  settings are kept apart from its current ones.
- Fact: `resolveAlias` in `workflow-runner.ts` copies only `harness` and `model` from an alias. The
  agent's own fields, `placement` and `metered`, are added afterwards.
- Fact: every runtime the lab names on a command line goes through `runtimeOf` in
  `packages/lab/src/review/format/runtime.ts`. That covers the proposer, the panel and its
  tie-break, match first, and `draft-key`.
- Fact: a lab variant or scorer is identified by the semver its file declares. Its results belong to
  `{name}@{major}.{minor}`, and whether a change is a new version is the researcher's call
  (`packages/lab/src/review/lab/version.ts`). Nothing derives identity from runtimes.
- Fact: the stopgap `hostReasoningEffort` and the codex config it writes are in
  `packages/lab/src/review/lab/execute.ts`. Contained variants in the data repository that name no
  effort rely on it.
- Constraint: `RuntimeTarget`, `ExecutionRequirements`, `ExecutionConfig`, `AgentExecution`,
  `AgentForkSpec`, `AgentRef` and the record formats are published types (`AGENTS.md`, "The rule
  that matters"). This story settles them before any code.
- Constraint: a capability is built or absent with a reason, and tsc enforces it (story 019).

## Code map

### `packages/contract`

- `src/workflow/agents.ts`:
  - `Effort` is new.
  - `RuntimeTarget`, `ExecutionRequirements` and `AgentForkSpec` gain `effort?`, and
    `ExecutionConfig` and `AgentExecution` gain it through `RuntimeTarget` (Q1).
  - `SettingsSpec` and `AgentRef.set` are new.
  - `AgentRef.execution` becomes the agent's current settings.
  - `OperationRecord` needs no new field.
- `src/records.ts`: `byAgent[].execution` carries effort with no change; it holds the agent's first
  operation's settings, which a `set` before its first turn has already changed.

### `packages/harness`

- `src/harnesses/define.ts`:
  - `TurnContext` gains `effort`.
  - `interactive` and `interactiveResume` take it.
  - A required `effort` field lists the harness's levels, or is `Absent` with a reason.
  - Optional `setHeadless` and `setPane` capabilities say a resume, or a pane relaunched on its
    session, runs at the settings it is given.
  - A required `settingsEnv` names the operator's variables that would override them.
- `src/harnesses/{claude,codex,pi,cursor}.ts`: each launch and resume plan adds the harness's flag.
  cursor takes none (M3).
- `src/adapter.ts`: `HarnessSession` gains `set?(settings, deadline)`, beside `compact`. Absent
  means the host can't switch.
- `src/adapters/direct-process.ts`: a `set` updates the settings that the next resume's plan is
  built from.
- `src/adapters/herdr.ts`:
  - a `set` waits for the agent to settle and its session to be written, closes its tab, and
    relaunches the harness on its session (`interactiveResume`) at the new settings (Q6).
- `CLAUDE.settingsEnv`: `CLAUDE_CODE_EFFORT_LEVEL`, withheld from every agent.

### `packages/engine`

- `src/workflow-runner.ts`:
  - `resolveAlias` copies the alias's `effort`, and the workflow's replaces it (Q1);
  - the agent's identity keeps its opened execution for reattach, apart from its current one;
  - `set` is queued, made idempotent by id, and recorded the way `compact` is;
  - its effort is checked against the harness's levels;
  - later operations, forks included, take the new settings.
- `src/operator-aliases.ts`: unchanged; the installed aliases name no effort.
- `src/workflow-testing/host.ts`, `script.ts`: the testing host implements `set` and records each
  agent's settings, so a workflow's test can check them.

### `packages/lab`

- `src/review/format/runtime.ts`: `runtimeOf` reads `harness/model:{effort}`, and `runtimeName`
  prints it back.
- `src/review/lab/execute.ts`: remove `hostReasoningEffort` and the config it writes, once the data
  repository's contained variants name their effort.

### Docs

- `docs/workflow-api.md`: effort at open, and `set`.
- `docs/adding-a-harness.md`: what a new harness must give for effort, and what to measure.
- `docs/findings/agent-effort.md`: new, from task 1.

### Checked, no change

- `engine/src/accounting`: effort doesn't change pricing. Tokens already split out `reasoning`, and
  `byModel` already splits an agent whose model changed.
- `packages/wf`: an agent doesn't change its own settings; the workflow does.
- `packages/sandbox`: the effort flag is an argument like any other. A sandbox's fresh harness home
  means a sandboxed agent that names no effort gets the harness default (Q2).
- The lab's version rule (Q5).

## Proposed design

### The contract

These types are published; task 2 builds them as written here.

```ts
/** A harness's own level name, such as claude's `max` or codex's `xhigh`; see its definition's `effort`. */
export type Effort = string;

export type RuntimeTarget = {
  harness: HarnessKind;
  model: string;
  /** Absent, awf passes none and the harness uses its default (Q2). */
  effort?: Effort;
};

export type ExecutionRequirements = PlacementChoice & {
  alias: RuntimeAliasName;
  harness?: HarnessKind;
  model?: string;
  /** Replaces the alias's effort rather than having to match it, unlike `model` (Q1). */
  effort?: Effort;
};

export interface AgentForkSpec extends PlacementChoice {
  key: AgentKey;
  instructions?: string;
  labels?: JsonObject;
  /** Absent, the fork takes its parent's current effort, as it takes its current model. */
  effort?: Effort;
}

export interface SettingsSpec {
  /** Idempotency key scoped to this agent. Generated when omitted. */
  id?: string;
  /** Another model of the same harness. */
  model?: string;
  effort?: Effort;
  /** Defaults to the current workflow scope deadline. */
  deadline?: AbsoluteDeadline;
  /** Relative bound, capped by the current workflow scope deadline. */
  timeoutMs?: number;
}

export interface AgentRef extends ParticipantRef {
  /** The agent's settings now: as opened, then as the last answered `set` left them. */
  readonly execution: AgentExecution;
  /**
   * Switches this session's model or effort after the earlier operations; the context is kept.
   * Answered once the switch is confirmed; the outcome's `usage.execution` is the settings now in
   * force. Refused where the harness can't switch, with why.
   */
  set(spec: SettingsSpec): Promise<TurnOutcome<null>>;
  // enqueue, run, compact and fork as today.
}
```

```ts
const reviewer = await agents.open({ key: "reviewer", runtime: { alias: "codex", effort: "high" } });
const findings = await reviewer.run({ prompt: review, schema: Findings });   // high
await reviewer.set({ effort: "low" });
const summary = await reviewer.run({ prompt: "Summarise." });                // low
const recheck = await reviewer.run({ prompt: "Check the fixes." });          // still low
```

In the records, each operation's `execution` holds the settings it ran at:

```json
{ "agent": "reviewer", "operationId": "…",
  "execution": { "harness": "codex", "model": "gpt-6.1-sol", "placement": "pane", "effort": "low" } }
```

Not changed: the turn specs, `CompactSpec`, `wf`. `attach` and a repeated `open` compare against the
agent's settings as it was opened, so code that reopens an agent after a `set` with its original
spec still gets it back.

### How it runs

- **At open**, the harness's flag goes into its launch, in a pane and headless, on the host and in a
  sandbox.
- **Headless**, `set` runs no process. It is answered once its effort is valid, and the next resume
  carries the new flags.
- **In a pane**, `set` relaunches the harness on its session at the new settings, once its agent has
  settled, and is answered once the harness is up (Q6). Before the pane's first turn it only
  changes what the pane opens at.

Invariants:

- An operation records only the settings awf launched it at or switched it to.
- An effort the harness doesn't list is refused at `open`, `fork` or `set` before any process
  starts, and the refusal quotes the harness's levels.
- A `set` the harness can't do is refused with the definition's absent reason. It never silently
  leaves the old settings in force.
- A pane `set` whose relaunch fails or times out settles `failed` or `timed-out`, and nobody knows
  the agent's settings any more. The agent is closed, as after any failed turn, so nothing later runs at
  settings nobody can name.

Alternatives rejected:

- **Effort on each turn (`run({ effort })`).** This was in the first draft. It makes two
  mechanisms, needs a switch and a switch back in a pane for every such turn, and changes the turn
  specs. `set` covers it with one mechanism.
- **An awf scale (`low`/`medium`/`high`) mapped per harness.** It would be portable, but the levels
  don't line up, and the record would say what was asked rather than what ran.
- **Effort inside the model string, as cursor and pi allow.** `byModel` would split one model in
  two.
- **Effort as a raw launch argument, as skills' `launchArgs` are passed.** Nothing would record it,
  and nothing could switch it.
- **Answering `set` with the new settings (`TurnOutcome<AgentExecution>`).** `AgentExecution`
  has optional fields, so it isn't a `JsonValue`. The outcome's `usage.execution` carries the new
  settings anyway.

## Tasks at a glance

- [x] 1. Measure each harness: effort levels; effort and model at launch and on a resume; the pane
  commands and the screens that confirm them; precedence over config
- [x] 2. Add `effort` and `set` to the contract, the engine and the testing host; refuse what a
  harness doesn't list
- [x] 3. Each harness launches at its agent's effort, headless and in a pane;
  `CLAUDE_CODE_EFFORT_LEVEL` withheld
- [x] 4. `set` switches model and effort mid-session, headless and in a pane, where the harness can
- [x] 5. The lab names effort wherever it names a runtime; the stopgap's removal moved to
  [[loop-next]], since it waits on the data repository's variants naming their effort (Q5)

## To measure

What task 1 finds out by running each harness. These are not decisions. A switch that can't be
shown working is absent with its reason.

- **M1. Resume.** Does each harness honour `--model` and its effort flag on a resumed headless
  turn, or does a resume keep the session's first settings? This decides whether a headless `set`
  is possible.
- **M2. Pane switch.** In a pane, which command switches model and effort, and what on screen
  confirms it?
  - claude is reported to have `/model` and `/effort`;
  - codex is reported to pick both under `/model`;
  - pi's and cursor's are unknown.
- **M3. Cursor.** Which models take `[effort=…]`, and what does a cursor agent on another model get?
- **M4. Precedence.** Does claude's `--effort` beat `CLAUDE_EFFORT` and its settings file? Does
  codex's `-c` beat a profile?
- **M5. Codex's levels** for the models awf runs, so its definition lists the right ones.
- **M6. Logs.** Where each harness logs the model and effort it actually used, so the live checks
  can read them back. codex's rollout is reported to log `effort` in its `turn_context`; claude's
  and pi's session files are unchecked.

## Open questions

Decisions for the operator. None is open; each keeps its reasons.

### Decided

- **Q1. Can an alias carry an effort?** Yes (operator, 2026-10-04): an alias names a harness, a
  model and, optionally, an effort, so `deep` can be claude's `opus` at `high`.
  - An alias's effort is a default. A workflow that also names one gets its own:
    `{ alias: "deep", effort: "low" }` is opus at `low`.
  - Why not refuse a different effort, as a different `model` is refused: `set` can change the
    effort straight after `open`, so refusing it at `open` would protect nothing.
  - Installed aliases name no effort (Q2).
- **Q2. What does an agent that names no effort get?** awf passes none, and the harness uses its
  default; the record says `effort` absent. Installed aliases name no effort (operator,
  2026-10-04).
- **Q3. How is effort changed mid-run?** By its own operation, not as part of a prompt or a turn,
  and that operation switches model as well as effort (operator, 2026-10-04).
- **Q4. What is that operation called?** `set` (operator, 2026-10-04). It beat:
  - `configure`, which reads like setup before the agent starts;
  - `switchTo`, which reads oddly for a later permission mode;
  - `use`, which says little.
- **Q5. Does a lab variant's or scorer's identity change?** No. A variant's effort is in its file,
  and the researcher versions a change to it as any other change (`version.ts`). Old results were
  never tied to an effort.
- **Q6. How does a pane `set` switch claude and codex?** By relaunching the harness on its
  session at the new settings, on every harness that switches (operator, 2026-10-04). M2 found
  claude's typed `/effort` and `/model` save to the operator's `~/.claude/settings.json` as their
  default, and codex's `/model` is a picker. The relaunch was measured to keep the context and save
  nothing; it costs a few seconds, and the operator sees the agent's tab replaced.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. Measure each harness

Outcome: M1–M6 are answered per harness in
`docs/findings/agent-effort.md`, or marked unknown with why.

Execution:

- [x] Plan: list each probe and the cheapest model it can run on.
- [x] Implement: run the probes and record the commands, versions and output in the finding.
- [x] Review: one subagent checks each claim in the finding against its probe's output.
- [x] Resolve: disposition every gap; a switch that can't be shown working is absent.
- [x] Verify: every row of the finding's table is measured or marked unknown.

Work:

- For each harness:
  - launch at a level, headless and in a pane, and read the level back from its logs;
  - resume headless at another level and another model;
  - switch model and effort in a pane, and capture the screen that confirms it;
  - check precedence over its config and environment.

Done when:

- M1–M6 each have an answer, or a reason it can't be had.
- Each harness's levels and switches are known well enough to write its definition.

### 2. Contract, engine and testing host

Outcome: `effort` and `set` are in the published types, run through the engine and the testing
host, and are documented in `workflow-api.md`.

Execution:

- [x] Plan: map the reattach change to opened and current settings.
- [x] Implement:
  - the contract as in "The contract";
  - in the engine: the alias's effort and the workflow's over it, `set` queued like `compact`, level
    checks, the opened settings kept for reattach;
  - `set` on the testing host.
- [x] Review: architecture/scope and correctness/proof subagents on the diff.
- [x] Resolve: disposition findings.
- [x] Verify: focused workflow tests; `bun test`, `bunx tsc --noEmit`, boundaries.

Done when:

- A workflow test opens an agent at an effort, runs a turn, sets another effort and model, and runs
  two more. Each operation records the settings in force when it ran.
- Reopening the agent with its original spec still returns it.
- An unknown level, another harness, and `set` on the caller are each refused before any agent
  runs.

### 3. Launch at the agent's effort

Outcome: every harness starts at its agent's effort, headless and in a pane, on the host and in a
sandbox.

Execution:

- [x] Plan: per-harness flags and levels from task 1's finding.
- [x] Implement:
  - each harness definition's `effort`;
  - the launch and resume plans;
  - `CLAUDE_CODE_EFFORT_LEVEL` in claude's `settingsEnv`, withheld (and `CLAUDE_EFFORT` in
    `callingSessionEnv`, which only keeps an agent's shell clean);
  - `adding-a-harness.md`.
- [x] Review: two subagents.
- [x] Resolve: disposition findings.
- [x] Verify: plan tests per harness; a cheap live check per harness reads the effort back.

Done when:

- A live run of each harness, headless and in a pane, logs the effort it was given. Done for
  claude, codex and pi; cursor takes none. A sandboxed launch is not checked live.
- A claude agent never sees `CLAUDE_CODE_EFFORT_LEVEL`, which would beat `--effort`.

### 4. `set` switches the session

Outcome: `set` switches model and effort in the agent's session, which keeps its context, headless
and in a pane. A harness that can't is refused with its reason.

Execution:

- [x] Plan: the shape of `setPane` and `HarnessSession.set`, from task 1's screens (M1, M2): a
  relaunch on the session (Q6), so `setPane` is a marker, not commands to type.
- [x] Implement:
  - headless: the settings carried to the next resume;
  - pane: a relaunch on the session at the new settings;
  - the absent reasons.
- [x] Review: two subagents.
- [x] Resolve: disposition findings.
- [x] Verify: adapter tests for a switch and for a relaunch that fails; a live pane check on claude,
  codex and pi.

Done when:

- A live run switches effort, then model, between turns, in a pane and headless, on each harness
  that can.
- The harness's own log agrees with `output.json`.
- The later turn still knows what the first was told.

### 5. The lab names effort

Outcome: every runtime the lab names on a command line can carry an effort, and no lab agent runs at
an effort copied from the operator's config.

Execution:

- [x] Plan: the `harness/model:{effort}` syntax. The suffix after the last `:` is an effort only if
  it is one of the harness's levels; otherwise it stays part of the model, as in a pi model
  ending `:free`.
- [ ] Implement:
  - [x] `runtimeOf` and `runtimeName`, and `draft-key`'s names;
  - [ ] the data repository's contained variants name their effort (an operating step; the
    researcher's, Q5);
  - [ ] then remove `hostReasoningEffort`.
- [x] Review: two subagents.
- [x] Resolve: disposition findings.
- [ ] Verify: lab tests (done); one contained codex trial at `high` logs `high` (waits on the
  variants).

Done when:

- `awf-lab loop --proposer codex/{model}:high` runs its proposer at `high`, and its record says
  so.
- A contained trial's effort comes from its variant, not from the host's codex config.

## Verification

Automated:

- [x] Workflow tests (`engine/src/settings.test.ts`, `workflow-testing.test.ts`,
  `examples/effort/workflow.test.ts`):
  - effort at open, from an alias, over an alias's, and on a fork;
  - `set` runs in order with turns, and a repeated id is harmless;
  - reattach after a `set`;
  - refusals: an unknown level, another harness, the caller, and an absent switch.
- [x] Harness plan tests: each harness's flag at launch and on a resume, and a pane's relaunch
  (`direct-process.test.ts`, `herdr.test.ts`).
- [x] Lab tests: `runtimeOf` with and without an effort, and a model containing `:`; the lab's
  levels match the harnesses' (`tests/effort-levels.test.ts`).
- [x] `bun test`
- [x] `bunx tsc --noEmit`
- [x] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [x] Per harness, headless and in a pane: launch at a level, then `set` another effort and model;
  the harness's own log agrees with `output.json`. `tests/effort.eval.ts` on claude, codex and pi
  (cursor left out: any cursor run on another model rewrites the operator's
  `~/.cursor/cli-config.json`).

## Review record

### Task 1

### Task 1

One subagent checked each claim in the finding against the probes' scripts, their logged output
and the harnesses' own session files, and against the first live eval. About 55 claims supported,
one contradicted, eleven partial; all corrected in the finding:

- pi's `thinkingLevelMap` differs between `gpt-6-luna` and `gpt-5.6-terra`.
- codex's cross-model warning was never seen beside a completed turn.
- claude's `--effort` was shown to beat `--settings`' `effortLevel`, not the user file's
  `modelSettings` shape a typed `/effort` writes.
- The flat cursor ids worked on the three tried, not "every listed model".
- `agent_prompt_stalled` was seen for claude only.
- `--effort ultracode` turns on ultracode mode, not just `xhigh`.
- pi's level without a flag is its last `thinking_level_change` row.
- Two inferences are marked as such.
- claude's relaunch wrote nothing to `settings.json`; `.claude.json` bookkeeping changed.
- pi's `/model` switches directly only within `enabledModels`.
- A pi pane relaunch writes no level rows (from the live eval).

None changes the design: the switches are the relaunch and the resume, which the live eval proved.

### Task 2

Two subagents, architecture/scope and correctness/proof, on the diff before tasks 3–4. No
blockers.

- Effort is recorded but no harness launches with it yet (major): task 2 lands with tasks 3 and 4,
  not alone.
- `set` on the caller untested (major): `workflow-testing.test.ts` refuses it.
- A pane `set` held past a cancelled scope: it now closes the agent and settles `cancelled`.
- An effort that is no string reached the host on an unknown harness: refused everywhere.
- A `set` past its deadline settled at "now": it settles at its deadline, as compaction does.
- A `set` is not a turn in progress: decided, and said where `set` is defined.
- Docs: a reopen's effort constrains only when given; a pane switch that fails *or times out*
  closes the agent; a fork rejects when a `set` before it did not take; the record's alias is the
  one opened through, whose model a `set` may have changed; a headless switch applies whole or not
  at all.
- Tests added: a pane switch past its deadline; a failed headless switch; one past its deadline
  before it runs; a switch before the first turn and before a compaction; an effort of the wrong
  type.
- Kept: `SetRecord` has no `id` or `outcome`. Idempotency is the engine's, and the scripted host
  answers every switch it is asked for. `setHeadless` and `setPane` are provisional: task 4 shapes
  them from M1 and M2.

### Tasks 3–5

Reviewed together, as one diff: architecture/scope and correctness/proof subagents. No blockers.

- A pane relaunch could drop the session's last turn (major): it waits, as a fork does, until the
  usage reader sees the session written.
- `CLAUDE_CODE_EFFORT_LEVEL` beats `--effort` (major): a harness's `settingsEnv` names such
  variables, and every agent is launched without them.
- The story described the dropped design (major): corrected, with Q6.
- A relaunch reused the closed agent's Herdr name: it takes a new one.
- A forked pi pane could relaunch on its parent's session, the id Herdr reports: a session named by
  its file keeps that name.
- A codex pane whose turn never found its session refused `set`, which closes the agent: it looks
  again first.
- A headless codex compaction ran at codex's default effort: it takes the agent's.
- The eval's pi check took `xhigh` for `high`, and claude's switch to haiku, which takes no effort,
  proved none: exact words, and claude switches to opus.
- `draft-key` named graders without their effort; the stopgap's comment was false; the lab's copy
  of the levels was unlisted and could drift: fixed, listed in `adding-a-harness.md`, and pinned by
  `tests/effort-levels.test.ts`.
- Kept: pi's rpc fork passes no `--thinking`, and codex's fork no effort; neither asks the model.
- Not built: adapter tests for a pane `set` in a sandbox, with a turn left finishing, and closed
  mid-relaunch. The code paths are traced, and are those `fork` and every turn take.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design. The measurements still owed are task 1's,
  and they decide only which switches are absent, not the design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled: the contract is
  written out, and Q1–Q5 are decided.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

What changed from the design above, and why:

- **A pane `set` relaunches the harness on its session** (Q6), so `setPane` is a capability marker
  and the herdr adapter does the work: settle, wait for the session to be written, close the tab,
  start the harness again by `interactiveResume` at the new settings, under a new agent name.
- **cursor takes no effort.** Its effort is part of the model id (`gpt-5.6-luna-high`), or a
  parameter whose key differs per model (M3); a variant is chosen as the model. Its headless `set`
  switches the model; its pane `set` is absent, since measuring it rewrites the operator's
  `~/.cursor/cli-config.json` or asks for the keychain.
- **`CLAUDE_EFFORT` never mattered**: claude ignores it, and Sonnet's own default is `medium`.
  `CLAUDE_CODE_EFFORT_LEVEL` does matter, and is withheld through the new `settingsEnv`.
- **codex's levels are per model.** Its definition lists every level of the models awf runs; one a
  model lacks fails its turn at the API, as an unknown model does.
- **`byAgent[].execution`** is the agent's first operation's settings, which a `set` before its
  first turn has already changed.

Known gaps:

- No live check of a sandboxed agent at an effort; the flag is an argument like any other, and a
  sandbox's home has no settings to beat it.
- A cursor `set` is not checked live, for the reason above; M1 measured its resume on another model.
- The settings' `maxEffortLevel` caps claude's effort silently (M4): a host agent recorded at `max`
  can run lower. A claude `settings.json` `env` block, or a pane's login shell rc files, could still
  set `CLAUDE_CODE_EFFORT_LEVEL`; not measured.
- An interactive `claude --resume` of a long session may show a prompt the startup screens don't
  answer; unchecked.
- Task 5's stopgap stays until the data repository's contained variants name their effort.

## Human review

- [x] Every task is complete and story-level verification passes, but for task 5's stopgap, moved
  to [[loop-next]].
- [x] Present the outcome, architecture decisions, task-level subagent findings and dispositions,
  exact verification results, deviations, and remaining risks.
- [x] The operator approved it and asked for it merged and marked done (2026-10-04).
- [x] Marked `done`, and `Stories at a glance` updated.
