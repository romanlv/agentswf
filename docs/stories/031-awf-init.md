---
id: "031"
title: "`awf init` sets up a folder for writing workflows"
summary: "`awf init [dir]` writes a hello workflow, its test, package.json, tsconfig, .gitignore and AGENTS.md, never overwriting, and installs agentswf for editor types, so `awf test` passes at once."
type: story
status: awaiting-human-review
priority: P2
epic: launch
discovered_in: "operator, 2026-10-13, after 0.1.0-beta.0 went to npm"
depends_on: ["009"]
---

# `awf init` sets up a folder for writing workflows

## Outcome

With `agentswf` installed, `awf init` in an empty folder leaves a project an author, or their
coding agent, can extend right away: a hello workflow, its test, editor types and the config files.
`awf test` passes in it at once and costs nothing, and `awf run hello/workflow.ts` runs one real
agent.

Why now: `0.1.0-beta.0` is on npm, and today's quick start has an author copy a workflow out of the
README and assemble a `tsconfig.json` from a collapsed section. The test surface's types aren't in
the npm package at all.

## How it works

```
awf init [dir]                       never asks, never overwrites
  ├─ package.json        new, or adds only the missing devDependencies and scripts:
  │                      agentswf, typebox, @types/bun, typescript; test → awf test,
  │                      check → tsc --noEmit
  ├─ tsconfig.json       new only
  ├─ .gitignore          new, or appends only the missing lines
  ├─ AGENTS.md           new only
  ├─ hello/workflow.ts       ┐ templates shipped in @agentswf/engine,
  ├─ hello/workflow.test.ts  ┘ so init works offline and matches awf's version
  └─ bun install         unless --no-install
```

- **Each file that exists, or is a symlink, is skipped and named.** Nothing is deleted or rewritten; `package.json`
  and `.gitignore` are only added to. Running it again changes nothing. What would stop it, such
  as a `package.json` that isn't a JSON object or a file named `hello`, stops it before it writes.
- **`agentswf` is a dev dependency, for types.** `awf` still runs the workflow against its own
  copies. It also puts a local `awf` in `node_modules/.bin`, so the `test` script works without
  the global install.
- **The hello workflow is the README's:** one headless codex agent, one typed answer with a known
  value, so it needs neither Herdr nor a sandbox. Its test answers it on a fake agent and covers an
  agent that never answers.
- **The output is one block:** the files written, those skipped, then `awf test` and
  `awf run hello/workflow.ts`.

## Scope

In scope:

- `awf init [dir] [--no-install]`, its usage text, and a test that the generated folder passes
  `awf test` and `tsc --noEmit`.
- `agentswf/testing` exported from the `agentswf` package, so the test typechecks from npm.
- The README's quick start using `awf init`.

Out of scope:

- More than one template, `--template`, and a sample list (Temporal's `--list-samples`): added
  when there is a second template.
- Interactive prompts, `--force`, and API keys.
- Shipping `docs/workflow-api.md` inside the package; `AGENTS.md` links to it on GitHub.
- Publishing `0.1.0-beta.1`; the operator publishes, with 2FA.

## Context and evidence

- Research, 2026-10-13: tools split into "create" (a new folder; Temporal and CrewAI delete one
  that exists) and "init" (adds to the current one, safe to re-run: Deno, Bun, Playwright,
  Trigger.dev, Dagger). Deno's `main.ts` plus `main_test.ts` is the closest pattern. Bun writes
  CLAUDE.md and Playwright a SKILL.md for coding agents. Pitfalls: fetching templates or logging
  in at init, asking for keys, and suggesting a flag that doesn't exist (Playwright's `--force`).
- `awf test` already serves `agentswf/workflow`, `agentswf/testing` and `typebox` with nothing
  installed (`packages/engine/src/workflow-test-preload.ts`).
- `@agentswf/engine` already exports `./workflow-testing`; `agentswf` exports only `./workflow`.
- The engine's `files` exclude `src/**/*.test.ts`, and `bun test` in this repository would pick
  up a template named `*.test.ts`, so templates carry a `.template` suffix.

## Code map

- `packages/engine/src/operator-cli.ts` — dispatches subcommands; gains `init`.
- `packages/engine/src/run-command.ts` — `usage`, the top-level usage; gains a line.
- `packages/engine/src/init-command.ts` (new) — parse, write, install.
- `packages/engine/src/init-template/` (new) — the template files.
- `packages/agentswf/` — gains `src/testing.ts` and the `./testing` export.
- `tests/workflow-api-samples.test.ts` — the precedent for running a generated folder under
  `awf test`.
- `README.md` — quick start and the editor-types section.

## Tasks at a glance

- [x] 1. `agentswf/testing` exported from the `agentswf` package
- [x] 2. `awf init` writes the folder and installs
- [x] 3. The README's quick start uses `awf init`

## Open questions

None. Settled by the operator, 2026-10-13: write `AGENTS.md` by default (never overwriting), the
hello workflow uses codex, and the design is recorded here first.

## Task details

### 1. `agentswf/testing` exported from the `agentswf` package

Work: `packages/agentswf/src/testing.ts` re-exports `@agentswf/engine/workflow-testing`.

Done when: a scratch consumer of the packed tarballs passes `tsc` on a test importing it.

### 2. `awf init` writes the folder and installs

Work: `init-command.ts` and the templates; `awf init -h`; dispatch and usage.

Done when: a test runs `awf init --no-install` into an empty folder, then `awf test` there passes,
and `tsc --noEmit` passes with `agentswf`, `typebox` and `@types/bun` linked in; a second
`awf init` writes nothing; an existing `package.json` keeps its fields and gains only what is
missing.

### 3. The README's quick start uses `awf init`

Done when: the quick start's first workflow comes from `awf init`, and the editor-types section no
longer says the npm package lacks `agentswf/testing`.

## Verification

- [x] `bun test`: 1907 pass, 1 fail. The failure, "the samples quoted from an example are still
  in it", fails on main too and is not this story's.
- [x] `bun run check`: clean.
- [x] By hand, 2026-10-13: the six packages packed at `0.1.0-beta.1`, installed through
  `overrides` into a folder `awf init` wrote; there `bun run test` passed 2, `bun run check`
  passed, and the installed `awf init` wrote a second folder from the packed templates.
- [ ] After publishing `0.1.0-beta.1`: `bun add -g agentswf@beta`, then `awf init` with its
  `bun install` in an empty folder.

## Implementation notes

- **Versions bumped to `0.1.0-beta.1`** in the six published manifests, because `awf init` pins
  `agentswf` to `^{the engine's version}` and `agentswf/testing` is new. Until `bun run release`
  publishes it, `awf init`'s `bun install` fails: the version isn't on npm.
- **`typescript` and a `check` script** are added beside the planned dev dependencies, so
  `bun run check` typechecks without a global tsc. The versions match the root's catalog, which a
  test holds.
- **Templates are `*.template` files** under `packages/engine/src/init-template/`, outside this
  repository's `tsc`, Biome and `bun test`. `tests/init-command.test.ts` proves them instead: the
  generated folder passes `awf test` and `tsc`, and the README's hello is the template's, minus
  comments.
- **`AGENTS.md` links the API doc on `main`,** which can drift ahead of a pinned beta. Accepted
  until the doc ships in the package.

## Review record

- Architecture and scope: no blockers. Fixed: the `agentswf` pin is a caret range, and a test
  holds it to the engine's version; a test holds the README's hello to the template; the README
  names `typescript`. Recorded above: the unpublished version and the drifting doc link.
- Correctness and proof: fixed: a `package.json` that is JSON but not an object, a symlink
  (dangling ones were written through), and a path in the way (a partial write, then a raw
  `EEXIST`) are all found before anything is written, each with a test; the `cd` line is
  shell-quoted; peer and optional dependencies count as declared; CRLF is kept; the package name
  is cut to 214 characters. Recorded: the tarball proof is by hand, above.

## Human review

- [ ] Record the operator's approval or requested changes here.
