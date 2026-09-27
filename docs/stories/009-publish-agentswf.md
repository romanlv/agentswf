---
id: "009"
title: Install agents.wf from npm on another machine
summary: One naming rule across the repository, a publishable package `agentswf` that installs into an empty directory and runs a workflow there, the docs a stranger needs to do that, and 0.0.1 published and tried on the operator's second machine.
type: story
status: draft
discovered_in: "ADR 0005, 2026-09-27"
depends_on: []
---

# Install agents.wf from npm on another machine

## Outcome

On a machine that has never seen this repository, the operator runs:

```sh
mkdir ~/workflows && cd ~/workflows
bun add agentswf
bunx awf run ./review.ts        # review.ts imports agentswf/workflow
```

and the workflow runs its agents the same way it would from a clone. That is 0.0.1. It is for the
operator's own machines, and the author surface stays open to change before 1.0 ([[0005-published-as-agentswf]]).

Getting there means three things that don't exist yet:

- **One naming rule.** The repository is `awf`, its packages are `@wf/*`, the domain is agents.wf,
  and the package on npm will be `agentswf`. A reader should be able to tell which name means what.
- **A package that installs.** Every workspace package is `private: true`. The engine finds
  `cli-agent`, the docker image files and `bun` from paths inside the repository.
- **Docs for someone who isn't us.** The README says "Nothing here is published". Nothing says
  what to install first or how to write a first workflow outside the repository.

Why now: the operator wants the engine on a second machine for personal workflows, and each
week the author surface grows makes every renamed import cost more.

## How it works

```text
repository (workspace)                    npm                     ~/workflows (any machine)
─────────────────────                     ───                     ─────────────────────────
packages/contract   ─┐                                            package.json
packages/harness     │   pack: one          agentswf@0.0.1          dependencies: agentswf
packages/sandbox     ├─► package, with  ─►  bin: awf, wf       ─►  review.ts
packages/engine      │   internals          exports: ./workflow      import … from "agentswf/workflow"
packages/cli-agent  ─┘   inside             engines: bun            bunx awf run ./review.ts
packages/agentswf        (the published
  package.json            manifest)
```

The workspace stays as it is: separate packages with their boundaries. A new
`packages/agentswf` holds only the published manifest and the entry points. Packing puts the
internals it needs inside the tarball, so a user installs one package and nothing named after a
workspace package reaches their `node_modules`.

A workflow folder depends on `agentswf` itself. The `awf` that runs a workflow and the
`agentswf/workflow` it was typed against then come from one installed version, and can't drift apart
the way a global command and a local import can.

What people will ask first: **why not a compiled binary?** The engine runs `bun build` on `wf`
while a workflow runs, and loads workflows as TypeScript at run time. `bun build --compile` supports
neither. And **why Bun only?** The engine uses `Bun.spawn`, `Bun.serve` and `Bun.listen`
throughout (ADR 0005).

## Scope

In scope:

- **The naming rule.** Apply it to package names, the README, `foundation.md`'s naming note and
  ADR 0005.
- **`packages/agentswf`.** The published manifest, and a pack check that installs the tarball into
  an empty directory and runs from there.
- **Installed layout.** Self-location that works from an installed package as well as from a
  clone: `cli-agent`'s manifest, the docker image directory, the `wf` bundle.
- **Docs.**
  - The README becomes the package's front page.
  - A getting-started page covers prerequisites and a first workflow.
  - A LICENSE.
- **Publishing and trying it.** Publish 0.0.1, tag `v0.0.1`, and install on the second machine.

Out of scope:

- A Node.js build, compiled JavaScript, or `.d.ts` output ([[foundation]] §13 question 4 stays
  answered as Bun).
- Publishing `contract` or `harness` as packages of their own.
- Rewriting git history or making the repository public. [[scrub-private-references]] owns that.
  This story covers only what the tarball ships, which npm makes public.
- Renaming the `awf` and `wf` commands, `~/.awf/runs`, `AWF_*` variables or docker's `awf.*`
  labels. Under the rule below they belong to the command, and stay.
- Release automation, provenance, a changelog. They come when there is a second release and a
  second user.

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
- **Fact: the engine locates things by repository layout.**
  - `packages/engine/src/agent-launcher.ts` — `resolveAgentCommand` uses
    `require.resolve("@wf/cli-agent/package.json")`, and `buildAgentBundle` runs
    `bun build` on that entry at run time.
  - `packages/sandbox/src/docker/index.ts` — `IMAGE_DIRECTORY` is
    `import.meta.dir/../../docker`, which holds `Dockerfile`, `proxy.js` and `relay.js`.
  - `packages/autoresearch/src/write-schemas.ts` — the same pattern, but a development tool.
- **Fact: both bins are ready to install.**
  - Each has the shebang `#!/usr/bin/env -S bun --no-env-file` (f8d6071).
  - `bun link` of `packages/engine` gave a working `awf` in a scratch `BUN_INSTALL`.
  - `packages/contract` linked into an outside folder resolved `@wf/contract/workflow`.
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
- **Assumption, unverified: `bun pm pack` resolves `workspace:*` and `catalog:`.** It should do
  this in the published manifest, the way it does in a package's own dependencies.

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

### Package

- **New:** `packages/agentswf/package.json`, with bins and the `./workflow` export pointing into
  the internals.
- **New:** a pack check. It could be `scripts/pack-check.ts` or a `*.local.test.ts`. It packs the
  package, installs the tarball into a temporary directory, then checks four things:
  - it runs `awf` and `wf`;
  - a workflow importing `agentswf/workflow` typechecks and loads;
  - the docker directory is present;
  - no test file and no private name is in the tarball.
- **Change:**
  - `resolveAgentCommand` and `buildAgentBundle` in `packages/engine/src/agent-launcher.ts`;
  - `IMAGE_DIRECTORY` in `packages/sandbox/src/docker/index.ts`.

  Both should work whichever way the internals are laid out in the tarball.
- **Callers:** `awf run` in `packages/engine/src/operator-cli.ts`, and the `wf` launcher and
  `boxScript` that `sandboxes.test.ts` asserts.

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
  - a workflow folder's `package.json`;
  - the smallest workflow;
  - `awf run`, and where runs are kept;
  - that `awf` loads no `.env`, and how Jev still finds `OPENROUTER_API_KEY`.
- **`LICENSE`** at the root.
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

**The package.** `packages/agentswf` is the only package that isn't private. Its manifest:

```json
{
  "name": "agentswf",
  "version": "0.0.1",
  "type": "module",
  "bin": { "awf": "…/operator-cli.ts", "wf": "…/cli.ts" },
  "exports": { "./workflow": "…/workflow/index.ts" },
  "engines": { "bun": ">=1.4.0" },
  "dependencies": { "typebox": "^1.3.34" },
  "files": ["…"]
}
```

How the internals get inside is task 2's first decision, made by packing and installing, not on
paper. The candidates:

- **Source, copied in.** Copy each needed package's `src` (and `sandbox/docker/`) under the
  package, and give it a `package.json` `imports` map or rewritten specifiers. This matches ADR 0005
  and keeps `import.meta.dir` meaningful.
- **Bundled dependencies.** List the `@agentswf/*` packages as `bundleDependencies`, so they ship
  inside the tarball's own `node_modules`. The fewest changes, if `bun pm pack` supports it with
  workspace symlinks (unverified).
- **One `bun build` bundle.** Bundle each bin, and prebuild the `wf` bundle at pack time instead
  of at run time. This needs `.d.ts` for `./workflow`, and breaks `import.meta.dir`. It is the
  fallback.

Whichever wins, self-location stops assuming a repository:

- `cli-agent` is found from the entry that is running;
- the docker directory is found next to the provider's code.

The existing tests pin both.

**Where a workflow finds the engine.** It uses its folder's own `agentswf` (`bunx awf run`). A
global `bun add -g agentswf` works for convenience, and the getting-started page says it can
disagree with the folder's version.

Alternatives rejected:

- **Keep `@wf/*` internally (ADR 0005 as written):** the operator wants one set of names, and the
  cost only grows.
- **Use `package.json` `imports` (`#contract`) instead of a scope:** boundary 7 checks declared
  dependencies between workspace packages, and one package with import aliases would lose that.
- **A scoped published package (`@agentswf/agentswf`, `@evolvedstack/…`):** ADR 0005 chose an
  unscoped import line.
- **`bun build --compile`:** see How it works.

## Tasks at a glance

- [ ] 1. The repository follows one naming rule
- [ ] 2. `agentswf` packs, installs into an empty directory, and runs a workflow there
- [ ] 3. The README, a getting-started page and a LICENSE let a stranger do the same
- [ ] 4. 0.0.1 is published, tagged, and running on the operator's second machine

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

### 2. Package

- **Internals:** how do they get into the tarball? This is settled by the pack check (see Proposed design).
- **`autoresearch` and `awf-lab`:** do they ship in `agentswf`, or stay repository-only until
  story 008 settles?
  - Recommended: repository-only for 0.0.1.
- **Bun version:** does `engines.bun` pin the minimum this repository tests on, or the one
  `sandbox/docker`'s `BUN_VERSION` uses (1.4.0)?

### 3. Docs

- **License:** MIT or Apache-2.0? Apache-2.0 adds a patent grant. MIT is what most agent tooling
  on npm uses.
- **Getting-started location:** does the page live in `docs/` or in the README itself?
  - Recommended: the README holds install and a first workflow; `docs/getting-started.md` holds
    the rest.

### 4. Publish

- **Second machine:** what OS is it? On Linux, check `env -S`, and srt's bubblewrap requirement.
- **Who publishes:** the operator runs `bun publish`, or logs in so this session can, with 2FA
  either way.

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

### 2. `agentswf` packs, installs into an empty directory, and runs a workflow there

Outcome: a pack check proves an installed `agentswf` works without the repository.

Execution:

- [ ] Plan: pack each candidate layout and install it into an empty directory, then pick one. Record
  the loser and why.
- [ ] Implement:
  - `packages/agentswf`;
  - self-location for `cli-agent`, the `wf` bundle and the docker directory;
  - the pack check;
  - the private reference in `packages/harness/src/usage/claude.ts` removed.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings, and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item.

Work:

- The pack check runs where `bun test` runs. If installing needs the network, it runs as a
  `*.local.test.ts` instead.

Done when:

- `bun pm pack` in `packages/agentswf` gives a tarball with:
  - no `*.test.ts`;
  - no `workspace:` or `catalog:` specifier;
  - no private name;
  - `docker/Dockerfile`, `proxy.js` and `relay.js`.
- Installed into an empty temporary directory:
  - `bunx awf --help` and `bunx wf --help` run;
  - a workflow importing `agentswf/workflow` passes `tsc --noEmit` there;
  - `awf run` loads it and reaches opening its first agent.
- From the clone: the existing tests pass, and `bun run eval` still passes its non-sandbox
  scenarios. That shows self-location still works in the repository layout.

### 3. The README, a getting-started page and a LICENSE let a stranger do the same

Outcome: someone with only the npm page can install agents.wf and run a first workflow.

Execution:

- [ ] Plan: settle the license and where the getting-started material lives (open questions 3).
- [ ] Implement: the README, `docs/getting-started.md` and `LICENSE`.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews.
- [ ] Resolve: disposition findings.
- [ ] Verify: satisfy every `Done when` item.

Work:

- The first workflow on the page is one the pack check runs, so the docs can't drift from what
  works.

Done when:

- A subagent with no repository context follows the README and getting-started page in an empty
  directory against the packed tarball, and reaches `awf run`.
- The README no longer says nothing is published.

### 4. 0.0.1 is published, tagged, and running on the operator's second machine

Outcome: `bun add agentswf` works anywhere, and the operator has used it for a real workflow.

Execution:

- [ ] Plan:
  - the operator has claimed `agentswf` on npm, and the GitHub org if chosen;
  - confirm who publishes.
- [ ] Implement:
  - version `0.0.1`;
  - tag `v0.0.1` and push it;
  - `bun publish` with the operator's approval.
- [ ] Review: check the published tarball's file list against the pack check.
- [ ] Resolve: if the published package is wrong, publish 0.0.2. npm doesn't allow a version to
  be republished.
- [ ] Verify: satisfy every `Done when` item.

Work:

- None beyond the release itself.

Done when:

- `npm view agentswf` shows 0.0.1, with bins `awf` and `wf`.
- On the second machine, a workflow folder with `bun add agentswf` runs one of the operator's
  workflows with a live agent. What it needed that the docs didn't say goes back into task 3's
  pages.
- `docs/status.md` says 0.0.1 is out and how it installs.

## Verification

Automated:

- [ ] The pack check: pack, install into an empty directory, bins run, the workflow typechecks and
  loads.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] `bun run eval` from the clone after task 2: self-location in the repository layout.
- [ ] One live workflow on the second machine from the published package (task 4).

## Review record

Record reviews under the task they cover.

## Readiness

- [x] Outcome and boundaries are concrete.
- [ ] Relevant implementation, callers, and tests are mapped. Self-location sites are known; the
  pack check will show whether there are others.
- [x] Evidence and research support the proposed design.
- [ ] Expensive interface, record-format, and stage-gate decisions are settled. `agentswf/workflow`
  is settled; the internal scope and the license are not.
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
