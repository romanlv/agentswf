---
id: "002"
title: Know what each run cost and how long it took
summary: The engine records time, tokens and cost for every agent in a run, without workflow code, so variants can be compared on price as well as quality.
type: story
status: done
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
verifier limits and samples per lens, built in this repository
([ADR 0002](../adr/0002-autoresearch-lives-here.md)). It needs a price and a duration for every
variant, not just a quality score. Today a pane run records no tokens at all.

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

11. **claude `/clear`**, in a haiku pane. Before it, `CLAUDE_CODE_SESSION_ID` and Herdr's
    `agent_session` (`kind: "id"`) were `ee2b9b84…`; after it, both were `5eaa0d2e…`, and the
    project directory held one transcript for each. A cleared agent has two sessions, both read.
12. **Codex subagents.** A spawned subagent writes a rollout of its own. Its `session_meta` names
    the root session in `session_id` and its parent in `parent_thread_id`. Delegated codex spend is
    found by scanning the run's date directories for rollouts whose `session_id` is the agent's.
13. **Codex per-response rows.** CLI 0.156 also writes `token_usage_record` rows, one per
    response, each with its own usage. Older rollouts lack them, while every version has
    `token_count`, so the reader keeps to differences of `total_token_usage`. `total_tokens` is
    `input_tokens + output_tokens`, so `output_tokens` includes reasoning.

14. **Released turns**, in one codex terra agent run through `runWorkflow` on the Herdr host.
    - The result was accepted at 18:05:14.860, and `runWorkflow` returned at 18:05:14.925, with
      the agent's tab and the run workspace closed.
    - The rollout kept growing after that. Its last `token_count` was at 18:05:16.473 and
      `task_complete` at 18:05:16.811. That last request was 19,503 of the turn's 112,490 tokens.
    - The launcher's `--session` reported the rollout's id, so experiment 2 holds through a live
      `wf` call.
    - So a released turn is not cut off, but its last request lands up to seconds after the run
      body returns. Task 3 reads after the host closes, and waits until the figures stop moving.

## Code map

- `packages/contract/src/workflow/agents.ts`: `TurnUsage` and `TokenUsage` are reshaped (see
  Proposed design), and `TurnCost` is removed.
- `packages/contract/src/wire.ts` and `packages/wf/src/client.ts`: a `wf` call carries the
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

**Billing.** Billing is read once per run for each harness, model and provider that was used,
from `billing()`:

- claude in a pane: `claude auth status --json`. Headless `claude -p` is `api` whatever the login
  (E3, foundation §2);
- codex: `codex login status`;
- pi: the credential its `auth.json` holds for the provider it logged.

It is `unknown` when none of these says.

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

- [x] 1. Times and session refs on each `TurnUsage`; the launcher reports sessions; the workflow drops `usage`
- [x] 2. Session-file readers for claude, codex and pi, with billing
- [x] 3. Read usage when the run ends, and split it between operations
- [x] 4. Prices and the summary, returned by `runWorkflow` and printed by the CLI
- [x] 5. Check one live run against the session files

## Open questions

These are experiments to run, not questions for the user.

### 3. Reading when the run ends

- **Codex agents that never call `wf`.** A codex agent's session id reaches the engine only
  through `wf` (experiment 1), so one that times out before calling it has no ref and its spend is
  unknown. Task 5 counts how often this happens. If it matters, the prompt carries the operation
  id, which is unique, so the rollout that contains it can be found.

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

Plan (Gate 1, 2026-09-23):

- **Contract.** `TurnUsage` and `TokenUsage` take the shapes under Proposed design; `TurnCost`
  goes and `Money = {amount, currency}` replaces it for `charged`. `billing` is `unknown` until
  Task 2 reads it, and `spend` stays absent until Task 3 reads it. A record handed to workflow
  code at settle has times and sessions but no spend: spend is only known when the run ends.
- **Times.** `deliveredAt` is when the harness accepted the operation's first attempt, which
  excludes time spent queued behind the agent's earlier work. `settledAt` is when the operation
  finished, after any nudge. An operation that expired settles at its deadline, not at the moment
  the engine noticed.
- **Launcher.** `spec.ts` gains `sessionEnv` for claude, codex and pi, and `sessionEnvOf(harness)`
  for callers that hold only a name (`fake` has none). The engine writes the variable into the
  launcher script, `--session "${CODEX_SESSION_ID:-}"`, so the shell of the agent's own tool call
  expands it. `wf` passes a non-empty value on as the optional wire field `session`.
- **Control plane.** `openChannel(agentId, onSession)` reports every `session` a request carries,
  before the result is judged: a rejected submission still proves the session.
- **Adapter refs.** `HarnessSession.sessions?()` returns every native session id the adapter has
  seen. `session-core` collects `sessionRef` from every outcome, not only completed ones, so
  Herdr's `agent_session` and headless stdout both feed it. The single-session host passes it
  through. It is optional because the fake has nothing to report.
- **Runner.** Each agent keeps one set of launcher ids. A record's `sessions` is that set joined
  with `session.sessions()`, de-duplicated, with the agent's harness. Pi's pane ref is a file path
  and its launcher ref an id; both are kept here, and Task 2's reader resolves them to one file.
- **Examples.** `usage` goes from all three example results, not only `CatalogueResult`: once
  Task 3 reads spend at the end, a copy taken inside the workflow would disagree with the run's.
- **Proof.** Real time with recorded bounds, rather than a fake clock that would also move the
  deadlines: the fake adapter records when it ran each attempt, and the test checks the stamps
  bracket both. The timeout test checks `settledAt` equals the deadline exactly.
- **Rejected.** A `delivered` promise on `HarnessTurn`, stamped when a pane shows the prompt. It
  would move pane start-up out of agent time, but it is one more adapter obligation, and start-up
  is time the variant really costs.

Done when:

- Runner tests, with times bounded by what the fake adapter recorded, show that:
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

Plan (Gate 1, 2026-09-23):

- **Record.** Every reader returns `UsageRecord[] | undefined`, one record per request:
  `{at, model, delegated, tokens: TokenUsage}`, where `at` is the ISO time the harness logged it,
  for Task 3 to split on. `undefined` means none of the agent's sessions could be found. It is
  never an empty list standing in for "unknown".
- **One call per agent.** `spec.readSessionUsage(ids, cwd)` takes every id the agent had. The
  reader resolves them to files and removes duplicates by path, because a pi pane reports a path
  and its `wf` reports an id for the same file. Claude keeps the last row for each `requestId`
  across all the files, as the proven reader does.
- **Ids are not trusted.** An id is matched against file names inside the harness's own
  directory, and only `[A-Za-z0-9._-]` is accepted. A pi ref may also be an absolute path, used
  only if it lies inside pi's sessions directory.
- **claude** (`usage/claude.ts`): the proven reader, reshaped into `TokenUsage`:
  - `input` is `input_tokens`;
  - `cacheWrite` is `cache_creation_input_tokens`, and `cacheWrite1h` is the one-hour part when
    the breakdown is present;
  - `delegated` is `isSidechain`;
  - the root is `$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects` by default.
- **codex** (`usage/codex.ts`): a root rollout is found as `rollout-*-<id>.jsonl` under
  `$CODEX_HOME/sessions` (default `~/.codex/sessions`).
  - Subagent rollouts are found by the root's id in their `session_meta.session_id`, scanning only
    the day directories from the root's date onward. They are `delegated` (experiment 12).
  - Each `token_count` row whose `total_token_usage` rose gives one record: the difference, at
    that row's time, under the model of the latest `turn_context`. A total that falls is a reset
    and counts from zero.
  - `input` is `input_tokens − cached_input_tokens`, and `cacheWrite` is
    `cache_write_input_tokens`, which is zero on OpenAI. `reasoning` is
    `reasoning_output_tokens`.
- **pi** (`usage/pi.ts`): each assistant message with usage, skipping `stopReason: "error"` and
  de-duplicated by the row's `id`.
  - `input`, `cacheRead`, `cacheWrite`, `output` and `reasoning` are copied as they are.
  - `cacheWrite1h` is absent.
  - The model is `message.model`; the provider is not part of the model name.
- **Billing** (`usage/billing.ts`): pure parsers, and `spec.billing(model)`, which runs the
  command with a short timeout and returns `unknown` on any failure.
  - claude: `claude auth status --json` gives `authMethod: "claude.ai"`, which is a subscription;
    any other method while logged in is `api`.
  - codex: `codex login status` says "ChatGPT" for a subscription and "API key" for `api`.
  - pi: the provider comes from the model (`provider/model`) or `defaultProvider` in
    `settings.json`. In `auth.json`, a provider entry of type `oauth` is a subscription and
    `api_key` is `api`.
- **Headless.** No reader change is needed. A headless turn's session id already reaches
  `sessions()` from stdout, and the engine reads the same files. `readUsage` on stdout stays as it
  is, because the frozen experiments read it. The engine takes only `costUsd` from it, and only
  for `api` billing.
- **Fixtures.** Trimmed from real files under `packages/harness/src/usage/fixtures/`. Every id
  and cwd is replaced, and message text is dropped.
- **Rejected.**
  - Codex `token_usage_record` rows. They are per response and name the turn, but older CLIs do
    not write them (experiment 13).
  - Matching sessions by cwd and time. All of a run's agents share one cwd.

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

Plan (Gate 1, 2026-09-23):

- **Where the readers come from.** From `runtime.host.accounting`, which Task 2 put on the host
  factory, because how an agent is launched decides who pays.
  - The Herdr host provides one.
  - A host without one reads nothing: every record keeps `billing: "unknown"` and no `spend`.
  - The runner never reaches into the harness table for readers.
- **When.** The runner reads after the workflow body returns and the host has closed, not before
  the host closes as the design first said. Experiment 14 shows a released codex turn writes its
  last request 1.6 s after `runWorkflow` would have returned.
  - Every agent's sessions are read. A read also says whether a session's turn is still open. Only
    codex reports one: `task_started` without a later `task_complete` or `turn_aborted`.
    - Codex was seen finishing a turn after its tab closed (experiment 14).
    - Claude writes nothing once its pane closes. Every awf-launched claude session ends on its
      `wf result` call.
    - pi runs headless, and its process has ended by the time the run does.
    - A cut-off turn from either of those would never close, so reporting it open would only cost
      `stalledMs` on every run.
  - While any turn is open, the sessions are read again every `pollMs` (1 s). This stops when the
    turn closes, when the reads stop changing for `stalledMs` (10 s: a pane closed mid-turn stays
    open for good), after a 20 s grace, or when the run is stopped.
  - The harness sets both intervals; `SessionAccounting` carries them.
  - Whatever the last read found is kept. Task 5 measures how often a read is cut short.
- **Whose records.** Each logical agent registers its execution, cwd and live session set with the
  owner. Its sessions are the launcher's ids plus `session.sessions()`, as in Task 1. An agent with
  no sessions is not read.
- **Splitting.** Records are de-duplicated run-wide by harness and `key`, the first agent to report
  one keeping it. Records from before the run started are dropped: a resumed session carries old
  requests. An agent's operations are ordered by `deliveredAt`.
  - Operation n owns `[deliveredAt(n), deliveredAt(n+1))`, and the last runs to the end.
  - A record logged before the first delivery belongs to the first operation, and so does every
    record when no operation was delivered: a share never drops one.
  - A claude record's `at` is when its request ended. A request that spans a delivery counts
    toward the operation in which it ended.
  - An operation never delivered has `spend: []`: it is known to have cost nothing.
  - An agent whose read gave `undefined` leaves every one of its operations without `spend`.
  - `spend` groups the records by model and `delegated`, summing each token class.
- **Billing and charge.** `accounting.billing(execution, records)` is asked once per agent per
  run, concurrently, with every record the agent kept. `charged` is the operation's `costUsd` samples, only when billing is
  `api`. The runner keeps those samples beside the record until then.
- **Final records.** Each record's `sessions` becomes the agent's full set when the run ends.
  `WorkflowRunResult.usage` returns these final records. Records handed to workflow code during
  the run keep what they had.
- **Out of reach.** A workflow that throws has no result to carry its spend, so nothing is read
  for it. Returning spend from a failed run is story [003](003-failed-run-accounting.md).
- **Best effort.** A read that throws, overruns the grace, or is stopped leaves the records as they
  were at settle, with the agent's final sessions. The run's result stands.
- **For Task 4.** `finishedAt` is taken after cleanup and before the read, so `wallMs` does not
  include the wait for session files.
- **Proof.** Runner tests with a fake `SessionAccounting`:
  - a timed-out agent's spend is counted;
  - two operations of one agent are split at the second delivery;
  - an agent with no sessions, or a read giving `undefined`, has no `spend`, while a delivered
    operation with no records has `[]`;
  - a record that appears after the first read is picked up by the quiet re-read;
  - a request two agents both report is counted once;
  - `charged` appears only under `api`.

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

Plan (Gate 1, 2026-09-23):

- **Prices** (`accounting/prices.ts`). A rate is USD per million tokens for every class: `input`,
  `output`, `cacheRead`, `cacheWrite5m` and `cacheWrite1h`. The rates are matched by the model id's
  longest prefix, as in the proven `price.ts`.
  - Cache multipliers are set per model, not per provider. Anthropic now discounts cache reads
    differently for some models: 0.05× on Opus 5.5 and 0.025× on Fable 5.1.
  - Two helpers fill in the classes:
    - `anthropic(input, output, read = 0.1)`: writes at 1.25× and 2×.
    - `openai(input, cached, output, write = 1.25 × input)`: gpt-5.5 and gpt-5.4 list no write
      charge.
  - A model is priced only as itself: its family id, the id followed by a release date, or either
    with a context tag such as `[1m]`. A sibling such as `claude-opus-5-6` or `gpt-5.5-pro` is
    unpriced and named, never priced at another model's rate.
  - `basis` names the table and its date. `PUBLISHED_PRICES` carries the rates as of 2026-09-23,
    with their sources:
    - https://platform.claude.com/docs/en/about-claude/pricing
    - https://developers.openai.com/api/docs/pricing
  - The proven table is out of date: Sonnet 5 is now $2 in and $10 out, and gpt-5.6-sol is $4 in
    and $20 out. OpenAI's long-context rates are not modelled, so a very long codex session is
    under-estimated.
- **Cost** (`costOf(tokens, rate)`). The `cacheWrite1h` part is priced at the one-hour rate, and
  the rest of `cacheWrite` at the five-minute rate. `reasoning` is part of `output` and is not
  priced a second time.
- **Summary** (`accounting/summary.ts`). `summarizeRun(usage, prices, {startedAt, finishedAt})`
  is pure, so a run can be re-priced from its `output.json`. It returns:
  - `basis`, `startedAt`, `finishedAt`, `wallMs`;
  - `totals`, and one entry each in `byStage` and `byAgent`. Each has:
    - `agents`: a count;
    - `agentMs`: the sum of `settledAt − deliveredAt` over operations;
    - `tokens`, and `delegated`, the part of the tokens spent by subagents;
    - `estimate`: USD over the priced tokens. An agent known to have spent nothing counts as 0.
      The field is absent only when no agent's usage was both known and priced, so it is never a
      zero standing in for unknown;
    - `charged`: USD, where an API billed;
    - `known`: how many agents have usage;
    - `priced`: how many agents have all their usage priced.
  - A stage is the `callPath` plus the agent key's prefix before `:`, joined with `/`. For example,
    `lens:database` is in stage `lens`.
  - Each `byStage` entry also has `spanMs`, from its first delivery to its last settle.
  - `byModel` has only `agents`, `tokens`, `delegated` and `estimate`. A charge or an operation's
    time cannot be split between the models it used.
  - An agent is its key within its call path.
  - `billing` is the one mode every agent with a known billing shares, `mixed` when they differ,
    and `unknown` when none is known.
  - `unpriced` lists the models the table has no rate for.
  - Proven `summarize` de-duplicated by request. Here that happened in Task 3, before a record
    became spend.
- **`runWorkflow`** returns `startedAt`, `finishedAt` (taken before the end-of-run read) and
  `accounting`, priced with `PUBLISHED_PRICES`.
- **CLI.** `output.json` gains `accounting`. The summary lines go to stderr, so stdout stays the
  workflow's own report or the `--json` document:

  ```
  21 agents · 14m 05s · 3.24M tokens (2.91M cached) · ~$4.10 at list prices 2026-09-23 · subscription · usage known 21/21
    lens      12 agents · 9m 40s · ~$2.80
  ```

  Any unpriced model or charge is named on the first line.
- **Proof.**
  - The proven `records.test.ts` cases are ported to `costOf` and `summarizeRun`.
  - Codex cached input is priced at OpenAI's rate.
  - A partial run shows `known` below the total and no `estimate` that stands in for zero.
  - The operator-cli test checks the printed lines and `output.json`.

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

Plan (Gate 1, 2026-09-23):

- **Catalogue review.** `awf run ~/dev/braintrust/workflows/catalogue-review.ts --timeout 30m`,
  from the braintrust worktree the last run reviewed (`air-password-login-client-claim`), against
  `origin/main...HEAD`. That file puts every lens on codex terra and every verifier on codex sol,
  on the Herdr host and the ChatGPT subscription. It is read-only: its instructions forbid edits.
- **Two short agents.** A scratch script runs one claude haiku agent on the Herdr host, and one pi
  agent on `openai-codex/gpt-5.6-terra` through the headless adapter with
  `createSessionAccounting({headless: true})`, since the Herdr host serves only claude and codex.
  Each is asked for a one-line answer.
- **Independent check.** A subagent that has not seen the readers recomputes each agent's tokens
  from its session files and compares them with `output.json`:
  - codex: per-response rows;
  - claude: the last row per request;
  - pi: assistant messages.

  It also checks that wall time agrees with the run directory's timestamps, and explains every
  unknown agent and every turn still open when the read ended.
- **Also measured:**
  - how long the end-of-run read took;
  - whether any codex turn was still open after the run;
  - the codex readers' cost on this machine's session tree.

Done when:

- Tokens match for every agent.
- Wall time agrees within a second.
- Every agent reported unknown, and every turn cut off, is explained.

## Verification

- [x] Focused tests named under each task.
- [x] `bun test`: 400 pass, 0 fail, across 38 files (2026-09-23).
- [x] `bunx tsc --noEmit`: clean.
- [x] `bun run scripts/check-boundaries.ts`: "boundaries ok". `biome check .`: no findings.
- [x] Task 5: one catalogue-review run on the codex subscription (19 agents; the lens selection
  gave 12 lenses and 7 verifiers), plus two short agents. See the Task 5 record.

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

### Task 1 review, 2026-09-23

Architecture and scope:

- Session refs reach workflow code and `output.json`, against foundation §6 — accepted. §6 now
  lets them cross as accounting evidence only.
- `settledAt` as the accept time cannot close a spend window — accepted. Recorded for Task 3.
- A record's `sessions` is a snapshot at settle — accepted. The comment now says so, and Task 3
  rewrites the run's final records.
- Herdr's session `kind` is dropped — rejected. It would add a field to a published record. The
  reader tells a path from an id, and `NativeSessionRef.id` already says either may appear.
- The runner looks `sessionEnv` up in the built-in table by name — kept. The launcher is installed
  before the session exists, and every production harness is in that table.
- `charged` was filled before billing was known — accepted; see the correctness review below.
- An unread `launcherSessions` on `AgentEntry` — removed.
- The wire change is additive in one direction only — kept. `wf` ships with the engine that
  installs it; the field's comment says so.
- An agent can name any session — accepted as a Task 2 constraint (Implementation notes).
- The story still said "with a fake clock"; `RunResult.usage`'s comment still described aggregated
  tokens — both fixed.

Correctness and proof:

- `settledAt` could fall before the attempt ended, even before delivery, when a nudge deadline had
  already passed — fixed. It is now when the last held attempt was seen to end, capped at that
  attempt's deadline; before any attempt, the operation's deadline. New tests: an attempt that
  ends past the nudge deadline, a nudge that times out, and an operation expired before dispatch.
- `charged` was set from claude's `total_cost_usd` on a subscription — fixed. It is set only when
  billing is `api`.
- Failure and cancellation included up to 5 s of release grace — fixed by the same change: the end
  is taken before any release.
- A blank session id made the wire reject a valid result — fixed. `wf` trims it and drops a blank
  one.
- Session ids are agent-controlled — recorded as a Task 2 constraint.
- A throwing `onSession` would leave `wf` without an answer — fixed with a guard.
- `finish` read `held` before its declaration — fixed.
- Proof gaps: queued delivery, the nudged test's upper bound, session refs from failed turns, the
  pre-dispatch record, and the timeout test's 30 ms budget — each now has a test, or a fix to the
  test.

Focused verification: `bun run check` passes, and `bun test` passes 326 of 326.

- A 20-run loop of the runner tests then failed once. `settledAt` was 1 ms after the fake saw
  `submit` return, because the accept time was taken in a callback on `slot.settled`. The slot now
  stamps `acceptedAt` itself, before the agent is told, and the runner uses that. After the fix,
  20 more runs were clean.

### Task 2 review, 2026-09-23

Architecture and scope:

- `billing()` could not tell a pane from a headless run. E3 found that `claude -p` bills metered on
  a subscription login — accepted. `createSessionAccounting({headless, run})` builds the readers
  and billing for agents launched one way. Headless claude is `api`, and its
  `total_cost_usd` becomes `charged`.
- The status commands ran in the engine's environment, not the agents' — accepted. They now run
  through the `RunProcess` the host launches agents with.
- The status parsers are duplicated in `operator-runtime.ts` — kept. That code is a policy gate
  that also requires a first-party provider, and refusing to run is a different answer from
  "subscription".
- `UsageRecord` had no request key, so no de-duplication across agents was possible — accepted.
  `key` is claude's `requestId`, codex's `response_id` (or rollout and row), and pi's entry id with
  its time.
- pi's provider was dropped — accepted. Records carry `provider`, and pi's billing uses the
  provider pi logged.
- Removing pi's `costUsd` from `readUsage` changed what a frozen E2 rerun reports — accepted. It is
  restored; the engine counts it only for `api` billing.
- Empty `at` and `model` fallbacks — accepted. Rows with no time are skipped, and a codex request
  before any `turn_context` is `unknown`.
- pi's `reasoning` was reported as zero when pi logged none — fixed.
- Ids matched by suffix — fixed. The id is parsed from the file name and compared exactly.
- Codex reading cost — measured, and deferred to Task 5. A full scan of this machine's 1,010
  rollouts takes 25–35 ms.
- The harness `AGENTS.md` table and the story's billing text are updated. The proven module's
  `agentType` is not carried over: no consumer of the summary needs it.
- The helpers moved to `usage/files.ts`, and `records.ts` holds only the record type.

Correctness and proof. The reviewer checked every session file on this machine: 618 claude, 1,010
codex and 315 pi.

- claude: a forked subagent's partial copy of a parent request replaced it, and the proven module
  has the same bug — fixed. For each `requestId` the largest output is kept, and `delegated` stays
  with whoever logged the request first. A zeroed copy in a resumed session is covered by the same
  rule, and `cacheWrite1h` and `reasoning` are capped at their totals.
- codex: a rollout opening on a compacted thread's totals was counted as one request of 54M
  tokens, and a reset above the old total was missed — fixed. Each moved total counts
  `last_token_usage`, never a difference.
- codex: compaction requests have no `token_count` — fixed, reversing the plan's rejection of
  `token_usage_record`. Where a rollout has per-response rows (CLI 0.155 on), the reader uses
  those, and otherwise it falls back to `token_count`. Across the 328 real rollouts that have both,
  the fallback alone agreed on 315; the other 13 differed only by compaction requests. The new
  path agrees on all 328.
- claude `authMethod`: `oauth_token` is a subscription token, and `none` says nothing — fixed,
  each method mapped explicitly.
- pi: a forked session's copied entries were counted twice — fixed; keyed by entry id and time.
- pi billing guessed the provider — fixed, as above.
- codex Bedrock and token logins read as `unknown` — kept, since that is safe. Archived sessions
  are not searched; that matters only if a thread is archived mid-run.
- Test gaps — filled: resets, repeated rows, `info: null`, a model change, a request before any
  `turn_context`, compaction and per-response rows, a subagent in an earlier day's directory,
  exact id matching, codex status on stderr, and headless versus pane billing.
- pi path containment does not resolve symlinks — kept. Exploiting it needs write access to
  `~/.pi`, and a `wf` id still finds the file.

Focused verification:

- `bun test packages/harness/src/usage`: 28 pass.
- The reviewer's five repro tests, which asserted the old behaviour, now all fail as they should.
- The live readers on this machine's files agree with experiments 10 and 13, and billing is
  `subscription` for all three harnesses.

Targeted re-review of the fixes. Nothing was blocking, and it found no wrong figures across 1,010
codex rollouts and 54,573 claude requests.

- Nothing tied `headless` and `run` to the host that launched the agents — accepted.
  `AgentRunHostFactory.accounting` belongs to the host. The Herdr host builds its own, as a pane
  host whose status commands run without the credentials it withholds from panes.
  `createSingleSessionHostFactory(adapter, accounting)` takes one for a headless adapter.
- A pi agent that moved between providers was billed by the first — fixed. Two providers give
  `unknown`. Task 3 asks billing once per agent, with all of its records.
- A rollout resumed on a newer CLI dropped its earlier token counts — fixed. `token_count` rows
  before the first own per-response row are counted, and per-response rows after it.
- Claude replaced a request on a tie across files — fixed. Across files only a larger output
  replaces it, and within a file the last row does.
- Codex's provider was hard-coded — fixed. It comes from `session_meta.model_provider`, and codex
  billing is `unknown` for any provider but `openai`.
- Test names described the old rule, and the per-response path had no real fixture — fixed. A
  trimmed real 0.156 rollout is added, along with a mixed-version test and billing-by-provider
  tests.
- Notes for Task 3, taken into its plan: de-duplicate by harness and key, drop records from before
  the run started, and a claude record's `at` is the end of its request.

### Task 3 review, 2026-09-23

Architecture and scope:

- Stopping when two reads 1.5 s apart agree was a stand-in for "the turn has finished". The right
  signal belongs to the harness — accepted. Each reader reports whether a session's turn is open,
  and re-reading continues while one is. `pollMs` and `stalledMs` are set by the harness alone,
  where `quietMs` had two owners.
- The read ignored `stop()` and the operator's signal — fixed. `account()` takes the run's signals,
  and on abort returns the records as they settled at once. It runs past the run's deadline by
  design, bounded by a 20 s grace plus 12 s for status commands.
- Billing answers were cached on the host factory, which lives for the whole process — fixed.
  `createSessionAccounting` caches nothing, and `settleUsage` asks once per agent per run.
- The token arithmetic Task 4 needs was private to `run-usage.ts` — moved to
  `engine/src/accounting/tokens.ts`.
- `finishedAt` must be taken before the read — noted for Task 4.
- Records from an agent whose operations were all undelivered became a known zero — fixed. They go
  to the first operation.
- The de-duplication tie-break followed activation-completion order — fixed. Agents register
  synchronously in open order.
- The contract did not say `billing` and `charged` are decided when the run ends — fixed.

Correctness and proof:

- The split test failed 23 times in 500 in-process runs, because a record and a delivery landed in
  the same millisecond — fixed. The fake agent now sleeps clear of each delivery. 30 runs of the
  file were clean.
- The quiet window was shorter than one model request, as experiment 4 had already shown —
  fixed, as above.
- An operation answered before its turn was held lost its records and reported zero — fixed. An
  answer stamps `deliveredAt` from when the attempt began, and a share never drops a record.
- Nondeterministic attribution between agents — fixed, as above.
- Billing ran after the reads, one agent at a time, and could lose everything to the outer bound —
  fixed. It runs concurrently, and the fallback keeps final sessions.
- The fingerprint covered only three fields — fixed. The whole read is compared.
- A reader or billing that throws synchronously rejected the whole read — fixed. Every call goes
  through `attempt`.
- Proof gaps — tests added: an open turn re-read until it closes, a turn stalled open, stopping
  during the read, throwing readers and billing, a request before the first delivery, a
  malformed time, an answer before the turn was held, and open-order attribution.

Focused verification: `bun run check` passes, `bun test` passes 374 of 374, and 30 runs of
`run-usage.test.ts` were clean.

Targeted re-review of the fixes:

- Blocking: every claude agent read as open after answering, because its session ends on the
  `tool_use` of its `wf result` call. That was 14 of 14 awf-launched sessions from 2026-09-18 to
  2026-09-22, and it cost the full `stalledMs` on every run — fixed. Only codex reports an open
  turn, and a test copies the real awf tail.
- pi probably had the same problem, though no awf pi session has been observed — fixed the same
  way.
- After a stop, billing still started its status commands, and one abort listener stayed attached —
  fixed.
- The eager-answer test passed even without the fix — strengthened. Its second operation answers
  early, and removing the fix now fails it (checked).
- `NO_TOKENS` and `totalTokens` were unused — removed until Task 4 needs them.
- Noted for Task 5: a codex agent that timed out mid-turn goes on spending after its tab closes.
  Its session keeps changing, so the read runs its full 20 s grace, and only what was written
  before then is counted.

### Task 4 review, 2026-09-23

Architecture and scope, with correctness and proof. Both reviewers found the first three:

- `byModel` counted a whole operation's charge and time under every model it used, so summing it
  gave $14 from a $7 charge — fixed. `byModel` has its own narrower type.
- The prefix rule priced siblings, against its own comment. For example, `claude-opus-5-6` was
  priced as Opus 5, and `gpt-5.5-pro` six times too low — fixed. A model matches its family id,
  optionally followed by a date or a context tag. Anything else is unpriced and named. An
  inherited name such as `__proto__` cannot match.
- A known zero had no `estimate`, so "priced 1/1, no estimate" read as a gap — fixed. A fully
  priced agent contributes 0. The printed line says "no usage known" rather than "0 tokens" when
  nothing is known.
- OpenAI now lists cache writes at 1.25× input for gpt-5.6 and gpt-6 — fixed. It is latent
  today, since every codex row here writes zero.
- `agents` named both a count and an array — renamed the array `byAgent`. Agents are keyed by call
  path and key.
- `charged` summed any currency — now sums USD only. Every charge the engine records is USD.
- `startedAt` and `finishedAt` appear twice — kept. The top-level pair and `usage` are the record,
  and `accounting` is derived from them; the comment on `WorkflowRunResult` says so.
- Nothing kept `engine/src/accounting` pure — added. `check-boundaries.ts` forbids node and bun
  imports and the Bun global there.
- "unknown" billing among agreeing agents made the run `mixed` — fixed. `known` reports the gap.
- `describeAccounting` was not exported — it is now.
- Formatting printed "$0.00" for a real sub-cent cost and "1000k" — fixed.
- Long-context rates were described as GPT-6 only — corrected to gpt-5.6 and gpt-5.5 as well.
- gpt-5.4 was missing — added. The bare aliases `sol` and `luna` and `codex-auto-review`, codex's
  approval reviewer, stay unpriced and named, because none has a list price of its own.
- Proof gaps — tests added: a two-model operation in `byModel`, siblings unpriced, the newest
  models (`claude-opus-5-5`, `gpt-6-sol`, `gpt-6-astra`) priced as themselves, cache-write rates,
  `finishedAt` before the read, and `output.json` spend per record.

The user asked on 2026-09-23 that the newest models be listed: `claude-opus-5-5`, `gpt-6-sol` and
`gpt-6-astra`. All three were already priced, and a test now pins them.

Focused verification: `bun run check` passes, and `bun test` passes 398 of 398.

Targeted re-review of the fixes. Nothing was blocking. Every real model id on this machine that has
a list price is priced, including the three the user named.

- A stage line hid an agent that was only partly priced — fixed. Stage and run lines both say
  `fully priced n/m` when it falls short. The field is still `priced`, now documented as
  "all their usage priced".
- An agent with unknown billing was folded into the others. The earlier reason, "`known` reports
  the gap", was wrong, because `known` counts usage, not billing — fixed. The figures carry
  `billed`, and the line says `billing known n/m`.
- The purity rule missed bare `fs` and `globalThis.Bun` — fixed for accounting and contract alike:
  any Node builtin name, with or without `node:`, and any mention of `Bun`. Both were checked
  with a probe file.
- Formatting: `1 token`, and `<$0.01` without a tilde — fixed.
- Accepted as is:
  - a model can show an estimate of 0 when every agent using it is only partly priced, which is
    an unlikely edge;
  - a non-USD charge is dropped, when the engine only records USD.
- Not seen here, and unpriced if they ever appear: Bedrock, Vertex and provider-prefixed ids.

Verification after the re-review: `bun run check` passes, and `bun test` passes 400 of 400.

### Task 5 record, 2026-09-23

No production code changed in Task 5. Its proof is an independent subagent that never read the
readers or the accounting code. It recomputed every agent's tokens from the raw session files
with its own scripts, and compared them with each run's output.

Runs:

- **Catalogue review.** `awf run ~/dev/braintrust/workflows/catalogue-review.ts` in
  `air-password-login-client-claim`, from 19:06:10 to 19:14:10 UTC, with exit 0. The printed line
  was:

  ```
  19 agents · 7m 54s · 12.33M tokens (10.99M cached) · ~$6.77 at list prices 2026-09-23 · subscription · usage known 19/19
    lens      12 agents · 4m 48s · ~$4.36
    verifier  7 agents · 3m 06s · ~$2.41
  ```

  Its output is `~/.awf/runs/invocation-fb06a1dc…/549f9d7c…/output.json`.
- **claude haiku**, one pane agent: 9 input, 24,572 cache read, 11,038 cache write (all one-hour)
  and 463 output, ~$0.027.
- **pi on `openai-codex/gpt-5.6-terra`**, headless: 6,976 input and 106 output, ~$0.015. This
  equals pi's own cost field.

Results:

- **Tokens match exactly for all 21 agents.** Every class of every codex agent matches, and each
  codex agent's per-response sum equals its rollout's final `total_token_usage`. There are no
  duplicates and no delegated spend: no subagent rollout names any of the 19 sessions.
- **The estimates match to the last digit:** $6.7660532, $0.0268572 and $0.015224.
- **Wall time agrees to well under a second.**
  - `startedAt` equals the invocation directory's mtime, 19:06:10.933.
  - `finishedAt` is 72 ms after the last `result.json`.
  - `agentMs`, the sum of each operation's settle minus delivery, matches.
- **Unknown agents: none.** In all three runs, `known`, `priced` and `billed` equal the agent
  count. The Task 3 risk of a codex agent that never calls `wf` did not occur.
- **Cut-off turns: none.**
  - Every codex rollout has one `task_started` and one `task_complete`.
  - Only verifier:5's turn was still open at `finishedAt`. It logged one more request 4.2 s later
    (472 input, 51,968 cache read, 39 output) and completed at 19:14:09.261.
  - The end-of-run read waited for it and counted it. `output.json` was written 5.56 s after
    `finishedAt`, which is the read's cost on this run.
  - For claude and pi, the files stopped before `finishedAt`, so the read had nothing to wait for.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design, with experiments 1 to 9.
- [x] Expensive interface, record-format, and stage-gate decisions are settled. The user approved
  the `TurnUsage` reshape, the removal of `TurnCost` and the additive wire field on 2026-09-23.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are experiments placed inside the tasks they gate.

## Implementation notes

- Task 1 removed `usage` from all three example results, not only `CatalogueResult` (see its
  plan). Foundation §6 now says session refs cross only as accounting evidence.
- Task 1 plan, for Task 2: `charged` comes only from `NativeUsage.costUsd` and only when billing is
  `api`; until Task 2 reads billing it is never set. Pi's `cost` no longer counts as a charge.
- Task 1 plan, for Task 2: a session id comes from the agent and is not trusted. A reader matches
  it against file names inside its own directory and never uses it as a path; only a pi ref that
  the adapter reported may be a path. Herdr's `kind` is dropped, so the reader tells the two apart.
- Task 1 plan, for Task 3: a record's `sessions` holds what was known when it was made. The run's
  final records take the agent's full set when the run ends. Spend is split between operations by
  delivery, `[deliveredAt(n), deliveredAt(n+1))`, with the last running to the end of the run:
  `settledAt` is when the answer was taken, and codex writes its last request after that
  (experiment 4).

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [x] Record the human's explicit approval or requested changes here.
- [x] If changes are requested, return to the affected task and repeat its review and verification.
- [x] Only after explicit approval, mark the story `done` and update `Stories at a glance`.

Approved by the human on 2026-09-24, with two last requests: log a request in flight when a
finishing turn is killed, if easy, and a subagent review of the prompt change. Both are recorded
under "Approval, 2026-09-24" at the end.

### Requested change, 2026-09-23: headless agents

The human asked that accounting work for headless agents too, with an example agent for quick
testing, mainly on codex and pi, whose pricing does not depend on placement. They then clarified
that a workflow should be able to configure an agent to run headless, and that `awf run` needs no
headless flag. A first version with an `awf run --headless` flag was built, reviewed and replaced;
its useful findings are kept below.

Decisions, from the human:

- Placement goes on `ExecutionConfig` as `placement?: "pane" | "headless"`, so it is part of the
  resolved agent identity and every usage record.
- A headless claude is allowed only with an explicit extra field, `metered: true`, because
  `claude -p` bills per token even on a subscription login (E3). It cannot be tried live here: the
  account has no API credit.
- No `awf run` flag.

Change:

- Contract: `ModelSelection {harness, model}`, `AgentPlacement`, `PlacementChoice {placement?,
  metered?}`, and `ExecutionConfig = ModelSelection & PlacementChoice`. Runtime aliases name a model
  selection only. `ExecutionRequirements` adds the placement fields to what its alias names. This
  reverses foundation §6's rule that kept placement out of the author surface; §6 now says so.
- Runner: a pane is left unsaid, and `metered` is kept only when true, so one agent has one
  identity. Reopening an agent with another placement is refused, including by a bare alias.
- Harness: `createPlacementHostFactory({pane, headless})` is one run host that sends each agent to
  the side for its placement. Each side opens with the first agent that needs it, so a run of only
  headless agents never starts Herdr. Close closes every side that opened. Accounting is read and
  billed by the side that ran the agent. `createSessionAdapter` takes the one placement an adapter
  serves and refuses the other. The headless adapter refuses a harness with `meteredHeadless` in
  its spec (claude) unless the execution says `metered: true`.
- A headless read never reports an open turn. The host's close aborts and awaits each process, and
  the read starts only after it. The engine cancels a headless codex once its answer is accepted,
  so its rollout has `task_started` but no `task_complete`. The first live run waited the full 10 s
  stall limit for it.
- Operator runtime: the placement host over the Herdr host and the headless host. Both have
  metered credentials cleared.
- `examples/quick-check/workflow.ts` asks one agent per runtime named for 17 × 23 and prints right
  or wrong. Its `codex` and `pi` agents run headless on `gpt-5.6-terra`, and its `claude` agent runs
  in a pane on haiku.

Live runs of quick-check on codex and pi, headless (the first three used the replaced flag, with the
same adapter and accounting):

- Before the open-turn fix, both answered 391: `2 agents · 7s · 27k tokens (12k cached) · ~$0.04 ·
  subscription · usage known 2/2`. The read took 10.2 s.
- After it, both answered 391: `2 agents · 8s · 28k tokens (16k cached) · ~$0.03 · subscription ·
  usage known 2/2`. `output.json` was written within the second that `finishedAt` names.
- Both runs matched the raw files exactly:
  - codex: the one `token_usage_record` (19,490 input with 12,032 cached, so 7,458 uncached;
    185 output; 29 reasoning);
  - pi: the assistant message (4,177 input, 3,584 cache read, 137 output), and its estimate equals
    pi's own cost, $0.0107148.

Review of the flag version, findings that carry over:

- `open: false` might hide a cut-off request — rejected as a code change, recorded as a gap below.
  The 17% of experiment 14 is a pane agent whose process runs on after release. Headless, the engine
  kills the process, so the closing request is normally never sent. Letting codex finish would spend
  a request on a closing message nobody reads.
- A mutation test found that neither the accounting nor the agent turns were proven to get the
  unmetered runner — fixed. The runtime test runs a codex turn and asserts that the billing probe's
  env clears the keys. The ordering claim holds on every path: `account` runs only after the host
  closes cleanly, and the close awaits each process's exit and pipe EOF.
- `docs/status.md` says pi runs on Herdr, which only runs claude and codex — left for the human.
  That file is uncommitted work from another session.
- `read` relies on being called after close, and its doc comment now says so.

Follow-up operations, asked for next by the human: a headless agent keeps its native session, so a
second `agent.run` continues the same conversation. It may come from workflow code, and later from
a person or another agent through messaging.

When a headless agent may be killed, which the human asked about next. Between operations a
headless agent holds no process, only its native session, so keeping it costs nothing. The
decision is only about the turn still running after its answer is accepted: its closing message
leaves a whole session to resume, and killing it cuts the conversation off after the answering tool
call. The engine cannot know whether a follow-up will come, so neither choice can be made when the
answer is accepted. It is made later instead, with no new contract type:

- An answered turn on a session that continues is left finishing. `HarnessTurn.release` takes
  `{ answered }`, which the runner sets only after accepting the result. A backend with
  `finishesAnswered` (the headless one) answers `{ kind: "finishing", settled }` instead of killing
  the turn. The operation returns at once, and a single-shot or fan-out workflow waits for nothing.
- A finishing turn is stopped after `finishGraceMs` (30 s by default), whether or not a follow-up
  comes. An agent that keeps working after its answer would otherwise keep spending, and keep
  changing files the rest of the workflow reads, until the run ends.
- The session's next start waits for the finishing turn for at most half its own time, then stops
  it and resumes the session, so the follow-up still has time to run.
- Run end and a run-level cancel stop it at once, since nothing will resume it. So does any release
  that is not answered, such as a timeout, and host close ends whatever is finishing. Cancelling a
  parallel scope after the operation has returned does not reach the finishing turn; the grace
  bounds it.
- The native evidence of a finishing turn arrives late. The runner records its charges when it ends,
  and the run-end account waits for those, after the host has closed.
- Saying "this agent is done" before the run ends is what the contract's existing
  `agents.stop(key)` is for. It is still a stub, and gets built with messaging; it matters more for
  pane agents, which hold a live process.
- Session-core now keeps the session ref from any turn that reported one, so an agent stopped after
  its answer can still be resumed. A session id we handed pi counts only from a turn that ran, since
  one that failed may have created no session, and resuming it would silently start a new one
  without the agent's instructions.
- The Herdr host still takes one operation per agent (`herdr-pane-settlement`), and releases a pane
  at once.
- quick-check asks each headless agent a follow-up that names no number: "add 9 to the number you
  gave".

Live runs of `bun awf run examples/quick-check/workflow.ts -- codex pi claude`:

- With the finish wait on the release path: codex and pi answered 391 and then 400 in one native
  session each, and claude answered 391 in a pane. Each turn ended on its own, with codex logging
  `task_complete`. But each operation returned 3.4 s (codex) or 4.0 s (pi) after its answer. pi's
  wait was at the kill limit, and a single-shot workflow would have paid it too.
- With the background version: the same answers, and
  `3 agents · 16s · 137k tokens (75k cached) · ~$0.15 · subscription · usage known 3/3`.
  - The wait moved to the follow-up's start: 2.75 s (codex) and 4.1 s (pi) between an answer and
    the next delivery.
  - The last operations were accepted 31 ms before `finishedAt`, and the run did not wait for them.
  - Codex's second turn was stopped at run end before its closing request, so no `task_complete`
    was logged and nothing was spent after the answer. pi's finished first and is counted.
  - Every operation matched the raw files exactly:
    - codex: 13,064 input, 26,112 cached, 175 output; then 3,939, 19,200 and 152;
    - pi: 1,349, 14,336 and 146; then 919, 15,360 and 118.

- With the review fixes (`-- codex pi`): the same answers,
  `2 agents · 19s · 95k tokens (66k cached) · ~$0.08 · subscription · usage known 2/2`.
  - Every operation matched the raw files exactly:
    - codex: 7,938 input, 31,232 cached, 173 output; then 3,935, 19,200 and 171;
    - pi: 15,670, 0 and 130; then 887, 15,360 and 121.
  - codex logged `task_complete` 1.7 s after its answer, but its process exited about 2 s later,
    and the follow-up waits for the exit. That exit time is most of the 3.9 s between codex's
    answer and its next delivery.

Re-review of the background version:

- A finishing turn had no bound when no follow-up came — fixed with the grace timer above, and
  tested.
- The host snapshot showed a follow-up `idle` or `dormant` while it ran, and a closed agent
  `dormant` — fixed, with a test:
  - only the newest turn's end is recorded, and nothing is recorded after close;
  - an answered turn ending leaves the agent `idle`.
- A finishing turn that ended after its old operation's deadline was rewritten as timed out —
  fixed: its answer was taken in time.
- A follow-up's wait could take its whole deadline, so a timeout closed the agent — fixed: it waits
  at most half its time. There is a test.
- A pi id we chose was dropped whenever its turn was stopped, even after an accepted answer —
  fixed: it is dropped only when the process failed on its own.
- `{ kind: "finishing", settled }` repeated `turn.settled` — fixed: now `{ kind: "finishing" }`.
  Harness AGENTS.md now describes the finishing lifecycle.
- The eval wrapper dropped the release options — fixed. Its run accounting reads no spend, because
  it rebuilds the host factory without `accounting` — kept; it is a frozen measurement harness.
- Kept, with nothing live reaching them:
  - `HarnessSession.compact` waits, but no test covers it, because the engine cannot compact;
  - a follow-up answered before its turn is acquired dates its delivery from before the wait;
  - there is no conformance case for a host that answers `finishing`. The direct-process tests go
    through the production host.
- Once, under load from concurrent mutation runs, "cleanup is bounded when activation and adapter
  close never settle" failed after 75 s. It passes alone, and the full suite passed twice after it.

Re-review of the first follow-up version, before the background change:

- Two parts could be removed with no test failing: the single-session host forwarding the release
  options on the production path, and a timeout release wrongly marked answered — fixed. Tests now
  go through `createSingleSessionHostFactory`, and a timed-out release is asserted unanswered.
- The kill at the deadline, less a second, left one second to drain the pipes, and could quarantine
  an answered agent — gone. The wait no longer shares the release deadline.
- The eager wait on every operation, and pi at the kill limit — fixed by the background version.
- A pi session id we chose was resumed after a failed turn — fixed, as above.
- Scope cancellation, the run deadline and host close during the wait all stop the turn promptly,
  and accounting still splits spend at delivery — no change.
- The mutation that stops the run-end account waiting for late charges now fails a test, and so
  does one that drops the options.

Architecture review of per-agent placement:

- Aliases typed `ModelSelection` would have built "harness and model only" into a published name,
  though `design/permissions.md` plans a pool and sandbox there — fixed, renamed `RuntimeTarget`.
- `metered` was kept on pane agents, putting a billing-looking field on records whose billing
  disagreed — fixed: it is kept only on headless agents. The contract now calls it consent, not a
  billing fact.
- The requirements rule is now stated as one rule: target fields constrain, and agent fields are
  added.
- The placement host inside the harness is the right seam — no change.
- A side opens with its first agent, so a broken Herdr now fails after headless siblings have spent
  — recorded under the gap below.
- The metered check lives in the headless adapter only — kept until a second headless provider.
- Direct callers of the headless adapter must say `headless` — harness AGENTS.md now says so.
- Foundation §8 now lists placement as a workload parameter, with `metered` as consent. The
  `AgentRuntimeConfig.host` comment is fixed.
- Stale elsewhere, left for the human because the files are another session's uncommitted work or
  measurements:
  - `docs/design/README.md` calls `pane | headless` legacy vocabulary that §6 took off every
    surface;
  - `docs/findings/README.md` says the same;
  - `README.md` and `docs/status.md` describe one Herdr host.
- The extra harness exports belong to this story's earlier tasks — kept.

Correctness review of per-agent placement: no runtime bug. The reviewer ran 26 mutations; 19 were
caught.

- The races hold:
  - an agent open racing close closes the side exactly once;
  - no side opens after close begins;
  - retrying a failed close works;
  - the headless `open: false` read still starts only after every side has closed.
- Close waiting for a side still opening, and refusing an agent after close, could each be removed
  with no test failing; either would leak a Herdr workspace — fixed with a test for each, and both
  mutations now fail it.
- A misspelt placement from untyped workflow code ran in a pane — fixed; it is refused.
- Alias values carrying extra fields were stripped, but untested — fixed.
- The Herdr adapter's `pane` refusal and its withheld credentials on status commands are untested
  — kept. Reaching them needs a Herdr adapter harness; the type and the operator's up-front refusal
  cover them.
- Herdr opens lazily. A run that fails while the first pane agent's workspace is still being created
  waits on it past the 5 s cleanup grace — recorded under the gaps below.
- `inspect` lists no agent for a side that failed to open — kept. The agent's open rejected with
  the reason.

Known gaps:

- An agent its host cannot run, such as pi in a pane or claude headless without `metered`, is
  refused when it opens. So is every agent of a placement whose host fails to open. That happens
  after sibling agents may have spent, and the runner then fails the whole run. The engine could
  check a resolved execution against its host before any agent starts. A run that fails while
  Herdr is still creating its workspace waits on it past the cleanup grace.
- A turn left finishing is killed when its 30 s grace runs out, or by a follow-up that has waited
  half its time. A request in flight at that moment is not logged. At run end this is fixed (see
  the change of 2026-09-24 below).
- pi's billing is inferred from `auth.json`, and nothing refuses a metered pi before the run. The
  operator still requires claude and codex logins even for a pi-only run.
- A headless claude cannot be tried live here, since the account has no API credit.

### Requested change, 2026-09-24: the result prompt

While discussing headless follow-ups, the human asked whether a harness's own output schema should
carry the answer. An experiment, E8, measured it on headless codex, 10 two-turn trials per arm:
- native `--output-schema` answers were valid 40/40, with one request per turn;
- `wf result` was just as valid, but one `wf result` command broke on shell quoting;
- strict mode refuses optional properties and open objects.

The human then asked for the minimal prompt below, and a rerun. Afterwards they decided `wf result`
is good enough and native output will not be pursued; the experiment and its todo were deleted, so
this section is its only record.

- The operation prompt shows the value in a quoted heredoc, `wf result <id> <<'WF_JSON'`, and
  carries the schema itself instead of `describe()`'s rendering. It no longer repeats what `wf`
  says on a rejection. That closes `todo/schema-in-prompt`, marked done.
- `wf`'s rejection text adds: "A long value can be written to a file and passed with < file."
- Tests:
  - the prompt carries the schema;
  - a heredoc through a real shell delivers a value with an apostrophe, `$` and a backslash
    untouched;
  - the rejection text names the file route.
- The rerun with this prompt, 10 two-turn trials:
  - 20/20 answers valid first time, and no nudges;
  - all 20 calls used the heredoc, and none broke;
  - turn 1 cost $0.0144, against $0.0192 with the quoted argument and $0.0125–0.0143 native.
- Reviewed by a subagent at approval; see below.

### Approval, 2026-09-24

**A request in flight at run end.** A turn left finishing was killed when the host closed, so a
closing request still in flight never reached the session file. After a successful body the runner
now waits for turns left finishing, for up to 10 s and never past the run's deadline, before closing
the host; a stop or cancel ends the wait. A turn still going then is killed as before. A kill by
the 30 s grace, or by a follow-up that stopped waiting, can still lose a request: those turns are
runaways by then. Tests: the run waits for a turn that ends on its own and closes after it, and
closes at the deadline for one that does not; removing the wait fails the first.

**Subagent review** of the prompt change and the wait:

- The prompt indented the heredoc's lines, and an indented `WF_JSON` does not close a heredoc in
  sh, bash or zsh: copied as shown, the value runs to the end of input and fails to parse, with a
  rejection that blames the value. The live rerun passed because codex dropped the indentation.
  Fixed: not indented. A new test copies the command from the prompt as it stands, fills in the
  value and runs it through `sh -c`; re-indenting fails it.
- `stop()` did not end the finishing wait — fixed; it gets the same signals as the body.
- `wf` reads a value of up to 1 MiB, but the control plane refused requests over 1 MiB, and escaping
  can double a value inside the request — fixed; the request limit is 2 MiB plus the envelope.
- Only codex has run the heredoc prompt live. claude and pi run commands in bash or zsh, where it
  works; fish has no heredocs — kept, untested.
- Checked and fine: stdin handling (empty, a TTY, a trailing newline, bounded size and time), a
  value containing a `WF_JSON` line (impossible in JSON), pane agents never delaying run end, and
  `finishedAt` including the wait, which is agent time whose cost is now counted.

After the human decided native output schemas will not be pursued, E8 and its todo were deleted.

Verification: `bun test` 423 pass, 0 fail; `bun run check` clean.

### Cleanup review, 2026-09-24

A review for duplication and slop, then two rounds of fixes and a second review. The sections
above name things as they were built; these are the names now.

- **Records.** `TurnUsage` split in two. `OperationRecord` (`@agentswf/contract/workflow`) is what a
  workflow sees: times and sessions. `SettledOperation` (`@agentswf/contract/records`) adds billing,
  spend and charged, and only the end-of-run settle makes one. `Billing`'s `api` is now `metered`,
  so one word means billed per token. `RunAccounting` and its figures moved to
  `@agentswf/contract/records`. `output.json` has a declared type, `OutputRecord`, with `version: 1`;
  its top-level `startedAt` and `finishedAt` went, since `accounting` carries them. A charge in
  another currency counts the agent as not billed instead of vanishing.
- **Harness.** Tokens come only from session files: `readUsage` became `readCharge`, and
  `nativeUsage` became `chargesUsd`. `findHarness` replaced `sessionEnvOf`. The headless claude
  rule (always metered) lives only in `createSessionAccounting`. The credential withholding is
  one helper, `withholding`, and each host factory builds its own accounting. `SessionAccounting`
  carries `statusMs`. The finishing state lives only in session-core, and a backend whose turns
  finish after answering must be cancellable.
- **Engine.** The run ledger (`createRunLedger` in `run-usage.ts`) holds the operation records,
  late charges, the end-of-run finishing wait and the settle; `workflow-runner.ts` went from 1517
  to 1261 lines. The preflight uses the harness's billing readers, so it accepts a
  `claude setup-token` login and its checks can no longer disagree with billing. A settle that hits
  its bound now stops its reads and status commands.
- **Author surface.** Reopening an agent without `placement` or `metered` means as it was opened.
- **Boundaries.** A `pure` rule covers contract, `engine/src/accounting` and examples; a bare
  `import "fs"` in an example now fails.
- Kept on review: session refs in workflow records (accepted above), the per-operation spend split,
  pi's pane session path.
- No test yet for a turn that starts finishing while the end-of-run wait is already running.

Verification: `bun test` 426 pass, 0 fail; `bun run check` clean.
