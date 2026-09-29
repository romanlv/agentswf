---
id: "009"
title: Install agents.wf from npm on another machine
summary: One naming rule across the repository, an engine that provides the author surface to any workflow it loads, the workspace packages published in lockstep as `@agentswf/*` under an `agentswf` that installs the command, docs a stranger can follow, and 0.0.1 published and tried on the operator's second machine.
type: story
status: draft
discovered_in: "ADR 0005, 2026-09-27"
depends_on: []
---

# Install agents.wf from npm on another machine

## Outcome

On a machine that has never seen this repository, the operator runs:

```sh
bun add -g agentswf             # awf on PATH
mkdir ~/workflows && cd ~/workflows
awf run ./review.ts             # review.ts imports agentswf/workflow; nothing installed here
```

and the workflow runs its agents the same way it would from a clone. A folder that wants
typechecking adds `agentswf` as a dev dependency, for its types. Someone building on the engine
instead of writing workflows installs the packages they need: `@agentswf/harness` to drive one
coding agent, `@agentswf/sandbox` for the sandboxes, `@agentswf/engine` to run workflows from
their own program.

That is 0.0.1. It is for the operator's own machines, and nothing published is stable before 1.0
([[0005-published-as-agentswf]]).

Getting there means four things that don't exist yet:

- **One naming rule.** The repository is `awf`, its packages are `@wf/*`, the domain is agents.wf,
  and the package on npm will be `agentswf`. A reader should be able to tell which name means
  what, and every name has to be one nobody else holds on npm.
- **A surface the engine provides.** Today a workflow outside the repository fails on its first
  import. It only works through a `bun link`.
- **Packages that install.** Every workspace package is `private: true`.
- **Docs for someone who isn't us.** The README says "Nothing here is published". Nothing says
  what to install first or how to write a first workflow outside the repository.

Why now: the operator wants the engine on a second machine for personal workflows. Also, each
week the author surface grows makes every renamed import cost more, and existing workflows get
upgraded along with the rename.

## How it works

```text
repository (workspace)                 npm, one version for all          any machine
──────────────────────                 ────────────────────────          ───────────
packages/contract      @agentswf/contract      ◄─┐                       bun add -g agentswf
packages/sandbox       @agentswf/sandbox       ◄─┤                            │
packages/harness       @agentswf/harness       ◄─┤ dependencies,              ▼
packages/cli-agent     @agentswf/cli-agent     ◄─┤ exact versions        awf run ./review.ts
packages/engine        @agentswf/engine        ◄─┤                            │ loads review.ts;
packages/autoresearch  @agentswf/autoresearch    │ (bin: awf-lab)             │ agentswf/workflow
packages/agentswf      agentswf ─────────────────┘                            │ and typebox are
                       bin: awf, exports: ./workflow                          ▼ the engine's own
```

**Each workspace package is published as it is, as pi publishes its packages.**

- **One version for all.** Every package has the same version, and `bun pm pack` turns each
  `workspace:*` into that exact version.
- **What a user installs.** `agentswf` is a new, thin package: the `awf` command and the author
  surface, depending on the engine.
- **What someone building on it installs.** The package they need, and nothing that comes with
  the command.
- **Why nothing needs relocating.** Each package installs as a real dependency. So
  `require.resolve("@agentswf/cli-agent/package.json")` and the docker directory next to the
  sandbox's source find in `node_modules` what they find in the clone.

**The engine provides the author surface.** Before `awf run` imports a workflow, it registers
`agentswf/workflow`, `typebox` and `typebox/value` as Bun virtual modules whose exports are the
engine's own copies. pi does the same for its extensions, with jiti aliases under Node and
virtual modules in its Bun binary. This has three effects:

- a workflow in any folder runs, with no install there;
- the surface it runs against is always the engine's version, never a stale copy in the folder;
- the schemas a workflow writes with `typebox` are the ones the engine checks results with.

The folder's own `agentswf` is only for the editor and `tsc`. It is declared the way pi tells
extensions to declare their host: a peer or dev dependency, never something that gets loaded.

What people will ask first:

- **Why not a compiled binary, as opencode and codex ship?**
  - It is possible. A `bun build --compile` binary loads a TypeScript workflow from disk and serves
    it the virtual module (tried 2026-09-28).
  - But it needs three things 0.0.1 doesn't:
    - the `wf` bundle built at pack time instead of at run time;
    - the docker files embedded (`with { type: "file" }`, as opencode embeds its web UI);
    - a package per platform, with a wrapper that finds the right one. opencode has 12 of
      these, codex 6.
  - A Bun user already has Bun, so shipping the source costs them nothing.
- **Why not Node?** Node can't run what is published as it is, and the engine calls Bun's own
  API in 17 files. Supporting Node is a separate piece of work: see
  [[node-runtime]] and Context.

## Scope

In scope:

- **The naming rule.** Apply it to package names, the README, `foundation.md`'s naming note and
  ADR 0005.
- **The author surface.** `awf run` provides `agentswf/workflow`, `typebox` and `typebox/value`
  to the workflows it loads.
- **Publishing the packages.**
  - Every workspace package, published as `@agentswf/*`, plus the new `agentswf`.
  - Each package's `files` and exports trimmed to what it publishes.
  - A pack check that installs the packed tarballs into an empty directory and runs from there.
- **Docs.**
  - The README becomes `agentswf`'s front page.
  - A getting-started page covers prerequisites and a first workflow.
  - A LICENSE.
- **Publishing and trying it.** Publish 0.0.1 by hand, tag `v0.0.1`, and install on the second
  machine.

Out of scope:

- **Running on Node.js.** [[node-runtime]] records what it takes, measured 2026-09-28; the
  packages here are TypeScript source for Bun. The cheapest part of it is `@agentswf/contract`,
  which is pure: it only needs compiled JavaScript and `.d.ts` beside its source for any Node tool
  to read run records.
- **A compiled binary.** See How it works.
- **Rewriting git history or making the repository public.** [[scrub-private-references]] owns
  that.
  - Of what the packages would ship, one line names private work, and task 3 removes it. The
    search was of every published file but the tests, checked 2026-09-28; see Context.
  - The rest of that todo is about docs, tests, experiments and history. None of them publishes.
- **Renaming the command's own names.** `awf` and `wf`, `~/.awf/runs`, `AWF_*` variables and
  docker's `awf.*` labels all belong to the command under the rule below, and stay.
- **Release automation, release notes and a changelog.**
  - A CI workflow that publishes on a `v*` tag through npm trusted publishing (OIDC) is how pi and
    codex release.
  - npm can only trust a publisher for a package that already exists, so the first publish is by
    hand anyway.
  - Automation comes with the second release.

## Context and evidence

- **Fact: the decision is recorded.** [[0005-published-as-agentswf]]:
  - One unscoped package, `agentswf`.
  - Bun only, shipped as TypeScript source.
  - Authors import `agentswf/workflow`.
  - The commands stay `awf` and `wf`.

  It kept the workspace packages as private `@wf/*` names. The operator has since asked for names
  that match, and for the packages to be published so others can build on them. Task 1 amends
  both points.
- **Fact: the scope names on npm, checked 2026-09-28 against `registry.npmjs.org/-/org/{name}/package`.**
  That endpoint answers for users and organisations alike, since both are scopes.
  - `@awf` exists, with no packages, so someone holds it.
  - `@agentswf`, `@agents-wf` and `@agentwf` all answer "Scope not found".
  - The unscoped `agentswf` and `agents-wf` are free.
  - GitHub users or organisations named `agentswf`, `agents-wf` and `agentwf` do not exist.
- **Fact: the internal `@wf/` names are widespread.** 81 TypeScript files import them, across
  `packages`, `examples` and `scripts`. 9 examples import `@wf/contract/workflow`.
- **Fact: there is one external runtime dependency, `typebox`.** Everything else is `node:*` or
  `bun:*`.
- **Fact: a workflow is loaded in the engine's process.** `loadWorkflowFile` in
  `packages/engine/src/workflow-loader.ts` does `await import(pathToFileURL(absolute).href)`.
- **Fact: both commands run only when started directly.** Both files end in
  `if (import.meta.main)`: `packages/engine/src/operator-cli.ts:520` and
  `packages/cli-agent/src/cli.ts:126`.
  - So `agentswf`'s `bin/awf` can't just import the engine's file. It has to call a function the
    engine exports.
  - `wf` needs no command on PATH at all: `agent-launcher.ts` writes each agent its own `wf`
    launcher.
- **Fact: the engine locates things through package resolution.**
  - `resolveAgentCommand` in `packages/engine/src/agent-launcher.ts` uses
    `require.resolve("@wf/cli-agent/package.json")`.
  - `buildAgentBundle` in the same file runs `bun build` on that entry at run time.
  - `IMAGE_DIRECTORY` in `packages/sandbox/src/docker/index.ts` is `import.meta.dir/../../docker`.

  With each package installed as a real dependency, all three work as long as each package's
  `files` keeps `src` and, for the sandbox, `docker`.
- **Fact: autoresearch is meant to be imported from elsewhere.** ADR 0003: a project's own
  autoresearch repository "runs `packages/autoresearch`'s workflows and imports the package to
  build, check and score them". Its fixtures and scores stay in that repository, and none are in
  this one.
- **Fact: some exports exist only for tests or the archive.**
  - `./testing` in contract, harness, sandbox and engine. Used by tests in other packages.
  - `./archive-compat` in engine. Used by `experiments/_archive`.
- **Fact: the commands already refuse `.env`.**
  - Each has the shebang `#!/usr/bin/env -S bun --no-env-file` (f8d6071).
  - opencode's compiled binary sets `autoloadDotenv: false` for the same reason.
- **Fact: `bun pm pack` fills in version specifiers.** Bun 1.4.0, tried 2026-09-28:
  - It rewrites `workspace:*` to the sibling's version and `catalog:` to the catalog's range.
  - opencode relies on this and rewrites nothing by hand.
- **Fact: `bun add` fails on bundled dependencies.** One package that bundles the others is ruled
  out:
  - A tarball listing a package in both `bundleDependencies` and `dependencies` fails under
    `bun add`, locally and with `-g`: `GET https://registry.npmjs.org/@x%2flib - 404`.
  - `npm install` of the same tarball works.
- **Fact: the engine can serve the surface as a virtual module.** Tried with Bun 1.4.0,
  2026-09-28:
  - `plugin({ setup(b) { b.module("agentswf/workflow", () => ({ exports, loader: "object" })) } })`
    serves a workflow in a folder with no `node_modules`, under `bun` and in a compiled binary.
  - `onResolve` with the same filter does not reach a bare import from outside the project.
  - A workflow's own `import "typebox"` failed until the engine served it too.
- **Fact: Node can't run what would be published.** Tried with Node 22.20, 2026-09-28:
  - Node strips types from a `.ts` file it is given, so a user's workflow would run.
  - Under `node_modules` it refuses with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, so a
    published package has to be JavaScript.
  - `bun build --target=node` leaves `Bun.spawn` as it is, so the output fails under Node.
  - The code that would ship makes about 37 calls into Bun's own API in 17 files, across engine,
    harness, sandbox and cli-agent. [[node-runtime]] has the count and the work.
- **Fact: one line that would ship names private work.** A search of every file the packages
  would publish, tests excluded, 2026-09-28. `autoresearch` was searched too, and names only
  GitLab as a source it reads:
  - Terms searched: the private workspace's name, home paths, the operator's names and emails,
    `loops`, `gitlab` and `~/dev`.
  - The one hit: `packages/harness/src/usage/claude.ts:13`, which names the private file it was
    lifted from.
  - "Jev" appears too, and is a public model on OpenRouter.
  - The `repository` field will link the GitHub repository, which is private until
    [[scrub-private-references]] is done.
- **Fact: the reference projects agree on the basics.** Checked 2026-09-28:
  - **Versions:** all three keep every package at one version, set at release. codex keeps
    `0.0.0-dev` in source and stamps the version when it stages.
  - **Republishing:** all three skip a version `npm view` already shows.
  - **Tags:** pi and codex push a tag, `v*` and `rust-v*`, whose CI job publishes through OIDC.
    pi adds `--provenance`.
  - **Smoke test:** pi installs its packed tarballs into a scratch consumer before release.
  - **Package name vs command:** opencode publishes `opencode-ai` for the command `opencode`, the
    same split as `agentswf` and `awf`.
  - **Packages:** pi publishes each workspace package under its scope (`@earendil-works/pi-ai`,
    `pi-agent-core`, `pi-tui`, …), with lockstep versions, and its command's package depends on
    them.
  - **License:** a single root `LICENSE`, MIT for pi and opencode, Apache-2.0 plus `NOTICE` for
    codex. opencode copies it into the package it publishes.
- **Fact: nothing is licensed yet.** The repository has no LICENSE, and a package without one
  is "all rights reserved".
- **Constraint: publishing is outward-facing.** The operator:
  - claims `agentswf` and the `agentswf` organisation on npm (this machine is not logged in);
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

- **Change:** `packages/engine/src/workflow-loader.ts`. Register the virtual modules once, before
  the first `import`.
- **Tests:** a workflow in a temporary folder with no `node_modules` loads and gets the engine's
  copies. Its tests sit next to `workflow-loader.ts`.
- **Checked:** `isExecutableWorkflow` compares `kind` as a string, not by `instanceof`. So a
  workflow built against another copy of the surface still loads, and the virtual module is about
  one version, not about identity.

### Packages

- **Each `packages/*/package.json`:**
  - `private` dropped;
  - `files`, `license` and `repository` (with `directory`) added;
  - `engines.bun` added.

  Its exports are trimmed to what it publishes (see open questions 3).
- **New:** `packages/agentswf`, with:
  - `package.json`;
  - `bin/awf.ts`, which calls the engine's exported entry;
  - `workflow.ts`, which re-exports `@agentswf/contract/workflow`;
  - its README, which is the repository's README copied in at pack time.
- **Changes in the engine and cli-agent:**
  - `packages/engine/src/operator-cli.ts` exports the function its `import.meta.main` block
    runs, so `bin/awf.ts` can call it.
  - `cli-agent` needs no change: it is bundled into each agent's launcher, not run from PATH.
- **New:** `scripts/release.ts`, which:
  - sets one version in every published package;
  - refuses a version `npm view` already shows;
  - packs each package into `dist/`.
- **New:** a pack check. It could be `scripts/pack-check.ts` or a `*.local.test.ts`. It installs
  the packed tarballs into an empty directory, then checks:
  - `awf` runs;
  - a workflow in a folder without `agentswf` runs;
  - with `agentswf` added as a dev dependency, a workflow passes `tsc --noEmit`;
  - the sandbox package holds its docker directory;
  - no tarball holds a test file, a `workspace:` or `catalog:` specifier, or a private name.
- **Likely unchanged:** `resolveAgentCommand`, `buildAgentBundle` and `IMAGE_DIRECTORY`. The pack
  check proves it.
- **`.gitignore`:** `dist/`.

### Docs

- **`README.md`:**
  - what agents.wf is;
  - prerequisites;
  - install;
  - a first workflow;
  - which package to use for what;
  - where the design docs are.

  It replaces the line "Nothing here is published".
- **A getting-started page,** new, under `docs/`, with:
  - prerequisites: bun, git, Herdr, and agent CLIs logged in;
  - the optional sandboxes: srt (plus bubblewrap on Linux) and docker;
  - a workflow folder, with `agentswf` as a dev dependency for types;
  - the smallest workflow;
  - `awf run`, and where runs are kept;
  - that `awf` loads no `.env`, and how Jev still finds `OPENROUTER_API_KEY`.
- **`LICENSE`** at the root, copied into each package at pack time.
- **`docs/status.md`:** a line when 0.0.1 is out.

## Proposed design

**The naming rule, one sentence per name:**

- **agents.wf** is the project, in prose and on the README, and **`agentswf`** is its npm package
  and GitHub organisation. The repository is `agentswf/awf`, named for the command.
- **`@agentswf/*`** are its other packages, one per workspace package. The directory name is the
  package name: `packages/harness` is `@agentswf/harness`.
- **`awf`** is the operator's command and everything it owns at run time: `~/.awf/runs`, `AWF_*`,
  `awf.*` docker labels, `awf-*` containers.
- **`wf`** is the agent's command.

Why `@agentswf`:

- it is free on npm and GitHub, and it is the package's own name, so one claim covers both;
- `@awf` is held by someone else;
- `@agents-wf` matches the domain, but not the package, and a reader would have two spellings to
  keep straight.

The rule goes into `foundation.md`'s naming note, and into ADR 0005 as an amendment. Tools named
after the command (`awf-lab`) follow the command.

**The author surface.** `awf run` registers Bun virtual modules before it imports a workflow:

- `agentswf/workflow`, whose exports are the engine's own `@agentswf/contract/workflow`;
- `typebox` and `typebox/value`, whose exports are the engine's own copy, as pi provides typebox
  to its extensions.

Provided `typebox` pins one version for every workflow. That is the point: a result schema and
the engine's validation of it then agree. A workflow that imports any other package installs it
in its own folder, as any TypeScript file would.

Nothing else in the engine becomes importable by that route. The list is part of the author
surface: adding a name later is cheap, removing one breaks workflows.

There is no alias for the old `@wf/contract/workflow`. The operator upgrades their existing
workflows to `agentswf/workflow` along with the rename, which is why it lands before 0.0.1.

**The packages.**

| Package | Holds | Depends on |
| --- | --- | --- |
| `agentswf` | the `awf` command, `./workflow` | engine, contract |
| `@agentswf/engine` | running workflows | contract, harness, sandbox, cli-agent |
| `@agentswf/harness` | driving one coding agent | contract, sandbox |
| `@agentswf/sandbox` | the sandbox seam and providers, with `docker/` | contract |
| `@agentswf/cli-agent` | the `wf` source the engine bundles | contract |
| `@agentswf/contract` | types, schema, records, wire | typebox |
| `@agentswf/autoresearch` | review fixtures, `collect`, `draft-key`, and the `awf-lab` command | contract |

- **Versions:** the same for every package. `bun pm pack` writes each `workspace:*` as that exact
  version, so an install never mixes two releases.
  - The workspace keeps `0.0.0` in source, and `scripts/release.ts` stamps the version at release,
    as codex's staging does.
- **The boundaries become published facts.** A user of `@agentswf/harness` gets what boundary 4
  allows it and nothing more. Boundary 7 already makes every cross-package import a declared
  dependency, which is what an install needs.
- **What each publishes:** `src` without tests, `README.md`, `LICENSE`, and for the sandbox
  `docker/`.
- **Promises:** none before 1.0, and each README says so.
- **`engines.bun`:** npm and bun only warn on it. The shebang is what actually requires Bun.

Alternatives rejected:

- **Keep `@wf/*` internally (ADR 0005 as written):** the operator wants one set of names, and the
  cost only grows.
- **`@awf/*`:** the scope is held.
- **One `agentswf` with the rest bundled inside:**
  - with `bundleDependencies`, `bun add` fails (see Context);
  - with a pack script that copies the rest into the package's own `node_modules`, `bun add`
    works, but nobody can build on a package they can't install.
- **Copying the internals' sources into one package and rewriting their imports:** the rewrite
  touches every file and moves `import.meta.dir`.
- **The workflow folder's own `agentswf` at run time (`bunx awf`):**
  - the global command and the folder's copy can disagree;
  - a folder without an install can't run;
  - a rename breaks every folder at once.

  pi's host-provided imports avoid all three.
- **Use `package.json` `imports` (`#contract`) instead of a scope:** boundary 7 checks declared
  dependencies between workspace packages, and one package with import aliases would lose that.
- **Authors import `@agentswf/workflow`:** it is one more package to publish, and ADR 0005 chose
  an unscoped import line that the operator's command package also answers to.
- **A compiled binary with per-platform packages:** see How it works. It stays open for later.
- **A `wf` command on PATH:** each agent already gets its own launcher, and a global `wf` would be
  one more name to collide.

## Tasks at a glance

- [ ] 1. The repository follows one naming rule
- [ ] 2. `awf run` provides `agentswf/workflow` and `typebox` to a workflow in any folder
- [ ] 3. The packages pack, install into an empty directory, and run a workflow there
- [ ] 4. The README, a getting-started page and a LICENSE let a stranger do the same
- [ ] 5. 0.0.1 is published, tagged, and running on the operator's second machine

## Open questions

### 1. Names

- **Scope:** decided 2026-09-28, `@agentswf`. The operator claims the npm organisation, which is
  free for public packages.
- **Look-alike names:** decided 2026-09-28, the operator reserves them so no one can publish
  under them.
  - npm refuses an unscoped name that differs from a published one only in punctuation, so
    `agents-wf` and `agents.wf` are covered once `agentswf` exists.
  - It does not guard scopes, or names a letter apart.
  - So the operator creates the empty npm organisations `@agentwf` and `@agents-wf`, and the
    GitHub organisations `agentwf` and `agents-wf`.
  - The unscoped `agentwf` is optional. npm treats an empty placeholder as squatting, so if it is
    taken, it holds a small package whose README and deprecation message point to `agentswf`.
- **Repository:** decided 2026-09-28, `agentswf/awf`.
  - `romanlv/awf` is transferred to a new `agentswf` organisation. GitHub redirects the old URL,
    and the clone needs one `git remote set-url`.
  - The organisation carries the brand and the repository the command, as `earendil-works/pi` and
    `sst/opencode` do.
  - GitHub's Agent Workflow Firewall also answers to "awf" in a search. The `agentswf` in the URL
    tells them apart, and the README leads with agents.wf.
- **Timing:** when does the 81-file rename land? It affects the open review-scorer worktree, so
  agree the moment first.

### 2. Author surface

- **Old import name:** decided 2026-09-28, no alias. The operator upgrades existing workflows
  with the rename.
- **`typebox`:** decided 2026-09-28, the engine provides `typebox` and `typebox/value`.

### 3. Packages

- **`./testing` exports:** do they publish?
  - They let a builder test against fakes, such as a fake harness or the sandbox conformance
    suite, which is useful to exactly the people publishing is for.
  - Recommended: publish them, marked unstable. Drop `./archive-compat` from the published
    engine, which only the archive uses.
- **`autoresearch`:** decided 2026-09-28, it publishes as `@agentswf/autoresearch`, `awf-lab`
  included.
  - ADR 0003 has a project's own autoresearch repository import this package to build, check and
    score its fixtures, which on another machine needs it published.
  - Its formats are young (story 008 awaits review), but nothing is promised before 1.0.
  - `awf-lab` comes with `bun add -g @agentswf/autoresearch`, not with `agentswf`: someone who only
    runs workflows never needs it.
- **Bun version:** does `engines.bun` pin the minimum this repository tests on, or the one
  `sandbox/docker`'s `BUN_VERSION` uses (1.4.0)?

### 4. Docs

- **License:** decided 2026-09-28, MIT, as pi and opencode use.
- **Getting-started location:** does the page live in `docs/` or in the README itself?
  - Recommended: the README holds install and a first workflow; `docs/getting-started.md` holds
    the rest.

### 5. Publish

- **Second machine:** what OS is it? On Linux, check `env -S`, and srt's bubblewrap requirement.
- **Who publishes:** the operator runs `npm publish` on the packed tarballs, or logs in so this
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

- [ ] Plan:
  - the repository has moved to `agentswf/awf`, and the clone's remote points there;
  - agree the commit's timing with open branches;
  - list every file the rename touches.
- [ ] Implement:
  - the mechanical rename;
  - the `foundation.md` naming note, §6 and §13 question 1;
  - ADR 0005 amended, for the names and for publishing each package;
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

### 2. `awf run` provides `agentswf/workflow` and `typebox` to a workflow in any folder

Outcome: a workflow outside the repository runs under the clone's `awf`, without `bun link`.

Execution:

- [ ] Plan:
  - decide where the plugin is registered, once per process, before the first workflow import;
  - check that every `typebox` subpath the examples use is served.
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

### 3. The packages pack, install into an empty directory, and run a workflow there

Outcome: a pack check proves the installed packages work without the repository.

Execution:

- [ ] Plan:
  - settle open questions 3;
  - pack by hand once, install it, and record what the design above got wrong.
- [ ] Implement:
  - the manifests, and `packages/agentswf`;
  - the exported entry in `operator-cli.ts`;
  - `scripts/release.ts` and the pack check;
  - the private line in `packages/harness/src/usage/claude.ts` removed.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings, and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item.

Work:

- The pack check installs from the local tarballs, with `typebox` from the registry.
- It runs as a `*.local.test.ts` if the network makes it unfit for `bun test`.

Done when:

- No tarball holds:
  - a `*.test.ts`;
  - a `workspace:` or `catalog:` specifier;
  - a private name.
- `@agentswf/sandbox` holds `docker/Dockerfile`, `proxy.js` and `relay.js`.
- Installed with `bun add -g` into an empty temporary `BUN_INSTALL`:
  - `awf --help` runs;
  - a workflow in a folder without `agentswf` loads, and `awf run` reaches opening its first agent.
- With `agentswf` as a dev dependency, that workflow passes `tsc --noEmit`.
- A scratch program that depends only on `@agentswf/harness` imports it.
- From the clone: the existing tests pass, and `bun run eval` still passes its non-sandbox
  scenarios.

### 4. The README, a getting-started page and a LICENSE let a stranger do the same

Outcome: someone with only the npm page can install agents.wf and run a first workflow.

Execution:

- [ ] Plan: settle open questions 4.
- [ ] Implement:
  - the README, and a short README for each `@agentswf/*` package;
  - `docs/getting-started.md`;
  - `LICENSE`.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews.
- [ ] Resolve: disposition findings.
- [ ] Verify: satisfy every `Done when` item.

Work:

- The first workflow on the page is one the pack check runs, so the docs can't drift from what
  works.

Done when:

- A subagent with no repository context follows the README and getting-started page against the
  packed tarballs, and reaches `awf run`.
- The README no longer says nothing is published.

### 5. 0.0.1 is published, tagged, and running on the operator's second machine

Outcome: `bun add -g agentswf` works anywhere, and the operator has used it for a real workflow.

Execution:

- [ ] Plan:
  - the operator has claimed `agentswf` and the `agentswf` organisation on npm, and the GitHub
    org if chosen;
  - the look-alike names in open questions 1 are reserved;
  - confirm who publishes.
- [ ] Implement:
  - `scripts/release.ts 0.0.1`;
  - tag `v0.0.1` and push it;
  - `npm publish` of each tarball, with the operator's approval. Dependencies go first, and
    `agentswf` last, as codex orders its publishing, so `agentswf@latest` never names a version
    that isn't there yet.
- [ ] Review: compare the published file lists with the pack check's.
- [ ] Resolve: if a published package is wrong, publish 0.0.2 of all of them. npm doesn't allow a
  version to be republished.
- [ ] Verify: satisfy every `Done when` item.

Work:

- Once the packages exist, configure npm trusted publishing for the repository. That makes the
  next release CI's job, in a story of its own.

Done when:

- `npm view agentswf` shows 0.0.1, with the bin `awf`. `npm view @agentswf/engine` shows 0.0.1.
- On the second machine, `bun add -g agentswf` runs one of the operator's workflows with a live
  agent. What it needed that the docs didn't say goes back into task 4's pages.
- `docs/status.md` says 0.0.1 is out and how it installs.

## Verification

Automated:

- [ ] The author-surface test: a workflow from a folder with no `node_modules` loads.
- [ ] The pack check: pack, install into an empty `BUN_INSTALL`, `awf` runs, a workflow loads and
  typechecks, a single package installs on its own.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] `bun run eval` from the clone after task 3: the repository layout still works.
- [ ] One live workflow on the second machine from the published packages (task 5).

## Review record

Record reviews under the task they cover.

### Refinement, 2026-09-28

The draft was compared with pi, opencode and codex, and Bun 1.4.0's packing was tried against a
scratch workspace. Changes from the first draft:

- **`bundleDependencies` is ruled out:** `bun add` fails on a bundled package that is also a
  dependency.
- **The engine now provides the author surface as a virtual module.** A workflow folder no longer
  runs its own copy.
- **"`--compile` supports neither" is corrected.** A compiled binary loads workflows from disk,
  and is deferred rather than impossible.
- **Release automation stays out, now with its reason:** trusted publishing needs the package to
  exist first.
- **The operator decided, 2026-09-28:** there is no alias for `@wf/contract/workflow`, because
  existing workflows are upgraded with the rename. The engine provides `typebox` alongside
  `agentswf/workflow`.
- **The operator's review, 2026-09-28:**
  - **Scope:** it has to be one nobody else holds. The candidates were checked on npm and GitHub,
    and `@agentswf` is proposed.
  - **Publishing every package:** others should be able to build on them. One bundled package
    became seven published in lockstep, as pi publishes. `autoresearch` is included, since ADR
    0003's data repositories import it.
  - **Node:** its cost was measured and moved to [[node-runtime]].
  - **Private information:** the files that would ship were searched. One line names private
    work.
- **The operator decided, later on 2026-09-28:**
  - the scope is `@agentswf`;
  - the repository is `agentswf/awf`;
  - the license is MIT;
  - the look-alike names are reserved before 0.0.1.

## Readiness

- [x] Outcome and boundaries are concrete.
- [ ] Relevant implementation, callers, and tests are mapped. The pack check will show whether
  anything else locates files by repository layout.
- [x] Evidence and research support the proposed design.
- [ ] Expensive interface, record-format, and stage-gate decisions are settled. `agentswf/workflow`
  and how it resolves, the scope and the license are settled; the published exports are not.
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
