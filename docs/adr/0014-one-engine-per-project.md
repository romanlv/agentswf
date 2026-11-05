# 0014 — One engine per project

**Decided:** 2026-11-04, in [[040-workflows-from-code|story 040]].
**Amends:** `site/guide/install.md`, which said a workflow needs nothing installed and that
`bun add -g agentswf` updates what `awf` serves. That still holds for a folder with no `agentswf`;
a project that installs one is updated with `bun add -d agentswf`.

## What was decided

- **A project's runs run on the project's engine:** the `agentswf` installed in a `node_modules`
  at or above the project, found by walking up for `node_modules/agentswf/package.json`. Engines
  are told apart by that file's `version`: a copy at the same version is the same engine.
- **The global `awf` hands over before parsing anything.** It walks up from the shell's directory;
  when the installed version differs from its own it warns once, runs the project's `awf` as a
  child with `--no-env-file`, and exits with the child's code or signal. `AWF_ENGINE`, set on the
  child, names the engine it is; an `awf` skips the hand-over only when it names that `awf`'s own,
  a guard against a loop. `init`, `help`, `--version` and `tick --all` don't hand over.
- **Checked where it is used.** An engine refuses a command's file or run, a `wf.emit` target, or a
  client's workflow whose project is at another version, naming the project to run from. A project
  declaring `agentswf` without installing it is refused, naming `bun install`, and `awf tick --all`
  reports it and passes over it. A project
  with no `agentswf` runs on any engine, as before; a program's client alone refuses it.
- **`awf tick --all`** wakes each registered project on its own engine, in a child at its version.

## What it replaces, and why

The global `awf` won: measured on 2026-11-04, a project with `agentswf` 0.1.0-beta.5 in
`node_modules` ran under a beta.4 global against beta.4's author surface, while a program importing
the same workflow got beta.5's. A newer project's flags and records were refused by an older
global, whose parser refuses unknown options and whose reader refuses newer records.

- Handing over after parsing was rejected: an older global refuses a newer command's flags before
  it could hand over.
- Bun's resolver was rejected for finding the engine: its auto-install answers with a cache copy
  where nothing is installed, so "not installed" can't be told from "installed".
- One process can't load two engines (each serves its own author surface) and Bun has no `exec`,
  so the hand-over is a second process: about 10 ms, as it runs before the engine's modules load.

## Costs, accepted

- A global older than this decision doesn't hand over. It refuses a run with recorded args (a newer
  record version, [[0015-a-run-started-from-code-records-its-args|ADR 0015]]), but runs a project's
  other runs on itself until updated.
- A local clone at a release's version is not told apart from the release; its developer runs the
  clone's own `awf`.
