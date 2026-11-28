---
title: Land the engine fixes stranded on workflow-cases
type: story
status: todo
priority: P1
epic: codebase
discovered_in: "review of the 044 and factory session, 2026-11-27"
depends_on: []
---

# Land the engine fixes stranded on workflow-cases

Move the fixes on `workflow-cases` that aren't about the lab onto main now, without waiting for
044's review.

Why it matters: `workflow-cases` is 88 commits ahead of main. Some of those commits fix the
harness, sandbox and engine, which every run uses. The factory links to main's awf, so it runs
without them.

Notes, the candidates as of 2026-11-27:
- a5c2b09f, 5f8b511b: pi in a box. Before them, pi blocked every boxed run.
- 8948db29: a boxed run can make a repository in its working folder.
- b6c8f6c9: a provider can box a whole run. Check whether it depends on lab code.
- bd92e717: a cursor login by `CURSOR_API_KEY` passes the login check.
- 460f8475, 6ed6359e: prices.
- `awf` and `awf-lab` reading the project's `.env` (2026-11-26, after the user's rule that keys come
  from the workflow's folder). Find the commit.

Cherry-pick each one with its test and changelog line, and resolve against main's later changes
(`prices.ts` already conflicted once).
