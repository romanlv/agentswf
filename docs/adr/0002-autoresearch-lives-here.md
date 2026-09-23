# 0002 — Autoresearch lives in this repository

**Decided:** 2026-09-23. **Replaces:** `foundation.md` §7's "Autoresearch is a separate
repository", and the §10 trigger that tied the cross-repository pack test to it.

## What was decided

The autoresearch loop — searching over workflow variants such as prompts, models, harnesses,
verifier limits and samples per lens for a better, faster or cheaper one — is built in this
repository, not beside it.

Where it goes inside the repository is not decided. It gets a §10 row and a home when the first
loop runs, by the same rule as everything else here: a package only when something outside must
import it.

What does not change:

- It is a *consumer* of the engine. It runs workflows through `runWorkflow` with injected aliases
  and run policy, and scores them from the run record. It does not reach into the engine or a
  harness, and the engine does not learn about it.
- Evals stay what §7 says they are: `*.eval.ts`, a reporter and a summary.
- The run record is still a public format with a reader the engine does not control. Changing it
  is a breaking change.

## Why

Story 002 made the loop the next concrete consumer: cost and time accounting exists so variants can
be compared on price as well as quality. The loop's inputs are this repository's workflows, and its
changes land in them. Keeping it in another repository would put a publish-and-install cycle between
a variant and its evaluation before anything outside needed one.

The separate-repository argument was about lifecycle and failure mode, not about imports. The
consumer boundary above keeps what it was protecting.

## What this moves

- The pack-and-install test in §7 no longer gates the loop. It still applies the first time
  something outside this repository consumes `contract` or `harness`.
- `experiments/_archive/`'s `trial.ts` and `runner.ts` are prior art for this repository's loop,
  not another repository's.
