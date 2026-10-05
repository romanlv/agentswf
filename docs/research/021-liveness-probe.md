# Claude liveness probe: yielded turn and native continuation

2026-10-04. Follow-up to [[turn-liveness-and-limits|source research]] and
[[021-turn-liveness-and-limits|the story]]. The user authorized bounded experiments
and asked for review, not runtime implementation.

**Result:** Claude Code 2.1.289 supplied a Stop-hook snapshot containing a running background
shell, ended its first native turn, and then resumed automatically when that shell completed.
The second Stop snapshot was empty. This proves feasibility in **persistent streaming-input
print mode**. It is not a fresh Herdr-pane conformance result.

The most consequential ordering was:

```text
Stop(tasks = [running shell])
result(WAITING)
background_tasks_changed(tasks = [])
task_updated(completed)
task_notification(completed)
UserPromptSubmit(task notification)
assistant(RESUMED)
Stop(tasks = [])
result(RESUMED)
```

An empty registry appeared **before** the notification-triggered continuation. It cannot by
itself authorize closing the operation. A yielded turn's outstanding obligation includes the
handoff back to the model, then that continuation's settlement.

## Setup and bounds

- CLI: `claude --version` reported **2.1.289**.
- Model: `--model haiku` resolved to **claude-haiku-4-5-20251001** in result usage.
- Working directory: `/private/tmp/awf-liveness-probe-021/workspace`, an otherwise empty directory.
- Settings: an explicit temporary settings file, with `--setting-sources ''` and an empty strict
  MCP configuration. No project files or global operator configuration were intentionally edited.
  Authentication used the existing CLI login; credentials were neither copied nor printed.
- Tools: only Bash, explicitly allowed; `dontAsk` denied any unexpected permission prompt.
- Hooks: observation-only command hooks for UserPromptSubmit, PreToolUse, PostToolUse, Stop,
  StopFailure, and SessionEnd. Each parsed stdin JSON, added its wall-clock observation time,
  appended one local JSON line, and returned success without blocking or adding model instructions.
- One model-requested command: `sleep 12; printf "AWF_LIVENESS_TASK_DONE\n"`, with
  `run_in_background: true`. No polling or follow-up tool calls.
- Native spending threshold: **$0.20**. External process deadline: **85 seconds**, followed by
  stdin close and bounded SIGTERM/SIGKILL fallback for the experiment process group.
- Actual duration: **16.35 seconds**, exit code **0**, with SessionEnd observed. The shell finished
  normally before shutdown; no pending test task remained. A subsequent exact-session process
  lookup found no remaining Claude process.
- Final native cumulative estimate: **$0.0137315**, about **1.4 cents**. This is the final value,
  not the sum of both results. The first result reported $0.0117814.

The $0.20 native threshold is a stopping policy, not a promise that an in-flight request cannot
overshoot it. This probe stayed well below it.

The reproduction command shape was:

```sh
claude -p --verbose \
  --input-format stream-json --output-format stream-json --include-hook-events \
  --max-budget-usd 0.20 --model haiku --effort low \
  --setting-sources '' --settings /private/tmp/awf-liveness-probe-021/settings.json \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --disable-slash-commands --tools Bash --allowedTools Bash \
  --permission-mode dontAsk --session-id {fresh-uuid} \
  --system-prompt 'You are performing a bounded local lifecycle experiment. Follow the user instructions exactly. Use no commands beyond the single requested shell command.'
```

The driver sent exactly one streaming-input user message. It instructed the agent to start the
command in the background, say `AWF_LIVENESS_WAITING` and end its turn, then say
`AWF_LIVENESS_RESUMED` if a later native completion notification arrived. The driver kept stdin
open until the second result or an error, then closed it. **It sent no second prompt and did not
inject the task notification.** Keeping input open is material: this was not a one-shot print
process whose stdin ended after the initial prompt.

The temporary driver, settings, hook, raw local trace, and summary are retained under
`/private/tmp/awf-liveness-probe-021/` for review. Claude also saved its native transcript for
session `da485892-3460-4e66-a6ea-e8136d6956e9` in the project directory corresponding to that
scratch cwd. No real workflow or repository was run.

## Observed trace

Times below are UTC on 2026-10-04. Hook timestamps are the local hook's observation time;
transcript timestamps are native event fields. They are different clocks/observation points,
so fine ordering uses the stream's record sequence rather than assuming timestamp sorting
reconstructs causality. Task IDs below are replaced with `task-1`.

| Time | Source | Observation |
| --- | --- | --- |
| 19:30:24.990 | PreToolUse hook | The single Bash command begins. |
| 19:30:25.351 | PostToolUse hook | Background launch returned; native task ID available. |
| 19:30:26.434 | Stop hook | `background_tasks` contains `task-1`, type shell, status running; `session_crons` is empty; message is WAITING. |
| After Stop | Output stream | First successful result is WAITING. The session remains alive. |
| 19:30:37.346 | Task update field | Background command completed. In stream order, empty `background_tasks_changed` preceded this update and `task_notification`. |
| 19:30:37.347 | Transcript line 25 | Completion notification enqueued for `task-1`. |
| 19:30:37.360 | Transcript line 26 | Generic queue dequeue, carrying no task identity. |
| 19:30:37.361 | Transcript line 27 | New user-role message contains the matching task notification. |
| 19:30:37.393 | UserPromptSubmit hook | The prompt contains the matching native completion notification. |
| 19:30:38.643 | Transcript line 30 | Assistant text is RESUMED, with `stop_reason: end_turn`. |
| 19:30:38.677 | Stop hook | Both arrays explicitly empty; message is RESUMED. |
| After Stop | Output stream | Second successful result is RESUMED. |
| 19:30:38.728 | SessionEnd hook | Driver has closed stdin and session exits cleanly. |

Selected hook data, with identities shortened:

```json
{"hook_event_name":"Stop","background_tasks":[{"id":"task-1","type":"shell","status":"running"}],"session_crons":[],"last_assistant_message":"AWF_LIVENESS_WAITING"}
{"hook_event_name":"Stop","background_tasks":[],"session_crons":[],"last_assistant_message":"AWF_LIVENESS_RESUMED"}
```

The live stream additionally emitted `background_tasks_changed`, `task_started`, `task_updated`,
and `task_notification`. Those exact extra stream shapes are empirical observations of 2.1.289,
not a promise that every CLI version or pane transcript exports the same interface. The final
native transcript contained the enqueue/dequeue/user-message chain, but not the SDK stream's
registry-change events as equivalent top-level records.

## Cross-check against the original pane transcript

A read-only second pass over the existing AIRS-1515 **Claude 2.1.287** transcript found an
additional distinction beyond the previously documented killed-task notifications:

- A successful subagent completion was enqueued at **20:59:17.277Z**, line 1745.
- A generic dequeue followed at **20:59:17.288Z**, line 1746.
- The matching completion was later removed with reason **`absorbed_mid_turn`** at
  **20:59:28.171Z**, line 1758, with a `deliveryId`. More foreground work followed before
  an assistant `end_turn` at line 1768.
- The same subagent ID subsequently produced another completion, enqueued at **20:59:43.888Z**,
  line 1771, and removed with the same reason at **20:59:47.764Z**, line 1780.

This is existing pane evidence of mid-turn absorption and repeated lifecycles under one agent
ID. It is not proof that every dequeue consumes every task notification. The first enqueue-to-
absorption gap is **10.894 seconds**; closing on enqueue would be premature. The native records
also have timestamps that are not strictly ordered by transcript append position. Preserve
source order/correlation instead of sorting by wall-clock timestamps.

The private source transcript is session `5dbd8155-35fa-42da-968a-9a33e435f361` under
`~/.claude/projects/-Users-roman-dev-braintrust-agent/`. Only metadata was extracted here;
private task content and tool output are omitted.

## Architectural conclusion and remaining gate

A production Claude observer should prefer the documented Stop snapshot over inferred task
counts, retain a waiting/handoff obligation after a yielded native turn, and observe continued
model work plus a later native stop before declaring that continuation settled. A task's
terminal status answers what happened to the task; it does not answer whether its parent
operation has finished. The probe gives a concrete regression sequence for this rule.

The UserPromptSubmit hook is a useful observed continuation boundary in this experiment,
but it does not by itself guarantee model execution: another hook or an API failure can stop
processing. Later assistant/Stop evidence matters. Mid-turn absorption also needs coverage;
requiring a new UserPromptSubmit for every delivered task would miss that case.

The exact **pane transport** remains a required implementation gate: install an observation-only
hook in a temporary pane session, reproduce this sequence, correlate Herdr readiness with the
hooks and transcript, and verify cancellation/cleanup. This experiment deliberately used
streaming print mode because the CLI's native monetary budget option only applies to print mode.
Do not relabel it a Herdr test or switch the project's pane transport just to match the probe.
Monitor, background subagents, recurring schedules, lost hooks, sandbox boundaries, and
permission/API-error paths also remain unmeasured here. No runtime implementation changed.

Primary documentation consulted before the experiment:
[Stop hook input](https://code.claude.com/docs/en/hooks#stop-input),
[streaming versus single input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
and [SDK task messages](https://code.claude.com/docs/en/agent-sdk/python#taskstartedmessage).
Installed `claude --help` independently confirmed the flags, including the print-only budget.
