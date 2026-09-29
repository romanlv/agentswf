# @agentswf/engine

The runtime: the run directory, result slots, the local control plane, and the workflow runner —
logical-agent identity, alias resolution, queueing, idempotency, and `parallel`. Spend-pool
admission lands here too and is not built; `docs/foundation.md` §6 has the full list.

**The engine is the only writer of the run directory**, but for each sandbox's `homes/`, which
the sandboxed harnesses write, what a provider keeps in its sandbox's directory, and `agents/`,
where a host agent given skills gets their copies and, for codex, a home of its own that its
harness writes. `src/skills/` resolves, checks and copies skills; its `sources.ts` does no I/O. Formats come
from `@agentswf/contract/records`;
the I/O is here and stays here.

The installed `wf` command lives in `@agentswf/wf`, compiles against contract alone, and reaches
this package over the per-agent Unix socket argued in
[`docs/design/README.md`](../../docs/design/README.md#what-an-agent-inside-a-session-sees).
`archive-compat.ts` preserves frozen E2/E5 imports; it is not an agent-facing command or a
production result path.

`result-validation.ts` never repairs a value. A near-miss is a rejection the agent corrects, not
something the engine quietly fixes. `result-slots.ts` is package-internal; callers outside the
engine use the one-shot `runWorkflow` boundary in `workflow-runner.ts`.

`src/decisions/` answers `decisions.decide`: `directory.ts` resolves aliases and owns deadlines,
retries, artifacts and records; a provider (`seam.ts`) only sends one request and translates it.
Only `operator-runtime.ts` installs a real provider; `fake.ts` is for tests.

The runner owns one run and then disappears. Its logical agents serialize native operations, and
its parallel scopes own activation, turns, and nested scopes until settlement. If an engine deadline
cannot prove a native turn quiesced, that logical agent is terminalized before its queue advances.
