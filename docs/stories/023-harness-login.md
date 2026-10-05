---
id: "023"
title: Say when an agent's harness needs a login, and let the workflow stop on it
summary: "A turn whose harness has no login, or whose login is refused, ends `failed` with a `login` field naming the harness and what the operator runs, headless and in a pane, for claude, codex, cursor and pi; it is never nudged, and a workflow can stop on it."
type: story
status: awaiting-human-review
priority: P1
epic: long-runs
discovered_in: "story 016, task 4's live run, 2026-10-03 (todo expired-login)"
depends_on: []
---

# Say when an agent's harness needs a login, and let the workflow stop on it

## Outcome

An agent whose harness cannot sign in, because it has no login or its login is refused (expired,
invalidated, corrupted), ends its turn `failed` with a reason that names the harness and what to
run, and a `login` field a workflow can test:

```
✗ reviewer · 3s · failed: pi needs a login for openai-codex: run `pi`, then /login
```

The turn is not nudged, and nothing awf retries. The run does not stop on its own: the outcome is
the agent's, and the workflow decides. A workflow that wants to stop does
`if (outcome.kind === "failed" && outcome.login) workflow.stop(outcome.reason)`, and the operator
reads the reason in `awf run`'s closing block and in `--here`'s hand-back.

Why it matters: on 2026-10-03 every pi agent in `examples/fork` ended in 2–5 s as `unanswered:
agent settled without an accepted result`, was nudged, and the run went on; the cause, an
invalidated refresh token, was only in pi's own output.

## How it works

```
headless turn ── stdout, stderr ──► spec.login.headless(stdout, stderr) ─┐
pane turn     ── screen ──────────► spec.login.screen(screen) ───────────┤
pane launch   ── screen ──────────► spec.login.screen(screen) ───────────┤  (codex, cursor stop
                                                                         │   at a sign-in screen)
                                       { provider? } ◄───────────────────┘
                                             │
HarnessTurnOutcome { state: "failed", detail: "{harness} needs a login…: {how}", login }
                                             │  a failed native turn is never nudged
TurnOutcome { kind: "failed", reason, retryable: false, login: { harness, provider?, run } }
                                             │
                               the workflow: stop, or go on
```

Each harness's definition says how its output shows a missing or refused login, and what the
operator runs (`login`, beside `interrupted`). Headless, it reads what the CLI printed of itself:
claude's `result` envelope, codex's `turn.failed` and its auth log on stderr, cursor's stderr, pi's
`turn_end` error and stderr; never the agent's own words. In a pane it reads lines of the screen
that begin with the harness's own error text. codex and cursor never reach a prompt without a
login: their pane shows a sign-in screen at launch, which is recognised as the launch fails, and
the pane is closed (a sandboxed one could not open the browser anyway).

## Scope

In scope:

- `login` in `HarnessSpec`, given by claude, codex, cursor and pi, tested on output each printed.
- Headless, pane turn, pane launch, and the calling session's pane (`--here`).
- `TurnOutcome`'s `failed` gains `login?: TurnLogin` (contract).

Out of scope:

- A run-level stop raised by the engine (operator, 2026-10-05: the workflow decides).
- Checking logins before a run (`billing`'s status commands could): a refused refresh shows only
  at the first request, so it would not replace this.
- Logging in for the operator.

## Context and evidence

Captured 2026-10-05 (claude 2.1.289, codex-cli 0.160.1, cursor-agent 2026.10.01, pi 0.87.1), each
in a throwaway home with no credential ("missing") and a made-up one ("refused"); nothing of the
operator's logins was copied. Fixtures in `packages/harness/src/harnesses/fixtures/login/`.

| harness | headless missing | headless refused | pane |
| --- | --- | --- | --- |
| claude | exit 1, `result: "Not logged in · Please run /login"`, `is_error` | exit 1, `api_error_status: 401`, `"Failed to authenticate. API Error: 401 OAuth access token is invalid."` | `⎿ Not logged in · Please run /login`; `⏺ Please run /login · API Error: 401 …` |
| codex | exit 1 after ~10 retries, `turn.failed` `401 Unauthorized: Missing bearer…` | exit 1, `turn.failed` `… unauthorized (401)`; stderr `codex_login::auth::manager: Failed to refresh token … Please log out and sign in again.` | sign-in screen at launch: `Finish signing in via your browser` |
| cursor | exit 1, stderr `Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY…` | exit 1, stderr `The provided API key is invalid.` | missing: sign-in screen at launch, `Signing in with the browser...`; refused: prints the stderr line and exits to the shell |
| pi | exit 1, stderr `No API key found for {provider}.` | **exit 0**, `turn_end` `stopReason: "error"`, `errorMessage: "OAuth refresh failed for {provider}: …"` | `Error: No API key found for {provider}.`; `Error: OAuth refresh failed for {provider}: …` |

- Fact: a real invalidated codex login (2026-09-25, `~/.awf/runs/invocation-4fdc676c…`) printed
  `Failed to refresh token status=401 … refresh_token_invalidated … Please try signing in again.`
  on stderr, matching the refused capture.
- Fact: a native `failed` turn is never nudged (`operation-liveness.ts`, non-completed native
  states end the operation); pi's refused login exits 0, which is why it was nudged.
- Fact: codex and cursor TUIs open a browser tab at their sign-in screen.
- Constraint: a pattern must not match the agent's own words: an agent reviewing this code prints
  "Please run /login". Headless reads only the CLI's envelope and stderr; a pane matches a line's
  start, after the harness's own glyph.

## Proposed design

- `contract/src/workflow/agents.ts`: `TurnLogin = { harness: string; provider?: string; run: string }`;
  `failed` gains `login?: TurnLogin`.
- `harness/src/harnesses/define.ts`: `login?: { headless(stdout, stderr); screen(screen); run: string }`,
  the first two returning `{ provider?, said } | undefined`. Each harness gives it.
- `HarnessTurnOutcome.login?: TurnLogin`, set by `direct-process` (any exit), `herdr`'s
  `paneOutcome` and launch failure, and `herdr-caller`'s `callerOutcome`; its `detail` is the
  reason.
- `SupervisedOutcome` carries `login` from the native outcome; the runner puts it on `failed`.

Alternatives rejected:

- A seventh outcome kind — every exhaustive switch changes, and generic `failed` handling stops
  catching it (operator, 2026-10-05).
- Reason text only — a workflow could tell it only by matching text.
- An engine-raised run stop — the agent's outcome is the signal; the workflow owns stopping.

## Tasks at a glance

- [x] 1. Each harness recognises a login it lacks, on fixtures, headless and on its screen.
- [x] 2. A turn that needs a login ends `failed` with `login`, headless, in a pane and at a pane's
      launch, through to the workflow, with `reply.needsLogin()` for a workflow's own tests.

## Open questions

None.

## Verification

Automated:

- [x] Every fixture recognised, with the provider for pi; no false match on a quoted error, an
      earlier turn's line, or a codex refresh that recovered (`login.test.ts`).
- [x] A headless turn, a pane turn, a stalled pane prompt and a pane launch onto a sign-in screen
      end `failed` with `login` (`direct-process.test.ts`, `herdr.test.ts`); through the engine,
      unnudged, and a workflow stops on it (`workflow-testing.test.ts`).
- [x] `bun test` (all pass), `bun run check` (Biome, tsc, boundaries ok)

Manual or live:

- [x] `awf run examples/quick-check -- pi` with `PI_CODING_AGENT_DIR` on a made-up login:
      `✗ check:pi · 0s · failed: pi needs a login for openai-codex: run \`pi\`, then /login …`,
      unnudged.
- [x] Each harness's pane through the pane adapter, its throwaway home passed as the workspace's
      `--env`: claude, pi and codex failed with `login` within seconds; cursor with no login at
      once, on its sign-in screen; cursor with a refused key after 122 s (below).

## Implementation notes

- A pane's own environment is Herdr's, not `awf run`'s: the live pane checks passed the throwaway
  home through `workspace create --env`, from a scratch script, not through `awf run`.
- pi in a pane fails before Herdr sees it working, so `agent prompt` reports a stall, which the run
  host waits out to the deadline. A failed or stalled prompt now reads the screen for a login
  first.
- Known limit: cursor with a refused `CURSOR_API_KEY` prints its warning and exits to the shell;
  Herdr's `agent start` waits its full 120 s for an agent that never comes, and only then is the
  screen read. A turn deadline under that ends `timed-out`.
- Known limit: a pane line that a tool printed in this turn, starting with a harness's own login
  error (claude's `⎿` is both its tool output's glyph and its error's), reads as a login. Only a
  turn with no accepted answer is affected: an answered turn never reads the native outcome.
- A pane turn is read from the prompt that carries its operation id. claude and pi draw it, a long
  multi-line prompt included (checked live); a harness that folds a paste away, as cursor does,
  shows none, and its screen after a prompt is then not read for a login. Its launch, which sends
  no prompt, is read whole: cursor's and codex's login failures show there.
- Codex and cursor TUIs open a browser tab at their sign-in screen; a pane is closed once it is
  recognised, and a docker box's cannot open one.
- `examples/fork` checks each harness apart, so it does not stop on one harness's login; its
  problem line now names the login instead of `unanswered`.
- `run.turns[].outcome` records `needs-login` for a scripted `reply.needsLogin()`, as it records
  `silent` and `hang`, which are scripts' words too.

## Review record

### Tasks 1 and 2

- Architecture and scope: `login.run` is prose in the contract — kept, as the operator chose the
  shape; documented as text to show, not parse. Whole-screen read in a run's pane — fixed: only
  what follows this turn's prompt (`thisTurn`), as the calling session already did. Testing label
  `needs-login` — kept (see notes). `examples/fork` not stopping — task reworded (see notes).
  `LoginCheck`/`LoginNeed` — out of the package index; nothing outside harness uses them. Optional
  `login` with a fallback in the test host — kept: optional with an absence is how every
  capability is declared.
- Correctness and proof: tool output starting with the phrase — a limit, recorded above. Stale
  lines and a stall under a live agent — fixed by `thisTurn`. A codex refresh that failed and
  recovered — fixed: only a 401 or `refresh_token_invalidated`, never on `turn.completed`. claude
  wordings with the reason first — matched (` · Please run /login` at a line's end). Cancellation
  during the screen read — fixed: the read takes the signal and an aborted one reads as no login.
- Round 1 of the full review: `thisTurn` read the whole screen when the id was not drawn, so an
  earlier turn's line could fail a later turn, or a stall under a live agent — fixed: a prompt's
  id not on screen reads nothing. Screen cleanup duplicated `readable` and missed OSC — `readable`
  moved to `harness/src/screen.ts`, shared. `run(provider?)` never read its argument — now a
  string. `login` could ride on a timed-out supervised outcome — only a failed one keeps it. The
  operator's skill list in the pi screen fixtures — replaced by a placeholder. Untested paths — the
  calling session, the pane adapter's failed prompt, and headless cancel/timeout winning over a
  login are now tested. A provider with a dot in pi's "No API key found" — matched.

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Set the story status to `awaiting-human-review` and present the outcome.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
