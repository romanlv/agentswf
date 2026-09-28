---
id: "009"
title: Install agents.wf from npm on another machine
summary: One naming rule across the repository, an engine that provides the author surface to any workflow it loads, a packed `agentswf` that installs into an empty directory and runs a workflow there, docs a stranger can follow, and 0.0.1 published and tried on the operator's second machine.
type: story
status: draft
discovered_in: "ADR 0005, 2026-09-27"
depends_on: []
---

# Install agents.wf from npm on another machine

## Outcome

On a machine that has never seen this repository, the operator runs:

```sh
bun add -g agentswf             # awf and wf on PATH
mkdir ~/workflows && cd ~/workflows
awf run ./review.ts             # review.ts imports agentswf/workflow; nothing installed here
```

and the workflow runs its agents the same way it would from a clone. A folder that wants
typechecking adds `agentswf` as a dev dependency, for its types. That is 0.0.1. It is for the
operator's own machines, and the author surface stays open to change before 1.0
([[0005-published-as-agentswf]]).

Getting there means four things that don't exist yet:

- **One naming rule.** The repository is `awf`, its packages are `@wf/*`, the domain is agents.wf,
  and the package on npm will be `agentswf`. A reader should be able to tell which name means what.
- **A surface the engine provides.** Today a workflow outside the repository fails on its first
  import. It only works through a `bun link`.
- **A package that installs.** Every workspace package is `private: true`, and nothing assembles
  them into something npm can hold.
- **Docs for someone who isn't us.** The README says "Nothing here is published". Nothing says
  what to install first or how to write a first workflow outside the repository.

Why now: the operator wants the engine on a second machine for personal workflows, and each
week the author surface grows makes every renamed import cost more.

## How it works

```text
repository (workspace)          scripts/pack.ts            npm              any machine
──────────────────────          ───────────────            ───              ───────────
packages/contract  ─┐           dist/agentswf/                              ~/.bun/bin/awf, wf
packages/harness    │           ├ package.json  (made       agentswf@0.0.1       │
packages/sandbox    ├─ copied ─►│  here: bins, exports,  ─►  ──────────────►     ▼
packages/engine     │           │  engines, typebox)                        awf run ./review.ts
packages/cli-agent ─┘           ├ bin/ awf, wf                                   │ loads review.ts;
                                ├ node_modules/@agentswf/*                        │ its import of
                                │   (the internals, laid                          │ agentswf/workflow
                                │    out as in the clone)                         ▼ is the engine's own
                                ├ LICENSE, README.md                        the engine's copy
```

**The workspace stays as it is.** It keeps separate packages with their boundaries.
`scripts/pack.ts` assembles the published package in `dist/agentswf/`, the way opencode's
publish script does:

- it writes a manifest built for publishing;
- it copies the internals into the package's own `node_modules/@agentswf/*`, laid out exactly
  as they are in the clone;
- it copies the root `LICENSE` and `README.md` in.

Inside the tarball, `require.resolve` and `import.meta.dir` find what they find in the clone. The
internals are deliberately not listed as dependencies: `bun add` ignores `bundleDependencies`
and would go looking for `@agentswf/contract` on the registry.

**The engine provides the author surface.** Before `awf run` imports a workflow, it registers
`agentswf/workflow` as a Bun virtual module whose exports are the engine's own copy. pi does
the same for its extensions, with jiti aliases under Node and virtual modules in its Bun binary.
This has three effects:

- a workflow in any folder runs, with no install there;
- the surface it runs against is always the engine's version, never a stale copy in the folder;
- `typebox`, which a workflow writes its schemas with, comes from the engine too, so the
  schemas it validates against are the ones the engine checks results with.

The folder's own `agentswf` is only for the editor and `tsc`. It is declared the way pi tells
extensions to declare their host: a peer or dev dependency, never something that gets loaded.

What people will ask first: **why not a compiled binary, as opencode and codex ship?** It is
possible. A `bun build --compile` binary loads a TypeScript workflow from disk and serves it the
virtual module (tried 2026-09-28). But it needs three things 0.0.1 doesn't:

- the `wf` bundle built at pack time instead of at run time;
- the docker files embedded (`with { type: "file" }`, as opencode embeds its web UI);
- a package per platform, with a wrapper that finds the right one. opencode has 12 of these, codex 6.

A Bun-only user already has Bun, so shipping the source costs them nothing.

**Why Bun only?** The engine uses `Bun.spawn`, `Bun.serve` and `Bun.listen` throughout (ADR 0005).

## Scope

In scope:

- **The naming rule.** Apply it to package names, the README, `foundation.md`'s naming note and
  ADR 0005.
- **The author surface.** `awf run` provides `agentswf/workflow` to the workflows it loads.
- **Packing.**
  - `scripts/pack.ts`, which assembles `dist/agentswf/` and packs it.
  - A pack check, which installs the tarball into an empty directory and runs from there.
- **Docs.**
  - The README becomes the package's front page.
  - A getting-started page covers prerequisites and a first workflow.
  - A LICENSE.
- **Publishing and trying it.** Publish 0.0.1 by hand, tag `v0.0.1`, and install on the second machine.

Out of scope:

- **A Node.js build, compiled JavaScript, `.d.ts` output, or a compiled binary.** See How it
  works. [[foundation]] §13 question 4 stays answered as Bun.
- **Publishing `contract` or `harness` as packages of their own.** pi and opencode publish
  several packages, because each is used on its own. Nothing here is yet.
- **Rewriting git history or making the repository public.** [[scrub-private-references]] owns
  that. This story covers only what the tarball ships, which npm makes public.
- **Renaming the command's own names.** `awf` and `wf`, `~/.awf/runs`, `AWF_*` variables and
  docker's `awf.*` labels all belong to the command under the rule below, and stay.
- **Release automation, release notes and a changelog.** A CI workflow that publishes on a `v*`
  tag through npm trusted publishing (OIDC) is how pi and codex release. npm can only trust a
  publisher for a package that already exists, so the first publish is by hand anyway. Automation
  comes with the second release.

## Context and evidence

- **Fact: the decision is recorded.** [[0005-published-as-agentswf]]:
  - One unscoped package, `agentswf`.
  - Bun only, shipped as TypeScript source.
  - Authors import `agentswf/workflow`.
  - The commands stay `awf` and `wf`.

  It kept the workspace packages as `@wf/*` to avoid churn. The operator has since asked for
  names that match, so task 1 amends that one point.
- **Fact: the internal `@wf/` names are widespread.** 81 TypeScript files import them, across
  `packages`, `examples` and `scripts`. 9 examples import `@wf/contract/workflow`.
- **Fact: there is one external runtime dependency, `typebox`.** Everything else is `node:*` or
  `bun:*`.
- **Fact: a workflow is loaded in the engine's process.** `loadWorkflowFile` in
  `packages/engine/src/workflow-loader.ts` does `await import(pathToFileURL(absolute).href)`.
- **Fact: the engine locates things by repository layout.**
  - `resolveAgentCommand` in `packages/engine/src/agent-launcher.ts` uses
    `require.resolve("@wf/cli-agent/package.json")`.
  - `buildAgentBundle` in the same file runs `bun build` on that entry at run time.
  - `IMAGE_DIRECTORY` in `packages/sandbox/src/docker/index.ts` is `import.meta.dir/../../docker`.

  A tarball that keeps the clone's layout leaves all three working. pi finds its own assets by
  walking up from `import.meta.url` to the nearest `package.json`, overridable by `PI_PACKAGE_DIR`.
- **Fact: both bins are ready to install.**
  - Each has the shebang `#!/usr/bin/env -S bun --no-env-file` (f8d6071).
  - opencode's compiled binary sets `autoloadDotenv: false` for the same reason.
- **Fact: `bun pm pack` fills in version specifiers.** Bun 1.4.0, tried 2026-09-28:
  - It rewrites `workspace:*` to the sibling's version and `catalog:` to the catalog's range.
  - It puts `bundleDependencies` into the tarball's `node_modules`.
  - opencode relies on this and rewrites nothing by hand.
- **Fact: `bun add` fails on bundled dependencies.**
  - When a bundled package is also listed in `dependencies`, `bun add` of that tarball fails:
    `GET https://registry.npmjs.org/@x%2flib - 404`. This happens both locally and with `-g`.
  - `npm install` of the same tarball works.
  - With the bundled name dropped from `dependencies`, `bun add` and `bun add -g` both keep the
    nested `node_modules`. The bin runs and a subpath export imports.
- **Fact: the engine can serve the surface as a virtual module.** Tried with Bun 1.4.0,
  2026-09-28:
  - `plugin({ setup(b) { b.module("agentswf/workflow", () => ({ exports, loader: "object" })) } })`
    serves a workflow in a folder with no `node_modules`, both under `bun` and in a compiled binary.
  - `onResolve` with the same filter does not reach a bare import from outside the project.
  - In the same run, a workflow's own `import "typebox"` failed: the engine has to serve it too.
- **Fact: the reference projects agree on the basics.** Checked 2026-09-28:
  - **Versions:** all three keep every package at one version, set at release. codex keeps
    `0.0.0-dev` in source and stamps the version when it stages.
  - **Republishing:** all three skip a version `npm view` already shows.
  - **Tags:** pi and codex push a tag, `v*` and `rust-v*`, whose CI job publishes through OIDC.
    pi adds `--provenance`.
  - **Smoke test:** pi installs its packed tarballs into a scratch consumer before release.
  - **Package name vs command:** opencode publishes `opencode-ai` for the command `opencode`, the
    same split as `agentswf` and `awf`.
  - **Internal names:** opencode's private internals share the published packages' scope.
  - **License:** a single root `LICENSE`, MIT for pi and opencode, Apache-2.0 plus `NOTICE` for
    codex. opencode copies it into the package it publishes.
- **Fact: nothing is licensed yet.** The repository has no LICENSE, and a package without one
  is "all rights reserved".
- **Fact: the tarball would ship private references.** [[scrub-private-references]] lists
  `packages/harness/src/usage/claude.ts` and two tests that name private work. The tests stay out
  of the tarball, but the source comment would ship.
- **Constraint: publishing is outward-facing.** The operator:
  - claims `agentswf` on npm (this machine is not logged in);
  - approves the publish itself.
- **Constraint: others work on this repository at the same time.**
  - `main` has concurrent sessions ([[story-worktrees]]).
  - The review-scorer worktree is open.

  A rename of 81 files lands as one mechanical commit, at a moment agreed with whoever has a
  branch open.
- **Assumption, unverified: `env -S` works on the second machine.** It is fine on macOS and on
  GNU coreutils 8.30 or later.

## Code map

### Names

- **Package names:** `packages/*/package.json`, `examples/package.json` and
  `experiments/*/package.json` (`@wf/*`).
- **Imports:** every `@wf/` import in `packages`, `examples` and `scripts`.
- **Scripts:**
  - `scripts/check-boundaries.ts` names packages to enforce the seven boundaries.
  - `scripts/eval.ts` may name them too.
- **Docs:** `README.md`, `docs/foundation.md` (the naming note, §6's package list and §13
  question 1), `AGENTS.md`, `docs/adr/0005-published-as-agentswf.md`.
- **Checked, unchanged:** `experiments/_archive/`, which is frozen evidence. If it breaks under
  the rename, it keeps its own names, and that is noted in the story.

### Author surface

- **Change:** `packages/engine/src/workflow-loader.ts`. Register the virtual module once, before
  the first `import`.
- **Tests:** a workflow in a temporary folder with no `node_modules` loads and gets the engine's
  surface. Its tests sit next to `workflow-loader.ts`.
- **Checked:** `isExecutableWorkflow` compares `kind` as a string, not by `instanceof`. So a
  workflow built against another copy of the surface still loads, and the virtual module is about
  one version, not about identity.

### Package

- **New:** `scripts/pack.ts`. It assembles `dist/agentswf/` and runs `bun pm pack` there.
- **New:** a pack check. It could be `scripts/pack-check.ts` or a `*.local.test.ts`. It installs
  the tarball into an empty directory, then checks:
  - it runs `awf` and `wf`;
  - a workflow in a folder without `agentswf` runs;
  - with `agentswf` added as a dev dependency, a workflow passes `tsc --noEmit`;
  - the docker directory is present;
  - no test file, `workspace:` or `catalog:` specifier, or private name is in the tarball.
- **Likely unchanged:** `resolveAgentCommand`, `buildAgentBundle` and `IMAGE_DIRECTORY`. The
  pack keeps the clone's layout, and the pack check proves it.
- **`.gitignore`:** `dist/`.

### Docs

- **`README.md`:**
  - what agents.wf is;
  - prerequisites;
  - install;
  - a first workflow;
  - where the design docs are.

  It replaces the line "Nothing here is published".
- **A getting-started page,** new, under `docs/`, with:
  - prerequisites: bun, git, Herdr, and agent CLIs logged in;
  - the optional sandboxes: srt (plus bubblewrap on Linux) and docker;
  - a workflow folder, with `agentswf` as a dev dependency for types;
  - the smallest workflow;
  - `awf run`, and where runs are kept;
  - that `awf` loads no `.env`, and how Jev still finds `OPENROUTER_API_KEY`.
- **`LICENSE`** at the root. `scripts/pack.ts` copies it into the package.
- **`docs/status.md`:** a line when 0.0.1 is out.

## Proposed design

**The naming rule, one sentence per name:**

- **agents.wf** is the project, in prose and on the README, and **`agentswf`** is its npm package
  and GitHub name.
- **`awf`** is the operator's command and everything it owns at run time: `~/.awf/runs`, `AWF_*`,
  `awf.*` docker labels, `awf-*` containers.
- **`wf`** is the agent's command.
- **`@agentswf/*`** are the workspace packages. They stay private, and their names never reach a user.

The rule goes into `foundation.md`'s naming note and into ADR 0005 as an amendment. Tools named
after the command (`awf-lab`) follow the command.

**The author surface.** `awf run` registers Bun virtual modules before it imports a workflow:

- `agentswf/workflow`, whose exports are the engine's own `@agentswf/contract/workflow`;
- `typebox` and `typebox/value`, whose exports are the engine's own copy, as pi provides typebox
  to its extensions.

Provided `typebox` pins one version for every workflow; that is the point, since a result schema
and the engine's validation of it then agree. A workflow that imports any other package installs
it in its own folder, as any TypeScript file would. Nothing else in the engine becomes importable
by that route, and the list is part of the author surface: adding a name later is cheap, removing
one breaks workflows.

There is no alias for the old `@wf/contract/workflow`: the operator upgrades their existing
workflows to `agentswf/workflow` along with the rename, which is why it lands before 0.0.1.

**The package.** `scripts/pack.ts` writes `dist/agentswf/package.json`:

```json
{
  "name": "agentswf",
  "version": "0.0.1",
  "type": "module",
  "bin": { "awf": "bin/awf", "wf": "bin/wf" },
  "exports": { "./workflow": "./node_modules/@agentswf/contract/src/workflow/index.ts" },
  "engines": { "bun": ">=1.4.0" },
  "dependencies": { "typebox": "^1.3.34" },
  "license": "…",
  "repository": { "type": "git", "url": "…" }
}
```

- **What gets copied:** the internals' `package.json`, `src` and `sandbox/docker/` go into
  `node_modules/@agentswf/*`. Tests do not. The script rewrites each internal manifest's
  `workspace:*` to a path the tarball holds.
- **Bins:** `bin/awf` and `bin/wf` are the two entry files, or one-line re-exports of them, with
  the existing shebang.
- **Versions:** the workspace packages keep `0.0.0`, and the pack script takes the published
  version from its argument, as codex's staging does. A version already on npm is refused before
  packing.
- **`engines.bun`:** npm and bun only warn on it. The shebang is what actually requires Bun.

The first pack decides whether an `exports` target inside the package's own `node_modules`
typechecks in a consumer's editor. If it doesn't, a thin `workflow.ts` at the package root
re-exports it.

Alternatives rejected:

- **Keep `@wf/*` internally (ADR 0005 as written):** the operator wants one set of names, and the
  cost only grows.
- **A static `packages/agentswf` manifest with `bundleDependencies`:** `bun add` tries to fetch
  each bundled package from the registry and fails (see Context).
- **Copying the internals' sources into the package and rewriting their imports:** the rewrite
  touches every file and moves `import.meta.dir`. Copying them whole into `node_modules` keeps
  both.
- **The workflow folder's own `agentswf` at run time (`bunx awf`):**
  - the global command and the folder's copy can disagree;
  - a folder without an install can't run;
  - a rename breaks every folder at once.

  pi's host-provided imports avoid all three.
- **Use `package.json` `imports` (`#contract`) instead of a scope:** boundary 7 checks declared
  dependencies between workspace packages, and one package with import aliases would lose that.
- **A scoped published package (`@agentswf/agentswf`, `@evolvedstack/…`):** ADR 0005 chose an
  unscoped import line.
- **A compiled binary with per-platform packages:** see How it works. It stays open for later.
- **Publishing each internal package, as pi does:** nothing outside uses them on their own yet,
  and each would become a published surface.

## Tasks at a glance

- [ ] 1. The repository follows one naming rule
- [ ] 2. `awf run` provides `agentswf/workflow` to a workflow in any folder
- [ ] 3. `agentswf` packs, installs into an empty directory, and runs a workflow there
- [ ] 4. The README, a getting-started page and a LICENSE let a stranger do the same
- [ ] 5. 0.0.1 is published, tagged, and running on the operator's second machine

## Open questions

### 1. Names

- **Internal scope:** `@agentswf/*`, or something shorter (`@awf/*`)? Private packages never
  publish, so no scope needs claiming. But claiming the free npm org `agentswf` stops anyone else
  from taking the scope, and leaves a later split open.
  - Recommended: `@agentswf/*`, and claim the org.
- **Repository:** rename `romanlv/awf` to `agentswf/agentswf` (with the GitHub org) or to
  `romanlv/agentswf`? GitHub redirects the old URL either way.
  - It decides the `repository` field and the README's links.
- **Timing:** when does the 81-file rename land? It affects the open review-scorer worktree, so
  agree the moment first.

### 2. Author surface

- **Old import name:** decided 2026-09-28, no alias. The operator upgrades existing workflows
  with the rename.
- **`typebox`:** decided 2026-09-28, the engine provides `typebox` and `typebox/value`.

### 3. Package

- **`autoresearch` and `awf-lab`:** do they ship in `agentswf`, or stay repository-only until
  story 008 settles?
  - Recommended: repository-only for 0.0.1.
- **Bun version:** does `engines.bun` pin the minimum this repository tests on, or the one
  `sandbox/docker`'s `BUN_VERSION` uses (1.4.0)?

### 4. Docs

- **License:** MIT (pi, opencode) or Apache-2.0 with a NOTICE (codex)? Apache-2.0 adds a patent
  grant.
- **Getting-started location:** does the page live in `docs/` or in the README itself?
  - Recommended: the README holds install and a first workflow; `docs/getting-started.md` holds
    the rest.

### 5. Publish

- **Second machine:** what OS is it? On Linux, check `env -S`, and srt's bubblewrap requirement.
- **Who publishes:** the operator runs `npm publish` on the packed tarball, or logs in so this
  session can, with 2FA either way.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. The repository follows one naming rule

Outcome: every workspace package, import, doc and ADR follows the rule in Proposed design, and
nothing else changes behaviour.

Execution:

- [ ] Plan: settle the internal scope and the repository name (open questions 1). Agree the
  commit's timing with open branches. List every file the rename touches.
- [ ] Implement:
  - the mechanical rename;
  - the `foundation.md` naming note, §6 and §13 question 1;
  - ADR 0005 amended;
  - `AGENTS.md`.
- [ ] Review: have two read-only subagents review this task's actual diff and test output. One
  reviews architecture and scope, the other correctness and proof.
- [ ] Resolve: fix or disposition every finding.
- [ ] Verify: satisfy every `Done when` item.

Work:

- Rename in one commit, with no other change in it, so an open branch can rebase through it
  with a single find-and-replace.

Done when:

- `bun install`, `bun test` and `bun run check` pass.
- `grep -r "@wf/"` finds nothing outside `experiments/_archive/` and git history.
- `foundation.md`, ADR 0005 and `AGENTS.md` state the same rule.

### 2. `awf run` provides `agentswf/workflow` to a workflow in any folder

Outcome: a workflow outside the repository runs under the clone's `awf`, without `bun link`.

Execution:

- [ ] Plan: decide where the plugin is registered, once per process, before the first workflow
  import, and check `typebox`'s subpaths the examples use are all served.
- [ ] Implement: the virtual modules in `workflow-loader.ts`: `agentswf/workflow`, `typebox`,
  `typebox/value`.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings.
- [ ] Verify: satisfy every `Done when` item.

Work:

- `examples/` keeps resolving through the workspace, so the repository's own typecheck is
  unchanged.

Done when:

- A test loads a workflow from a temporary folder with no `node_modules` that imports
  `agentswf/workflow` and `typebox`, and gets the engine's copies of both.
- `bun run awf run {folder}/x.ts` from the clone reaches opening the workflow's first agent.

### 3. `agentswf` packs, installs into an empty directory, and runs a workflow there

Outcome: a pack check proves an installed `agentswf` works without the repository.

Execution:

- [ ] Plan: settle open questions 3. Pack by hand once, install it, and record what the design
  above got wrong.
- [ ] Implement:
  - `scripts/pack.ts`;
  - the pack check;
  - the private reference in `packages/harness/src/usage/claude.ts` removed.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings, and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item.

Work:

- The pack check runs where `bun test` runs. If installing needs the network, for `typebox`, it
  runs as a `*.local.test.ts` instead.

Done when:

- The tarball holds:
  - no `*.test.ts`;
  - no `workspace:` or `catalog:` specifier;
  - no private name;
  - `docker/Dockerfile`, `proxy.js` and `relay.js`.
- Installed with `bun add -g` into an empty temporary `BUN_INSTALL`:
  - `awf --help` and `wf --help` run;
  - a workflow in a folder without `agentswf` loads, and `awf run` reaches opening its first agent.
- With `agentswf` as a dev dependency, that workflow passes `tsc --noEmit`.
- From the clone: the existing tests pass, and `bun run eval` still passes its non-sandbox
  scenarios.

### 4. The README, a getting-started page and a LICENSE let a stranger do the same

Outcome: someone with only the npm page can install agents.wf and run a first workflow.

Execution:

- [ ] Plan: settle open questions 4.
- [ ] Implement: the README, `docs/getting-started.md` and `LICENSE`.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews.
- [ ] Resolve: disposition findings.
- [ ] Verify: satisfy every `Done when` item.

Work:

- The first workflow on the page is one the pack check runs, so the docs can't drift from what
  works.

Done when:

- A subagent with no repository context follows the README and getting-started page against the
  packed tarball, and reaches `awf run`.
- The README no longer says nothing is published.

### 5. 0.0.1 is published, tagged, and running on the operator's second machine

Outcome: `bun add -g agentswf` works anywhere, and the operator has used it for a real workflow.

Execution:

- [ ] Plan:
  - the operator has claimed `agentswf` on npm, and the GitHub org if chosen;
  - confirm who publishes.
- [ ] Implement:
  - `scripts/pack.ts 0.0.1`;
  - tag `v0.0.1` and push it;
  - `npm publish` of the tarball, with the operator's approval.
- [ ] Review: compare the published file list with the pack check's.
- [ ] Resolve: if the published package is wrong, publish 0.0.2. npm doesn't allow a version to
  be republished.
- [ ] Verify: satisfy every `Done when` item.

Work:

- Once the package exists, configure npm trusted publishing for the repository. That makes the
  next release CI's job, in a story of its own.

Done when:

- `npm view agentswf` shows 0.0.1, with bins `awf` and `wf`.
- On the second machine, `bun add -g agentswf` runs one of the operator's workflows with a live
  agent. What it needed that the docs didn't say goes back into task 4's pages.
- `docs/status.md` says 0.0.1 is out and how it installs.

## Verification

Automated:

- [ ] The author-surface test: a workflow from a folder with no `node_modules` loads.
- [ ] The pack check: pack, install into an empty `BUN_INSTALL`, bins run, a workflow loads and
  typechecks.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] `bun run eval` from the clone after task 3: the repository layout still works.
- [ ] One live workflow on the second machine from the published package (task 5).

## Review record

Record reviews under the task they cover.

### Refinement, 2026-09-28

The draft was compared with pi, opencode and codex, and Bun 1.4.0's packing was tried against a
scratch workspace. Changes from the first draft:

- **`bundleDependencies` in a static manifest is replaced by a pack script** that writes the
  manifest itself. `bun add` fails on a bundled package that is also a dependency.
- **The engine now provides the author surface as a virtual module.** A workflow folder no longer
  runs its own copy.
- **"`--compile` supports neither" is corrected.** A compiled binary loads workflows from disk,
  and is deferred rather than impossible.
- **Release automation stays out, now with its reason:** trusted publishing needs the package to
  exist first.
- **The operator decided, 2026-09-28:** there is no alias for `@wf/contract/workflow`, because
  existing workflows are upgraded with the rename. The engine provides `typebox` alongside
  `agentswf/workflow`.

## Readiness

- [x] Outcome and boundaries are concrete.
- [ ] Relevant implementation, callers, and tests are mapped. Self-location sites are known; the
  pack check will show whether there are others.
- [x] Evidence and research support the proposed design.
- [ ] Expensive interface, record-format, and stage-gate decisions are settled. `agentswf/workflow`
  and how it resolves are settled; the internal scope and the license are not.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
