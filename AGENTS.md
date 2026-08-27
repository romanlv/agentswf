# awf

An engine that runs workflows made of coding agents. Read
[`docs/foundation.md`](docs/foundation.md) before changing anything structural — it is the
argument behind every boundary here, and this file only restates the parts an agent needs at
the keyboard.

## The rule that matters

**The scarce resource here is design, not code.** A coding agent writes any of this competently
and fast. What it does not do reliably is pick the seams. Completeness is not a goal of this
repository, and feature count is not a measure of it.

So: prefer a smaller surface that is right to a larger one that is plausible. If a change makes
something easy to build but hard to change later — a published type, a record format, a stage
gate — say so and stop. Those cost minutes to fix in a document and months to fix in a shipped
interface.

Anything not yet built is deliberate. Check `docs/foundation.md` §10 before adding it; it says
what would have to happen first.

## Where things go

| Package | Owns |
| --- | --- |
| `packages/contract` | types, schema, record formats. **Pure — no I/O, no `Bun.*`, no `node:`** |
| `packages/harness` | driving one coding agent: adapters, liveness, usage extraction |
| `packages/engine` | the runtime: run-directory I/O, the result gate, and the `wf` binary |
| `examples/` | scenario workflows, written against `@wf/contract/workflow` only |
| `experiments/_archive/` | E1–E3, E5–E6. Frozen evidence. Do not refactor to taste |
| `docs/findings/` | the measurement record. Frozen — cite it, do not edit it |
| `docs/reference.md` | surveyed repositories: what was taken, rejected, still unmined |

Three boundaries, enforced by `bun run scripts/check-boundaries.ts`:

1. `contract` imports nothing, performs no I/O, and uses no runtime-specific API.
2. `examples/` imports the author surface only — never the engine, never a harness.
3. A cross-package import must be a declared dependency, not just a hoisted symlink.

`packages/cli-agent` does not exist yet. Today's `wf` binary links the engine directly, which
is what it is; Stage 2 cuts it over to the local control plane and moves it out. Do not create
the package before the wire boundary is real.

## Working here

```sh
bun install
bun test                  # everything; no live agents, no cost
bunx tsc --noEmit
bun run scripts/check-boundaries.ts
```

`*.eval.ts` is anything that spends money on live agents. It is excluded from `bun test` and
run explicitly.

Comments are sparse: one only for non-obvious intent, a trade-off, or a constraint the code
cannot express. Never restate the code or narrate a change.
