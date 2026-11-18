# Changelog

What changed for someone who runs workflows or writes them, release by release. Every package
(`agentswf` and `@agentswf/*`) shares one version.

An entry goes under Unreleased with the change that makes it, in one of: Breaking, Added,
Changed, Fixed, Removed. A Breaking entry says what to change. `bun run release prepare
{version}` dates the section, and `bun run release` publishes it as the GitHub release.

## Unreleased

### Added

- `awf run --boxed`, for a caller that runs the whole `awf run` process in a sandbox of its own,
  as awf-lab does a trial: the workflow's sandboxes are set aside and every agent runs inside the
  caller's box. It never goes with `--sandbox` or `--continue`.
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
