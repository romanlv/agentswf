# 0016 — A run started from code records its args

**Decided:** 2026-11-04, in [[040-workflows-from-code|story 040]].
**Amends:** [[0011-a-run-continues-from-its-stages|ADR 0011]], whose `--continue {id}` "adds an
attempt with the argv the run was started with". A continue now adds an attempt with the argv, or
the args, the run was started with.

## What was decided

- **A run records its input as it was given.** A run `awf run` starts records its argv, and every
  attempt calls `prepare` on it again, so a fix to `prepare` reaches a continued run (unchanged). A
  run a program starts with `client().start(workflow, args)` records those args, and every attempt
  runs with them as they are; `prepare` never runs for it. `id(args)` still names the run.
- **`run.json` gains `args`,** written only for a run started from code, which always has the
  field (`null` for a workflow without args) and `argv: []`. It arrived with `run.json`'s `format`
  1 ([[0014-a-run-settles-its-facts-as-lines|ADR 0014]]), which an engine that predates it doesn't
  read, so no engine prepares empty argv for a run with args.
- **A continue follows the stage rule:** a plain run stops across a major `meta.version`, an event
  run continues, as their stage records do.
- **A plain workflow that gives `file` keeps its runs in its file's project,** registered in
  `~/.awf/projects`, as an event workflow's are, so `awf run {file} --id {id} --continue` finds a
  run a program started from anywhere. Only the run root and the registration move: `awf run` keeps
  every option for such a workflow, and a run it starts still works in the shell's directory.

## Why

A typed `start` can't reach a detached attempt through argv: the attempt would have to turn args
back into the strings `prepare` parses. Recording the first attempt's `Args` for every run was
rejected: a fix to `prepare` would stop reaching a CLI-started run.

An optional field an older engine reads was rejected: it would ignore a field that changes what an
attempt does, and prepare empty argv. Planned as a new record version, it shipped in the record
story 041 redesigned, whose `format` 1 no earlier engine reads.
