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
- `awf runs` lists every run still running after the newest 20, however long ago it started.
- `awf runs` and `awf logs` show a run `parked` once its process stays only for agents' `keepAlive` windows, with each agent and when its window ends (`warm` in `--json`); `log.jsonl` records it as `agent-warm`.

### Fixed

- A claude agent whose working directory holds the run's folder can be given `skills`: a host agent's skills, and a host codex agent's own home, are placed in `~/.awf/skills/{workflow}/{id}`, outside the project, not in the run's `work/agents`.

## 0.1.1 — 2026-11-09

### Added

- `awf run --quiet`: stderr only when a run fails ([#1](https://github.com/romanlv/agentswf/issues/1)).

### Fixed

- Claude stages failing with "prompt delivery could not be confirmed" ([#4](https://github.com/romanlv/agentswf/issues/4)).

## 0.1.0 — 2026-11-06

The first stable release.
