---
title: Remove private project references before open-sourcing
summary: Take the names, paths and projects of the private work awf grew out of out of the docs, code and history, so the repository stands on its own.
type: story
status: todo
discovered_in: "story 005 review, 2026-09-25"
depends_on: []
---

# Remove private project references before open-sourcing

Why it matters: awf will be open source, and should not be tied to the private projects it was
first used on. Story 005 now describes its fixtures without naming the project they came from, but
older files still do.

Notes:

- Files that still name the private workspace, its paths, projects or skills:
  - `docs/foundation.md` (sections 2, 7, 8 and 11);
  - `docs/design/README.md`, `docs/design/composition.md` and `docs/design/permissions.md`;
  - `docs/stories/002-cost-and-time-accounting.md` and `docs/stories/004-sandboxed-agents.md`;
  - `packages/harness/src/usage/claude.ts`, `packages/harness/src/usage/usage.test.ts` and
    `packages/engine/src/accounting/accounting.test.ts`: comments on where code was ported from,
    and a real home-directory path used as test data.
- Git history holds all of the above and more. Decide whether to publish from a fresh history or
  rewrite the existing one.
- `experiments/_archive/` has them in logs, results and `e1/headless.ts`. It is frozen evidence, so
  decide whether to redact it or leave it out of the public repository.
- Find the rest by searching for the private organisation's and projects' names.
