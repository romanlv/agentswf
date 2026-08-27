# @wf/harness

Drive one coding agent: open it as a Herdr pane or a headless process, prompt it, know when it
settled, read its raw outcome and what it cost.

This package knows nothing about workflows, run directories, or how a value gets reported. It
must never import `@wf/engine` — the dependency runs the other way.

| File | Holds |
| --- | --- |
| `spec.ts` | every harness-specific string in the project, in one table |
| `command.ts` | subprocess execution with a timeout and a capture cap |
| `backends/pane.ts` | Herdr-backed sessions |
| `backends/headless.ts` | one subprocess per turn; a nudge resumes the session |
| `adapter.ts` | the designed adapter seam (unimplemented) |
| `testing/fake.ts` | a scriptable stand-in, so nudges and tallies are proven without tokens |

Two things to know before editing:

- **`SettledState` keeps `unknown` distinct from `done`.** A reading that proves nothing must
  not read as a turn that completed. E1 is why.
- **`CallIdentity` is identifiers, not credentials.** Anything holding a `runDir` and a
  `callId` can name a call. Stage 2 replaces it with an unforgeable, invocation-scoped
  capability; until then, nothing may treat it as proof of the right to settle a call.

`spec.ts` rows carry `confirmed`. Set it only when the row has actually been run end to end.
