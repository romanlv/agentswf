# @wf/harness

Drive one coding agent through a configured session adapter, prompt it, know when it settled, read
its raw outcome and what it cost. Herdr currently provides pane sessions and a direct subprocess
provides headless sessions; neither provider is part of the workflow interface.

This package knows nothing about workflows, run directories, or how a value gets reported. It
must never import `@wf/engine` — the dependency runs the other way.

| File | Holds |
| --- | --- |
| `spec.ts` | every harness's argv and output readers, in one table; Herdr's startup screens are in `herdr-startup.ts` |
| `command.ts` | subprocess execution with a timeout and a capture cap |
| `session-core.ts` | shared `AgentSessionAdapter` lifecycle, status, and cleanup |
| `adapters/herdr.ts` | the Herdr run host (one workspace, a pane per operation), the isolated-pane adapter (exercised by tests only), and the command runner every Herdr path uses |
| `adapters/herdr-protocol.ts` | reading Herdr answers, building its argv, and the outcomes every pane path shares |
| `adapters/herdr-startup.ts` | answering the blocks an agent raises before it will accept a prompt |
| `adapters/herdr-legacy.ts` | the per-call pane driver the frozen experiments still open |
| `adapters/direct-process.ts` | one subprocess per headless operation |
| `adapter.ts` | the engine-facing adapter seam |
| `types.ts` | legacy driver shapes retained only for frozen experiments |
| `testing/fake.ts` | scriptable engine-facing adapter plus the frozen driver compatibility fake |
| `testing/herdr-cli.ts` | a Herdr 0.8.2 model: pane width, per-process environment, startup blocks, input readiness |

Before editing:

- **`SettledState` keeps `unknown` distinct from `done`.** A reading that proves nothing must
  not read as a turn that completed. E1 is why.
- **Each result-bearing operation gets a fresh process environment.** Scrub inherited metered
  credentials first. Nothing about the operation goes in: the return channel travels in the prompt,
  for the reason [`docs/design/README.md`](../../docs/design/README.md#what-an-agent-inside-a-session-sees)
  gives. A nudge is another delivery into the same operation — the same pane on Herdr, a resumed
  process headless — and a later operation never reuses the previous environment.
- **A session adapter is not a provider.** Herdr, a future tmux integration, and direct subprocess
  execution are replaceable session adapters selected by operator configuration. `BackendKind` in
  `types.ts` exists only for the frozen experiments.
- **The engine uses only `AgentSessionAdapter`.** `AgentSessionDriver`, `CallIdentity`, and the old
  factory names exist solely so frozen experiments remain runnable; do not build new behavior on
  them.
