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
| `packages/engine` | the runtime: run-directory I/O, result slots, and the local control plane; `src/accounting` prices and sums finished runs |
| `packages/cli-agent` | the in-session `wf` command; imports contract only and talks over wire |
| `packages/sandbox` | sandboxes a workflow opens: the provider seam, resolution, and the providers; imports contract only |
| `packages/autoresearch` | evaluating workflows against cases with known answers: review fixtures, `collect`, `draft-key` and their agent votes; a consumer of the engine |
| `examples/` | scenario workflows, written against the author surface and pure schema authoring libraries |
| `experiments/_archive/` | E1–E3, E5–E6. Frozen evidence. Do not refactor to taste |
| `docs/status.md` | what runs today and what is next. Update it when a story or stage changes state |
| `docs/testing.md` | the test levels, from free to live, what each costs, and when to run it |
| `docs/findings/` | what the measurements settled. Cite it; edit it only to record a new measurement |
| `docs/reference.md` | surveyed repositories: what was taken, rejected, still unmined |

Seven boundaries, enforced by `bun run scripts/check-boundaries.ts`:

1. `contract` imports nothing, performs no I/O, and uses no runtime-specific API.
2. `engine/src/accounting` imports contract only, performs no I/O, and uses no runtime-specific API.
3. `cli-agent` imports contract only and performs no run-directory I/O.
4. `sandbox` imports contract only. harness and engine import its seam, `@wf/sandbox`, and their tests `@wf/sandbox/testing`; only `engine/src/operator-runtime.ts` imports a provider, and no provider imports another. The same holds for decision providers in `engine/src/decisions/`: only `operator-runtime.ts` imports `openrouter`, and only tests import `fake`.
5. `autoresearch` imports contract and the engine's public entry only, never a harness; its review format stays pure outside the files that do I/O.
6. `examples/` imports the author surface and approved pure schema libraries — never the engine or a harness.
7. A cross-package import must be a declared dependency, not just a hoisted symlink.

## Working here

```sh
bun install
bun test                  # everything; no live agents, no cost
bunx tsc --noEmit
bun run scripts/check-boundaries.ts
bun run check             # Biome lint and format check, tsc, and the boundaries
bun run format            # Biome: format, organize imports, apply safe fixes
bun run eval              # live agents on cheap models: ~7 min, about $0.70
```

`bun install` points `core.hooksPath` at `.githooks`, whose pre-commit runs Biome's safe fixes on the
staged files and stages the result; what it cannot fix blocks the commit. Biome skips `experiments/_archive`, `docs` and fixtures. A lint rule is suppressed only at its
site, with a `biome-ignore` comment saying why.

`*.eval.ts` is anything that spends money on live agents. It is excluded from `bun test` and
run explicitly: `bun run eval` runs them all. [`docs/testing.md`](docs/testing.md) says which live check
to run when, and what each costs.

Comments are sparse: one only for non-obvious intent, a trade-off, or a constraint the code
cannot express. Never restate the code or narrate a change.
