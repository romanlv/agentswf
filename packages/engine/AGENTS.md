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

`src/agent-cli/` is `wfa`, the command an agent runs inside its session. The engine bundles it into
one file the agent's sandbox can read, so it imports contract alone, never reads or writes a run
directory, and reaches the engine only over the per-agent Unix socket argued in
[`docs/design/README.md`](../../docs/design/README.md#what-an-agent-inside-a-session-sees). It is a
directory of the engine, not a package of its own: the engine is its only consumer, and the
boundary checker holds it to that rule by path, as it does `src/accounting`.

`wfa result <call-id>` accepts flags the schema names, or JSON from one argument or standard input. Nothing it carries
is secret: the socket it arrives on is what says which agent is answering, so the call id is a
name, not a claim.

`result-validation.ts` never repairs a value. A near-miss is a rejection the agent corrects, not
something the engine quietly fixes. `result-slots.ts` is package-internal; callers outside the
engine use the one-shot `runWorkflow` boundary in `workflow-runner.ts`.

`src/decisions/` answers `decisions.decide`: `directory.ts` resolves aliases and owns deadlines,
retries, artifacts and records; a provider (`seam.ts`) only sends one request and translates it.
Only `operator-runtime.ts` installs a real provider; `fake.ts` is for tests.

`src/workflow-testing/` is the second composition root (ADR 0006): `testWorkflow` runs a workflow
through the real engine on a scripted host, the fake sandbox provider and a scripted decision
provider. It ships as `@agentswf/engine/workflow-testing`, so it imports no test runner.

The runner owns one run and then disappears. Its logical agents serialize native operations, and
its parallel scopes own activation, turns, and nested scopes until settlement. If an engine deadline
cannot prove a native turn quiesced, that logical agent is terminalized before its queue advances.
