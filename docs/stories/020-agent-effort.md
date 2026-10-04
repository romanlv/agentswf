---
id: "020"
title: An agent runs at the effort and model its workflow sets, and switches them mid-run
summary: "A workflow opens an agent at a reasoning effort, as at a model, and can switch either later in the same session with `set`; each harness is launched or switched by its own flag or command, a harness that cannot is refused with its reason, and every operation records the settings it ran at."
type: story
status: draft
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
  - headless claude took `CLAUDE_EFFORT=medium` from the Claude Code session that launched
    `awf-lab`;
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
                                  harness's levels                cursor  --model '{m}[effort=high]'

agent.set({                       queued like compact; from here  headless: the next resume carries
  effort: "low" })           ──▶  on the agent's execution says   the new flags. pane: the harness's
                                  "low", and so does each later   own command, confirmed on screen
                                  operation's record
```

- **At open.** An agent's effort is chosen with its runtime when it is opened, as its placement
  is; an alias names none (Q1). If none is named, awf passes no effort and the harness uses its
  default (Q2).
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

- `effort` on the runtime an agent is opened with, with or without an alias, and on a fork.
- `AgentRef.set({ model?, effort? })`, headless and in a pane, on claude, codex, pi and cursor where
  each can; refused with its reason where it can't.
- Launching each harness at an effort, headless and in a pane, on the host and in a sandbox.
- Recording effort on every operation and agent in `output.json`.
- Withholding `CLAUDE_EFFORT` from agents, like the other calling-session variables.
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
  | cursor | 2026.10.01 | none; a parameterised model takes `--model '{m}[effort=high]'` |

- Fact: a Claude Code session exports `CLAUDE_EFFORT` to the commands it runs (`medium` in the
  session that drafted this story). `CLAUDE.callingSessionEnv` in
  `packages/harness/src/harnesses/claude.ts` doesn't list it, so every claude agent awf starts from
  such a session inherits it.
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
  - `AgentChoice` is new: `PlacementChoice` and `effort?`. `ExecutionConfig`,
    `ExecutionRequirements` and `AgentForkSpec` take it in place of `PlacementChoice`, so
    `AgentExecution` gains `effort`. `RuntimeTarget` is unchanged (Q1).
  - `SettingsSpec` and `AgentRef.set` are new.
  - `AgentRef.execution` becomes the agent's current settings.
  - `OperationRecord` needs no new field.
- `src/records.ts`: `byAgent[].execution` carries effort with no change; it holds the opened
  settings.

### `packages/harness`

- `src/harnesses/define.ts`:
  - `TurnContext` gains `effort`.
  - `interactive` and `interactiveResume` take it.
  - A required `effort` field lists the harness's levels, or is `Absent` with a reason.
  - A new optional `setPane` capability switches a pane's model and effort, shaped like
    `compactPane`: the text to type, and the screen that confirms it.
- `src/harnesses/{claude,codex,pi,cursor}.ts`: each launch and resume plan adds the harness's flag.
  For cursor, the plan rewrites `--model` instead.
- `src/adapter.ts`: `HarnessSession` gains `set?(settings, deadline)`, beside `compact`. Absent
  means the host can't switch.
- `src/adapters/direct-process.ts`: a `set` updates the settings that the next resume's plan is
  built from.
- `src/adapters/herdr.ts`:
  - a `set` types the switch and waits for its screen;
  - a pane relaunched on its session (`interactiveResume`) launches at the current settings.
- `CLAUDE.callingSessionEnv`: add `CLAUDE_EFFORT`.

### `packages/engine`

- `src/workflow-runner.ts`:
  - the agent's `effort` is added after `resolveAlias`, as `placement` is; `resolveAlias` is
    unchanged (Q1);
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

/** The agent's own choices beside where it runs; an alias names none of them (Q1). */
export type AgentChoice = PlacementChoice & {
  /** Absent, awf passes none and the harness uses its default (Q2). */
  effort?: Effort;
};

// RuntimeTarget, what an alias names, stays { harness, model }.
export type ExecutionConfig = RuntimeTarget & AgentChoice;

export type ExecutionRequirements = AgentChoice & {
  alias: RuntimeAliasName;
  harness?: HarnessKind;
  model?: string;
};

export interface AgentForkSpec extends AgentChoice {
  key: AgentKey;
  instructions?: string;
  labels?: JsonObject;
  // effort, from AgentChoice: absent, the fork takes its parent's current effort, as it takes
  // its current model.
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
- **In a pane**, `set` types the harness's own command and is answered when the screen confirms it.

Invariants:

- An operation records only the settings awf launched it at or switched it to.
- An effort the harness doesn't list is refused at `open`, `fork` or `set` before any process
  starts, and the refusal quotes the harness's levels.
- A `set` the harness can't do is refused with the definition's absent reason. It never silently
  leaves the old settings in force.
- A pane `set` whose confirmation never shows settles `failed`, and nobody knows the agent's
  settings any more. The agent is closed, as after any failed turn, so nothing later runs at
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

- [ ] 1. Measure each harness: effort levels; effort and model at launch and on a resume; the pane
  commands and the screens that confirm them; precedence over config
- [ ] 2. Add `effort` and `set` to the contract, the engine and the testing host; refuse what a
  harness doesn't list
- [ ] 3. Each harness launches at its agent's effort, headless and in a pane; `CLAUDE_EFFORT`
  withheld
- [ ] 4. `set` switches model and effort mid-session, headless and in a pane, where the harness can
- [ ] 5. The lab names effort wherever it names a runtime; the stopgap is removed

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

Decisions for the operator. Q1 is open; Q2–Q5 are decided and kept so their reasons stay with them.

### Open

- **Q1. Can an alias carry an effort, or is effort only the agent's own?** Blocks task 2.
  - What an alias is today: a name for a harness and a model. `awf run` installs two,
    `claude` (claude, `sonnet`) and `codex` (codex, `gpt-5.6-sol`). Operators can't define their
    own; only a workflow's test can add some (`runtimes`).
  - How the fields behave today when a workflow opens `runtime: { alias: "codex", … }`:
    - `model` belongs to the alias. `{ alias: "codex", model: "o4" }` is refused, because the alias
      says another model.
    - `placement` belongs to the agent. The alias names none, and `{ alias: "codex", placement:
      "headless" }` simply adds it.
  - The question is which of the two effort is like.
    - **(a) The agent's own, like `placement`** (recommended). Aliases never name an effort, and
      a workflow writes `{ alias: "codex", effort: "high" }` to get codex's model at `high`. No
      conflict can arise, since only one side ever names it. In the contract, `effort` sits beside
      `placement`, not in `RuntimeTarget`, which stays harness and model.
    - **(b) Part of the alias, like `model`.** An alias could say `deep = claude, opus, high`. A
      workflow that wants another effort needs another alias, and `{ alias: "deep", effort: "low" }`
      is either refused or overrides the alias, which needs a rule of its own.
  - Why (a): Q2 already says the installed aliases name no effort, and nobody else can define an
    alias. (b) would add a field to `RuntimeTarget` that no real alias uses. (a) can grow into (b)
    later without breaking anything, if operators ever get aliases of their own.
  - The contract below is written for (a).

### Decided

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

- [ ] Plan: list each probe and the cheapest model it can run on.
- [ ] Implement: run the probes and record the commands, versions and output in the finding.
- [ ] Review: one subagent checks each claim in the finding against its probe's output.
- [ ] Resolve: disposition every gap; a switch that can't be shown working is absent.
- [ ] Verify: every row of the finding's table is measured or marked unknown.

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

- [ ] Plan: confirm Q1 is settled; map the reattach change to opened and current settings.
- [ ] Implement:
  - the contract as in "The contract";
  - in the engine: effort added after the alias, `set` queued like `compact`, level checks, the
    opened settings kept for reattach;
  - `set` on the testing host.
- [ ] Review: architecture/scope and correctness/proof subagents on the diff.
- [ ] Resolve: disposition findings.
- [ ] Verify: focused workflow tests; `bun test`, `bunx tsc --noEmit`, boundaries.

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

- [ ] Plan: per-harness flags and levels from task 1's finding.
- [ ] Implement:
  - each harness definition's `effort`;
  - the launch and resume plans;
  - `CLAUDE_EFFORT` in `callingSessionEnv`;
  - `adding-a-harness.md`.
- [ ] Review: two subagents.
- [ ] Resolve: disposition findings.
- [ ] Verify: plan tests per harness; a cheap live check per harness reads the effort back.

Done when:

- A live run of each harness, headless and in a pane, logs the effort it was given.
- A claude agent started from a Claude Code session no longer sees `CLAUDE_EFFORT`.

### 4. `set` switches the session

Outcome: `set` switches model and effort in the agent's session, which keeps its context, headless
and in a pane. A harness that can't is refused with its reason.

Execution:

- [ ] Plan: the shape of `setPane` and `HarnessSession.set`, from task 1's screens (M1, M2).
- [ ] Implement:
  - headless: the settings carried to the next resume;
  - pane: the switch and its confirmation, and a relaunch at the current settings;
  - the absent reasons.
- [ ] Review: two subagents.
- [ ] Resolve: disposition findings.
- [ ] Verify: adapter tests for a switch and for a confirmation that never shows; a live pane check
  on claude and codex.

Done when:

- A live run switches effort, then model, between turns, in a pane and headless, on each harness
  that can.
- The harness's own log agrees with `output.json`.
- The later turn still knows what the first was told.

### 5. The lab names effort

Outcome: every runtime the lab names on a command line can carry an effort, and no lab agent runs at
an effort copied from the operator's config.

Execution:

- [ ] Plan: the `harness/model:{effort}` syntax. The suffix after the last `:` is an effort only if
  it is one of the harness's levels; otherwise it stays part of the model, as in a pi model
  ending `:free`.
- [ ] Implement:
  - `runtimeOf` and `runtimeName`;
  - the data repository's contained variants name their effort (an operating step);
  - then remove `hostReasoningEffort`.
- [ ] Review: two subagents.
- [ ] Resolve: disposition findings.
- [ ] Verify: lab tests; one contained codex trial at `high` logs `high`.

Done when:

- `awf-lab loop --proposer codex/{model}:high` runs its proposer at `high`, and its record says
  so.
- A contained trial's effort comes from its variant, not from the host's codex config.

## Verification

Automated:

- [ ] Workflow tests:
  - effort at open, with an alias and without, and on a fork;
  - `set` runs in order with turns, and a repeated id is harmless;
  - reattach after a `set`;
  - refusals: an unknown level, another harness, the caller, and an absent switch.
- [ ] Harness plan tests: each harness's flag at launch and on a resume.
- [ ] Lab tests: `runtimeOf` with and without an effort, and a model containing `:`.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] Per harness, headless and in a pane: launch at a level, then `set` another effort and model;
  the harness's own log agrees with `output.json`. Cheap models, a few cents a harness.

## Review record

### Task 1

### Task 2

### Task 3

### Task 4

### Task 5

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design. The measurements still owed are task 1's,
  and they decide only which switches are absent, not the design.
- [ ] Expensive interface, record-format, and stage-gate decisions are settled: the contract is
  written out; Q1 is open.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope: Q1 is open.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
