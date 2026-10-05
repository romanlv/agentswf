# Result acceptance and stop ordering

Measured 2026-10-04 while reviewing [[021-turn-liveness-and-limits|story 021]].
This free, deterministic probe exercises the current result-slot registry with an injected clock
and in-memory persistence. It starts no agents and writes no run artifacts. It measures control
flow around persistence, not filesystem durability or provider behavior.

## Observed behavior

| Held work | Stop request | Result |
| --- | --- | --- |
| Accepted-result write, admitted at time 0 | Close requested at time 20, after deadline 10 | Acceptance wins; `acceptedAt` is 20; close returns `false`. |
| Semantic validation | Close requested at time 5, before deadline 10 | Closure wins; submission is rejected as `closed-operation`; no accepted write occurs. |

Validation runs outside the slot's serialized transition. After validation, acceptance checks
availability and awaits `writeAcceptedExclusive` inside that transition. Closure and the expiry
callback queue behind that write. Therefore serialization alone does not mean “a result persisted
after the deadline is rejected.” A write that never resolves can also hold the transition open;
this probe releases its gate and does not measure hung-I/O recovery.

Story 021 must define the winning point explicitly: admission to commit, durable publication, or
another arbitration rule. It must distinguish that point from persistence completion, preserve
an authoritative answer already written, and bound unresolved persistence. The existing
delayed-validation test does not cover the accepted-write case.

Sources: [[packages/engine/src/result-slots.ts|result-slot registry]] and
[[packages/engine/src/result-slots.test.ts|result-slot tests]].

## Reproduce

Save this code to a temporary `.ts` file and run `bun /path/to/probe.ts` from the repository root.
The clock advances explicitly; no sleeps or real expiry timers are used.

```typescript
const { createResultSlotRegistry } = await import(
  `${process.cwd()}/packages/engine/src/result-slots.ts`
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const held of ["write", "validation"] as const) {
  let now = 0;
  let writes = 0;
  const entered = deferred();
  const gate = deferred();
  const pause = async () => {
    entered.resolve();
    await gate.promise;
  };
  const slots = createResultSlotRegistry({
    runDir: "unused",
    now: () => now,
    schedule: () => () => {},
    persistence: {
      writeCall: async () => {},
      recordAttempt: async () => {},
      writeAcceptedExclusive: async () => {
        writes += 1;
        if (held === "write") await pause();
        return true;
      },
    },
  });
  const binding = await slots.open({
    operationId: "probe",
    agentId: "agent",
    question: "Return an answer",
    deadline: { unixMilliseconds: 10 },
    semantic: async () => {
      if (held === "validation") await pause();
      return { kind: "accepted" };
    },
  });
  const submitting = slots.submit({
    operationId: "probe",
    agentId: "agent",
    raw: "true",
    source: "wf",
  });
  await entered.promise;
  now = held === "write" ? 20 : 5;
  const closing = slots.close("probe");
  if (held === "validation") await closing;
  gate.resolve();
  const submission = await submitting;
  console.log(JSON.stringify({
    held,
    submission,
    closed: await closing,
    settlement: await binding.settled,
    writes,
  }));
}
```

Observed output:

```json
{"held":"write","submission":{"kind":"accepted","value":true,"attemptRecorded":true,"acceptedAt":20},"closed":false,"settlement":{"kind":"accepted","value":true,"attemptRecorded":true,"acceptedAt":20},"writes":1}
{"held":"validation","submission":{"kind":"rejected","code":"closed-operation","error":"closed-operation"},"closed":true,"settlement":{"kind":"closed"},"writes":0}
```
