# 0003 — Autoresearch tools here, a project's variants and data in its own repository

**Decided:** 2026-09-25, in [story 005](../stories/005-review-fixtures.md). **Amends:**
[ADR 0002](0002-autoresearch-lives-here.md), which left the home inside this repository open and
assumed the workflows being tuned live here; `foundation.md` §7 and §10's autoresearch rows.
**Amended:** 2026-09-26, fixture sets moved out of the workflows repository into their own.

## What was decided

Autoresearch is split by what is general and what belongs to one project.

- **`packages/autoresearch`, in this repository:** everything that works for any project. Today
  that is the review fixture format (`src/review/format.ts`, the single definition; `schema/` is
  generated from it), its checker, `collect` and `draft-key`. The scorer and the variant runner
  go here too.
- **A project's own workflows repository:** its variants (its review workflows, prompts and
  checklists).
- **A project's own autoresearch repository:** its fixture sets under `fixtures/{set}/`, which
  fixtures each variant was tuned on, its scores, and any script that reads that project's own
  notes into a fixture. It runs `packages/autoresearch`'s workflows and imports the package to
  build, check and score them.

What does not change from ADR 0002: autoresearch is a consumer of the engine. The package imports
`contract` and the engine's public entry, never a harness or a deep path, and the engine does not
know it exists. `scripts/check-boundaries.ts` enforces this.

## Why

- **The data is private.** A fixture is a project's frozen code, its review comments and an answer
  key built from them. None of it can live in this repository, which is going open source.
- **The variants are the project's.** Its review workflow and checklists already live in its own
  repository, which imports this repository's example workflows. Tuning them anywhere else would
  split one workflow across two repositories.
- **The tools are not the project's.** `collect` works on any GitLab project, and the scorer and
  runner need the same format whichever project the fixtures come from.
- **The data apart from the variants (the amendment):** each fixture carries its frozen code as a
  git bundle, so a set is large and grows with every build, and building, checking and scoring it
  is work for its own agent sessions. Its own repository keeps the workflows repository small and
  gives those sessions only the data's instructions.
- **A package, not a folder:** the project's repository has to import the tools. That is the
  trigger ADR 0002 set: a package only when something outside must import it.
- **Not `contract`:** the engine never reads fixtures, and a format specific to code review, still
  settling, should not be in the package every other package depends on.

## What this moves

- ADR 0002's "the loop's inputs are this repository's workflows" holds only for the examples. A
  project's variants are tuned where they live.
- The design of the fixture format lives in `format.ts` and story 005. No separate design note:
  a third copy would drift.
