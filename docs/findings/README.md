# Findings

What the experiments established, above the level of any single one. Plan and open questions:
[`../foundation.md`](../foundation.md).

| | question | verdict |
|---|---|---|
| [E1](e1-harness-matrix.md) | can each harness be driven as a pane and headless? | **yes, 48/48** |
| [E2](e2-return-channel.md) | how often does a terminal agent hand a value back? | **480/480 — 4 needed a nudge** |
| [E3](e3-call-cost.md) | what does a call cost? | **pane per call; pooling buys time, not tokens** |
| E4 | how many agents at once? | not run |
| [E5](e5-self-correction.md) | does the schema error get it to self-correct? | **yes, 240/240 — and it should not have to** |
| [E6](e6-resume.md) | does the journal replay? | **yes, and it is not enough** |

The verdict column is corrected against [`../foundation.md`](../foundation.md) §2 and §4. The
reports below are frozen as written, so E1's own text still reads 24/24 — that counts one
prompt-size arm of the 48 rows in `e1/results/e1.jsonl`.

Both gates are cleared. The design's premise holds: four harnesses, two backends, three return
channels, all of them work. Delivery is feasible and needs a nudge policy — it is not solved: 4 of
480 needed a nudge to land, and E3, which sends none, lost 4 of 80.

## What changed in the plan because of a measurement

- **The backend seam was wrong.** A one-shot `run(step, callId)` cannot express a nudge or an
  in-turn correction — both need the agent alive after it settles. Backends now open a session.
- **Delivery is not the risk.** It was written down as the highest-risk unknown in the design.
  480 trials later it is retired, and cost and concurrency are what remain.
- **"Nudge is nearly free" was half wrong.** True for a pane at 12% of a first turn. False
  headless, where a resume rebuilds the cache in a new process — 321% of the first turn's dollars
  on a trivial task. Resume saves the work already done, not money.
- **Pane scraping is not impossible, only unreliable.** Herdr's own documentation says the
  alternate screen loses output; a short value on the live screen read back 80 times out of 80.
  Long output is untested and still expected to fail.
- **Liveness must come from `agent_status`.** Only claude and codex write status into the terminal
  title, so `review-loop/liveness.ts` would read pi and cursor as `unknown` forever.
- **cursor is unpriceable.** codex and pi record per-turn usage on disk; cursor records none
  anywhere. E3 adds that Herdr reports no session reference for a cursor *pane* either, so there
  is nothing to look up even if cursor did write a log.
- **The two dollar columns were not the same number.** E3 concluded headless was 42% cheaper. A
  pane's session log records tokens and no price, so `e3/price.ts` imputes its dollars from a
  list-price rate card; headless dollars come from `total_cost_usd`, reported by the CLI. On a
  Claude subscription the pane figure is charged to nobody — the pane draws on the subscription,
  while `claude -p` bills as metered usage even with no API key in the environment. Corrected, a
  fourteen-way fan-out is **$0 in a pane against about $1.64 headless**, and the shape decision
  flips to a pane per call. Headless remains the way to buy past a rate limit, never the default.
  The mechanism is not documented by Anthropic; it is reported repeatedly against `claude -p`
  (`anthropics/claude-code` issues 43333 and 37686) and it matches how this account is set up.
- **Headless has a budget, and it is small.** The plan includes usage credits — about $70 a month
  on this account — so headless spends an allowance before it spends real money. At $1.64 a
  fourteen-way fan-out that is roughly **43 runs a month**. Worth having, not worth defaulting to,
  and worth showing the operator before a run rather than after.
- **A pooled pane saves wall clock and no tokens.** `/clear` starts a new conversation, so the
  whole cached prefix is written again: $0.2015 pooled against $0.2016 per call for claude. Its
  reset is also the most fragile thing measured — a slash command typed into a TUI that nothing
  acknowledges, which failed silently 2 times in 16.
- **The instructions do not carry the constraints the validator enforces.** `describe()` renders
  the shape and drops `minimum`, `maximum`, `minItems`, `minLength` and `additionalProperties`.
  First-attempt validity is 0% because of that, and 100% when the schema itself is in the prompt.
- **A later experiment corrected an earlier one.** E3 found that `e2/pane-cost.ts` double-counts
  claude pane tokens — one API response is written to the log as several rows sharing a
  `message.id`. E2's conclusion is unaffected; its pane cache figures are inflated.
- **The correction loop is real and the error text is what makes it cheap.** 240 of 240 refused
  turns fixed themselves inside the turn. With the per-field message that took exactly 2 attempts
  every time; with a bare refusal it took up to 11 and cost claude 3x the dollars.
- **Resume is not worth having yet.** The journal works — all six replay properties hold — and is
  silently wrong for the one workload the engine is for, because the key covers the prompt and not
  what the agent reads once running. Shelved rather than wired in.
- **The journal replays, and "enough" was too generous.** All six replay properties hold, but the
  key covers only what goes into the prompt. A step whose real input is the working tree replays a
  stale answer silently, and a resume re-runs every side effect the script itself performs — the
  thing the sandbox forbade by construction. Resume's honest scope is read-only fan-outs over
  inputs pinned in the prompt.

## E7 — forking works everywhere it exists, and saves tokens almost nowhere

Fork was the one idea in `wf/interfaces` with no evidence behind it. It has some now.

**Context sharing is real and it survives deletion of the source.** A claude parent spent 14 turns
reading a repo; the repo was deleted; its forks still named the secret token in `module_7` and real
functions from files that no longer existed. Same on codex and pi. A fork carries what the agent
*worked out*, which is the thing a prompt cannot cheaply reproduce.

**The saving is a different question, and the answer splits by provider.** On claude a warm fork
costs what a resume costs — $0.0047 against $0.0046 — and six concurrent forks with different
questions all read the full cached prefix. On codex a fork gets 33% of its input cached where a
resume of the same session gets 96%; pi, on the same OpenAI backend, pays about 7x a resume.
Cursor has no fork at all.

Two conditions matter. The first fork pays the write, so fanning out fourteen at once against a
cold parent buys fourteen writes. And claude's saving was reliable when the fork point was one
pasted message but not when the parent's context came from many tool turns — there, a fan-out of
differing questions re-paid every branch, three times out of three.

This partly corrects E3. E3 found `/clear` on a pooled pane saved 0% of tokens, and we assumed a
fork was the same move. It is — on codex, on pi, and, as it turns out, on claude in a pane. Only
headless claude escapes it.

**The pane arm reverses it.** Panes are the subscription path, so they were measured separately.
Fork works there — herdr exposes each pane's session id, forks replay the parent and answer from
it, four concurrent forks finished in 11s. But six pane forks scored **zero** cache hits, while a
relaunched pane that resumes instead of forking got a full one, and a *second* cold agent handed
the identical brief also got a full one. So in a pane, fourteen forks write the prefix fourteen
times where fourteen cold agents write it once: about **11x more tokens for forking than for not
bothering**. Same CLI, same model as the headless arm that showed the opposite.

The practical rule that falls out: if the prepared context can be written down, hand the brief to
cold agents and let prefix caching work. Fork only for working memory you cannot re-express — and
know it buys correctness, not cost.

**`/fork` is a third mechanism and lands the same way.** Claude's in-TUI `/fork` is not the CLI flag
— it copies the conversation into a separate background process with its own pid and session id,
listed by `claude agents --json`. As a way to get one live agent per lens it is the nicest primitive
of the three. It still re-pays the context: two forks' own first turns wrote 50,736 and 22,969
tokens while the parent's resume in the same window wrote 200. Across every mechanism tested the
rule is the same — **continuing a session keeps the cache, branching it does not.**

**A prompt can also vanish with no error.** One 43KB brief never reached the model: the call
returned success, the pane sat idle, the transcript showed nothing. It is not a size limit — 44KB
with 900 newlines landed fine afterwards, and the same brief landed on four retries — so it is a
startup race that happened once in about a dozen sends. Reproducible neighbours: `agent start` on a
fresh pane often needs a retry, and `agent prompt --wait --until idle` returned `timeout` on a turn
that actually ran. The engine has to confirm submission from the transcript, because the tool's
return value is not evidence the model received anything — the same lesson E2 reached about the
return channel.

## The one question still open

**E4 — how many agents at once.** Never run. It needs the laptop to itself, and it is the only
remaining measurement that changes the engine rather than confirming it: whether a fourteen-lens
review is one batch or four. Everything it needs exists, including the atomic append the code
review added — before that fix, concurrent writes lost records, which is precisely what E4 would
have done to its own data.

The billing correction makes it more valuable, not less. If the shape is a pane on a subscription,
the ceiling is not process count or RAM — it is the rate limit, and E4 is the only thing that would
measure where it sits. Run it on **codex**, which bills a pane and a headless call the same way, so
the concurrency numbers come back without a billing asymmetry mixed into them; then repeat the
pane arm on claude to find the rate-limit ceiling specifically.

Two things it should watch that the other experiments could not see, because they ran one call at
a time: whether `agent_pane_busy` at start (10 of 24 in E1) gets worse under load, and whether the
delivery rate holds. E3 lost 4 calls in 80 because it sends no nudge; E2 missed 4 in 480 and the
nudge recovered all of them. Under concurrency the question is whether the nudge still can.

## Two things found that are about the wider workspace, not this experiment

- `review-loop/agents/herdr.ts` calls `agent prompt` without `--wait`. That single omission is why
  it needs the poll-Enter-Ctrl-C landing dance, which E1 never once needed.
- A herdr server started from inside a Claude Code session propagates `CLAUDE_*` into every pane,
  which turns off transcript saving — those agents record no usage at all. It silently zeroed part
  of E1's cost data before E1 noticed.

## Trust

Numbers here are from committed raw data, not from a summary: `../../experiments/_archive/e1/results/`, `../../experiments/_archive/e2/results/`,
`../../experiments/_archive/e3/results/`, `../../experiments/_archive/e5/results/`.
E2's 100% is only meaningful because its negative control fails — pointing the run id at a decoy
produced 8 of 8 lost while the agents still settled `done`. Check the instrument before believing
the reading.

## What graduates to the engine, and what does not

`wf-poc1/` mixed two kinds of code. Worth knowing which is which before the next phase starts.

**Keep.** `types.ts` (the session seam), `schema.ts`, `result-layer.ts`, `cli.ts`, `run-dir.ts`,
`return-method.ts`, `command.ts`, `harness.ts`, `backends/`. This is the engine's spine: one
acceptance gate, one place per harness where its flags live, two interchangeable backends.

**Throwaway.** `trial.ts`, `runner.ts`, `e1/`, `e2/`, `e3/`, `e5/`. Measurement scaffolding. It
exists to produce the numbers in this directory and has no job afterwards. `backends/fake.ts` is
the exception — keep it; it is what let E6 be proven without spending anything.

**Shelved.** `journal.ts` and its tests. Built, verified, and deliberately not wired in — see
[`e6-resume.md`](e6-resume.md) and the plan's abstraction 6 for why. Left in place so nobody
rebuilds it from scratch.

## Code review

[`code-review-1.md`](code-review-1.md) — six defects, all reproduced, all fixed, all
mutation-tested. Two mattered: the validator crashed on a value carrying a `toString` key, throwing
past the CLI error handling the correction path depends on; and `wf result` rejoined shell-split
arguments, silently accepting `{"msg": "a  b"}` as `{"msg":"a b"}`.
