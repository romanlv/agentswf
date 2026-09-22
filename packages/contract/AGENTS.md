# @wf/contract

**Pure: types and pure functions. No I/O, no `Bun.*`, no `node:` import.** That is a sharper
rule than "zero dependencies" and it is mechanically checked — a `Bun.file` or a `node:fs`
import here is a bug, not a judgement call.

Formats live here; the code that reads and writes them does not. `records.ts` is the *shape* of
a call and an attempt; the engine owns the files.

| Entry | Holds |
| --- | --- |
| `.` | `CallResult`, the record formats, the schema subset, the semantic seam |
| `./schema` | the supported JSON Schema subset, structural check, validation, description, and errors |
| `./records` | `CallSpec`, `Attempt` — formats only |
| `./wire` | versioned, runtime-decodable control-plane messages |
| `./workflow` | the author surface: `WorkflowContext`, `AgentRef`, messaging, composition |
| `./testing` | fixtures shared by tests in other packages |

`./workflow` is the author surface used by `examples/`; the engine implementation is intentionally
partial. Read the interface decisions in Story 001 before extending it.

Workflow schemas are structurally compatible JSON Schema objects. Authoring libraries such as
TypeBox are the author's dependency, declared in `examples/package.json` and never here: this
package has no `dependencies` at all, which is the rule it exists to keep. Contract checks the
supported subset and owns validation.

The per-field error text in `schema.ts` is load-bearing: E5 measured 2.00 correction attempts
against 2.90–4.95 for a bare refusal. Do not make it terser.
