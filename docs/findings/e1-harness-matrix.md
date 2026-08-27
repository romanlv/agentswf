# E1 — does each harness drive at all, both ways

Run 2026-08-22, macOS 25.5.0, one laptop, nothing else contending except a parallel E2 agent
doing headless work. Herdr session `wf-lab`, Herdr 0.8.x CLI. Binaries: claude 2.1.241 (the
installed 2.1.240 self-updated mid-run), codex 0.149.0, pi 0.84.2, cursor-agent 2026.08.11.

Scripts: `../../experiments/_archive/e1/`. Raw rows: `../../experiments/_archive/e1/results/e1.jsonl`. Three reps each, all listed.

## Verdict

Everything worked. 24/24 measured runs succeeded, 12 headless and 12 pane, across four harnesses
and two prompt sizes. No truncation at 15KB on either backend. `prompt --wait` landed the prompt
by itself in 12/12 pane runs; the Enter / Ctrl-C follow-up was never reached.

E1's failure conditions — "only claude works in a pane, or a big prompt truncates" — did not
occur. The gate passes.

## Matrix

`ok` means the harness answered with the expected reply. Pane `start` is the wall clock of the
`agent start` call that succeeded; `prompt` is `agent prompt --wait` returning, which includes
the model round trip.

| harness | backend | case | ok | startup ms (3) | round trip ms (3) | intact |
|---|---|---|---|---|---|---|
| claude | headless | trivial | 3/3 | 6098 / 2042 / 3483 | 6345 / 2336 / 3767 | 3/3 |
| claude | headless | 15KB | 3/3 | 4871 / 5674 / 3972 | 5146 / 5909 / 4184 | 3/3 |
| claude | pane | trivial | 3/3 | 3028 / 3038 / 3038 | 1966 / 2191 / 2403 | 3/3 |
| claude | pane | 15KB | 3/3 | 3022 / 3016 / 3027 | 2290 / 2506 / 2406 | 3/3 |
| codex | headless | trivial | 3/3 | 437 / 130 / 150 | 4354 / 4292 / 3985 | 3/3 |
| codex | headless | 15KB | 3/3 | 136 / 142 / 126 | 5401 / 5650 / 3890 | 3/3 |
| codex | pane | trivial | 3/3 | 3046 / 3032 / 3034 | 2811 / 3751 / 2580 | 3/3 |
| codex | pane | 15KB | 3/3 | 3034 / 3010 / 3024 | 3959 / 3021 / 4890 | 3/3 |
| pi | headless | trivial | 3/3 | 666 / 561 / 476 | 6684 / 5773 / 5500 | 3/3 |
| pi | headless | 15KB | 3/3 | 674 / 405 / 422 | 6468 / 5769 / 10351 | 3/3 |
| pi | pane | trivial | 3/3 | 3040 / 3027 / 3023 | 2601 / 3008 / 2793 | 3/3 |
| pi | pane | 15KB | 3/3 | 3037 / 3023 / 3025 | 3955 / 2614 / 3636 | 3/3 |
| cursor | headless | trivial | 3/3 | 3064 / 3400 / 3093 | 3117 / 3470 / 3168 | 3/3 |
| cursor | headless | 15KB | 3/3 | 3566 / 5206 / 5534 | 3629 / 5279 / 5595 | 3/3 |
| cursor | pane | trivial | 3/3 | 3035 / 3025 / 3012 | 2586 / 2917 / 2487 | 3/3 |
| cursor | pane | 15KB | 3/3 | 3012 / 3018 / 3032 | 4141 / 3934 / 3339 | 3/3 |

Headless startup is spawn to the first byte on stdout. For claude and cursor that is effectively
the whole turn: both buffer their JSON and print it once at the end, so the number says nothing
about process boot. codex and pi stream JSONL, so their 130–670ms is a real spawn-to-first-event
figure and is the only honest startup measurement in the headless column.

Pane startup clusters at 3010–3046ms for every harness, which is Herdr's readiness settle, not
the harness. It is the same number whichever CLI is booting.

## The 15KB prompt

The prompt is `docs/projects/code-reviews/categories/checks/observability.md` repeated and cut
into 17 numbered `[[BLOCK nnn]]` blocks, exactly 15360 bytes, ending with an instruction to reply
with the first marker number, the last marker number, and the word pong. Byte counts are not
something an agent can report reliably; marker numbers it can only echo if it read them.

All 24 runs replied `001 017 pong`. Nothing truncated, on either backend, on any harness. In the
pane, claude and cursor collapse the paste into a `[Pasted text #1 +241 lines]` line in the
terminal but the model still sees all 17 blocks; codex and pi echo it in full.

15KB is the largest check page, not a ceiling. Nothing above 15KB was tested.

## `prompt --wait` versus the Enter/Ctrl-C dance

`review-loop`'s `submit` polls for a revision change, presses Enter, then presses Ctrl-C. It calls
`herdr agent prompt` **without** `--wait` (`agents/herdr.ts:194`). That is why the dance exists.

With `--wait`, 12/12 pane runs — four harnesses, both prompt sizes — landed and answered with no
send-keys at all. The runner is written to fall back to `send-keys enter` when the answer is
missing; that branch never executed. In every run `--wait` returned `agent_status: "idle"` and the
answer was already on the terminal, with an empty composer.

The dance is obsolete for the case measured here. Two caveats before deleting it: this is 12
samples on an unloaded machine, and `--wait`'s own help warns that when submission starts from a
non-working state it first requires a state change within 5000ms, returning `agent_prompt_stalled`
otherwise, and that it does not track turns — an already-working agent can match that turn's
completion instead. Neither condition was hit here because every pane was freshly started and idle.

## Settled state and liveness

`--wait` returned `idle` in all 12 pane runs. Never `done`, never `blocked`.

A separate probe (`../../experiments/_archive/e1/states.ts`) checked whether a mid-turn pane is distinguishable:

| harness | idle title | working title | `--until working` matched |
|---|---|---|---|
| claude | `✳ Claude Code` | `◐ Claude Code` | yes |
| codex | `agent` | `⠼ agent` | yes |
| pi | `π - wf-poc1` | `π - wf-poc1` | yes |
| cursor | `Cursor Agent` → `Pong` | `Pong` | yes |

`agent_status` reports `working` then `idle` for all four. The **title** only carries status for
claude and codex. pi's title never changes, and cursor's changes to the conversation topic rather
than a state. `review-loop/liveness.ts` derives busy-versus-idle from the title glyph and would
read pi and cursor as `unknown` forever. A cross-harness engine has to use `agent_status`.

## Machine-readable usage and cost

Headless, all four print usage in their JSON mode:

| harness | flag | tokens | cost |
|---|---|---|---|
| claude | `-p --output-format json` | yes, with cache breakdown | yes, `total_cost_usd` |
| codex | `exec --json` | yes, on `turn.completed` | no |
| pi | `--print --mode json` | yes | yes, `usage.cost.total` |
| cursor | `-p --output-format json` | yes | no |

claude's `input_tokens` reads 2 for these prompts; the real volume is in
`cache_creation_input_tokens` / `cache_read_input_tokens` (13k/19k trivial, and it still billed
$0.016–$0.196 per trivial turn because CLAUDE.md discovery rebuilds the cache). Any cost model
that reads only `input_tokens` will be off by four orders of magnitude.

Pane, from session logs on disk:

- codex — `~/.codex/sessions/…/rollout-*.jsonl` carries `total_token_usage` and `last_token_usage`.
- pi — `~/.pi/agent/sessions/…/*.jsonl` carries tokens and cost per turn.
- claude — `~/.claude/projects/…/<session>.jsonl` carries per-message `usage`. Herdr reports the
  session id in `agent_session`, so the file is findable.
- cursor — `~/.cursor/chats/<id>/<chat>/store.db` holds the messages but **no** token or cost
  figures anywhere I could find. Pane cursor records nothing accountable.

## What surprised me

**`agent start` refuses a pane that was just created.** `agent_pane_busy: agent target w3:p1 is
not an available shell`. It happened on 10 of the 24 pane starts and always cleared on the
second attempt after a 2s sleep. `review-loop` already retries five times for this reason;
anything on Herdr needs the same. Without the retry the first run of every batch fails.

**The wf-lab server inherits the env of whatever started it.** I started it from inside a Claude
Code session, so every claude pane under it printed `⚠ Transcript saving is off — inherited
CLAUDE_CO…` and wrote no transcript — no usage record for pane claude. Relaunching claude in a
pane with `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and the other `CLAUDE_*` vars unset made the
warning disappear and produced a normal transcript with `usage` in it. This is my setup, not
Herdr and not claude, but it will bite E3: the server must be started from a shell with no
`CLAUDE_*` env, or claude panes silently stop being accountable. Headless claude writes its
transcript either way.

**pi's headless input token count is not stable.** Trivial run 2 reported 219 input tokens against
9947 for runs 1 and 3, and cost $0.006 against $0.050 — the same prompt, seconds apart. It looks
like context discovery (AGENTS.md/CLAUDE.md) sometimes does not happen. Same effect in the pane
runs, where the status line showed `↑9.9k` then `↑3.8k R9.7k`.

**claude reports a per-turn cost that swings 12x for identical work.** $0.174, $0.121, $0.016 for
three identical trivial prompts, driven entirely by whether the CLAUDE.md prefix hit the cache.

**codex prints `Reading additional input from stdin...` to stderr** when given a prompt argument
while stdin is a pipe. Passing the prompt on stdin with an explicit `-` argument avoids it.

## Not tested

- Anything larger than 15KB.
- Concurrency. Every run here was serial; a parallel E2 agent was doing headless work on the same
  laptop, which may have added noise to the wall-clock columns.
- Blocked panes. No permission prompt or approval dialog was triggered, so `--wait` returning
  `blocked` was never observed.
- `--wait` against an agent that is already working, which its own help says can match the wrong
  turn.
- Whether the answer can be read back off the pane for a long reply. Every reply here was one
  line, which is not the case the plan rules out.
- Pane cursor cost. There may be a usage record somewhere in `~/.cursor` I did not find.

## Contradictions with the plan

None. The plan's guess that the prompt-landing dance may be obsolete holds, and the reason is
narrower than "Herdr changed": `review-loop` never passed `--wait`.

The plan says a step "can pick its harness" and treats the four as interchangeable. They are for
driving, but not for accounting: cursor gives up no cost anywhere, codex gives up tokens but no
cost, and only claude and pi report dollars. The plan's "Not building" section already says
non-Claude cost accounting is out of scope, which is the right call given this.
