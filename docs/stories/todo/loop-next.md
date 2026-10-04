---
title: The loop's next version, from its first live run
type: story
status: todo
priority: P0
discovered_in: "story 013, task 6, the first live loop, 2026-10-01"
depends_on: ["013", runtime-effort, comparison-efficiency]
---

# The loop's next version, from its first live run

What the first live loop showed is missing from awf-lab loop itself — a proposer that thinks, spend
a cut can't hide, a loop that outlives its shell, a scorer checked before it spends — plus what
story 013 deferred.

Why it matters: the first live loop (data repository,
`reports/2026-10-01-first-live-loop.md`; [story 013](../013-autoresearch-loop.md), "The first live
loop") worked end to end. One try cost about 3 hours and $24, proposed a generic idea, and was
discarded. It ended $4 over its $25 cap. Most of what it taught is about running the loop, not
about reviews. The loop isn't worth running again on the operator's own workflows until the items
below are done.

Where each finding of the report went:

| Report | Where |
| --- | --- |
| 1. A second turn of one agent finds little; separate agents do | the program, below; [[review-shapes-and-models]] |
| 2. The proposer was lazy | here, and [[runtime-effort]] for its effort |
| 3. A try costs 3 h and $24; it should stop at 8 cases | [[comparison-efficiency]] |
| 4. The proposer was told no resolution | [[comparison-efficiency]] |
| 5. A cut loop lost its place | fixed (`f61911a`); its spend: here |
| 6. Codex 0.157 refused `gpt-6.1-sol` | fixed: the image has 0.159.3 |
| 7. Contained codex ran at low effort | stopgap in `execute.ts`; the fix is [[runtime-effort]] |
| 8. A finished review lost to a slow shutdown | fixed: the lab reruns it, its spend counted |
| 9. The scorer needs `OPENROUTER_API_KEY` | here |

## What to build

1. **Spend a cut can't hide.** A resumed try counts only what it ran after the cut:
   `loop.ts` says so ("what it ran before the cut is not in its spend"), and that is the $4
   overrun. Sum a try's spend from the trial and score records under its candidate's name, as the
   cap already does for finished tries, so a resume reads what the cut left.
2. **A proposer that thinks.** It spent one minute, 50 reasoning tokens and $0.05. It is the
   cheapest step by far.
   - High effort, or a stronger model, for the proposer only: `--proposer` names a harness and
     model and no effort, so it needs [[runtime-effort]]. Until then the contained home's copy of
     the host's effort applies to it too.
   - Its answer cites the feedback it used: which cases' `missed` text, and what pattern across
     them. A hypothesis that cites nothing is refused, like a scope breach.
   - The prediction is held to the resolution: a predicted gain below what the try can resolve is
     refused before it spends (needs [[comparison-efficiency]]'s resolution at 1 trial).
3. **The program carries what is known.** Seed `program.md` with the screen's finding: separate
   agents, each with one job, beat a longer single pass (+0.24 against +0.035). An operating step
   in the data repository, not code; the next loop runs from `air-single` or from `air-lenses`.
4. **A loop outlives its shell.** The shell's 2-hour limit killed the first one at case 15. Say in
   the lab's README how to run a loop unattended (detached, resumed by the same command), and keep
   the machine awake for it ([[run-through-sleep]]).
5. **Check the scorer before spending.** Jev's key is read from the environment or `.env` in the
   run's `cwd` (`openRouterKey`, `engine/src/operator-runtime.ts`), which for a loop is the data
   repository. `awf-lab run` and `loop` should fail before the first trial when the scorer can't
   reach its decision model, not after the review has spent.

## Deferred from story 013

- `list loops`, and `show` of a loop's tree (task 3–4 review).
- The allowed proposer models live in the CLI, not in the loop's records.
- The stall round: after two or three tries without `better`, sort the tuning failures by root
  cause; suspect cases go to an audit, not to the proposer.
- Acceptance that tightens over rounds; a Pareto front of parents; a model × effort staircase per
  stage (Anthropic's `cost-hillclimb`).
- A thin agent skill that drives `check`, `run` and `report`.
- From the original todo's notes, still true: one hypothesis per try, kept or reverted whole; the
  proposer never copies case content into a variant; the headline is the kept variant confirmed on
  fresh trials, not the score of the round that selected it
  ([`autoresearch-practices`](../../research/autoresearch-practices.md)).
