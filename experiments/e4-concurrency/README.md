# E4 — concurrency

**Unrun.** The one question the experiments never answered, and the only remaining measurement
that would change the engine rather than confirm it.

Everything measured so far was sequential: one call at a time, one agent at a time. Every cost
figure in [`docs/findings/`](../../docs/findings/) is a per-call figure multiplied out, not a
fan-out that actually happened. The engine's `parallel` is designed against an assumption
nothing has tested.

What it has to establish:

- What happens to per-call cost and latency when N agents run at once, per backend.
- Where the ceiling is, and what it is set by — the Herdr server, the machine, or the harness.
- Whether concurrent submissions to the result gate settle exactly once. `writeAccepted`'s
  check-then-write is a check-then-act, and this is the workload that breaks it.
- Whether a pane's usage attribution survives concurrency, or whether E3's `$0` reading is an
  artefact of running one at a time.

`docs/foundation.md` §12 schedules this for Stage 3, after the engine can run something real —
measuring fan-out through `trial.ts` would measure the scaffolding.
