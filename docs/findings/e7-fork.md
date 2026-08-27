# E7 — Does forking a prepared agent actually save anything?

`wf/interfaces` rests on one idea: prepare a context once, fork it many ways, one fork per lens.
Nothing had tested it. This did.

Two questions, kept apart on purpose:

1. **Does a fork inherit the parent's context?** — correctness.
2. **Does the forked turn re-pay for that context?** — economy.

The answer differs by question and by harness. Context sharing works everywhere it exists.
The saving only exists on claude, and only under conditions worth stating precisely.

## What each harness offers

| harness | fork surface | headless? |
| --- | --- | --- |
| claude | `--resume <id> --fork-session`; `/fork` in the TUI spawns a background session | yes |
| codex | `codex fork <id>`, and `codex exec fork <id> <prompt>` | yes |
| pi | `--fork <path\|id>` | yes |
| cursor | none — only `--resume` / `--continue` | n/a |

Three of four can fork. Cursor cannot, so any design that needs fork needs a fallback for it.

## Question 1: context is genuinely inherited

Tested so the answer could not be faked. The parent was told a secret written nowhere else, the
source files were deleted before forking, and the event stream was checked for tool calls.

- **codex** — parent memorised a 900-line corpus plus the code `PLATYPUS-4417-XENON`. Files deleted.
  The fork answered `PLATYPUS-4417-XENON` with zero tool-call items in its event stream.
- **claude** — a parent spent 14 turns reading a 12-module repo with real tools. The repo was then
  deleted. Forks correctly reported `SECRET_TOKEN = 'MARMOSET-8823-INDIGO'` in `module_7`, the
  module count, and real function names from files that no longer existed.
- **pi** — same corpus test, same correct recall.

So fork carries knowledge the agent *derived*, not just text it was handed. That is the part a
prompt cannot replicate, and it is the strongest argument for the mechanism.

## Question 2: the saving exists on claude, not on the OpenAI-backed harnesses

Measured as cached versus freshly-written input tokens on the turn after the fork.

### codex and pi re-pay almost everything

| turn | input | cached | share |
| --- | --- | --- | --- |
| codex parent prepare | 30,464 | 11,008 | 36% |
| codex **fork** | 33,039 | 11,008 | 33% |
| codex **resume** (control) | 30,494 | 29,440 | **96%** |

The control is what makes this readable. The cache is fully available to a resume of the same
session, and a fork of that same session cannot reach it. The 11,008 tokens a fork does get are
codex's own static preamble, cached long before our content existed.

Three identical forks run back-to-back all sat at exactly 11,008. They did not even hit each
other. pi, which routes to the same OpenAI backend, behaves identically: resume 96% cached at
$0.013, fork 0–15% cached at $0.077–$0.089 — **a fork costs about seven times a resume**.

The cause is visible in codex's session files. A fork does not replay the parent's recorded
preamble; it **rebuilds** it from the current environment and puts it at the front. Parent
preamble 16,506 chars, fork preamble 11,014, diverging 7,137 chars in. Everything behind the
divergence is a cache miss. There are no timestamps in the preamble, so this is not inherent
randomness — but forks still failed to hit one another, so something per-session sits in the
prefix. Not worth reverse-engineering further; the measured behaviour is the fact.

### claude forks for the price of a resume

Parent: one pasted message holding the corpus. Model `claude-haiku-4-5` so the probe cost cents —
the ratios are what matter and they are model-independent.

| turn | cache_read | cache_write | cost |
| --- | --- | --- | --- |
| prepare | 143,959 | 24,680 | $0.0682 |
| fork #1 | 22,232 | 20,786 | $0.0441 |
| fork #2 | 43,018 | 0 | **$0.0047** |
| resume (control) | 43,018 | 0 | $0.0046 |

**A warm fork costs the same as continuing the conversation.** The first fork pays a one-time
write; every fork after it reads.

It holds under concurrency. Six forks launched at once, six different questions:
all read the full 43,018 and wrote only their own ~110-token question. $0.048 for six, 30s wall.
Repeated later: 5 of 5 hit again.

### the honest baseline

Cold agents are not as expensive as they first look, because if every one is handed a
byte-identical brief they share a prompt cache too: first cold call $0.062, next $0.027.

Per lens, on this corpus, for a 14-way fan-out:

| approach | first | each subsequent | 14 lenses |
| --- | --- | --- | --- |
| fork | $0.068 prepare + $0.044 | $0.005 | **$0.177** |
| cold, identical brief | $0.062 | $0.027 | $0.413 |

Fork is about 5× cheaper per branch and 2.3× cheaper overall. Real, but smaller than
"prepare once instead of fourteen times" suggests — because the naive alternative already
benefits from prefix caching.

## The condition that decides it

The claude saving is **not** unconditional. The two parents behaved differently:

- **Parent built from one pasted message** — forks hit whether run sequentially or six at once.
- **Parent built from 14 turns of tool use** — forks hit only when the follow-up prompt was
  *identical* ($0.0408 then $0.0046 then $0.0045). Fan out six differing questions and **0 of 5
  hit**, each re-writing ~19,000 tokens: $0.205 instead of ~$0.06. Tried three separate times,
  including after the cache was demonstrably warm.

This is the case that matters, because "prepare the diff" in `catalogue-review` is tool work, not
a pasted brief.

The way out is to make the fork point a pasted message: let the preparing agent do its tool work
and then **emit one consolidated brief**, and fork from a parent whose context is that brief.
That converts the reliable-cheap case into the one you actually use. It also costs an extra turn,
and it means the fork inherits the brief rather than the agent's full working memory — which is a
real loss of the thing that made fork attractive in question 1.

## The pane arm: fork works, and it saves nothing

The headless numbers above spend usage credits. The pane spends the subscription, and it is the
path this project is built around, so it was measured separately: one parent pane holding a 10KB
brief, then forks launched as new panes via
`herdr agent start <n> --kind claude --pane <id> -- --resume <sid> --fork-session`.

Mechanically it all works. Herdr reports each pane's session id as `agent_session.value`, which is
how an engine would get a fork point. Every fork replayed the parent's history in its UI and
answered from it correctly — four concurrent forks with four different questions, 11 seconds for
the whole fan-out.

The cache did not follow. Six pane forks, sequential and concurrent, **zero hits**:

| pane turn | cache_read | cache_write |
| --- | --- | --- |
| fork #1 (sequential warm-up) | 26,830 | 13,437 |
| forks #2–5 (concurrent, differing questions) | 26,830 | ~13,435 each |
| forks #6–7 (strictly sequential) | 26,830 | ~13,432 each |
| **resume** — same pane relaunched, no `--fork-session` | **40,223** | **38** |
| a fork's *second* turn | 40,265 | 145 |

The two controls are what make this readable. A relaunched pane that resumes rather than forks
gets a full hit, so pane caching works and relaunching a process is not what breaks it. And a
fork's second turn hits its own freshly-written entry. So **each fork pays the write exactly once,
and no fork ever reads another's.** Fourteen forks means fourteen writes.

### which makes cold agents cheaper than forks, in a pane

Two cold panes given the byte-identical brief:

| | cache_read | cache_write |
| --- | --- | --- |
| cold #1 | 26,830 | 12,749 |
| cold #2 | 40,135 | **335** |

The second cold agent reads the first one's cache. So for a 14-way fan-out in panes:

| approach | cache-write tokens |
| --- | --- |
| 14 cold agents, identical brief | 12,749 + 13×335 ≈ **17,100** |
| 14 forks | 14 × 13,435 ≈ **188,000** |

**Forking a pane costs about eleven times what handing the same brief to cold agents costs.** In a
pane those tokens are not dollars — they are consumption against the rate limit — but that is the
budget the whole design is trying to protect.

This inverts the headless result on the same harness. Headless claude: a fork costs what a resume
costs. Pane claude: a fork never reuses the prefix and a cold agent does. Same CLI, same model.
The economy exists only on the path that spends money.

## `/fork` is a third mechanism, and it does not help either

The pane numbers above used the CLI flag, `--resume <id> --fork-session`. Claude also has a `/fork`
slash command inside the TUI, and it is genuinely a different thing:

> `/fork` — Copy this conversation into a new background session

It does not branch in place. It spawns a **separate background process** with its own pid and
session id, holding a verbatim copy of the parent's conversation, discoverable through
`claude agents --json` alongside interactive sessions. As a way to get one live agent per lens, it
is a better primitive than the CLI flag — herdr never sees it, but claude itself tracks it.

It does not reuse the prepared cache. Measured on each fork's *own* first turn, with the parent's
cache proven warm in between:

| turn | cache_read | cache_write |
| --- | --- | --- |
| `/fork` #1, own first turn | **0** | 50,736 |
| `/fork` #2, own first turn | 27,925 | 22,969 |
| parent `--resume`, same window | **48,961** | **200** |

The first fork re-wrote everything including the static prefix; the second matched the static
prefix and re-wrote the 23,000-token conversation body. Neither came close to the parent's own
resume. So all three mechanisms agree:

| mechanism | reuses the prepared cache? |
| --- | --- |
| `--resume <id>` (no fork) | **yes**, everywhere — this is the control |
| `--resume <id> --fork-session` | headless yes, pane no |
| `/fork` (TUI, background session) | no |
| `codex fork` / `codex exec fork` | no |
| `pi --fork` | no |

The pattern across all of them: **continuing a session keeps the cache, branching it does not.**
That is the finding, and it is why the recommendation does not change.

## What this changes

- **Fork earns its place for correctness, not for cost.** It was the one wholly unevidenced idea in
  `wf/interfaces`. It now has evidence: it reliably carries context an agent *derived*, everywhere
  it exists. But it is cheaper than the alternative in exactly one configuration — claude, headless
  — which is the configuration that spends credits.
- **If the prepared context can be written down, do not fork it.** Hand the same brief to N cold
  agents and let prefix caching do the work: cheaper than forking in a pane by ~11x, simpler, and
  it works on cursor too. Reserve fork for working memory you cannot re-express as text.
- **`fork: "native" | "seeded"` is the wrong axis.** Every harness that forks does it natively and
  inherits context correctly. What varies is whether the fork is *cheap*, and that turns out to
  depend on the backend as much as the harness: claude headless yes, claude pane **no**, codex no,
  pi no, cursor cannot fork. A capability like `forkReusesCache` has to be answered per
  (harness, backend) pair, not per harness.
- **Warm the fork point before fanning out.** The first fork pays the write. Launching fourteen at
  once against a cold parent means fourteen writes.
- **Prefer a pasted-brief fork point over a tool-built one**, or accept that a differing-question
  fan-out may re-pay every branch.
- **The earlier pessimism was half right.** E3 found `/clear` on a pooled pane saved 0% of tokens,
  and this review assumed a fork would behave the same. It does on codex and pi. It does not on
  claude, where fork and resume cost the same.

## Caveats

- claude figures are haiku. The token ratios are model-independent; the dollar figures are not.
- The pane arm used a 10KB brief rather than the headless arm's 43KB one, because the 43KB prompt
  vanished on the first attempt. That turned out not to be a size limit — see the delivery note
  below — but the arms are not byte-identical, so compare their ratios and not their absolute
  token counts.
- Why a pane fork misses when a headless fork hits was not chased down. The measured behaviour is
  consistent across six `--fork-session` forks, two `/fork` forks and three resume controls, which
  is enough to design against.
- Codex's TUI was not searched for a `/fork` slash command; its CLI `fork` and `exec fork` were
  measured and both miss.
- pi could only be tested on its `openai-codex` provider — the Anthropic providers are not
  authenticated. So "the split is per-provider, not per-harness" is a well-supported hypothesis
  (claude/Anthropic hits, codex/OpenAI misses, pi/OpenAI misses) and not a confirmed one. pi on an
  Anthropic provider is the control that would close it.

## A side finding: a pane prompt can vanish with no error

The first 43,650-byte brief sent with `herdr agent prompt` never reached the model. The call
returned `agent_prompted`, the pane sat idle with an empty composer, and the transcript showed the
message was simply absent. Nothing reported a failure.

The obvious explanation — a size ceiling — is wrong. Probing afterwards, every one of these landed
intact: 12,000 / 16,000 / 16,400 / 20,000 / 24,000 / 32,000 bytes, then 44,000 bytes with no
newlines, 32,000 with 900 newlines, and 44,000 with 900 newlines — the exact shape that had failed.
The original brief was then re-sent four more times, with and without a settle delay after
`agent start`, and landed every time.

So the drop is a startup race, not a limit, and it happened once in roughly a dozen sends. Two
related things are reproducible and worth designing around:

- **`agent start` on a freshly created pane often fails** with `pane not found` or
  `agent not found`. It needs a settle delay; four starts failed this way and succeeded on retry.
- **`agent prompt --wait --until idle` is not a reliable completion signal.** On the large brief it
  returned `timeout` after 60s even though the prompt had landed and the turn ran normally.

The rule this argues for is not a length cap. It is that **submission must be confirmed from the
transcript**, because the tool's return value does not mean the model received anything. That is
the same shape as E2's result on the return channel: the transport reporting success is not
evidence that the work happened.

Moving large payloads into a file instead has a measurable cost, so it is not a free fix. What made
cold fan-out cheap in the pane arm was every agent sending a byte-identical prompt prefix — the
second cold agent wrote only 335 tokens. Replacing the pasted brief with a file read adds a tool
round-trip per agent and makes the shared prefix depend on tool-result formatting. If a cap is
wanted anyway, it should be justified as a robustness choice, not as a fix for a limit that was not
found.
