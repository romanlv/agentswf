---
title: Say what a percent of a plan is worth, as it changes
type: story
status: todo
priority: P2
epic: observability
discovered_in: "story 022, 2026-10-05: 10% of a $200 plan and of a $20 one differ"
depends_on: ["022"]
---

# Say what a percent of a plan is worth, as it changes

Estimate what 1% of each plan window buys, in list-price dollars of work, from the lab's own runs:
"1% of codex's week ≈ $X at list prices, last 7 days, Pro 100, gpt-6.1-sol, 14 runs".

Why it matters: `awf allowance` shows a percent and the plan's price, and no vendor publishes a
window's size (Anthropic none; OpenAI ranges such as 70–700 Sol messages per 5 hours on Pro 100;
Cursor relative pools). A percent alone can't compare plans or say what a loop will cost a plan.

What 1% is worth is not a constant. It moves when a vendor changes limits (Anthropic's weekly caps;
OpenAI re-tiered Pro in April 2026, and codex issue #21216 reports a weekly percent jumping when an
account's plan type flipped from `pro` to `prolite`; Cursor's pools since June 2026), with the
model (a percent buys less Opus than Sonnet), with peak hours and promotions, and when the plan
under a login changes. So:

- Record observations, never the ratio: per lab run and window, the percent before and after
  (story 022's waiting runner reads it already), the run's list-price estimate, its model, the
  plan and tier, the date.
- Derive the value when asked, over a recent span, with the span, plan, model and sample count
  beside it; flag a shift when recent runs disagree with the span before, rather than average it.
- Never decide on it: waiting and budgets stay on the harness's own percent.

Notes: the operator's own sessions move the same windows meanwhile, so one run's delta is noisy and
the median over many is the figure; percents are whole numbers, so short runs read as 0 and only
long ones count. Where the observations live is the design question: the lab's results, or the
run's `output.json`, which would make it a record change.
