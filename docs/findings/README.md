# Findings

What the experiments settled, and what is still live. The plan they feed is
[`../foundation.md`](../foundation.md).

The long per-experiment reports were removed on 2026-09-17. They narrated `poc1` code — `cli.ts`,
`result-layer.ts`, `trial.ts`, `runner.ts`, `backends/` — that the Stage 0 move deleted or archived,
and one of them (`e2-design.md`) had been refuted by its own sibling without either saying so. The
prose is in git (`git show ee0df49:docs/findings/`). The numbers are not in git alone: every figure
below is re-derivable from committed raw data, except where marked.

| | question | verdict |
|---|---|---|
| E1 | can each harness be driven as a pane and headless? | **yes, 48/48** |
| E2 | how often does a terminal agent hand a value back? | **480/480 — 4 needed a nudge** |
| E3 | what does a call cost? | **pane per call; pooling buys time, not tokens** |
| E4 | how many agents at once? | **not run** — see [`../../experiments/e4-concurrency/`](../../experiments/e4-concurrency/) |
| E5 | does the schema error get it to self-correct? | **yes, 240/240 — and it should not have to** |
| E6 | does the journal replay? | **yes, and it is not enough** |
| E7 | does forking a prepared agent save anything? | **correctness yes, tokens almost never** |
| X1–X18 | what can srt and docker hold? | **both hold the seam; docker's door is a relay** — see [`sandbox-providers.md`](sandbox-providers.md) |
| S1–S10 | what does a System One model (Jev) do on awf's questions? | **matches findings well; grades severity only after re-thresholding** — see [`system-one-models.md`](system-one-models.md) |

E1's removed report read 24/24; that counted one prompt-size arm of the 48 rows in
`e1/results/e1.jsonl`. [`../foundation.md`](../foundation.md) §4 carries the corrected number.

## Carried in foundation.md

These conclusions changed the design and are stated where the design is. They are not repeated here:
delivery is feasible and needs a nudge policy; a subscription pane is charged to nobody on the
measured account while `claude -p` bills metered; cost is a domain, not a metric; branching a session
re-pays the context and continuing it keeps the cache; schema constraints belong in the prompt; a
tool call returning success is not evidence the model received anything. See §2, §4, §6, §7 and §8.

## Recorded only here

Each of these survived the reports because nothing else in the repository holds it.

**Send the schema, not a rendering of it.** `describe()` renders the shape and drops `minimum`,
`maximum`, `minItems`, `minLength` and `additionalProperties` — every constraint the validator
enforces. First-attempt validity was 0/160 without the schema in the prompt and 80/80 with it. E5
offered two fixes, widening `describe()` or appending the schema. The second was taken on
2026-09-24: the operation prompt carries the schema itself, and the value goes in a quoted heredoc
rather than a quoted argument, which broke once on shell quoting. That prompt gave 20/20 valid
first answers and no broken commands on headless codex (story 002, human review).

**Keep the per-field error text anyway.** It costs 2.00 attempts against 2.90–4.95 for a bare
refusal, worst case 11. It also steers the *value*, not only its shape: corrected values pin to the
boundary the message names. A rejection is not a neutral event when the value matters.

**Nothing bounds the attempt count.** E5 measured the loop and says nothing about where a cap
belongs. A deadline is a different axis.

**What the journal cannot replay** — the detail behind §10's "after deciding effect boundaries".
All six replay properties hold, and the key covers only what goes into the prompt. So: a step whose
real input is the working tree replays a stale answer silently; a resume re-runs every side effect
the script itself performs; an agent's side effects do not replay with its value at all; a clock,
counter or random value in a prompt caches nothing and nothing currently looks at the 0% hit rate;
an unstable fan-out admission order replays none of itself, which chained keys and a global slot
pool make the default shape rather than an edge case; and harness version, unpinned model, tool
config and pane environment are not in the key. The cheap repair is a caller-computed digest of
out-of-band inputs in the fingerprint, which turns a silent wrong replay into a correct miss.
Resume's honest scope is read-only fan-outs over inputs pinned in the prompt.

**Fork's real capability is not whether it can.** Every harness that forks does it natively and
inherits context correctly, so "can it fork" is the uninteresting question. The economics split by
**(harness, backend)**: a warm headless claude fork costs about what a resume costs; codex gets 33%
of its input cached where a resume gets 96%; pi pays about 7x a resume; cursor has no fork. In a
pane it inverts — six pane forks scored zero cache hits, so fourteen forks write the prefix fourteen
times where fourteen cold agents write it once, about 11x. A boolean fork capability cannot tell a
cheap fork from an expensive one, and §6 has since removed `pane | headless` — the axis the
economics split on — from every surface. Settle that before fork is ever exposed.

**E7 is prose-only.** It was ad-hoc CLI probing, never committed: no scripts, no
`experiments/_archive/e7/`, no raw rows. Its numbers cannot be re-derived from this repository —
only re-measured. Everything above about fork rests on that.

**Operational traps, each of which cost a run.** A herdr server started from inside a Claude Code
session propagates `CLAUDE_*` into every pane, which turns off transcript saving; those agents record
no usage at all, and it silently zeroed part of E1's cost data. `agent_pane_busy` hit 10 of 24 fresh
pane starts, so the retry in `packages/harness/src/adapters/herdr.ts` is mandatory, not defensive.
`agent prompt --wait` on a slash command stalls for a fixed 5000ms window on claude, pi and cursor,
and submitting without `--wait` corrupts the next prompt 4 times in 4. A `/clear` reset is not
acknowledged and failed silently 2 times in 16 — nothing in the returned value would reveal the
cross-contamination.

**Pane scraping is unreliable, not impossible.** A short value on the live screen read back 80 times
out of 80; output that scrolled off the alternate screen is gone. `packages/harness/src/types.ts`
carries the hedge.

**A later experiment corrected an earlier one.** E3 found `e2/pane-cost.ts` double-counting claude
pane tokens — one API response is written to the log as several rows sharing a `message.id`. E2's
delivery conclusion is unaffected; its pane cache figures are inflated.

## What E4 should watch

E4 is the one remaining measurement that changes the engine rather than confirming it. Run it on
**codex**, which bills a pane and a headless call the same way, so the concurrency numbers come back
without a billing asymmetry mixed in; then repeat the pane arm on claude to find the rate-limit
ceiling. Two things the other experiments could not see because they ran one call at a time: whether
`agent_pane_busy` gets worse under load, and whether the nudge still lands. E3 lost 4 calls in 80
because it sends none; E2 missed 4 in 480 and the nudge recovered all of them.

## Trust

Numbers are from committed raw data, not from a summary:
[`e1`](../../experiments/_archive/e1/results/), [`e2`](../../experiments/_archive/e2/results/),
[`e3`](../../experiments/_archive/e3/results/), [`e5`](../../experiments/_archive/e5/results/).
E6's evidence is its two test files in the archive; it ran offline and produced no rows. E7 produced
nothing — see above.

E2's 100% is only meaningful because its negative control fails: pointing the run id at a decoy
produced 8 of 8 lost while the agents still settled `done`. Check the instrument before believing the
reading.
