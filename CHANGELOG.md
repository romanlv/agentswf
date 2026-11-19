# Changelog

What changed for someone who runs workflows or writes them, release by release. Every package
(`agentswf` and `@agentswf/*`) shares one version.

An entry goes under Unreleased with the change that makes it, in one of: Breaking, Added,
Changed, Fixed, Removed. A Breaking entry says what to change. `bun run release prepare
{version}` dates the section, and `bun run release` publishes it as the GitHub release.

## Unreleased

### Breaking

- `awf-lab` has one kind: cases for any workflow. The review kind is retired with its commands
  and flags, each refused with what replaced it (`show` → `report --case`, `list` → `runs`,
  `--scorer` → `score --grader`, `--baseline` → the reference column, `--comparison` → `compare`
  in `graders.ts`), and `@agentswf/lab/review` is gone. `awf-lab.json` is
  `"kind": "awf.lab-workspace/1"`, and the lab's records are `/1`: a `/0` one is named, never
  converted, so earlier runs drop out of history and are not reused.

### Added

- `awf-lab` runs a workflow on cases you wrote in a project's `evals/`, each built by its
  `env.ts` with services faked, graded against its key by `expect`, a criteria judge or your own
  graders; compares columns (`--against`, `--param`, `--vary`) by the dataset's `compare`; runs a
  whole trial in srt (`"sandbox": { "lab": "srt" }`); and loops (`awf-lab loop`), keeping a
  proposer's change only when better. `packages/lab/docs/cases.md` is the reference. Each
  command takes only its own flags, and `awf-lab {command} --help` prints its own.

- `awf run --boxed`, for a caller that runs the whole `awf run` process in a sandbox of its own,
  as awf-lab does a trial: the workflow's sandboxes are set aside and every agent runs inside the
  caller's box. It never goes with `--sandbox` or `--continue`. Its `run.json`, its record
  (`boxed: true`) and `awf runs` say so, so its agents never read as the host's.
- `AWF_CONTROL_ROOT` moves the folder the engine's sockets are made in, `/tmp` by default.

### Fixed

- A run starts where `ps` is forbidden, as inside srt: the process takes its own start time from
  its uptime.

## 0.1.1 — 2026-11-09

### Added

- `awf run --quiet`: stderr only when a run fails ([#1](https://github.com/romanlv/agentswf/issues/1)).

### Fixed

- Claude stages failing with "prompt delivery could not be confirmed" ([#4](https://github.com/romanlv/agentswf/issues/4)).

## 0.1.0 — 2026-11-06

The first stable release.
