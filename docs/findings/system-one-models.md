# System One models: what Jev does on awf's own questions

Run 2026-09-26 against `typesafe/jev-1.13` (snapshot `typesafe/jev-1.13-20260917`) through
OpenRouter's Decisions API, for [story 006](../stories/006-typed-decisions.md). The API is described
in [`research/system-one-models.md`](../research/system-one-models.md); this page is what the live
calls showed. Every call together cost about $0.05.

S1–S5 used synthetic text. S6–S10 used a private fixture set (story 005): 110 answer-key issues from
22 MRs, each with three agent graders' severity votes, and 165 review comments that are the sources
of the keys' issues, refuted claims and exclusions. The data is private, so this page has counts
only. The scripts read that data and were not kept, so like E7 these numbers can be re-measured but
not re-derived from this repository.

| # | Question | Result |
|---|---|---|
| S1 | Do the documented endpoints answer? | **Yes.** `POST /api/alpha/decisions` and `POST /api/v1/systemone` (bare `jev-1.13`) return the same shape. `~typesafe/jev-latest` resolved to the same dated snapshot. `chat/completions` refuses: "is a decisions model and cannot be used with the chat/completions endpoint". |
| S2 | Where are the limits? | 255 choices answer, 256 is a 400 ("Too many choices"). 10 score levels answer, 11 is a 400. One option or one level answers with probability 1. A 30,273-token state answers in 407 ms; 40k tokens is a 400 `max_tokens_exceeded`. No questions, or an unknown `type`, is a 400. A yes/no question without `criteria` answers. |
| S3 | What is billed? | **The state, once per request.** One, ten and fifty questions over the same state billed 9,275, 9,410 and 10,050 input tokens. 200 questions over a short state: 3,759 tokens, 192 ms. `usage.cost` is exactly input tokens × $0.042/M; output tokens are reported and not charged. |
| S4 | How fast? | p50 150–167 ms and p90 200–241 ms over passes of 110–385 calls, 8 at a time. 60 at once: all answered, p50 204 ms, slowest 913 ms, no 429. |
| S5 | Is it deterministic? | **No, but close.** Five identical calls: expected score 2.78–2.82, one probability 0.86–0.90. Two full passes over 110 issues: the top answer changed on 2 (score) and 4 (choice). Median largest probability change 0.02, at most 0.11. |
| S6 | Can it grade severity by the rubric `draft-key` uses? | **Only after re-thresholding, and it doesn't read the code.** Its top level matched the graders' settled severity on 44–49% (80–83% within one level), a weighted κ of 0.55–0.58, where grader pairs agree at 0.56–0.70. It inflates: 51 of 110 predicted `must-fix` against 10 settled. It caught all 10 `must-fix`, and got 4 of 26 `should-fix`. With level names and no rubric: 20%. Cut points on its expected score, fitted on half the MRs and tested on the other half (20 splits): **64% exact, 97% within one**, where always answering `could-fix` scores 46%. The same without the code excerpts: 64%. |
| S7 | Does splitting the rubric into yes/no questions help? | **No: 57%.** "Does it change runtime behaviour" separates nits cleanly (median 0.09 against 0.95). "Did this MR cause it" does not, even with `scope` in the state (0.35–0.49 in every class). |
| S8 | Can it match a review comment to the key issue it raises? | **Yes.** One choice over the MR's issues (their `mechanism` as descriptions) plus `none`: 116 of 120 comments that are an issue's source matched correctly. Of 45 comments that are not, 30 got `none` (refuted 5/6, unconfirmed 9/13, later-push 15/25). With the answer kept only at top probability ≥ 0.9: 72% of comments, 117/118 right, one negative matched. At ≥ 0.7: 81%, 95% right. $0.0123 for all 165, under $0.0001 each. The keys' mechanisms were drafted from these comments, so an independent finding will be harder. |
| S9 | …and one comment to several issues? | One yes/no per issue at 0.7: the exact set on 79% of comments, 24 extra labels over 165. The choice's answer and the highest yes/no agreed on 93%. The 385 graders' explanations matched 385/385, but the graders had read the mechanism: an upper bound, not evidence. |
| S10 | What is `confidence`? | **Not reproducible, and not needed.** It is near `(n·max − 1)/(n − 1)` (median error 0.007) but not in the tail (p90 0.15, max 0.31). The top probability ranks right answers above wrong ones exactly as well: AUC 0.900 for both, and 99.2% accuracy at 72% coverage for both. On severity, neither tracked where the graders disagreed (AUC 0.49–0.53). Probabilities come rounded to two decimals and sum to 0.99–1.00. |

## What it settles

- **A decision is a state plus many questions.** The state is the bill (S3), and more questions
  over it are nearly free and no slower. A call per question pays the state again each time.
- **The answer is the distribution; the top pick is a convenience.** Severity's top pick was
  useless (S6), and its expected value with tuned cut points was the best result. Thresholds are
  fitted offline, so the probabilities must be kept with every call, and they are only valid for
  the snapshot they were fitted on (S5).
- **Keep the probabilities and drop the vendor's `confidence`.** awf can compute its own statistic
  from them, and it works as well (S10).
- **It judges the text, not the code.** Code excerpts changed nothing (S6), and a fact it had to
  look up in the state was missed (S7). Anything that needs tracing through code stays with agents.
- **Matching is the fit.** Match with a threshold and send the rest to an agent (S8). Settling
  severity is not: at best it can put issues in order.
- **Limits are enforced by the provider, with clear 400s** (S2). awf does not need to know them in
  advance.
