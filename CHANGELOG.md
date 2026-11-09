# Changelog

What changed for someone who runs workflows or writes them, release by release. Every package
(`agentswf` and `@agentswf/*`) shares one version.

An entry goes under Unreleased with the change that makes it, in one of: Breaking, Added,
Changed, Fixed, Removed. A Breaking entry says what to change. `bun run release prepare
{version}` dates the section, and `bun run release` publishes it as the GitHub release.

## Unreleased

### Added

- `awf run --quiet` leaves out the progress and the workflow's log, so a run a scheduler or
  supervisor starts writes nothing to stderr unless it fails, stops or is cancelled
  ([#1](https://github.com/romanlv/agentswf/issues/1)).

### Fixed

- A Claude stage no longer fails with "prompt delivery could not be confirmed" when Claude saves
  the typed lead before the prompt without its trailing space
  ([#4](https://github.com/romanlv/agentswf/issues/4)).

## 0.1.0 — 2026-11-06

The first stable release.
