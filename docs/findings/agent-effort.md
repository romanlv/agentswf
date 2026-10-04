# Agent effort, M1–M6

How each harness takes a reasoning effort and a model at launch, on a headless resume and in a
pane, measured 2026-10-04 for [story 020](../stories/020-agent-effort.md) on macOS 26 (Darwin
25.6), claude 2.1.289, codex-cli 0.160.0, pi 0.87.1, cursor-agent 2026.10.01-14929f9 and Herdr
0.9.1. Each probe ran once, from throwaway scripts in a scratch directory, with the invocations
`packages/harness/src/harnesses/*.ts` builds today plus the effort flag. Models: claude `sonnet`
(Sonnet 5.5) and `haiku`; codex `gpt-6-luna` and `gpt-5.6-luna`; pi `openai-codex/gpt-5.6-terra`,
`gpt-5.6-luna` and `gpt-6-luna`; cursor `gpt-5.4-nano` and `gpt-5.4-mini` variants, `composer-2.5`.
Claude ran with the calling session's variables withheld, as `CLAUDE.callingSessionEnv` does,
`CLAUDE_EFFORT` included.

| | question | verdict |
|---|---|---|
| M1 | does a headless resume honour model and effort? | **yes on all four**. Without the flag, claude and codex take their config or default, not the session's last level, and pi takes the level of the session's last `thinking_level_change` row, which after `--print` resumes is the one it was created with |
| M2 | which pane command switches, and what confirms it? | **claude `/effort {level}` and `/model {alias}`, pi `/thinking {level}` and `/model {provider/id}` (directly only for an id in `enabledModels`; otherwise a picker), typed with an argument. codex only through its `/model` picker. cursor unknown**. claude's typed forms save to the user's settings file |
| M3 | cursor: which models take a bracketed effort? | **the parameter key is per model**: `gpt-5.4-nano[reasoning=low]` ran, while `[effort=…]` was refused on every model tried. The flat `{model}-{level}` ids worked on every one tried (three) |
| M4 | does the flag beat env and config? | **claude: `--effort` beats `--settings`' `effortLevel`, `CLAUDE_CODE_EFFORT_LEVEL` beats `--effort`, `CLAUDE_EFFORT` is ignored. codex: `-c` beats a profile and config.toml. pi: `--thinking` beats `:level` and settings** |
| M5 | codex's levels and an invalid one | **per model, from `codex debug models`**. An invalid level runs and fails at the API: `turn.failed`, exit 1 |
| M6 | where is the effort logged? | **claude's transcript `perTurnEffort`, codex's rollout `turn_context.effort`, pi's session only when set in-session; cursor logs none** |

## Per harness

| | claude | codex | pi | cursor |
|---|---|---|---|---|
| levels | `low, medium, high, xhigh, max` (`--help`); `/effort` also takes `auto` and `ultracode [on\|off]` | per model (M5) | `off, minimal, low, medium, high, xhigh, max` | per model: the suffixes of its ids (M3) |
| default | per model: Sonnet 5.5 ran at `medium`; Haiku 4.5 takes no effort (`perTurnEffort: null`) | config.toml's `model_reasoning_effort`, else the model's `default_reasoning_level` | `defaultThinkingLevel` in settings (operator's: `medium`) | the bare id's own variant, or the last parameters cursor saved for that model (M3) |
| launch flag | `--effort {level}` | `-c model_reasoning_effort="{level}"` | `--thinking {level}` | `--model '{id}-{level}'`, or `--model '{base}[{key}={level}]'` where the model has a key |
| headless resume switches model and effort | yes | yes | yes | yes for model and variant; the effort applied is unverified (M6) |
| pane switch | `/effort {level}`, `/model {alias}`; the session-only forms are in their pickers | `/model` picker, then the effort picker; `s` for this session only | `/thinking {level}`, `/model {provider/id}` (an id in `enabledModels`; else a picker) | unknown (see "Not measured") |
| pane confirmation | `Set effort level to {level} (saved as your default for new sessions)`; `Set model to {Name} and saved as your default for new sessions` | `Model changed to {model} {level} for this session only` | `Thinking level: {level}`; `Model: {id}` | unknown |
| log | session jsonl, assistant row `perTurnEffort` | rollout `turn_context.effort`, `collaboration_mode.settings.reasoning_effort` | `thinking_level_change` / `model_change` rows, only when set in-session; `PI_REASONING_LEVEL` in the agent's shell | none; headless `stream-json` `init.model` is a display name |
| invalid level | `--effort bogus`: a warning on stderr, the default used, exit 0 | sent to the API: 400, `turn.failed`, exit 1 | `--thinking bogus`: a warning on stderr, the flag ignored, exit 0 | refused before any request: `Cannot use this model: …`, exit 1 |

## M1 — headless resume

**claude.** `claude -p --resume {id} … --model {m} --effort {level}` (the `resumeTurn` argv plus
`--effort`). The session started at `--model sonnet --effort low` and was told "pelican". Its
transcript (`~/.claude/projects/{cwd}/{id}.jsonl`) logs each assistant row's model and
`perTurnEffort`:

| resume flags | assistant row | answer |
| --- | --- | --- |
| `--model sonnet --effort high` | `claude-sonnet-5-5`, `high` | `pelican` |
| `--model sonnet`, no `--effort` | `claude-sonnet-5-5`, `medium` | `pelican` |
| `--model haiku --effort max` | `claude-haiku-4-5-20251001`, `null` | `PELICAN` |
| `--model sonnet --effort xhigh` | `claude-sonnet-5-5`, `xhigh` | `nacilep` |

A resume with no `--effort` ran at `medium`, the default, not the `high` the session last ran at.
Haiku takes no effort: `--effort max` on it ran, logged `null`, and printed no warning.

**codex.** `codex exec resume {id} --json --skip-git-repo-check -c 'sandbox_mode=…' -c
'model_reasoning_effort="{level}"' --model {m} -`. Started at `gpt-6-luna` `low`, told "pelican".
The rollout's `turn_context` rows:

| resume flags | `turn_context` model, effort | answer |
| --- | --- | --- |
| `-c …="high" --model gpt-6-luna` | `gpt-6-luna`, `high` | `pelican` |
| `--model gpt-6-luna`, no `-c` | `gpt-6-luna`, `medium` | `pelican` |
| `-c …="low" --model gpt-5.6-luna` | `gpt-5.6-luna`, `low` | `PELICAN` |

The resume with no `-c` took `medium`, not the session's last `high`; here the operator's
`~/.codex/config.toml` and the model's default are both `medium`, and M4's temporary home shows
config.toml is the one read. A resume on another model prints an item of type `error`: "This session
was recorded with model `gpt-6-luna` but is resuming with `gpt-5.6-luna`. Consider switching back
…". Both probe turns that printed it failed for another reason (an unlisted level), and the
`gpt-5.6-luna` row above, which completed, printed none: the failed attempt had already recorded the
session on that model. Story 020's live eval completed a headless resume on another model
(`turn_context` then `task_complete`); its output was not kept, so the warning and a completion were
never seen together. A reader that fails a turn on any `error` item would misread one.

**pi.** `pi --print --mode json --session-id {id} --model {provider/id} --thinking {level}`. Started
at `gpt-5.6-terra` `--thinking low`, told "heron". The session file logged `model_change` and
`thinking_level_change: low` once, at creation. **A `--print` resume logs neither, whatever its
flags.** So the level actually used was read back two ways:

- `pi --mode rpc … ` with `{"type":"get_state"}` reports the `thinkingLevel` and model a launch
  resolves to, with no model turn. pi exits when stdin closes, so stdin has to stay open until it
  answers.
- The agent ran `echo "$PI_MODEL $PI_REASONING_LEVEL"`, which pi sets for its shell tools, and
  replied with the output.

| resume flags | ran at (agent's shell) | `get_state` afterwards, no flags |
| --- | --- | --- |
| `--model …/gpt-6-luna --thinking high` | (answer `heron`, 19 reasoning tokens) | `gpt-6-luna`, `low` |
| `--model …/gpt-5.6-terra --thinking xhigh` | `gpt-5.6-terra xhigh` | — |
| none | `gpt-5.6-terra low` | — |
| `--model …/gpt-5.6-terra:minimal` | `gpt-5.6-terra minimal` | — |

With no flags, pi takes the model of the last assistant row, and the thinking level of the last
`thinking_level_change` row, which a `--print` resume never writes. When that model can't be
resolved, it falls back to the settings' `defaultModel`: a session whose last row was a failed
`gpt-5.6-terra:bogus` resumed on `gpt-6-sol`. awf passes the flags on every resume, so none of this
applies as long as it keeps doing so.

pi maps levels per model: `get_state`'s `model.thinkingLevelMap` for `gpt-6-luna` is `minimal →
low` and `off → none`; `gpt-5.6-terra`'s maps `minimal → low` and has no `off` entry.

**cursor.** `cursor-agent -p --resume {chat} --output-format json --force --model {m}`. A chat
started on `gpt-5.4-nano-low` and told "pelican" was resumed on `gpt-5.4-mini-high` and answered
"pelican; GPT-5.4 Mini" when asked its word and the model its system prompt names. On
`composer-2.5[fast=true]`, it answered "pelican" and "Composer". `--output-format stream-json`
prints the model on its `init` row as a display name: `GPT-5.4 Nano High` for `gpt-5.4-nano-high`,
`GPT-5.4 Nano Low` for `gpt-5.4-nano[reasoning=low]`, `Composer 2.5 Fast` for
`composer-2.5[fast=true]`. `json` prints no model. So the variant cursor resolved is visible, but
whether the effort reached the provider is not: nothing logs it (M6).

## M2 — pane switch

Each pane was a Herdr workspace with the calling-session variables emptied, started with `herdr
agent start {name} --kind {harness} --pane {id} -- {argv}`, and driven with `herdr agent prompt` and
`send-keys`. **A claude local command runs no turn, so `herdr agent prompt … --wait` fails with
`agent_prompt_stalled` ("no observed working or blocked state within 5000 ms"); codex's and pi's
were sent without `--wait`. The switch must be
confirmed by reading the screen, not by Herdr's wait.**

### claude

Run on a temporary `CLAUDE_CONFIG_DIR`, because the typed commands write the settings file. Its
onboarding had to be marked done in its `.claude.json`. Launched with `--allowed-tools Bash
--model sonnet --effort low`; the header read `Sonnet 5.5 with low effort`, the status line
`○ low · /effort`.

- `/effort high` →
  `⎿  Set effort level to high (saved as your default for new sessions): Comprehensive implementation with extensive testing and documentation`.
  It wrote `"modelSettings": {"claude-sonnet-5-5": {"effortLevel": "high"}}` to `settings.json`.
- `/model haiku` in a conversation first shows a dialog: `Switch model?` … `This conversation is
  cached for the current model. Switching to Haiku 4.5 means the full history gets re-read on your
  next message.` with `❯ 1. Yes, switch to Haiku 4.5` selected. Enter confirms:
  `⎿  Set model to Haiku 4.5 and saved as your default for new sessions`. It wrote `"model": "haiku"`.
  The permission mode fell from auto to manual ("auto mode unavailable for this model").
- `/model sonnet`, then `/effort xhigh` →
  `Set effort level to xhigh (saved as your default for new sessions): Deeper reasoning than high, just below maximum (on supported models)`.
  The next turn logged `claude-sonnet-5-5`, `perTurnEffort: xhigh`, and still knew the word.
- `/effort bogus` →
  `⎿  Invalid argument: bogus. Valid options are: low, medium, high, xhigh, max, auto, ultracode [on|off]`.
- The transcript logs each command as a `user` row: `<command-name>/effort</command-name>` with
  `<command-args>high</command-args>`, then `<local-command-stdout>` holding the same confirmation.
- **Session only.** A typed `/effort {level}` or `/model {name}` always saved. Launching with
  `--setting-sources project,local` didn't change that. The pickers have the session-only key:
  - bare `/effort` draws a slider (`←/→ to adjust · Enter to confirm · s for this session only`)
    starting at the current level; `→` then `s` gave
    `Set effort level to xhigh (this session only): …`;
  - bare `/model` lists `1. Default`, `2. Sonnet`, `3. Fable`, `4. Opus`, `5. Haiku` with the cursor
    on the current one (`Enter to set as default · s to use this session only`); arrows then `s`
    gave `Set model to Haiku 4.5 for this session only`. Neither wrote the settings file. A digit
    selects and saves at once.
  - The picker offers aliases only. A full model name needs the typed form, which saves.
- **Relaunch.** `claude --resume {id} --allowed-tools Bash --model sonnet --effort low` in the pane
  came up at `○ low · /effort` and wrote nothing to `settings.json` (`.claude.json`'s own
  bookkeeping changed: `lastSessionId`, `numStartups`). No turn ran after it; story 020's live eval
  ran turns after such relaunches, on the operator's home, and its settings file was untouched.

So in the operator's own home, a typed switch in an awf pane would rewrite
`~/.claude/settings.json`'s `model` and `modelSettings.{model}.effortLevel`. The operator's next
plain `claude` would start on the agent's model.

### codex

Run on a temporary `CODEX_HOME` holding a copy of `auth.json`. Launched with `--sandbox
danger-full-access --ask-for-approval never --model gpt-6-luna -c model_reasoning_effort="low"`.
The status line read `GPT-6-Luna low · {cwd}`.

- `/model gpt-6-luna high` went to the model as text: `• I can't change the model from here.`
- Bare `/model` opens `Select Model and Effort` (`1. GPT-6.1-Sol (default)` … `› 4. GPT-6-Luna
  (current)` … `8. GPT-5.5`, `enter select · esc back`), the cursor on the current model. Enter
  opens `Select Reasoning Level for GPT-6-Luna`: `1. Low (current)`, `2. Medium (default)`,
  `3. High`, `4. Extra high`, `5. More reasoning…`, with the footer `enter default · s session · esc
  back`. `More reasoning…` opens `Advanced Reasoning` with `1. Max`.
- **A digit selects and saves at once**, as Enter does: `3` printed `• Model changed to gpt-6-luna
  high` and wrote `model` and `model_reasoning_effort = "high"` to `config.toml`. (C5 found that a
  digit only moves the cursor on the trust screen. On these pickers it confirms.)
- Arrows then `s` switch for the session only: `down` ×3 to `GPT-5.6-Luna`, Enter, `up` to `Low`,
  `s` → `• Model changed to gpt-5.6-luna low for this session only`, with the status line
  `GPT-5.6-Luna low`, and `config.toml` untouched. The next turn answered `pelican`, and its
  `turn_context` read `gpt-5.6-luna`, `low`.
- A picker is positional: the effort list depends on the model, so the keys to press come from
  the model's levels in `codex debug models`.

### pi

Run on the operator's home: pi saves only on Ctrl+S (`docs/models.md`), and the settings file's
hash was the same before and after. Launched with `--model openai-codex/gpt-5.6-terra --thinking
low`; the footer read `(openai-codex) gpt-5.6-terra • low`.

- `/thinking high` → `Thinking level: high`, footer `… • high`.
- `/model openai-codex/gpt-5.6-luna`, an exact id in the picker's scope, switched with no picker →
  `Model: gpt-5.6-luna`.
- `/model openai-codex/gpt-6-luna` instead opened the picker filtered on the text. Its scope was
  `scoped`: the settings' `enabledModels`, which lacks `gpt-6-luna`, so the top match was
  `gpt-5.6-luna`. Tab switched the scope to all, and Enter took `gpt-6-luna` → `Model: gpt-6-luna`.
  Typing anything else while the picker is open goes into its search.
- **Switching the model reset the level**: `high` became `medium` (footer `gpt-6-luna • medium`).
  So `/model` goes first, then `/thinking`.
- That `gpt-6-luna` turn then failed: `Error: Codex error: model 'gpt-6-luna' is not enabled in
  rustponsesapi`. The same model had answered through pi headless an hour before. On `gpt-5.6-luna`
  at `/thinking xhigh`, the agent answered `pelican gpt-5.6-luna xhigh` from its shell.
- An interactive session logs each switch: `thinking_level_change: high`, `model_change:
  gpt-6-luna`, `thinking_level_change: medium`, `model_change: gpt-5.6-luna`,
  `thinking_level_change: xhigh`.

### cursor

Unknown: not run. The probe would need either the operator's real home or an isolated one. The
real home's `cli-config.json` is rewritten by any `--model` choice (see M3). With a substituted
`HOME`, cursor-agent reaches for the macOS keychain and raises a "Keychain Not Found" dialog.
cursor's own listing says `/model {id}` switches in interactive mode.

## M3 — cursor's models and effort

`cursor-agent models` (with the `CURSOR_API_KEY` from `.env`; the keychain login answered
"Authentication required" for listing and for turns) lists flat ids. Effort is a suffix:
`gpt-5.6-luna-{none,low,medium,high,xhigh,max}` (plus `-fast`),
`claude-opus-5-5-{low,medium,high,xhigh,max}`, `claude-sonnet-5-5-{low,medium,high,xhigh,max}`,
`gpt-5.4-nano-{none,low,medium,high,xhigh}`, `grok-4.7-{low,medium,high,xhigh}`, and so on.
`composer-2.5`, `auto` and others have no effort variants. The medium variant's display name often
omits the level ("GPT-5.6 Luna 1M" for `gpt-5.6-luna-medium`).

The bracket form `--model '{base}[{key}={value}]'`:

| `--model` | result |
| --- | --- |
| `gpt-5.4-nano[reasoning=low]` | ran; `init.model` `GPT-5.4 Nano Low` |
| `composer-2.5[fast=true]` | ran; `Composer 2.5 Fast` |
| `gpt-5.4-nano[effort=high]`, `gpt-5.4-nano[effort=low]` | refused |
| `gpt-5.6-luna[effort=low]`, `gemini-3.8-flash[effort=low]`, `grok-4.7[effort=low]`, `grok-4.6[effort=low]`, `claude-sonnet-5-5[effort=low]`, `claude-opus-4-8[effort=low]` | refused |
| `composer-2.5[effort=high]`, `gpt-5.4-nano-low[effort=high]`, `gpt-5.4-nano[reasoning=bogus]` | refused |

A refusal comes before any request: `Cannot use this model: {arg}. Available models: …`, exit 1.

The key is per model. A run of the flat `gpt-5.4-nano-high` saved `"gpt-5.4-nano": [{"id":
"reasoning", "value": "high"}]`, and the operator's config already held `"grok-4.6": [{"id":
"effort", …}, {"id": "fast", …}]`. Which bases take which key on this account is unknown beyond
these. The help's own example, `claude-opus-4-8[context=1m,effort=high,fast=false]`, was refused on
the API key. **The flat `{model}-{level}` ids are the form known to work.**

**A cursor run with `--model` rewrites `~/.cursor/cli-config.json`**, headless too: `model`,
`selectedModel`, `modelSelectionHistory`, and that model's entry in `modelParameters`. Running
`composer-2.5[fast=true]` turned the operator's saved `composer-2.5` `fast` from `false` to `true`.
A later bare `gpt-5.4-nano` then ran as `GPT-5.4 Nano High`, the parameters the earlier run had
saved. So a bare cursor model id's effort depends on the last run that chose one, and every awf
cursor agent already rewrites the operator's cursor selection.

## M4 — precedence

**claude**, each a resume of the same Sonnet session, read back from `perTurnEffort`:

| set | ran at |
| --- | --- |
| `CLAUDE_EFFORT=high` only | `medium`: ignored |
| `CLAUDE_CODE_EFFORT_LEVEL=high` only | `high` |
| `CLAUDE_CODE_EFFORT_LEVEL=high`, `--effort low` | `high`, twice: the variable wins |
| `--settings '{"effortLevel":"xhigh"}'` | `xhigh` |
| that, and `--effort low` | `low` |
| `--settings '{"maxEffortLevel":"medium"}'`, `--effort max` | `medium`: the cap clamps silently |
| `--effort max` | `max` |
| `--effort HIGH` | `high` |
| `--effort ultracode` | `xhigh`, with no warning; the transcript logs an `ultra_effort_enter` attachment, and the first run loaded a skill by itself: it turns on ultracode mode |
| `CLAUDE_CODE_EFFORT_LEVEL=bogus` | `medium`, with no warning |

`CLAUDE_EFFORT` is what claude *exports* to its hooks and Bash ("Also exposed to hook commands and
Bash as the CLAUDE_EFFORT env var", in the binary's schema); it doesn't read it. The variable it
reads is `CLAUDE_CODE_EFFORT_LEVEL` (`auto` or `unset` mean none), and that variable beats
`--effort`. Story 008's judges ran at `medium` (story 008's records, not these probes), which is
also Sonnet's default. So withholding
`CLAUDE_EFFORT` is harmless, but `CLAUDE_CODE_EFFORT_LEVEL` is the one an operator's environment
could use to override an agent's `--effort`.

**codex**, in a temporary `CODEX_HOME` whose `config.toml` said `model_reasoning_effort = "high"`
and whose `prof.config.toml` said `"xhigh"`, each a new `codex exec` on `gpt-6-luna`:

| set | `turn_context.effort` |
| --- | --- |
| config.toml only | `high` |
| `-p prof` | `xhigh` |
| `-p prof -c model_reasoning_effort="low"` | `low` |
| `-c …="low"` | `low` |
| empty config.toml | no `effort` key; `collaboration_mode.settings.reasoning_effort: null` (the model's default, `medium` for `gpt-6-luna`) |

**pi**, read with `get_state` on a new session (`--no-session`): no flag → `medium` (the settings'
`defaultThinkingLevel`); `--thinking high` → `high`; `--model …:max --thinking off` → `off`. On a
resume, `--model …:low --thinking high` → `high`. pi also reads `modelThinkingLevels` from settings,
keyed by `provider/modelId`; not probed.

## M5 — levels, and an invalid level

**codex** lists each model's levels in `codex debug models` (JSON: `slug`,
`default_reasoning_level`, `supported_reasoning_levels[].effort`):

| model | default | levels |
| --- | --- | --- |
| `gpt-6.1-sol` | `low` | `low, medium, high, xhigh, max, ultra` |
| `gpt-6-sol`, `gpt-6-astra`, `gpt-5.6-terra` | `medium` | `low, medium, high, xhigh, max, ultra` |
| `gpt-5.6-sol` | `low` | `low, medium, high, xhigh, max, ultra` |
| `gpt-6-luna`, `gpt-5.6-luna` | `medium` | `low, medium, high, xhigh, max` |
| `gpt-5.5` | `medium` | `low, medium, high, xhigh` |

The `low` defaults of `gpt-6.1-sol` and `gpt-5.6-sol` would explain why contained codex ran at
`low` in the first live loop; an inference, not measured here.

codex doesn't check a level itself; the API does, and its lists are wider than the catalog:

- `bogus` on `gpt-6-luna`: `Invalid value: 'bogus'. Supported values are: 'none', 'minimal', 'low',
  'medium', 'high', 'xhigh', and 'max'.` (status 400), then `turn.failed`, exit 1.
- `minimal` on `gpt-5.6-luna`: `Unsupported value: 'minimal' is not supported with the
  'gpt-5.6-luna' model. Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and
  'max'.`, then `turn.failed`.
- `ultra` on `gpt-6-luna`, which the catalog doesn't list for it, completed, and `turn_context`
  logged `ultra`. What was sent is unknown.

The rejected level is still logged in `turn_context` (`effort: bogus`). A log read doesn't prove
that a level ran.

**claude**: `--effort bogus` → stderr `Warning: Unknown --effort value 'bogus' — ignoring it and
using the default effort. Valid values: low, medium, high, xhigh, max.`, exit 0, ran at `medium`.
**pi**: `--thinking bogus` → stderr `Warning: Invalid thinking level "bogus". Valid values: off,
minimal, low, medium, high, xhigh, max`, exit 0, the flag ignored. `--model …:bogus` was taken as a
custom model id and failed at the provider. **cursor**: refused before any request (M3).

## M6 — where the effort is logged

- **claude**: the session jsonl, each `assistant` row's `message.model` and top-level
  `perTurnEffort` (`null` when no effort was sent). `--output-format json` reports neither (only
  `modelUsage`, keyed by model and cumulative over the session). `stream-json`'s `system`/`init` row
  has `model` and `per_turn_effort_active: true`, but no level.
- **codex**: the rollout `~/.codex/sessions/{y}/{m}/{d}/rollout-…-{id}.jsonl`, each
  `turn_context` row's `payload.model` and `payload.effort` (absent when none was set), and
  `payload.collaboration_mode.settings.reasoning_effort`. `exec --json` reports neither.
- **pi**: the session file's `model_change` and `thinking_level_change` rows, written at creation
  and on an interactive or rpc switch, never by a `--print` resume, nor by a pane relaunched on
  the session with new flags (story 020's live eval). Each assistant row has
  `provider` and `model`, but no level. `--mode json` reports the model on `turn_end.message.model`,
  but no level. To read the level a resumed turn used: rpc `get_state` before it, or the agent's
  `$PI_REASONING_LEVEL`.
- **cursor**: nothing found. The chat's `store.db` holds the system prompt ("You are GPT-5.4
  Nano.") and no model id or parameters. `json` output has no model. `stream-json`'s `init.model` is
  the resolved display name, which carries the level for variants other than medium.

## Not measured

- **cursor in a pane (M2).** Stopped before it ran: see M2.
- **Which cursor bases take which bracket key** beyond `gpt-5.4-nano` (`reasoning`) and the
  operator's saved `grok-4.6` (`effort`). Finding out means more runs, each rewriting the
  operator's `cli-config.json`.
- **Whether cursor's effort reaches the provider**: nothing logs it.
- **What codex sends for a level outside the model's catalog** (`ultra` on `gpt-6-luna`).
- **The default effort of models other than Sonnet 5.5** in claude; the binary's text says it is
  per model.
- **Sandboxes.** Every probe ran on the host. A sandbox's fresh home has no settings, so the
  defaults above are the models' own.

## Side effects of these probes

- The headless cursor turns on the operator's home (`gpt-5.4-nano-high`, `gpt-5.4-nano`,
  `composer-2.5[fast=true]`, `gpt-5.4-nano-low`, then resumes on `gpt-5.4-mini-high`,
  `composer-2.5[fast=true]`, `gpt-5.4-nano-high` and `gpt-5.4-nano`) rewrote `~/.cursor/cli-config.json`. Its `model`, `selectedModel`, `modelSelectionHistory` and
  `modelParameters` changed from `composer-2.5` / `{"fast": "false"}` / `["composer-2.5",
  "grok-4.6", "auto-smart"]` to `gpt-5.4-nano` with `reasoning: high`, and `composer-2.5`'s `fast`
  to `true`. Restoring it was not done here.
- Four cursor runs used a substituted `HOME` (`gpt-5.4-nano[reasoning=low]`,
  `gpt-5.4-nano[reasoning=bogus]` twice, `gpt-5.4-nano[effort=low]`) and set off a macOS keychain
  dialog. A cursor
  `worker-server` the probes started on the real home was stopped afterwards.
- claude, codex and pi pane switches ran on temporary config homes, or, for pi, on a home whose
  settings file was shown unchanged.
