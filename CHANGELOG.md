# Changelog

What changed for someone who runs workflows or writes them, release by release. Every package
(`agentswf` and `@agentswf/*`) shares one version.

An entry goes under Unreleased with the change that makes it, in one of: Breaking, Added,
Changed, Fixed, Removed. A Breaking entry says what to change. `bun run release prepare
{version}` dates the section, and `bun run release` publishes it as the GitHub release.

## Unreleased

### Added

- `run.postsOf(participant)` in `testWorkflow`: the text the code posted to a participant, in order.
- `awf wake <run> [--timer <name>]`: wakes a parked run now, firing the timer its wait takes early, recorded as the operator's wake in `in.jsonl` (`awf:wake`); every other timer keeps its due.

### Changed

- `awf logs --wait` past its cap, 300s, says the cap and the value given, and points at `--follow`.
- `awf tick` exits 1 when a run with events is stuck or can't be read, naming it on stderr and under `stuck` or `unreadable` with `--json`, so a scheduler sees a run nothing will wake again.
- `awf logs` shows why a stage failed on its `stage ended` line, and a log line's fields after its text.

## 0.1.1 — 2026-11-09

### Added

- `awf run --quiet`: stderr only when a run fails ([#1](https://github.com/romanlv/agentswf/issues/1)).

### Fixed

- Claude stages failing with "prompt delivery could not be confirmed" ([#4](https://github.com/romanlv/agentswf/issues/4)).

## 0.1.0 — 2026-11-06

The first stable release.
