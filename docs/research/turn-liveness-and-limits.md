# Turn liveness and limits: source research

Researched 2026-10-04 for [[021-turn-liveness-and-limits|the story]].
This is documentation and read-only source inspection, **not a live conformance measurement**.
No model calls, new agent sessions, or paid probes were run for this initial source survey.
The later [[021-liveness-probe]] records a bounded live experiment;
[[021-result-ordering-probe]] records a free engine-ordering experiment.

## Scope and evidence

The installed binaries reported Claude Code **2.1.289**, Codex **0.160.0**, Pi **0.87.1**,
Cursor **2026.10.01-14929f9**, and Herdr **0.9.1**. These are inspection baselines, not a
claim that all documented signals have been exercised on these versions. Context7 resolved
and retrieved primary documentation for each product; directly fetched official Claude and
OpenAI pages provided additional detail. Current documentation may describe a newer implementation
than an installed binary. Versioned Pi documentation and its installed package documentation
both describe `agent_settled`.

Local reference checkouts inspected:

- Codex: `/Users/roman/dev/ref-repos/codex`, commit
  `1cc7e2361237ce7244430ee1d581c77f95c57ac8`.
- Pi: `/Users/roman/dev/ref-repos/pi`, commit
  `6f7551516b84278eb9da1c340c8e7bc66be1a6ba`.

## Claude: a documented observation seam exists

The official [Stop hook reference](https://code.claude.com/docs/en/hooks#stop-input)
provides `background_tasks` and `session_crons`. Both arrays are present when the registry is
reachable; empty means no listed work, while omission cannot mean empty. Task entries cover
shells, subagents, monitors, workflows, teammates, cloud sessions, and MCP tasks. Scheduled
entries distinguish recurring and one-shot wakeups. `SubagentStop` receives parent-session
arrays. `Stop` does not run for a user interrupt; API errors use `StopFailure` instead.
`TaskCreated`/`TaskCompleted` hooks concern task-list tools, not a generic background-process
registry. These distinctions matter when composing an observer; a hook name alone is not a
lifecycle guarantee. The docs also warn that the transcript can lag the Stop hook.

**Verification level:** documented; the installed Claude binary contains `background_tasks`,
but no Stop payload or delivery ordering was exercised here. Test the exact installed CLI in
both panes and supported sandbox placements before relying on these fields for settlement.
A hook transport must preserve existing hooks and distinguish a missing/broken observer from a
valid empty snapshot. An observation hook should report facts, not repeatedly block Stop to
manufacture extra model turns.

The [Python Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/python#taskstartedmessage)
documents `TaskStartedMessage`, `TaskProgressMessage`, and `TaskNotificationMessage`. Starts cover
background Bash, Monitor, subagents, and remote agents; messages carry task/session identities and
optional tool-use correlation. Progress includes usage and tool activity; terminal notifications
say completed, failed, or stopped. **These are SDK stream guarantees, not proof that awf's current
pane transcript reader sees equivalent records.** Choosing an SDK transport is a separate
integration decision; do not silently replace the pane harness in order to obtain these events.

The [subagent documentation](https://code.claude.com/docs/en/sub-agents#resume-subagents)
describes completed agents being resumed by messages under the same agent ID. Version 2.1.205
fixed task-list/task-event state for resumed agents. Therefore a permanent completed-ID set, or
simple starts-minus-completions counter, cannot describe successive executions safely. Correlate
a task execution with its session and observed lifecycle, account for duplicates, and reconcile
against a current registry snapshot where available.

A completed task, an enqueued report, an agent starting its continuation, and that continuation
settling are different events. None of the documents inspected establishes that a terminal task
notification is an acknowledgement that the main agent consumed it and finished responding.
That gap requires a bounded handoff state and measured continuation evidence, not an immediate
nudge when the pending-task count reaches zero. This is an architectural inference.

## The original failure provides narrower evidence than the initial hypothesis

Read-only inspection of the AIRS-1515 transcript
`~/.claude/projects/-Users-roman-dev-braintrust-agent/5dbd8155-35fa-42da-968a-9a33e435f361.jsonl`
found a Claude **2.1.287** tool result with `backgroundTaskId: bbxx8fio7` at line 1867,
2026-10-02T21:02:02.502Z. Lines 1939 and 1941 enqueue task notifications for `b3u5t19ze`
and `bbxx8fio7`, both **killed**, at 21:02:36.674Z and 21:02:36.690Z. The run notes describe
teardown killing these tasks after premature settlement.

That verifies the local start and notification representation. It does **not** verify successful
automatic continuation: the observed notifications are teardown events. The run notes' equation
“pending = started − notified” is a hypothesis, not a safe settlement rule. Preserve a small
redacted fixture of the relevant shapes during implementation; do not check the private transcript
or raw command/prompt contents into this repository.

## Other providers and transports

| Provider | Verified source facts | What remains unproven for awf |
| --- | --- | --- |
| Herdr 0.9.1 | `idle` and `done` mean ready for input; detection uses process/screen/integration signals. Prompt-and-wait observes activity then a settled status, and explicitly does not track individual turns. | Neither readiness nor a Done badge establishes that native background work is drained or that a continuation was consumed. |
| Codex | App-server emits `turn/started`, `turn/completed`, item events, and `thread/tokenUsage/updated`. Local source routes late command completion back to its original turn because a newer turn may already be running. | These app-server signals are not automatically available to awf's existing `codex exec` and pane paths. A running process alone does not establish an automatic model wakeup. |
| Pi 0.87.1 | JSON/RPC `agent_end` ends a low-level run; `agent_settled` means retries, compaction recovery, and queued continuation work have drained. | External extensions can introduce work whose lifecycle was not established by this research. Pane screen state is not the RPC event. |
| Cursor | CLI NDJSON documents tool-call started/completed events and terminal `result`; partial output requires its streaming option. | No reliable native outstanding-task snapshot, cross-turn wakeup guarantee, or complete live cost feed was established. Keep these capabilities unknown. |

Sources: [Herdr 0.9.1 concepts](https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.1/website/src/content/docs/concepts.mdx),
[Herdr 0.9.1 automation](https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.1/website/src/content/docs/agent-automation.mdx),
[official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server),
[Codex late command completion source](https://github.com/openai/codex/blob/1cc7e2361237ce7244430ee1d581c77f95c57ac8/codex-rs/app-server-protocol/src/protocol/thread_history.rs#L693),
[Pi 0.87.1 JSON events](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/json.md),
[Pi 0.87.1 RPC](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/rpc.md),
[Cursor output format](https://cursor.com/docs/cli/reference/output-format),
and [Cursor headless mode](https://cursor.com/docs/cli/headless).

The Codex evidence also refutes the broad assumption that process exit implies every child has
finished. Process cleanup and native wakeup support must be assessed separately. A background
server with no completion-dependent continuation is not automatically an outstanding workflow
obligation.

## Telemetry and cost cannot provide settlement authority

Claude's [OTel documentation](https://code.claude.com/docs/en/agent-sdk/observability)
describes default export batching of 60 seconds for metrics and 5 seconds for traces/logs,
and silent export failures unless diagnostic stderr is enabled. Traces require a beta setting.
These properties make OTel useful for observability but do not supply an ordered, acknowledged
control protocol or a complete pending-task registry. Missing telemetry cannot prove inactivity
or absence of work. Faster export does not turn a lossy exporter into a lifecycle authority.

The [Claude cost reference](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
requires deduplicating assistant messages by message ID. Per-step output-token fields are
placeholders; result-level usage covers the main loop, while model totals and total USD include
subagents. Resumed sessions restore earlier spend, and conversation resets restart accumulated
totals. Consequently, summing successive result totals double-counts, while summing assistant
messages alone can omit output cost and delegated work. Even a native budget has provider-specific
reset and inherited-spend semantics. **This research does not establish a complete live USD feed
for the existing Claude pane adapter.**

Locally, [[packages/harness/src/usage/cursor.ts|Cursor usage]] retains a headless turn's
terminal usage in a sidecar and explicitly marks missing usage unknown. [[packages/harness/src/usage/pi.ts|Pi usage]]
reads assistant-message usage from sessions. These readers were written for finished-run
accounting; their existence is not evidence that live snapshots are complete. Separate
availability, freshness, and coverage before using any reader to enforce a spending policy.

Design implication: a run-wide observed-spend threshold can request cancellation when known
spend reaches the limit; it cannot promise an exact bill ceiling while concurrent or in-flight
requests remain. Unknown prices, delayed usage, unreadable sources, and uncovered subagents must
remain explicit. Reuse the accounting normalization and identity rules rather than inventing a
second summation path, and retain a hard deadline.

## Conformance gates before enabling waiting support

These gates are proposed tests, not completed measurements:

1. Capture a normal idle completion and a background Bash/Monitor/subagent stop on each enabled
   provider/transport/version. Verify missing registry data differs from a confirmed empty registry.
2. Let a task finish naturally. Observe terminal event, queued delivery, resumed foreground work,
   accepted result, and final settlement. Hold delivery back to prove the observer does not close
   the operation in the gap. Test failed and cancelled background tasks separately.
3. Resume a completed subagent under the same ID; duplicate and reorder replayed observations;
   replay stale events after the next operation starts. None may settle or extend the wrong turn.
4. Exercise no-output waiting, endless output, recurring schedules, and a long-running service.
   Activity proves observable activity, not useful progress. Pending work and repeated output
   cannot bypass the hard deadline.
5. Break the observation channel while the provider remains alive. Surface lost coverage and
   enforce a finite fallback. Test cancellation, accepted-result races, and cleanup while waiting.
6. Compare live usage against final accounting, including parallel subagents, resume/fork history,
   repeated cumulative snapshots, unpriced models, and partial final responses. Enable a policy
   only for the measured coverage it actually has.

The smallest reliable first implementation is an observation seam that keeps one logical
operation open through native waiting and continuation, with engine-owned finite limits.
Provider-specific event names and raw logs stay inside the harness. Do not publish a universal
background-task API or promise a hard monetary cap before these gates establish their semantics.
