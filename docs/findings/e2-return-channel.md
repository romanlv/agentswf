# E2 — return channel reliability

Run 2026-08-23, macOS 25.5.0, one laptop, nothing else contending. Herdr 0.8.0, session `wf-lab`,
restarted from a shell with every `CLAUDE_*` variable stripped. Binaries: claude 2.1.241,
codex-cli 0.149.0, pi 0.84.2, cursor-agent 2026.08.11.

Scripts: `../../experiments/_archive/e2/`. Raw rows: `../../experiments/_archive/e2/results/e2.jsonl` (480 trials), plus
`negative-control.jsonl`, `nudge-cost.jsonl` and `attempts.jsonl` (every value any agent offered,
accepted or refused). Regenerate the tables with `bun run e2/report.ts e2/results/e2.jsonl`.

## Verdict

**480 of 480 trials delivered. Every cell is 100%, so the 95% gate is cleared by all three return
methods on all four harnesses on both backends.** 476 arrived unprompted; 4 needed the nudge, and
the nudge recovered all 4. Nothing was lost, no trial errored, and no headless nudge failed to
resume.

That is a stronger result than the plan expected, and two of the plan's assumptions turn out to be
wrong in the process — one in our favour, one against. See "Where this contradicts the plan".

## The matrix

`unprompted` = the value was on the channel when the first turn settled. `nudged` = it arrived
after one line of follow-up. `bad-1st` = the first turn produced a value the result layer refused
and that refusal survived the turn. `fixed-1st` = refused, then corrected inside the same turn —
counted apart from both, because it is delivery, and it is E5's subject rather than E2's.

| harness | backend | method | n | unprompted | nudged | lost | fixed-1st | bad-1st | nudge-fail | delivered | median ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| claude | headless | cli-callback | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 8702 |
| codex | headless | cli-callback | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 9752 |
| pi | headless | cli-callback | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 7932 |
| cursor | headless | cli-callback | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 7051 |
| claude | pane | cli-callback | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 11981 |
| codex | pane | cli-callback | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 11634 |
| pi | pane | cli-callback | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 9311 |
| cursor | pane | cli-callback | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 10441 |
| claude | headless | write-a-file | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 9842 |
| codex | headless | write-a-file | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 15862 |
| pi | headless | write-a-file | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 8803 |
| cursor | headless | write-a-file | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 6802 |
| claude | pane | write-a-file | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 12240 |
| codex | pane | write-a-file | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 15026 |
| pi | pane | write-a-file | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 10439 |
| cursor | pane | write-a-file | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 9786 |
| claude | headless | delimited-line | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 5401 |
| codex | headless | delimited-line | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 4469 |
| pi | headless | delimited-line | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 5828 |
| cursor | headless | delimited-line | 20 | 18 | 2 | 0 | 0 | 2 | 0 | 100% | 4811 |
| claude | pane | delimited-line | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 6617 |
| codex | pane | delimited-line | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 6596 |
| pi | pane | delimited-line | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100% | 6645 |
| cursor | pane | delimited-line | 20 | 18 | 2 | 0 | 0 | 2 | 0 | 100% | 7425 |

By method: cli-callback 160/160 unprompted, write-a-file 160/160 unprompted, delimited-line
156/160 unprompted and 160/160 delivered.

The only four imperfect turns in the whole matrix are cursor on `delimited-line`, which printed
`{ count: 2, even: true }` — a JavaScript object literal, not JSON. `wf`'s parse error went back
in the nudge and cursor fixed it every time. Every other value in `attempts.jsonl` was valid JSON
on the first try, in three different whitespace styles.

Median wall clock is per trial, workspace creation and teardown included for the pane rows. First
turn alone, median: pane 3.3–12.0s, headless 4.5–15.9s. The pane's `delimited-line` rows are the
fastest first turns measured (3.3–3.9s) because nothing but printing is asked of the agent.

## The nudge is not free, and where it is cheap depends on the backend

Four natural nudges is not enough to price one, so a separate probe forced 45 of them: the first
turn is the task with **no** reporting instructions, so it always settles empty, and the second
turn is the same one-line nudge `trial.ts` sends. Not the natural failure population — these
agents were never asked to report — but it is the same two turns against one live agent, which is
what the plan's claim is about.

**One nudge recovered 45 of 45.** Including the 4 natural ones, 49 of 49.

| cell | recovered | first turn ms | nudge ms | first turn $ | nudge $ | nudge as share |
|---|---|---|---|---|---|---|
| claude headless | 5/5 | 4907 | 7635 | $0.0436 | $0.1398 | **321%** |
| claude pane | 10/10 | 3255 | 6155 | — | — | see below |
| codex headless | 5/5 | 5054 | 8669 | — | — | 206% of tokens |
| codex pane | 5/5 | 3109 | 6158 | — | — | — |
| pi headless | 5/5 | 6205 | 7728 | $0.0067 | $0.0071 | 106% |
| pi pane | 5/5 | 3343 | 4814 | — | — | — |
| cursor headless | 5/5 | 4359 | 5295 | — | — | 205% of tokens |
| cursor pane | 5/5 | 3460 | 5446 | — | — | — |

**The plan's claim — "a one-line prompt telling it to report costs almost nothing, where
re-running the step pays for the work twice" — is false for the headless backend and true for the
pane backend.** The reason is the prompt cache, and claude's own token breakdown shows it plainly:

```
claude pane      first turn  uncached-in 3  cache-write 29532  cache-read 43595  out 122
                 nudge turn  uncached-in 2  cache-write   263  cache-read 45704  out  87

claude headless  first turn  uncached-in 4  cache-write 13419  cache-read 51864  out 197  $0.1651
                 nudge turn  uncached-in 2  cache-write 13528  cache-read 19334  out   9  $0.1452
```

A pane holds one process across both turns, so the nudge writes 263 tokens of new cache and reads
the rest. A headless nudge is a **new process**: `--resume` replays the conversation and rebuilds
the cache from scratch, writing as many cache tokens as the first turn did and costing 88% of it.
On the probe's numbers a headless claude nudge cost 3.2x its own first turn, because that first
turn happened to hit a warm cache and the resumed one did not.

So, in cost terms:

- **Pane.** Nudge ≈ 12% of a first turn, pricing cache writes at 1.25x input and reads at 0.1x.
  Nudging is decisively cheaper than re-running. The plan is right here.
- **Headless.** Nudge ≈ a whole extra turn. The nudge path costs first + nudge ≈ 2x a turn; the
  re-run path costs first + fresh ≈ 2x a turn. **There is no cost saving, only the saving of any
  work the first turn already did** — which for a real step is the actual argument, but it is not
  the argument the plan makes.
- Latency goes the same way and is worse than expected: the nudge turn was *slower* than the first
  turn in all eight cells, 1.2x to 2.0x. A nudged trial is roughly twice the wall clock of a clean
  one.

pi is the exception on both counts — its nudge costs 106% of a first turn in dollars — because pi
sends a small context and does not lean on a large cached prefix at all.

## The instrument can register a failure

100% everywhere is only good news if a broken channel would read as broken. A first attempt at a
negative control failed to fail, in an instructive way: with `wf` removed from PATH, all eight
agents found `bin/wf` in the working directory and ran it anyway — and during that run a
**`~/.local/bin/wf` shim pointing at `wf-poc1/bin/wf` appeared on the machine**, which nothing in
the harness creates. An agent installed it so the command it had been told to run would exist.
(Removed afterwards. Nothing else was left behind.)

The second attempt cannot be routed around: `WF_RUN` points at a decoy run directory that holds no
record of the call, so `wf` runs and refuses every value however well formed, while the trial
collects against the real directory where nothing will appear.

**8 of 8 recorded `lost`, `firstAttempt: absent`, on both backends and all four harnesses** —
with `settled` reading `done` (headless) or `idle` (pane) in every case. That is "finished is not
answered" demonstrated directly: the wait says the turn ended and says nothing about whether
anything came back. Raw rows in `negative-control.jsonl`.

One limitation it exposes: when `wf` cannot identify the call at all, its refusal never reaches
the run directory, so the tally reads it as silence rather than as a refused attempt. An engine
that wants to tell "the agent tried and the plumbing was wrong" from "the agent said nothing"
needs `wf` to record the attempt even when the call id is unknown.

## Where this contradicts the plan and E1

**`delimited-line` on a pane is not lost by construction.** The plan says agents run on the
alternate screen and rows that leave it never enter scrollback, and the E2 design took that as
settled — the cell was to be run once per harness to confirm the claim, then dropped. The
confirmation run refuted it: all four harnesses delivered. So the cell was run in full instead,
and **80 of 80 pane `delimited-line` trials delivered, 78 of them unprompted.**
`agent read --source detection` returns the detection region of the live screen, and a short
answer is sitting right there when the turn settles. The plan's warning is still right about *long*
output — nothing here tested a value that scrolls — but for a one-line JSON value it is wrong, and
this is the cheapest return channel of the three: no PATH, no environment, no tool permission, and
the fastest first turns in the matrix.

**All four harnesses have a working headless resume, not just claude.** The E2 design says "only
claude has one we have confirmed" and expected the other three to show mechanical losses. They do
not, and the resume-failure column is 0 across the matrix. What was found and driven:

| harness | resume | context carried across the turn |
|---|---|---|
| claude | `claude -p --resume <session_id>` | yes |
| codex | `codex exec resume <thread_id>` | yes, verified by recall probe |
| pi | `--session-id <id>` on both turns, an id we choose | yes, verified by recall probe |
| cursor | `cursor-agent -p --resume <chat_id>` | yes, verified by recall probe |

`codex exec resume` takes no `-s/--sandbox`, so the sandbox has to be set with
`-c sandbox_mode="danger-full-access"` on both turns rather than a flag that exists on only one.
`harness.ts` now has all four rows marked `confirmed`.

**E1's `agent_pane_busy` finding held, and the E2 pane backend had no retry.** Added; it fires
regularly. E1's other findings all reproduced: `prompt --wait` landed 100% of pane prompts with no
send-keys, and liveness came from `agent_status` throughout.

**Three Herdr verbs in the E2 design were wrong** and would have failed on the first live call:
`agent prompt` takes its text positionally, not as `--text`; `--timeout` is milliseconds, not
`180s`; and there is no `--until settled`. `pane split --workspace <label>` does not exist either —
a workspace per call comes from `workspace create --cwd --label --env`, which is also where the
call environment is injected.

## What this measured, and what it did not

The task was trivial by design — count the letter e in a nine-character string — so this is
plumbing, not reasoning. Everything below is untested and any of it could move the number:

- **A long or multi-line value.** Every answer here was one short JSON object. The pane
  `delimited-line` result in particular should not be generalised past that.
- **A real workload.** A step that spends five minutes on a code review has far more chance to
  forget its instructions than one that spends five seconds.
- **Concurrency.** Every trial ran sequentially. E4 owns that, and a return rate under load is not
  something these numbers speak to.
- **A blocked agent.** No permission prompt or approval dialog was ever triggered, because every
  harness was launched with permission pre-granted (claude `--allowed-tools Bash`, codex
  `--sandbox danger-full-access --ask-for-approval never`, cursor `--force`). What the plan calls
  "part of the price" was paid up front and not measured. A pane whose agent is *not* pre-granted
  would measure the permission prompt instead of the return channel.
- **In-turn self-correction.** `fixed-1st` is 0 for the whole matrix, so the column that separates
  it from silence is proven only by unit test, not by a live case. E5 will produce them.
- **Pane cost for codex, pi and cursor.** Herdr reports no usage, and only claude's session log is
  addressable from the `agent_session` id the pane backend records. E1 found codex's and pi's logs
  exist; nothing here reads them. cursor still records no cost anywhere.

## Cost of the run

The matrix billed $5.74 in figures the harnesses reported — claude and pi only; codex and cursor
report tokens but no dollars, so the true total is higher. Mean per trial where a dollar figure
exists:

| cell | mean $ | mean input+cache tokens | mean output |
|---|---|---|---|
| claude headless cli-callback | $0.0532 | 65450 | 212 |
| claude headless write-a-file | $0.1731 | 65730 | 371 |
| claude headless delimited-line | $0.0311 | 32323 | 135 |
| pi headless cli-callback | $0.0092 | 10141 | 4 |
| pi headless write-a-file | $0.0135 | 10228 | 4 |
| pi headless delimited-line | $0.0070 | 10030 | 20 |

`write-a-file` is 3–5x the price of the other two for claude: writing the file is a tool call, so
the turn is longer and the context is rebuilt around it. `delimited-line` is the cheapest thing an
agent can be asked to do. That ordering is worth carrying into the cost model — the return method
is not a free choice.

## What the engine should take from this

1. **Delivery is not the risk it was thought to be.** No supervisor step is needed on this
   evidence. Keep the nudge: it is the difference between 97.5% and 100% on the one cell that
   needed it, and it recovered 49 of 49 turns overall.
2. **`cli-callback` remains the right default**, not because it delivers better — all three tie at
   100% — but because it is the only one that can refuse. The four cursor failures were caught and
   fixed inside the loop precisely because `wf` said what was wrong.
3. **Nudge on a pane, re-run when headless.** The cheap-nudge argument only holds where the
   process stays alive. This is an argument for panes that the plan does not currently make.
4. **A settled state means nothing on its own.** The negative control settles `done`/`idle` in
   every case with no value anywhere. The engine must read both signals, as abstraction 2 says.
