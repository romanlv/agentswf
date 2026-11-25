# Changelog

What changed for someone who runs workflows or writes them, release by release. Every package
(`agentswf` and `@agentswf/*`) shares one version.

An entry goes under Unreleased with the change that makes it, in one of: Breaking, Added,
Changed, Fixed, Removed. A Breaking entry says what to change. `bun run release prepare
{version}` dates the section, and `bun run release` publishes it as the GitHub release.

## Unreleased

### Breaking

- Headless claude runs on your Claude plan, as its TUI does, and its record reads `billing` from
  the login. `metered: true` is gone: delete it from every runtime. A workflow that still passes it
  fails to type-check, and a fork's runtime with `metered` is refused at run time.

### Fixed

- A project linked to an awf clone with `bun link agentswf` type-checks against its own
  `@types/bun`, at any version; it used to load the clone's too, and `tsc` failed on the
  duplicates. The README's Contributing section says how to link a clone.
- An attempt after a run's first, as a wake, `awf tick` or `--continue` starts it, says so in its
  first line: `awf: {workflow}/{id} continued · attempt {n} · watch: …`, no longer `started`.
- `awf runs` shows a running run's cost so far, read from its agents' sessions as they stand, with
  a `?`: a run held open for a warm agent showed no cost until its attempt ended.
- A spec naming srt on a machine where awf can't find or run it says what it looked for, and under
  which node, with the command that installs it: `npm i -g @anthropic-ai/sandbox-runtime`. It used
  to say only `not installed`, which after switching node versions didn't say why.
- A fork that runs out of its own minute says so: `the fork of agent {parent} as {key} took
  longer than 60s (deadline exceeded at …)`. It said only `Deadline exceeded at …`, as the run's
  deadline does. It is still a `DeadlineExceededError`, and its `deadline` is the fork's own, not
  `wf.deadline`.
- A run starts where `ps` is forbidden, as inside srt: the process takes its own start time from
  its uptime.

### Added

- Gemini 4 Neon is priced, at Google's list rates, under each name cursor runs it by
  (`gemini-4-neon-low` to `-xhigh`).
- Claude Fable 5.2 is priced at its list rates.

## 0.2.0 — 2026-11-23

Better tools for runs that wait on events: park, wake, and see what woke them.

### Added

- `awf park <run>`: the next event runs the current workflow file.
- `awf wake <run> [--timer <name>]`: fire a parked run's timer now.
- `awf logs --tool <name>` and `--grep <text>` filters; `--full` works on a page.
- `awf logs` shows the events that woke a run.
- `wfa -h`.
- `run.postsOf(participant)` in `testWorkflow`.

### Changed

- `awf tick` exits 1 when a run is stuck or unreadable.
- `awf runs` and `awf logs` show a run held only by warm agents as `parked`.
- `awf runs` lists every running run, not just the newest 20.
- `awf logs` shows why a stage failed.
- `awf logs --wait` past its 300s cap points at `--follow`.

### Fixed

- A sandboxed claude agent no longer gets `blocked` on a Claude Code safety prompt.
- `skills` work for a claude agent whose working directory holds the run's folder.
- A stuck `wfa` build fails the run after 60s instead of hanging it.

## 0.1.1 — 2026-11-09

### Added

- `awf run --quiet`: stderr only when a run fails ([#1](https://github.com/romanlv/agentswf/issues/1)).

### Fixed

- Claude stages failing with "prompt delivery could not be confirmed" ([#4](https://github.com/romanlv/agentswf/issues/4)).

## 0.1.0 — 2026-11-06

The first stable release.
