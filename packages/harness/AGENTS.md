# @wf/harness

Drive one coding agent through a configured session adapter, prompt it, know when it settled, read
its raw outcome and what it cost. Herdr currently provides pane sessions and a direct subprocess
provides headless sessions; neither provider is part of the workflow interface.

This package knows nothing about workflows, run directories, or how a value gets reported. It
must never import `@wf/engine` — the dependency runs the other way.

| File | Holds |
| --- | --- |
| `spec.ts` | every harness-specific string in the project, in one table |
| `command.ts` | subprocess execution with a timeout and a capture cap |
| `session-core.ts` | shared `AgentSessionAdapter` lifecycle, authority protection, status, and cleanup |
| `adapters/herdr.ts` | pane operations in fresh capability-bound Herdr workspaces |
| `adapters/direct-process.ts` | one capability-bound subprocess per headless operation |
| `adapter.ts` | the engine-facing adapter seam |
| `types.ts` | legacy driver shapes retained only for frozen experiments |
| `testing/fake.ts` | scriptable engine-facing adapter plus the frozen driver compatibility fake |

Two things to know before editing:

- **`SettledState` keeps `unknown` distinct from `done`.** A reading that proves nothing must
  not read as a turn that completed. E1 is why.
- **Each result-bearing operation gets a fresh process environment.** Scrub inherited workflow
  authority first, then add only that operation's endpoint, id, and capability. A nudge resumes
  native context in a new process or pane; it never mutates or reuses the previous environment.
- **A backend kind is not a provider.** `pane` and `headless` describe execution behavior. Herdr,
  a future tmux integration, and direct subprocess execution are replaceable session adapters
  selected by operator configuration.
- **The engine uses only `AgentSessionAdapter`.** `AgentSessionDriver`, `CallIdentity`, and the old
  factory names exist solely so frozen experiments remain runnable; do not build new behavior on
  them.

`spec.ts` rows carry `confirmed`. Set it only when the row has actually been run end to end.
