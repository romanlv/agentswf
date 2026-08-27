# @wf/contract

**Pure: types and pure functions. No I/O, no `Bun.*`, no `node:` import.** That is a sharper
rule than "zero dependencies" and it is mechanically checked — a `Bun.file` or a `node:fs`
import here is a bug, not a judgement call.

Formats live here; the code that reads and writes them does not. `records.ts` is the *shape* of
a call and an attempt; the engine owns the files.

| Entry | Holds |
| --- | --- |
| `.` | `CallResult`, the record formats, the schema subset, the semantic seam |
| `./schema` | the JSON Schema subset, `validate`, `describe`, `formatErrors` |
| `./records` | `CallSpec`, `Attempt`, `RECORD_VERSION` — formats only |
| `./workflow` | the author surface: `WorkflowContext`, `AgentRef`, messaging, composition |
| `./testing` | fixtures shared by tests in other packages |

`./workflow` is designed and unimplemented — it is the surface `examples/` is written against.
Six defects in it are listed in `docs/foundation.md` §7 and are not yet fixed. Read that list
before extending it.

`@wf/contract/wire` — the control-plane messages, with runtime-decodable schemas — does not
exist yet. It arrives with the control plane in Stage 2, not before.

The per-field error text in `schema.ts` is load-bearing: E5 measured 2.00 correction attempts
against 2.90–4.95 for a bare refusal. Do not make it terser.
