---
title: Measure how often Jev's settled noise is wrong
summary: Match first lets a sure Jev label a finding noise without a voter; voters re-label a sample of those and the disagreement rate says whether that costs precision unfairly.
type: story
status: todo
discovered_in: "story 011, decision 5 and task 1's review"
depends_on: ["011"]
---

# Measure how often Jev's settled noise is wrong

Why it matters: noise counts in precision, a guard, so a real finding Jev calls noise costs a
variant on its text alone. Story 011 kept the rule (decision 5) and the user asked for it to be
measured (2026-09-30).

Notes:

- `check --rescore` can't show it: it re-scores with the same scorer, so Jev settles the same
  findings again. The audit needs the voters' label on the findings Jev settled.
- Cheap way: a workspace scorer of `MATCH_JUDGE` with `--sure 1` (voters label everything) run on
  the trials whose stored `match-first` score has Jev-settled noise, keeping no score, and a count of
  how many of those findings the voters label otherwise. Task 7's 52 trials and experiment 1's 32
  are the sample; on codex.
- Decides: keep decision 5, raise its cut, or send noise to the voters as `wrong` is.
