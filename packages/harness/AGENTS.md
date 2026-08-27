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
| `adapters/herdr.ts` | the current Herdr adapter for pane sessions |
| `adapters/direct-process.ts` | one subprocess per turn; a nudge resumes the session |
| `adapter.ts` | the designed adapter seam (unimplemented) |
| `types.ts` | the internal session-driver seam used by today's adapters |
| `testing/fake.ts` | a scriptable driver, so nudges and tallies are proven without tokens |

Two things to know before editing:

- **`SettledState` keeps `unknown` distinct from `done`.** A reading that proves nothing must
  not read as a turn that completed. E1 is why.
- **`CallIdentity` is identifiers, not credentials.** Anything holding a `runDir` and a
  `callId` can name a call. Stage 2 replaces it with an unforgeable, invocation-scoped
  capability; until then, nothing may treat it as proof of the right to settle a call.
- **A backend kind is not a provider.** `pane` and `headless` describe execution behavior. Herdr,
  a future tmux integration, and direct subprocess execution are replaceable session adapters
  selected by operator configuration.
- **The two seams have different callers.** The engine will use `AgentSessionAdapter`; concrete
  adapters use the smaller `AgentSessionDriver` internally while Stage D remains unimplemented.

`spec.ts` rows carry `confirmed`. Set it only when the row has actually been run end to end.
