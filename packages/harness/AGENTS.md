# @agentswf/harness

Drive one coding agent through a configured session adapter, prompt it, know when it settled, read
its raw outcome and what it cost. Herdr currently provides TUI sessions, each in a pane, and a direct subprocess
provides headless sessions. A workflow chooses an agent's placement, `tui` or `headless`; which
provider serves each placement is operator configuration and not part of the workflow interface.

This package knows nothing about workflows, run directories, or how a value gets reported. It
must never import `@agentswf/engine` — the dependency runs the other way.

| File | Holds |
| --- | --- |
| `spec.ts` | every harness's argv, output readers, session-file reader and billing, in one table; Herdr's startup screens are in `herdr-startup.ts` |
| `sandbox-needs.ts` | what each harness needs to run in a sandbox: its home variable, credentials, model domains, executable and install tree, and the flags that turn off model-side search; `hostHome`, the same home for a host agent that needs one for skills |
| `capabilities/skills.ts` | where an agent's skills go for its harness, and the arguments and environment that hold it to exactly those |
| `state.ts` | where the operator's own harness state lives, which no sandbox may reach, and the skills root harnesses share |
| `json.ts` | reading what a harness wrote as JSON: stdout, session files and status commands alike |
| `usage/claude.ts`, `usage/codex.ts`, `usage/pi.ts` | reading what an agent spent from the harness's own session files, one record per request |
| `usage/billing.ts` | whether a login is a subscription or metered, from each harness's status command or credentials |
| `usage/accounting.ts` | `SessionAccounting`: the readers and billing for agents launched through one `run`; each host factory builds its own |
| `command.ts` | subprocess execution with a timeout and a capture cap, a sandboxed command as its own group with exactly its environment, and `withholding` for credentials an agent must not get |
| `session-core.ts` | shared `AgentSessionAdapter` lifecycle, status, and cleanup; the active-operation helper and the outcomes every host shares |
| `allowance.ts` | `readAllowance`: what is left of a harness's plan, by its own command or its TUI's usage screen |
| `single-session-host.ts` | one adapter behind the run-host seam: per-agent sessions and snapshots |
| `placement-host.ts` | one run host over a TUI host and a headless one, routing each agent and its accounting by placement |
| `adapters/herdr.ts` | the Herdr run host (one workspace, a tab per agent), the isolated-pane adapter (exercised by tests only), and the command runner every Herdr path uses |
| `turns/record.ts` | reading a pane's turn from its harness's own session files, bounded: the file found by the prompt's delivery marker, then its rows told to the harness's reducer |
| `turns/claude.ts`, `turns/codex.ts` | each harness's reducer over those rows: the prompt taken in, its model's answer, the turn's end or interrupt; claude's also confirms delivery. `turns/fixtures/` holds the rows each version writes |
| `adapters/herdr-protocol.ts` | reading Herdr answers, building its argv, and the waits and outcomes every pane path shares |
| `adapters/herdr-layout.ts` | where a run's panes go: its workspace in each Herdr session, and each agent's pane as its layout says |
| `adapters/herdr-caller.ts` | `awf run --here`: finding the calling session's pane, the run host that prompts into it, and handing it back |
| `adapters/herdr-allowance.ts` | reading a plan's usage screen in a pane of its own, for a harness whose TUI alone shows it |
| `adapters/fork.ts` | forking a session: by its harness's own fork, inside a sandbox where the agent has one, or copied into another home; the calling session's fork |
| `adapters/herdr-startup.ts` | answering the blocks an agent raises before it will accept a prompt |
| `adapters/direct-process.ts` | the headless run host: one subprocess per headless operation |
| `adapter.ts` | the engine-facing adapter seam |
| `types.ts` | `Harness` and `SettledState` |
| `testing/fake.ts` | scriptable engine-facing adapter and a manual clock |
| `testing/herdr-cli.ts` | a model of the Herdr `HERDR_VERSION` names (0.9.1): pane width, per-process environment, startup blocks, input readiness |
| `testing/turn-records.ts` | a test's own claude and codex homes, and the turn records a fake harness writes into them |

Before editing:

- **`SettledState` keeps `unknown` distinct from `done`.** A reading that proves nothing must
  not read as a turn that completed. E1 is why.
- **Each result-bearing operation gets a fresh process environment.** Scrub inherited metered
  credentials first. Nothing about the operation goes in: the return channel travels in the prompt,
  for the reason [`docs/design/README.md`](../../docs/design/README.md#what-an-agent-inside-a-session-sees)
  gives. A nudge is another delivery into the same operation — the same pane on Herdr, a resumed
  process headless — and a later operation never reuses the previous environment.
- **A saved answer is not native release.** Engine callers use answered release with
  `awaitCompletion` and wait within its grace before returning workflow success. A queued
  check-in must be received before fresh native completion can release it. Keep observer
  cancellation distinct from native cancellation. Caller sessions never receive a stop-finishing
  interrupt after an answer; uncertain release is quarantined and handed back.
- **Receipt has three facts:** dispatched, accepted by the native queue, and received by the
  model. The engine owns their timing policy; adapters expose only measured evidence. A quiet
  screen and an exited prompt command are not receipt. Transcript baselines, bytes, rows and
  cumulative tracked files are bounded. Do not add task registries or widen supported placements
  from another placement's measurement.
- **Low-level finishing is still bounded.** Standalone callers may use the older `finishing`
  disposition; the engine's success path must request confirmed completion. Only the newest
  native turn updates session status, and every observer ends on release or cancellation.
- **A session adapter is not a provider.** Herdr, a future tmux integration, and direct subprocess
  execution are replaceable session adapters selected by operator configuration. Each serves one
  placement and refuses an agent asking for the other, so a direct caller of the headless adapter
  sets `placement: "headless"`, and `metered: true` for claude.
- **The engine uses only the run host.** It opens sessions through `AgentRunHostFactory`, never an
  adapter directly.
