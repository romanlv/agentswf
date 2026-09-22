# @wf/engine

The runtime. Today that is the run directory, secure result slots, and the local control plane.
`docs/foundation.md` §6 lists what else lands here — logical-agent identity, alias resolution,
queueing, idempotency, `parallel`, and spend-pool admission.

**The engine is the only writer of the run directory.** Formats come from `@wf/contract/records`;
the I/O is here and stays here.

The installed `wf` command lives in `@wf/cli-agent`, compiles against contract alone, and reaches
this package over the Unix-socket control plane. Each agent gets its own socket and a launcher
that points at it, so the connection *is* the authority: no secret reaches an agent, and no agent
can answer another's call by naming its id. That is the whole guarantee — every agent runs as the
engine's own user, so one that hunts for a sibling's socket on the filesystem will find it.
Keeping agents apart is a sandbox question, not a socket one. `archive-compat.ts` preserves frozen E2/E5
imports; it is not an agent-facing command or a production result path.

`result-validation.ts` never repairs a value. A near-miss is a rejection the agent corrects, not
something the engine quietly fixes. `result-slots.ts` is package-internal; callers outside the
engine use the one-shot `runWorkflow` boundary in `workflow-runner.ts`.

The runner owns one run and then disappears. Its logical agents serialize native operations, and
its parallel scopes own activation, turns, and nested scopes until settlement. If an engine deadline
cannot prove a native turn quiesced, that logical agent is terminalized before its queue advances.
