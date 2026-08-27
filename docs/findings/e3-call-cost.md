# E3 — what does a call cost

Run 2026-08-23, macOS 25.5.0, one laptop, sequential, nothing else contending. Herdr 0.8.0,
session `wf-lab`, whose server has no `CLAUDE_*` in its environment — checked with `ps eww`, and
checked again by confirming a claude pane wrote a transcript with `usage` in it before the matrix
started. Binaries: claude 2.1.241 (`claude-opus-5`, 1M context), codex 0.149.0 (gpt-5.6-sol), pi
0.84.2, cursor-agent 2026.08.11 (Grok 4.6).

Scripts: `../../experiments/_archive/e3.ts`, `../../experiments/_archive/e3/`. Raw rows: `../../experiments/_archive/e3/results/e3/trials.jsonl` (60),
`../../experiments/_archive/e3/results/e3-poolwait/trials.jsonl` (20), resolved usage in `../../experiments/_archive/e3/results/e3-usage.jsonl`,
full tables in `../../experiments/_archive/e3/results/e3-report.md`. Regenerate with
`bun run e3/report.ts e3/results/e3 e3/results/e3-poolwait`.

Same trivial task everywhere — count the letter `e` in `agent terminal` — plus a per-rep tag the
agent has to echo back, so a pooled pane handing over the previous call's answer would show as a
wrong tag rather than as a plausible number. Return method is `delimited-line` in all three
shapes, because it is the only one that needs nothing from the environment (see "What pooling
costs that is not time"). 5 reps per cell, all five printed.

## The answer

**Pooling loses on the merits; between the other two, billing decides.** Pooling buys wall clock
and nothing else — it does not reduce tokens at all, and its reset is the most fragile thing
measured here. That leaves a pane per call against headless per call, and for claude those two are
not paid for out of the same pocket.

| shape | 14 sequential calls, claude | claude tokens, priced | dollars, pi |
|---|---|---|---|
| pane per call | 101.2 s | $2.82 *(not billed — subscription)* | $0.59 |
| pooled pane, 1 s settle | 67.6 s | $2.82 *(not billed)* | $0.23 |
| pooled pane, correct reset | 109.0 s | $2.84 *(not billed)* | $0.60 |
| headless per call | 72.2 s | **$1.64 billed** | $0.44 |

The claude column is not one kind of number, which is the correction that matters here. A pane
writes tokens and no price to its session log, so its dollars are **imputed** by `e3/price.ts` from
a list-price rate card. Headless dollars are `total_cost_usd`, **reported by the CLI**. On a Claude
subscription the pane figure is charged to nobody, while `claude -p` draws on usage credits — an
included pool of about $70 a month on this account — even with no API key in the environment. So
the honest reading is $0 in a pane against $1.64 headless, roughly 43 fan-outs a month before
headless costs real money. That inverts the shape decision for claude: **pane per call by default,
headless as the way to spend credits to get past a rate limit.**

The mechanism is not documented by Anthropic. It is reported repeatedly against `claude -p`
(`anthropics/claude-code` issues 43333 and 37686) and matches this account's configuration —
`stripe_subscription`, `claude_max`, no API key, usage credits enabled.

**codex has no such split**, which makes it the harness where this choice can be made on merit
alone rather than on billing, and the right one to measure concurrency with. codex and cursor
report no dollar figure anywhere, so their columns are unmeasurable, not zero.

## Wall clock, every rep (ms)

`setup` is getting an agent ready. `turn` is `agent prompt --wait` returning, or the subprocess
exiting. `teardown` is `workspace close`.

| shape | harness | setup | turn | teardown | total | mean |
|---|---|---|---|---|---|---|
| pane per call | claude | 5119 / 3030 / 3105 / 3045 / 3117 | 3084 / 3431 / 3397 / 3104 / 2993 | 540 / 528 / 553 / 547 / 558 | 8743 / 6989 / 7055 / 6696 / 6668 | 7230 |
| pane per call | codex | 3023 / 3081 / 3117 / 3018 / 3100 | 3418 / 3315 / 2763 / 2769 / 3324 | 34 / 24 / 31 / 31 / 36 | 6475 / 6420 / 5911 / 5818 / 6460 | 6217 |
| pane per call | pi | 3102 / 5126 / 3105 / 3034 / 3108 | 3325 / 3209 / 4918 / 3300 / 3315 | 37 / 36 / 33 / 37 / 36 | 6464 / 8371 / 8056 / 6371 / 6459 | 7144 |
| pane per call | cursor | 3122 / 3031 / 3092 / 3109 / 3094 | 3984 / 7976 / 4865 / 4904 / 7370 | 34 / 36 / 33 / 36 / 34 | 7140 / 11043 / 7990 / 8049 / 10498 | 8944 |
| pooled, 1 s settle | claude | 0 / 1006 / 1008 / 1008 / 1007 | 3393 / 4489 / 4259 / 3532 / 3329 | 0 | 3393 / 5495 / 5267 / 4540 / 4336 | 4606 |
| pooled, 1 s settle | codex | 0 / 1005 / 1008 / 1005 / 1008 | 3319 / **222** / 2987 / 3621 / **219** | 0 | 3319 / 1227 / 3995 / 4626 / 1227 | 2879 |
| pooled, 1 s settle | pi | 0 / 1012 / 1010 / 1008 / 1010 | 4373 / 3726 / 3783 / 5681 / 3544 | 0 | 4373 / 4738 / 4793 / 6689 / 4554 | 5029 |
| pooled, 1 s settle | cursor | 0 / 1009 / 1008 / 1009 / 1013 | 9043 / 4553 / 13109 / 3852 / 3949 | 0 | 9043 / 5562 / 14117 / 4861 / 4962 | 7709 |
| pooled, wait reset | claude | 0 / 5113 / 5104 / 5078 / 5037 | 3115 / 3496 / 3438 / 3196 / 3514 | 0 | 3115 / 8609 / 8542 / 8274 / 8551 | 7418 |
| pooled, wait reset | codex | 0 / 1594 / 1274 / 1268 / 1270 | 4824 / 2998 / 2979 / 4825 / 2769 | 0 | 4824 / 4592 / 4253 / 6093 / 4039 | 4760 |
| pooled, wait reset | pi | 0 / 5105 / 5021 / 5045 / 5094 | 3311 / 3644 / 2881 / 3226 / 3984 | 0 | 3311 / 8749 / 7902 / 8271 / 9078 | 7462 |
| pooled, wait reset | cursor | 0 / 5023 / 5037 / 5016 / 5028 | 3935 / 4472 / 4817 / 3536 / 5731 | 0 | 3935 / 9495 / 9854 / 8552 / 10759 | 8519 |
| headless | claude | 0 | 5370 / 5363 / 5701 / 3813 / 5548 | 0 | same as turn | 5159 |
| headless | codex | 0 | 4374 / 4037 / 6150 / 4179 / 4330 | 0 | same as turn | 4614 |
| headless | pi | 0 | 6593 / 6547 / 7011 / 5688 / 5937 | 0 | same as turn | 6355 |
| headless | cursor | 0 | 6869 / 5181 / 4205 / 4276 / 6307 | 0 | same as turn | 5368 |

Pool setup, paid once per pool: claude 3103, codex 3119, pi 3018, cursor 5049 (settle arm);
5112 / 3118 / 3111 / 3110 (wait arm). Added to the fan-out figures above.

Headless has no setup column that means anything. E1 already found that claude and cursor buffer
their JSON and print it once at the end, so spawn-to-first-byte is the whole turn for them. There
is no honest startup-versus-turn split headless; the subprocess is the call.

### Where the pane's three seconds go

`workspace create` 6–12 ms. `agent start` 3010–3114 ms, on every harness, every rep.
`workspace close` 24–37 ms, except claude which takes 528–558 ms to shut down.

**E1's claim reproduces exactly: pane startup is Herdr's readiness settle and nothing else.** The
CLI being launched changes it by under 100 ms; the workspace itself is free. Two of 20 pane starts
hit `agent_pane_busy` and cost the retry's 2 s sleep — the 5119 and 5126 rows. E1 saw 10 of 24;
2 of 20 here, still regular enough that the retry is mandatory.

## Tokens per call, every rep

| shape | harness | source | uncached in | cache write | cache read | out |
|---|---|---|---|---|---|---|
| pane per call | claude | session log | 2 ×5 | 18562 / 18559 / 18562 / 18561 / 18566 | 27247 ×5 | 87 / 95 / 87 / 98 / 95 |
| pooled | claude | session log | 2 ×5 | 17408 / 18698 / 18697 / 18693 / 18696 | 27247 ×5 | 87 / 152 / 209 / 130 / 125 |
| headless | claude | stdout | 2 ×5 | not split | not split | 98 / 155 / 139 / 161 / 169 |
| pane per call | codex | session log | 18932 ×5 | 0 | 11008 / 11008 / 11008 / 18176 / 11008 | 60 / 57 / 27 / 27 / 27 |
| pooled | codex | session log | 18932 / 19070 / 18932 (3 of 5) | 0 | 11008 / 18176 / 18176 | 27 ×3 |
| headless | codex | stdout | 21093 ×5 | not split | 11008 ×5 | 27 / 27 / 55 / 27 / 27 |
| pane per call | pi | session log | 10044 / 10044 / 316 / 10044 / 10044 | 0 | 0 / 0 / 9728 / 0 / 0 | 27 / 27 / 27 / 27 / 57 |
| pooled | pi | session log | 316 / 10044 / 316 / 316 / 316 | 0 | 9728 / 0 / 9728 / 9728 / 9728 | 75 / 27 / 27 / 27 / 27 |
| headless | pi | stdout | 7484 / 10044 / 316 / 10044 / 316 | not split | 2560 / 0 / 9728 / 0 / 9728 | 27 / 27 / 78 / 27 / 27 |
| any | cursor | — | **unmeasurable** | | | |

claude headless reports `cache_creation_input_tokens` and `cache_read_input_tokens` but
`harness.ts` folds them into one number before the record is written, so the split is only
available for the pane rows, which come from the session log. It does not matter for pricing
headless — the CLI reports dollars directly.

**cursor is unmeasurable twice over in a pane.** Herdr reports no `agent_session` for a cursor
pane at all (`sessionRef` is `null` in all 10 pane rows), and E1 already found cursor writes no
token or cost figure anywhere on disk. Headless cursor at least reports tokens.

## Dollars per call

claude reports `total_cost_usd` headless and nothing at all from a pane, which would leave the
shape that most needs a price without one. So the pane rows are priced from their own tokens with
a rate card solved out of claude's own headless figure — `e3/price.ts`, mutation-tested in
`e3/price.test.ts`:

```
in 2, cache-write(1h) 13167, cache-read 19342, out 4   ->  claude reported $0.141451
2*$5 + 13167*$10 + 19342*$0.50 + 4*$25, per million     =            $0.141451
```

Both backends run `claude-opus-5` with 1-hour ephemeral cache writes — checked in the pane's
session log and in headless `modelUsage` — so the same card covers both. Marked *derived* below.

| shape | harness | $ per call, all five reps | mean |
|---|---|---|---|
| pane per call | claude *derived* | 0.2014 / 0.2016 / 0.2014 / 0.2017 / 0.2017 | **$0.2016** |
| pooled, 1 s settle | claude *derived* | 0.1899 / 0.2044 / 0.2058 / 0.2038 / 0.2037 | **$0.2015** |
| pooled, wait reset | claude *derived* | 0.2017 / 0.2038 / 0.2038 / 0.2031 / 0.2034 | $0.2032 |
| headless | claude reported | 0.0188 / 0.1466 / 0.1462 / 0.1272 / 0.1470 | **$0.1172** |
| pane per call | pi reported | 0.0510 / 0.0510 / 0.0073 / 0.0510 / 0.0519 | $0.0425 |
| pooled, 1 s settle | pi reported | 0.0087 / 0.0510 / 0.0073 / 0.0073 / 0.0073 | $0.0163 |
| pooled, wait reset | pi reported | 0.0510 / 0.0073 / 0.0510 / 0.0510 / 0.0524 | $0.0425 |
| headless | pi reported | 0.0395 / 0.0510 / 0.0088 / 0.0510 / 0.0073 | $0.0315 |
| any | codex, cursor | **no dollar figure exists** | — |

**pi's dollars are bimodal and its means are noise.** Every pi turn is either ≈$0.051 (10044
uncached input) or ≈$0.0073 (316 input, 9728 cache read) — the same prompt, the same second. E1
found this and called it context discovery sometimes not happening; it reproduces here in all
three shapes and the ratio between pi's three means is just how many of each landed in five reps.
Do not read a shape preference into pi's numbers.

**claude's are not noise, and the ordering is the surprise.** A pane call costs 72% more than a
headless one, consistently, five reps to five reps. The reason is in the token table: an
interactive claude carries a bigger cached prefix than `claude -p` does — 18.6 k cache write and
27.2 k cache read against 13.2 k and 19.5 k. The pane is not paying for the pane; it is paying for
what the interactive CLI loads.

## Pooling: what the reset actually costs, and what it does not save

Herdr has no reset verb. Each harness has its own, all four confirmed by reading their command
tables and then driving them:

| harness | reset | the harness's own words |
|---|---|---|
| claude | `/clear` | Clear conversation history and free up context |
| codex | `/new` | start a new chat during a conversation |
| pi | `/new` | Start a new session |
| cursor | `/clear` | Start a new chat session |

**All four work.** `e3/reset-probe.ts` plants a passphrase, resets, and asks for it back: 4 of 4
answered `NONE`. The harnesses agree with themselves — every reset produced a new session id in
the harness's own log, so the pool's calls are genuinely separate conversations.

**Getting the reset to land is the hard part, and it is where a pool is fragile.**

- `agent prompt --wait` on a slash command answers `agent_prompt_stalled` on claude, pi and
  cursor: "no observed state change within 5000 ms". The reset worked; Herdr just never saw the
  agent leave `idle`. The 5000 ms window is fixed — passing `--timeout 20000` still stalled at
  5024 ms. So a correct reset costs a flat ~5.0 s on three of four harnesses. codex is the
  exception: `/new` does change state, and its reset settles in 1.27–1.59 s.
- Submitting without `--wait` returns in 4–7 ms and **corrupts the next prompt**. The TUI has not
  consumed the command, so the task text lands concatenated onto it: `/clearWhat passphrase…`,
  `/newWhat passphrase…`. 4 of 4 harnesses, and codex then answered
  `Unrecognized command '/newWhat'`. Polling for the screen to change does not help — the screen
  changes in 8–114 ms because the text is being *typed*, well before Enter takes effect.
- A fixed sleep works. 4 of 4 harnesses passed the passphrase probe at 1000 ms and again at
  500 ms; 4 of 4 failed at 0 ms.

The matrix ran a pool both ways. With a 1 s settle, **codex lost 2 of 5 calls**: `--wait` returned
in 219–222 ms with `idle`, having matched the still-running `/new` turn rather than the task —
which is exactly the failure mode `agent prompt --wait`'s own help warns about, an already-working
agent matching the wrong turn's completion. The two failed reps are also the only two whose
`sessionRef` equals the previous rep's, so the harness's own log confirms the reset had not been
applied when the task arrived. With `--wait` on the reset, codex was 5 of 5.

Best case per harness — 1 s settle for claude, pi and cursor, `--wait` for codex — a pooled call
is 4.6 / 4.8 / 5.0 / 7.7 s against 7.2 / 6.2 / 7.1 / 8.9 s for a fresh pane. Over fourteen
sequential calls, pool setup included, that is 67.6 / 69.8 / 73.4 / 113.0 s against
101.2 / 87.0 / 100.0 / 125.2 s. **Pooling saves 10–33% of wall clock and 0% of tokens.**
claude's per-call dollars are $0.2015 pooled against $0.2016 per-call: `/clear` starts a new conversation, which means the whole cached prefix is
written again. There is no token argument for a pool. There is only a three-second one.

### What pooling costs that is not time

**A pooled pane cannot carry a per-call identity.** `workspace create --env` fixes the
environment when the pane is made, and the calls come afterwards, so `WF_CALL` can only name the
pool, not the call. E3 sidesteps this by using `delimited-line`, which needs no environment. An
engine that wants `cli-callback` — the only channel that can refuse a value, which is the whole of
abstraction 4 — has to put the call id in the prompt for a pooled pane, which is precisely what
the design chose the pane environment to avoid.

**A failed reset is not announced.** The reset is a slash command typed into a TUI and nothing
acknowledges it. 2 of the 16 one-second resets did not take, and neither Herdr nor the harness
said so — the only evidence was the next call's `sessionRef` still being the previous call's, and
that was only checked afterwards. In those two the call also produced no value, so nothing wrong
was returned. **That is luck, not a safeguard.** Had the task not needed the pane's whole
attention, the second call would have run inside the first call's conversation and answered
plausibly, and neither the schema nor the wait would have caught it. Fourteen review lenses
sharing a pool are fourteen lenses that stop being independent the first time a `/clear` is
swallowed, and nothing in the returned value would say so.

## Delivery

Not what E3 is for — E2 measured this over 480 trials — but recorded anyway.

76 of 80 calls delivered, 76 of 80 with the right tag and the right count. The four misses:

- **cursor, twice**, once per-call and once pooled: cursor printed
  `{ count: 2, even: true, tag: "R2-CU" }` between the markers. A JavaScript object literal, not
  JSON. This is the same failure E2 saw 4 times, on the same harness, on the same return method.
  E3 sends no nudge, so it stayed lost; in E2 the nudge fixed it every time.
- **codex, twice**, both in the 1 s-settle pool: the swallowed `/new` above.

## Contradictions

None with E1 or E2 on anything they measured. Two additions and one correction:

- **`e2/pane-cost.ts` double-counts claude's pane tokens.** claude writes one API response out
  as several log rows — a thinking block and the text after it carry the same `message.id` and the
  same `usage` — and that script sums them all. E2's pane cache figures (29532 write / 43595 read)
  are inflated wherever a turn had a thinking block; `e3/pane-usage.ts` dedupes by `message.id`
  and gets 18.6 k / 27.2 k for the same kind of turn. E2's *conclusion* — a pane nudge reads the
  cache instead of rebuilding it — is unaffected, because the double count applies to both turns.
- The plan's abstraction 3 lists "a pool of panes reset between calls — fast, but resetting is
  per-harness and leaks if it fails". Both halves are right. What it does not say is that the
  reset also costs about as much as a fresh pane's start on three of four harnesses, which is most
  of the reason to pool in the first place.
- The plan's "Not building" says cursor is unpriceable. In a pane it is worse than unpriceable —
  Herdr reports no session reference for it either, so there is nothing to look up even if cursor
  did write a log.

## What this did not measure

- **Concurrency.** Every number here is sequential; a fourteen-way fan-out that actually runs
  fourteen at once is E4, and the fan-out columns are fourteen times one call, not a measurement
  of fourteen calls. The shape ordering could change under load: fourteen panes contend for one
  Herdr server, fourteen subprocesses contend only for the laptop.
- **A real workload.** The task is five seconds of nothing. Setup is 30–45% of a pane call here
  and would be 2% of a five-minute review, which is the case the fan-out is actually for. Read the
  wall-clock argument for pooling as an upper bound on what pooling can ever win.
- **A pool deeper than five calls.** Nothing says a pane stays healthy for fifty.
- **codex and cursor dollars, and cursor pane tokens.** No figure exists.
- **claude pane dollars as reported by claude.** Only as derived, from a card that reproduces one
  headless turn to six decimal places.
- **Model parity across harnesses.** Each harness ran its own default model. The dollar columns
  compare shapes within a harness, never harnesses against each other.
