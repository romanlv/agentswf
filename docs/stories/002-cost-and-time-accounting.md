---
id: "002"
title: Know what each run cost and how long it took
summary: The engine records time, tokens and cost for every agent in a run, without workflow code, so variants can be compared on price as well as quality.
type: story
status: draft
discovered_in: "catalogue-review quality iteration, 2026-09-23"
depends_on: []
---

# Know what each run cost and how long it took

## Outcome

After a run, the result of `runWorkflow` carries an accounting summary. `awf run` writes it into
`output.json` and prints it. For the run, for each stage and for each agent, it says:

- when each agent's prompt was delivered and when it settled, and the run's wall-clock time;
- tokens, by model, with the part the agent's own subagents spent shown separately;
- whether the agent ran on a subscription, which is already paid for, or was billed per token
  through an API;
- cost, as two separate figures:
  - `charged` is what an API actually billed, and is present only for API billing;
  - `estimate` is what the same tokens cost at list price, naming the price table used;
- how complete the figures are: "usage known for 19 of 21 agents", never a silent zero.

Workflow code does none of this. The engine sees every agent it dispatches, and collects and totals
everything itself. Workflow code is for people to review, and it stays about the workflow.

Why now: the next step is an autoresearch loop over workflow variants such as prompts, models,
verifier limits and samples per lens. It needs a price and a duration for every variant, not just
a quality score. Today a pane run records no tokens at all.

### Why an estimate, not just the charge

On a subscription, nothing is charged per run, so `charged` is empty for every run the loop does
today. Raw token counts cannot be compared across variants either. A sol token costs more than a
terra token, and a cached input token costs about a tenth of an uncached one. The estimate turns
them into one number that means the same thing for every model and harness: what this run would
cost on the API. A plan's allowance is drawn down roughly in proportion to the model's list price,
so the estimate also tracks how much of a subscription a run consumed. That is the reasoning in
`braintrust/agent/loops/shared/usage/price.ts`, and those figures have held up in use.

## Scope

In scope:

- The engine records when each prompt was delivered and when it settled, and the run's start and
  end.
- Each agent's native sessions are discovered, and read once when the run ends.
- Session-file readers for codex, claude and pi, used by both pane and headless runs.
- Billing mode, from how each harness is logged in.
- Estimated cost from a hard-coded, dated price table, computed when the run is summarised, never
  stored in the usage record.
- An accounting summary on the result of `runWorkflow`, written to `output.json` and printed by
  the CLI.
- Removing `usage` from `CatalogueResult`.
- One live run checked against the session files.

Out of scope:

- cursor, which records no usage (foundation §8).
- Subscription rate-limit percentages. They are shared by the whole account and cannot be
  attributed to a run.
- Budgets and spend limits, a ledger across runs, and the autoresearch loop itself.
- Run provenance (pinned commit SHAs, the workflow file's hash). It is a separate todo.

## Context and evidence

### What exists

- Fact: in the last catalogue-review run (21 codex agents on Herdr), no usage record has tokens.
  `paneOutcome` in `packages/harness/src/adapters/herdr.ts` passes the pane's screen text to
  `spec.readUsage`. That function looks for `turn.completed` JSON lines, which only
  `codex exec --json` prints.
- Fact: the runner takes its usage samples at the point where an operation settles
  (`workflow-runner.ts`, the observed-turn branch).
  - When a result is accepted, it releases the turn and uses whatever the release returns.
  - When an operation times out or expires, the samples are `[]`, so the tokens those agents spent
    are never recorded.
- Fact: OpenAI's `input_tokens` includes the cached tokens. Claude's `input_tokens` excludes cache
  reads. Both readers copy the figure straight into `TokenUsage.input`, so summing across harnesses
  counts cached codex tokens twice.
- Fact: foundation §8 has already decided where each part goes:
  - reading the session files goes in `harness/src/usage/`;
  - prices and totals go in `engine/src/accounting/`, pure;
  - the record shape goes in `contract`.

  It also treats pricing as policy, separate from what was observed.
- Fact: foundation §7 says an optimiser calls the engine programmatically, so the summary must come
  from `runWorkflow` and not only from the CLI.

### The proven module: `braintrust/agent/loops/shared/usage/`

This is Claude usage accounting whose figures have held up in use. Its files are `records.ts`,
`price.ts`, `claude.ts`, `recorder.ts` and `store.ts`, with tests. What it settled:

- **Duplicate rows.** One request is logged once per content block, and the earlier lines are
  partial snapshots of a response still streaming. It keys rows by `requestId` and keeps the last
  one.
- **Subagents.** A session that delegates spends most of its budget in its subagent transcripts,
  under `<session id>/`, nested. Reading only the session file under-counts by a third or more. It
  walks that tree, and tags each row `main` or `subagent` from `isSidechain`.
- **Token classes.** It keeps five, never merged: `fresh`, `cacheRead`, `cacheWrite5m`,
  `cacheWrite1h` and `output`. When a write's lifetime is not reported, it counts as the cheaper
  class.
- **Prices.** A rate is `{input, output}` in USD per million tokens, matched by the model id's
  longest prefix. The cache classes are priced as multiples of the input rate: a read is 0.1, a
  5-minute write 1.25 and a 1-hour write 2.
- **Price basis.** Every figure is stored with its `basis`, and figures from two bases are never
  compared.
- **Unpriced models** are listed in `unpriced`, with their tokens still counted. They are never
  priced at zero.
- **Rows it skips:** `<synthetic>` rows, which are API errors, and a half-written last line.
- **Locating the transcript.** It guesses the project directory from the encoded cwd. If the guess
  misses, it scans for the session id instead.
- **Reading whole sessions.** It reads each session whole, rather than a turn at a time, and it
  keeps every session an agent ever had.

### Experiments run on 2026-09-23

These used codex CLI 0.156.1, Claude Code 2.1.280, and the Herdr pane skill, in a scratch
directory.

1. **Codex session id from Herdr.** `agent_session` was `null` after start, after one turn, and
   after two turns. Earlier, one long-lived codex pane did report an id. Herdr cannot be relied on
   to report it.
2. **Codex session id from the agent's environment.** The agent's shell has
   `CODEX_SESSION_ID` and `CODEX_THREAD_ID`, both equal to the rollout's id. Claude's shell has
   `CLAUDE_CODE_SESSION_ID`. The `wf` launcher runs in that shell, so it can report the session to
   the engine on every call.
3. **pi session from Herdr and from the agent's environment.** Herdr's `agent_session` is
   `{kind: "path", value: <session file>}`, and it is there from start. The agent's shell also
   has `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER` and `PI_MODEL`. So the launcher's
   environment variable is one source that works for all three harnesses.
4. **When codex writes its token counts.** In a turn that wrote a file and then answered:
   - the file was written at :55;
   - the `token_count` row covering the work up to that point was at :55.901;
   - the final `token_count` was at :58.059;
   - `task_complete` was at :58.542;
   - Herdr reported the pane idle at :58.760.

   The last request, written 2.2 seconds after the mid-turn "submit", was half of the turn's
   tokens (18,980 of 37,921). Reading at accept loses it. Reading after the pane is idle, or at the
   end of the run, gets it.
5. **Codex totals.** `total_token_usage` rose on every row across two turns, and its input
   includes the cached input. Taking the difference of the totals is sound.
6. **Codex model.** Each turn has a `turn_context` row naming the model, such as `gpt-5.6-terra`.
7. **Billing in the session files.**
   - A Claude transcript does not say it. `service_tier` is `standard` and `userType` is
     `external`, whether or not the account is on a subscription.
   - A codex rollout has `plan_type`, which was `prolite` here.
   - The login commands do say it:
     - `claude auth status --json` gives `authMethod: "claude.ai"` and `subscriptionType`;
     - `codex login status` gives "Logged in using ChatGPT".
   - pi's footer shows `(sub)`.
8. **Headless codex.** `codex exec` saves its session files unless it is run with
   `--ephemeral`, and the harness spec does not pass that flag. One set of session-file readers
   can therefore serve both pane and headless runs.
9. **A failed pi request.** It is logged as an assistant message with `stopReason: "error"` and
   zero usage. Like `<synthetic>`, it is skipped.
10. **pi's usage and cost, checked against the proven table.**
    - A completed two-request turn on `openai-codex/gpt-5.6-terra` logged
      `input 4317, cacheRead 2560, cacheWrite 0, output 55` for the first request, with
      `cost.total 0.009806`.
    - pi's `input` excludes the cached tokens.
    - Its cost matches the proven table exactly: terra at $2 in and $12 out per million tokens,
      with cached input at 0.1 of the input rate.
    - So OpenAI's cached-input multiplier for terra is 0.1, and pi's own `cost` is the same
      list-price estimate, not a charge, even on a subscription.

## Code map

- `packages/contract/src/workflow/agents.ts`: `TurnUsage` and `TokenUsage` are reshaped (see
  Proposed design), and `TurnCost` is removed.
- `packages/contract/src/wire.ts` and `packages/cli-agent/src/client.ts`: a `wf` call carries the
  native session id, when the launcher's environment has one. This is additive.
- `packages/engine/src/agent-launcher.ts`: the launcher passes on the session variable the harness
  names.
- `packages/harness/src/spec.ts`: each harness declares:
  - `sessionEnv`, the environment variable holding its session id;
  - `readSessionUsage(ref)`, which reads its session files;
  - `billing()`, from its login status.

  Stdout parsing remains only for claude headless `total_cost_usd`, which becomes `charged`.
- `packages/harness/src/usage/{claude,codex,pi}.ts` (new): the readers. `claude.ts` is lifted from
  the proven module, with its tests.
- `packages/harness/src/adapters/herdr.ts`: `paneOutcome` stops reading usage from the screen, and
  reports `agent_session` as one more source of session ids.
- `packages/engine/src/workflow-runner.ts`:
  - records the delivery and settle times;
  - collects each agent's session refs;
  - reads usage once, after the body and before the host closes;
  - returns `startedAt`, `finishedAt` and `accounting`.
- `packages/engine/src/accounting/{prices,summary}.ts` (new): lifted from the proven `price.ts`, and
  `records.ts` (`costOf`, `summarize`). `recorder.ts` and `store.ts` are for sessions read over and
  over across many passes, which a single run does not need.
- `packages/engine/src/operator-cli.ts`: prints the summary lines. `output.json` gets `accounting`
  from the result.
- `examples/catalogue-review/workflow.ts`: drop `usage` from `CatalogueResult`, and the
  `ctx.usage()` call.

## Proposed design

**Records.** The contract records only what was observed. Prices are applied when the run is
summarised, so a run can be re-priced later with a different table.

```ts
type TurnUsage = {
  callPath: string[]; agent: AgentKey; operationId: string; execution: AgentExecution;
  deliveredAt?: string; settledAt?: string;          // ISO, engine clock
  sessions: { harness: string; id: string }[];       // every native session seen for this agent
  billing: "subscription" | "api" | "unknown";
  spend?: { model: string; delegated: boolean; tokens: TokenUsage }[]; // absent means unknown
  charged?: Money;                                   // only what an API billed
};

type TokenUsage = {
  input: number;      // uncached input only
  cacheRead: number;
  cacheWrite: number; // all cache writes
  cacheWrite1h?: number; // the part of cacheWrite with a one-hour lifetime, where reported
  output: number;     // includes reasoning
  reasoning?: number; // part of output
};
```

**Sessions.** The engine collects each agent's session refs from every source it has:

- the id the `wf` launcher reports from the harness's `sessionEnv`: `CODEX_SESSION_ID`,
  `CLAUDE_CODE_SESSION_ID` or `PI_SESSION_ID`. This is the main source for all three;
- Herdr's `agent_session` when it has one. For pi it is the session file's path;
- the headless stdout, as today.

Every ref is kept. A claude `/clear` or a replaced pane adds a session, and does not replace one.

**Reading.** Usage is read once, after the workflow body returns and before the host closes its
panes. By then an answered agent has finished its turn: experiment 4 showed the final count is
written before the pane goes idle. Reading at the end also counts agents that timed out or failed,
whose spend the current design never records. An agent with several turns is split between its
operations by the timestamp on each record. A turn cut off when its pane closes loses at most its
last request. The live check in Task 5 measures how often that happens.

- **claude:** the proven reader, as it is.
- **codex:** for each session, the final `total_token_usage` minus the value at the start of the
  operation's window. `input` is `input_tokens` minus `cached_input_tokens`. The model comes from
  `turn_context`.
- **pi:** each assistant message's usage. Error rows are skipped. pi does not report a
  cache-write lifetime, so `cacheWrite1h` is left out.

**Billing.** Billing is read once per run for each harness that was used, from `billing()`:

- claude: `claude auth status --json`;
- codex: `codex login status`, confirmed by the rollout's `plan_type`;
- pi: its provider configuration.

It is `unknown` when neither says.

**Prices.** `engine/src/accounting/prices.ts` follows the proven `price.ts`:

- rates are `{input, output}` per model family, matched by longest prefix;
- the cache multipliers are set per provider, since OpenAI's cached-input discount is its own
  figure;
- a `basis` string names the table and its date;
- models it cannot price go in `unpriced`.

The rates are hard-coded. An agent looks them up online and cites the source URL.

**Summary.** `accounting/summary.ts` takes `TurnUsage[]`, the prices and the run's times, and
returns:

- `basis`;
- totals;
- `byStage`, keyed by `callPath` and the agent-key prefix;
- `byModel`;
- `agents`;
- `unpriced`;
- `known`, how many agents have usage and how many were priced;
- `wallMs`;
- `agentMs`.

`runWorkflow` returns it as `accounting`. The CLI prints it:

```
21 agents · 14m 05s · 3.24M tokens (2.91M cached) · ~$4.10 at list prices (2026-09) · subscription · usage known 21/21
  lens      12 agents · 9m 40s · ~$2.80
  verifier   9 agents · 4m 10s · ~$1.30
```

Alternatives rejected:

- **Read usage when each operation settles.** Experiment 4 shows it loses the last request, and
  timed-out agents record nothing.
- **Store the estimate on each `TurnUsage`.** That puts pricing policy in the published record, and
  a run could not be re-priced later.
- **One `tokens` field per agent.** It cannot be priced when the agent's subagents use another
  model.
- **Find codex sessions by cwd and time.** All of a run's agents share one cwd, so this cannot tell
  them apart.
- **Build the summary in the CLI.** An optimiser that calls `runWorkflow` would not get it.
- **Parse the pane screen.** It is lossy.
- **Report rate-limit percentages.** They are shared by the whole account.

## Tasks at a glance

- [ ] 1. Times and session refs on each `TurnUsage`; the launcher reports sessions; the workflow drops `usage`
- [ ] 2. Session-file readers for claude, codex and pi, with billing
- [ ] 3. Read usage when the run ends, and split it between operations
- [ ] 4. Prices and the summary, returned by `runWorkflow` and printed by the CLI
- [ ] 5. Check one live run against the session files

## Open questions

These are experiments to run, not questions for the user.

### 2. Readers

- **claude `/clear`.** Check that a claude pane's `CLAUDE_CODE_SESSION_ID` changes after
  `/clear`, and that the next `wf` call reports the new id. Use one short haiku pane.

### 3. Reading when the run ends

- **Released turns.** When the engine releases a turn after accepting its result, is the agent
  interrupted, or does it finish? Run one codex pane and compare the rollout's final
  `token_count` with the release time. If it is interrupted, wait for the pane to go idle, within
  a few seconds, before closing it.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

Each task follows the same checklist:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

### 1. Times and session refs on each `TurnUsage`; the launcher reports sessions; the workflow drops `usage`

Work:

- Reshape `TurnUsage` and `TokenUsage`, and remove `TurnCost`.
- Stamp `deliveredAt` and `settledAt`.
- Add `sessionEnv` to the harness specs.
- Have the launcher pass the session id on, and add the optional wire field.
- Have Herdr's `agent_session` feed the same set of refs.
- Remove `usage` from `CatalogueResult`.

Done when:

- With a fake clock, runner tests show that:
  - a nudged operation spans both attempts;
  - a timed-out one settles at its deadline.
- A control-plane test shows a `wf` call's session id landing on the agent's refs, and two ids
  both kept.
- The catalogue-review tests pass without `usage`.

### 2. Session-file readers for claude, codex and pi, with billing

Work:

- Lift the proven `claude.ts` and its tests.
- Add the codex and pi readers, producing the same record shape.
- Add `billing()` for each harness.
- Make headless runs use the same readers.

Done when:

- Tests against trimmed real session files show:
  - claude: the proven tests pass as ported;
  - codex: the difference of totals over two turns, `input` without the cached part, and the
    model taken from `turn_context`;
  - pi: error rows skipped;
  - a missing file gives `undefined`;
  - a half-written last line is ignored.
- A billing test covers parsing each login status output.

### 3. Read usage when the run ends, and split it between operations

Work:

- Run the released-turns experiment first.
- After the body returns, read every agent's sessions before the host closes.
- Split the records by operation window.
- Record agents without usage as unknown.

Done when:

- Runner tests with a fake reader show that:
  - a timed-out agent's spend is counted;
  - an agent with two operations is split by time;
  - an agent without refs is unknown, not zero.

### 4. Prices and the summary, returned by `runWorkflow` and printed by the CLI

Work:

- Lift `costOf`, `summarize` and the price table, and make the cache multipliers per provider.
- Enter the current rates, with source URLs.
- Add `summary.ts`, return `accounting` from `runWorkflow`, and print it in the CLI.

Done when:

- The proven `records.test.ts` cases pass as ported.
- Codex cached input is priced at OpenAI's rate.
- A partial run shows `known` below the total and no zeros.
- The operator-cli test checks the printed lines and `output.json`.

### 5. Check one live run against the session files

Work:

- Run catalogue-review with every lens, on codex terra and sol.
- Run one short claude agent and one short pi agent.
- Have a subagent recompute each agent's tokens from the session files and compare them with
  `output.json`.

Done when:

- Tokens match for every agent.
- Wall time agrees within a second.
- Every agent reported unknown, and every turn cut off, is explained.

## Verification

- [ ] Focused tests named under each task.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`
- [ ] Task 5: one catalogue-review run on the codex subscription, about 21 agents, plus two short
  agents.

## Review record

### Design review, 2026-09-23

These findings came from the design review, and the proposal above already includes them:

- Reading at settle loses the last request, and all spend by timed-out agents.
- One token total per agent cannot be priced when models are mixed.
- The estimate on the contract record fixes the price table for good.
- The summary must come from `runWorkflow`, for programmatic callers.
- There should be one reader path for pane and headless runs.
- An agent can have several sessions.
- Billing comes from login status, not transcripts.
- The start time should be the delivery time, not the dispatch time.
- Stages are keyed by `callPath`.
- Cache-write lifetimes are optional detail in the contract, not separate required classes.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design, with experiments 1 to 9.
- [x] Expensive interface, record-format, and stage-gate decisions are settled. The user approved
  the `TurnUsage` reshape, the removal of `TurnCost` and the additive wire field on 2026-09-23.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are experiments placed inside the tasks they gate.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
