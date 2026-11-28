---
title: Land the box fixes with 046
type: story
status: todo
priority: P2
epic: codebase
discovered_in: "review of the 044 and factory session, 2026-11-27"
depends_on: ["046"]
---

# Land the box fixes with 046

When 046 (the whole-workflow box, on `workflow-cases`) merges, bring in the box fixes that were
held back because main has no box yet.

Why it matters: the fixes from `workflow-cases` that every run needs are already on main (2026-11-28:
the run start without `ps`, cursor's key login, pi's installer in a sandbox, the project's `.env`,
three prices). The rest only make sense inside 046's box, and a merge could drop or garble them.

Notes:
- Held back: b6c8f6c9 (a provider boxes a whole run), 7befa98f (`awf run --in`), 8948db29 (a box's
  run makes a repository), a5c2b09f (a box leaves out a harness installed in its own state),
  5f8b511b's `boxNeeds` half, the `--boxed` commits (5acfd591, 15d3640f, 646fa2af, f1533880, and
  parts of 49acf2f9, 869234dd, bc950943), and `AWF_CONTROL_ROOT` from 10306c68.
- Main's 63136034 already carries pi's `reads` hook that 5f8b511b's `boxNeeds` half shares, so
  expect a small conflict there.
- The branch's comment on `openRouterKey` in `operator-runtime.ts` still says that only
  `OPENROUTER_API_KEY` is read from `.env`; main's says otherwise. Keep main's.
- The changelog and `site/guide/security.md` on main say only `awf` reads `.env`; `awf-lab` does
  too on the branch, so 044's merge restores that wording.
