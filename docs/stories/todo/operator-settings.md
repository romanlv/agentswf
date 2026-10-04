---
title: Operator settings files
summary: What awf does on this machine is fixed in code, flags and a few AWF_* variables; give the operator a settings file, per user and per project, that awf reads and passes to the engine.
type: story
status: todo
discovered_in: "run-through-sleep, 2026-10-02"
depends_on: []
---

# Operator settings files

Why it matters: keeping the machine awake for a run ([[run-through-sleep]]) wants a default the
operator can turn off, per machine or per project, and it is not the only such choice. Today they
are spread out and mostly fixed:

- in code: the runtime aliases (`OPERATOR_ALIASES`, `packages/engine/src/operator-aliases.ts`), the
  30-minute default deadline, `.awf/runs` under the working directory as the run root;
- on the command line, per run: `--timeout`, `--run-root`;
- in the environment: `AWF_HERDR_SESSION`, and `OPENROUTER_API_KEY` from the shell or `.env`.

Constraint: [[foundation]] says "the alias table and run policy are arguments to the engine, not
files it silently loads". A settings file is the operator command's input: `awf` reads it and
passes values in, the engine never reads it, and a run's record says what was in force.

Decide:

- Where the files are and which wins: a user file (`~/.awf/settings.json`), a project file in the
  repository, a local one kept out of git, the command line over all of them. Claude Code's
  user, project and local layering is one precedent.
- What a project file may set. A cloned repository is not trusted the way the operator is: it may
  choose aliases or a deadline, but not widen what the operator grants (credentials, mounts,
  sandbox off), as a repository's Claude Code settings cannot turn on `bypassPermissions`.
- The first keys: keeping the machine awake, the default deadline, the run root, the Herdr
  session, the aliases. Which of the `AWF_*` variables become keys, and which stay variables.
- The format and its version, and whether `awf-lab` reads the same files or passes its own.
- How a run records it: each value and where it came from, in `output.json`.
