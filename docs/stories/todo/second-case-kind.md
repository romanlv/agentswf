---
title: Move reviews onto the case kind
type: story
status: todo
priority: P3
epic: loop
discovered_in: "story 011, decision 1, 2026-09-30; rewritten for story 044, 2026-11-15"
depends_on: ["044"]
---

# Move reviews onto the case kind

Story 044 builds a kind of case for any workflow: `evals/{dataset}/` with an `env.ts`, cases with
`input.json`, `files/` and `key.md`, graders that are code or a workflow, and run, trial and score
records at `/0`. The review lab (`packages/lab/src/review/`) still runs its own kind: fixtures with
a frozen checkout, variants, its scorer. This story moves reviews onto the new kind and replaces
the old review lab rather than keeping it beside.

Why it matters: two kinds side by side mean two runners, two stores and two sets of commands.
Reviews are the third real use of the formats (after the mail triage and web-to-cli's build), so
this is where the records become `/1`.

What it needs, from 044's design:

- The `"lab"` sandbox setting: one sandbox around every agent of a trial, since a review workflow's
  agents read a checkout the lab restores.
- A grader that rebuilds the scratch folder at `score` time (the restored checkout), so `score`
  can grade a review again.
- The review scorer as a grader: per-finding labels in `parts` and `votes`, recall and precision
  as `numbers`, `key/evidence/`; 044's M2 checked the grader interface against it.
- A review fixture as a case: the snapshot bundle restored in `setup`, `request.md` as the input.
- `dataset.json`'s `graders` settled (exempt until now), and the review kind's commands, flags and
  exit codes retired.

Out of scope: the autoresearch loop's own changes beyond reading the new records
([story 013](../013-autoresearch-loop.md)).
