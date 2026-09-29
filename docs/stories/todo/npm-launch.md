---
title: Launch agents.wf on npm
summary: Make the repository public and publish every package as `@agentswf/*` under `agentswf`, researched in story 009 and deferred from it, 2026-09-28.
type: story
status: todo
discovered_in: "story 009, 2026-09-28"
depends_on: ["009"]
---

# Launch agents.wf on npm

Why it matters: [[009-publish-agentswf]] runs agents.wf on the operator's second machine from a
clone. A stranger can't do that: the repository is private, and nothing is on npm. A launch happens
once, so it waits until the repository, its docs and its packages are fit to be seen. The
operator decided on 2026-09-28 to publish nothing before then.

## What was settled while refining story 009

Research, and the operator's decisions, all 2026-09-28:

- **Names:**
  - `agentswf` is the package users install, with the `awf` command and `./workflow`.
  - `@agentswf/*` are the other packages, one per workspace package.
  - The repository is `agentswf/awf`.
  - The license is MIT.
- **Every workspace package publishes, as pi publishes its packages,** so others can build on
  them.
  - Every package has the same version, which the release stamps.
  - `bun pm pack` rewrites `workspace:*` to that exact version.
  - Each package's `files` keeps `src`, without tests, plus the sandbox's `docker/`. With that,
    `require.resolve` and `import.meta.dir` find what they find in the clone.
  - `agentswf` is a thin package: `bin/awf.ts` calls the engine's exported entry (`operator-cli.ts`
    runs only under `import.meta.main`), and `workflow.ts` re-exports the author surface.
- **Ruled out:**
  - **One package with the rest bundled.** `bun add` fails on a tarball whose
    `bundleDependencies` are also listed as dependencies:
    `GET https://registry.npmjs.org/@x%2flib - 404`. `npm install` of the same tarball works.
  - **A compiled binary.** It is possible, and deferred: see [[009-publish-agentswf]].
  - **Node.** It is its own work: see [[node-runtime]].
- **Reference projects:**
  - **Versions:** pi, opencode and codex all keep every package at one version, set at release,
    and skip a version `npm view` already shows.
  - **Releasing:** pi and codex publish from CI on a `v*` tag, through npm trusted publishing
    (OIDC). npm can only trust a publisher for a package that already exists, so the first
    publish is by hand.
  - **Publish order:** codex publishes dependencies first and the package users install last, so
    `@latest` never names a version that isn't there yet.
  - **Smoke test:** pi installs its packed tarballs into a scratch consumer before each release.

## Still to decide

- **Published names are permanent.** Settled in story 009's rename: `cli-agent` became
  `@agentswf/wf`, and `autoresearch` became `@agentswf/lab`.
- **`./testing` exports:** publish them marked unstable, and drop `./archive-compat`?
- **`@agentswf/lab/review/*`:** a wildcard export of every lab module, added in story 009 for the
  operator's review repository, which uses two dozen of them. Publish it marked unstable, or name
  the ones a project needs in `./review`?
- **`engines.bun`:** story 009 set the engine's to `>=1.4.0`, the only version tried. Is it the
  minimum this repository tests on, or `BUN_VERSION`?
- **The name `agentswf` until launch:** an unscoped npm name is held only by publishing it. If it
  is taken first, the fallback is `@agentswf/cli`, with `agentswf/workflow` changing to match.

## Work

- **Manifests:**
  - `private` dropped;
  - `files`, `license`, `repository` (with `directory`), `homepage: https://agents.wf`,
    `description` and `keywords`;
  - `engines.bun`, and `os: ["darwin", "linux"]`.
- **`packages/agentswf`.**
- **`scripts/release.ts`:**
  - stamps one version;
  - refuses a published version;
  - packs into `dist/`.
- **A pack check.** It installs the tarballs with `bun add -g` into an empty `BUN_INSTALL`, then:
  - `awf` runs;
  - a workflow in a folder without `agentswf` loads;
  - with `agentswf` as a dev dependency, it passes `tsc --noEmit`;
  - a program depending only on `@agentswf/harness` imports it;
  - no tarball holds a test file, a `workspace:` or `catalog:` specifier, or a private name.
- **The repository made public,** after [[scrub-private-references]].
  - Nothing consumes this repository yet, so publishing from a fresh history is as cheap as it
    will ever be.
- **The README and docs written for strangers:**
  - every package's README and `description` open with the same tagline;
  - a section on what the sandboxes do and don't hold ([[sandbox-host-protection]]).
- **"charged":** for a metered run, the output says "charged", and `output.json` has a `charged`
  field. For a headless claude, "metered" is a rule the harness applies, not a bill anyone saw.
  Rename the field, with a record version, before anything outside reads it.
- **Publish 0.x by hand,** in dependency order, with `agentswf` last. Then configure trusted
  publishing, so the next release is CI's.
