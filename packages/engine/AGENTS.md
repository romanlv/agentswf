# @wf/engine

The runtime. Today that is the run directory, the result gate, and the `wf` binary an in-session
agent calls. `docs/foundation.md` §6 lists what else lands here — logical-agent identity, alias
resolution, queueing, idempotency, `parallel`, spend-pool admission, the control-plane server.

**The engine is the only writer of the run directory.** Formats come from `@wf/contract/records`;
the I/O is here and stays here.

`bin/wf` and `src/cli.ts` are not `@wf/cli-agent` yet. The designed `cli-agent` compiles against
`contract` alone and reaches the engine over the local control plane; this one links the engine
directly, which is what it actually is today. Stage 2 builds the wire boundary and moves it out.
Do not create the package before then — an announced boundary that is immediately violated is
worse than none.

Known defects, scheduled rather than forgotten:

- **`writeAccepted` is a check-then-act.** Exists-then-write: two concurrent submissions can
  both see no file and both write. Single-writer only until Stage 2 replaces it with an atomic
  create. E4 is the workload that breaks it.
- **`WF_RUN` / `WF_CALL` are not authentication.** See `@wf/harness`'s `CallIdentity`.

`result-layer.ts` never repairs a value. A near-miss is a rejection the agent corrects, not
something the engine quietly fixes up.
