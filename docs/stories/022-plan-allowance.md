---
id: "022"
title: Read what is left of each harness's plan, and let heavy work wait for it
summary: "`awf allowance` reads each subscription harness's plan windows from the harness's own usage command (claude `/usage`, codex's `/status` data, cursor `/usage` in a pane) as an `awf.allowance/1` record, and `awf-lab run` and `loop` admit a step only while the plan it draws on has room, waiting for the reset otherwise."
type: story
status: done
priority: P1
epic: loop
discovered_in: "todo inbox, 2026-10-05: an API to see harness subscription allowance left"
depends_on: []
---

# Read what is left of each harness's plan, and let heavy work wait for it

## Outcome

`awf allowance` prints, for each harness logged in on a plan, how much of each of its windows is
used and when each resets. It reads the numbers the harness itself shows the operator:

```
claude   subscription · session 37%, resets Oct 5 13:20 · week 12%, resets Oct 8 12:00 · week (Fable) 0%, resets Oct 8 12:00
codex    prolite · week 93%, resets Oct 9 18:54 · gpt-reserve week 0%, resets Oct 11 09:52
cursor   Team · included 1%, resets Oct 21 · auto 1% · api 1%
pi       no allowance: pi has no plan usage command; its logins draw on claude's and codex's plans
```

`awf allowance --json` prints the same as an `awf.allowance/1` record, which is the interface: a
script, the lab, or a workflow's operator reads it, never a harness's screen.

`awf-lab run` and `loop` check it before each trial and score: a step that would draw on a window
at or past its limit waits for that window's reset instead of starting, and says so.

Why now: autoresearch and long runs of the operator's own workflows draw on the same plans the
operator works on. Codex's weekly window went from 62% to 93% in one hour on 2026-10-05; a loop
that runs into a plan's limit fails its trials as if the variant had, and a loop that is cut there
loses its place ([[loop-next]]).

## How it works

```
awf allowance [harness…] [--json]
  └─ harness: readAllowance(harness, context) ─┬─ claude:  claude -p "/usage" --output-format json   (0 turns, $0)
                                               ├─ codex:   codex app-server · account/rateLimits/read (the data /status shows)
                                               ├─ cursor:  a Herdr pane: cursor-agent, type /usage, read the screen
                                               └─ pi:      absent, with why
       → HarnessAllowance per harness → AllowanceReport (awf.allowance/1)

awf-lab run / score / loop: every awf run goes through the lab's Runner
  waitingOnAllowance(runner) ─ the run's harness/model arguments ─ awf allowance --json {their harnesses}
                               every window they draw on < limit? → run
                               otherwise → sleep until its reset (+1 min), read again
```

Each harness's definition says how its plan is read, or why it can't be, as it does for every other
capability (`defineHarness`). Two shapes:

- **Headless** (`readAllowance`): a command that answers without a model turn. claude's `/usage`
  runs headless with `num_turns: 0` and `total_cost_usd: 0`; codex's app-server answers
  `account/rateLimits/read`, the request behind its TUI's `/status`.
- **Pane** (`allowancePane`): cursor's `/usage` runs only in its TUI. Its definition says what to
  type and how to read the screen; the Herdr adapter opens the pane, types, reads and closes it, as
  it does a pane's compaction.

A window is what the harness shows: an id, its label, the percent used, when it resets, and, where
it applies only to some models, which (`Fable`, `gpt-5.6-luna`). Nothing is converted: claude and
cursor print percents, codex returns them. What a harness did not show is absent, never 0.

The lab waits at its Runner, the one place every trial, score and proposer run goes through. A
run's harnesses are the `{harness}/{model}` among its arguments (`--runtime` in a variant's, the
loop's `--proposer`); a run that names none, as a scorer on its workflow's default, is not waited
on, and that is said once. A window scoped to some models holds back only a run whose model names
it (`claude-opus-4-7` names `Opus 4.7`). A waiting run keeps the job slot and budget it was admitted
with.

## Scope

In scope:

- `awf.allowance/1` in `contract/records`.
- Readers for claude, codex and cursor, each tested on output recorded from the real harness; pi's
  absence with its reason.
- `awf allowance [harness…] [--json]`.
- `awf-lab run` and `loop` waiting on the allowance before each step, with `--allowance {percent}`
  as the limit, 90 by default, and `--allowance off`.

Out of scope:

- `awf run` refusing or pausing on its own. A workflow's operator can read `awf allowance` first;
  an engine-side gate needs live accounting ([[live-spend-limits]]).
- Telling how much one run or trial drew from a plan: the read is the account's, which the
  operator's own sessions share.
- Stopping a step already running when a window fills mid-step: it may overshoot.
- pi's allowance read through claude's or codex's: pi's anthropic login has no account id to match
  against claude's, so it would be a guess.

## Context and evidence

Probed live on 2026-10-05 (claude 2.1.289, codex-cli 0.160.0, cursor-agent 2026.10.01, pi 0.87.1):

- Fact: `claude -p "/usage" --output-format json` returns `num_turns: 0`, `total_cost_usd: 0`, and
  in `result` the text the TUI's `/usage` shows: "You are currently using your subscription…",
  then a line per window, `Current session: 37% used · resets Oct 5 at 1:20pm (America/Toronto)`,
  `Current week (all models): …`, `Current week (Fable): …`, then a breakdown of local sessions.
  The reset has no year and is in the named zone.
- Fact: claude's status line JSON carries `rate_limits`, but only for a status line the operator
  configured; not used (operator, 2026-10-05).
- Fact: headless claude's `stream-json` prints a `rate_limit_event` with `unifiedWindows` per
  request, and `isUsingOverage: false` on a subscription login; it needs a turn, so it is not the
  reader. It is evidence for [[billing-provenance]]: headless claude drew on the plan.
- Fact: `codex app-server`, `account/rateLimits/read` (`codex-rs/app-server-protocol/src/protocol/v2/account.rs`)
  returns `rateLimits` and `rateLimitsByLimitId`: per limit `primary` and `secondary` windows with
  `usedPercent`, `windowDurationMins`, `resetsAt` (Unix seconds), plus `planType`, `credits`,
  `limitName` and `normalModelSlug` for a model's own limit. The TUI's `/status` refreshes the same
  snapshot (`codex-rs/tui/src/chatwidget/slash_dispatch.rs`); `codex exec` has no slash commands.
- Fact: `cursor-agent -p "/usage"` and `cursor-agent usage` send the words to the model as a prompt.
  In the TUI, `/usage` opens a menu entry ("Show plan and on-demand usage"); Enter shows
  `Usage • Team … Resets Oct 21`, rows `Included 1% used`, `Auto 1% used`, `API 1% used`,
  `On-Demand $0`, `No personal limit`. `cursor-agent about --format json` gives only
  `subscriptionTier`.
- Fact: pi has no plan usage command (`docs/slash-commands.md`, `docs/rpc-commands.md`:
  `get_session_stats` is the session's tokens and cost). Its `anthropic` and `openai-codex` logins
  are OAuth on the same plans; its `openai-codex` entry keeps an `accountId`, its `anthropic` entry
  none.
- Constraint: `lab` imports contract only and reaches the engine through `awf` (boundary 5), so the
  lab reads `awf allowance --json`, as it reads `awf run --json`.
- Constraint: no keychain reads ([[no-keychain-for-cursor]]); none is needed.

## Code map

### contract

- `packages/contract/src/records.ts` — new `AllowanceReport`, `HarnessAllowance`,
  `AllowanceWindow`, `ALLOWANCE_VERSION`.

### harness

- `packages/harness/src/harnesses/define.ts` — `HarnessSpec.readAllowance`, `allowancePane`.
- `packages/harness/src/usage/allowance.ts` — parsers for claude's `/usage` text, codex's snapshot,
  cursor's screen; tested on fixtures in `usage/fixtures/allowance/`.
- `packages/harness/src/adapters/herdr-allowance.ts` — opens a pane, types, reads, closes.
- `packages/harness/src/harnesses/{claude,codex,cursor,pi}.ts` — each takes a position.

### engine

- `packages/engine/src/allowance-command.ts` — `awf allowance`, dispatched from `operator-cli.ts`.

### lab

- `packages/lab/src/review/lab/allowance.ts` — `waitingOnAllowance` wraps the Runner: which
  runtimes a run names, which windows hold it, how long it sleeps.
- `packages/lab/src/review/lab/runner.ts` — `awfAllowance` spawns `awf allowance --json`.
- `packages/lab/src/review/lab/cli.ts` — `--allowance`, and the wrap. `execute.ts` and the loop are
  unchanged: both run through the Runner.

## Proposed design

```ts
// contract/records
export const ALLOWANCE_VERSION = "awf.allowance/1";
export type AllowanceReport = { version: typeof ALLOWANCE_VERSION; readAt: string; harnesses: HarnessAllowance[] };
export type HarnessAllowance =
  | { harness: HarnessKind; read: "plan"; source: string; plan?: string; tier?: string; windows: AllowanceWindow[] }
  | { harness: HarnessKind; read: "none"; reason: string };
export type AllowanceWindow = {
  id: string;            // from the harness's wording, unique within it: "session", "week", "included"
  label: string;         // as the harness words it
  usedPercent: number;
  resetsAt?: string;     // ISO 8601, UTC
  models?: string[];     // the models it alone limits, as the harness names them; absent: all
};
```

- `read: "none"` covers a harness that has no reader, is not logged in, or is logged in with a key
  (no plan), each with its reason. A read that failed is `none` too: the lab treats it as unknown
  and does not wait on it, but logs it once.
- `plan` and `tier` are as the harness names them: claude's `subscriptionType` from
  `claude auth status` and `organizationRateLimitTier` from `~/.claude.json` (`max`,
  `default_claude_max_20x`); codex's `planType` (`prolite`); cursor's `/usage` header (`Team`).
- A plan's monthly price is policy, not observation (foundation §8): a dated table,
  `engine/src/accounting/plans.ts` (`plans 2026-10-05`), maps the names to what people call them
  and their list price: Max 20x $200, Max 5x $100, Pro $20; codex `prolite` Pro 100 $100, `pro`
  Pro 200, `promax` Pro 500, Plus $20, Go $8. `awf allowance` shows it; `--json` carries no price.
  cursor's Team is Standard ($40 a seat) or Premium ($120), which nothing it shows tells apart, so
  it has no price.
- The parsers are pure functions of the harness's output and the time of the read; the readers run
  them on what a process or a pane printed.

Alternatives rejected:

- Gating in `executePlan`'s `admit` — misses the loop's proposer, which calls the Runner directly.
- A run naming no runtime checked against every plan — a scorer would open cursor's pane per step
  and wait on plans it never draws on.
- claude's status line `rate_limits` — needs a status line the operator configured (operator).
- Anthropic's OAuth usage endpoint — undocumented, and its token is in the keychain.
- A probe turn per read — spends, and moves the window it reads.
- Inferring a plan's room from awf's own token records — the operator's other sessions draw on it.

## Tasks at a glance

- [x] 1. The record and the claude and codex readers
- [x] 2. cursor's reader through a pane
- [x] 3. `awf allowance`
- [x] 4. The lab waits on the allowance

## Open questions

Decided with the operator, 2026-10-05:

- Q1. Which harnesses: every one that can be read, cursor through a pane included; pi has none.
- Q2. Use each harness's own usage command, not claude's status line.
- Q3. The lab's check is in this story, not [[loop-next]].
- Q4. Priority P1, epic loop.
- Q5. Show the plan and what it costs, so a percent of a $200 plan and of a $20 one can be told
  apart (2026-10-05). awf may read `~/.claude.json` for claude's Max tier.
- Q6. What a percent is worth in dollars changes over time, so it is measured, not stored: filed as
  [[plan-percent-value]].

Open: none.

## Known gaps

- A pi run on its `anthropic` or `openai-codex` login draws on claude's or codex's plan, but is not
  waited on: pi reads `none`, and the lab does not map pi's provider to a plan (out of scope).
- A path argument shaped like `claude/notes.md` is taken for a runtime, and the run waits on
  claude's plan; a runtime inside a JSON argument is not seen.
- Windows' ids are slugged from the harness's wording: a reworded claude `/usage` renames them.
- cursor shows its reset to the day, and the record gives it as local midnight with nothing saying
  so: a window still full then is read again with backoff, five minutes up to the half-hour poll.
- Ctrl-C reaches the pane read only: a claude or codex read runs out its 30 s timeout.
- A Herdr abort that kills `workspace create` after Herdr made the workspace leaves it open, since
  no id came back to close.
- `claude -p /usage` is trusted to stay a local command (`num_turns: 0` today); nothing refuses
  its output if a future claude sends it to the model.
- cursor's usage pane starts as its interactive launch does, with `--force`; the steps await the
  menu entry before Enter, so the text is never submitted as a prompt while the menu is unchanged.

## Task execution rule

As in the template: one task at a time, each planned, implemented with its tests, reviewed and
verified before the next.

## Task details

### 1. The record and the claude and codex readers

Done when: the parsers read the recorded claude `/usage` and codex snapshot into windows with UTC
reset times; a key login, a logged-out harness and unexpected text are `none` with a reason; every
harness definition compiles with a position on both capabilities.

### 2. cursor's reader through a pane

Done when: the screen parser reads the recorded screen; the pane driver is tested against a fake
Herdr for the order of what it types and that it closes the workspace whatever happens.

### 3. `awf allowance`

Done when: `awf allowance` and `--json` print the report for named or all harnesses, tested with
fake readers; a live read on this machine matches the harnesses' own screens.

### 4. The lab waits on the allowance

Done when: a run whose window is at its limit waits until the reset and runs after; a read that is
`none`, or a run naming no runtime, holds nothing; each wait is logged once; a reset already past
waits five minutes rather than spinning; tested with a fake reader and clock.

## Verification

Automated:

- [x] Parser tests on recorded output, pane driver test, command test, lab waiting test (30 tests)
- [x] `bun test`: 1354 pass, 2 skip, 0 fail
- [x] `bunx tsc --noEmit`
- [x] `bun run check`: Biome, tsc, boundaries ok

Manual or live evaluation:

- [x] `awf allowance` on this machine, 2026-10-05: claude (3 s), codex (0.4 s) and cursor (5 s, a
  pane opened unfocused and closed) read; pi `none`. No model turn: claude's `/usage` reports
  `num_turns: 0`, `total_cost_usd: 0`.

## Review record

Tasks 1–4 were reviewed together, on the whole diff, by two read-only subagents.

- Architecture and scope: seams and boundaries hold; gating at the Runner is the better seam.
  Findings and dispositions: a run with no runtime read every plan and opened cursor's pane per
  step — now not waited on, said once; `models` widened to `string[]` while the format is new; the
  story doc lagged the code — updated; `none` with a prose reason only — intended, a reason code
  can be added; the id comment overclaimed stability — softened; the lab's copied harness list —
  kept, noted; an unused `signal` — now wired (below); a broken comment — fixed; exit 0 when all
  are `none` — intended, documented.
- Correctness and proof: the wait loop spun with no sleep on a reset already past — fixed (five
  minutes at least), tested; `claudeReset` put a time-alone reset in the past and a date up to a day
  behind — a time alone is now the next one, a date the nearest year, tested; Ctrl-C did not reach a
  pane read — `signal` threaded from `awf allowance` to the pane driver; model scopes missed
  version names — matched on normalised words, tested; the diagnostic screen read had no time left
  — it gets its own; codex's empty map hid the snapshot — falls back, tested; the read cache aged
  from the read's start — ages from when it settles, and is shared in flight, tested; no timeout on
  the lab's `awf allowance` — three minutes; `--runtime=` missed — read; cursor's `Sept` and rows
  not yet drawn — read, and the pane waits for `Esc to close`. Left as known gaps: pi's plans,
  path false positives, a create that names no workspace, a DST-gap time an hour early.
- Pre-merge review, on the whole diff after main was merged in: no blockers. A stale cursor screen
  put its reset a year ahead, where the lab would wait — now the nearest year, tested; a reset
  shown to the day re-read every five minutes until it passed — re-reads back off to the poll,
  tested; claude's `Sept` dropped the reset — read, tested. Left as known gaps: claude and codex
  reads ignore Ctrl-C, an aborted workspace create, `/usage` trusted not to reach the model,
  cursor's pane at `--force`, and pi's plans.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

- Plan and price (Q5), after the first review: `awf allowance` on this machine shows
  `claude  Max 20x ($200/mo)`, `codex  Pro 100 ($100/mo)`, `cursor  Team`. `prolite` is Pro 100 by
  OpenAI's own product names, as other tools found when it appeared (openai/codex#18805,
  steipete/CodexBar#691); Claude's prices are Pro $20, Max 5x $100, Max 20x $200.
- Probing cost two cursor turns: `cursor-agent -p "/usage"` and `cursor-agent usage` both went to the
  model. Hence the `readAllowance` absence for cursor.
- The lab's wait sleeps in naps of at most ten minutes, measured on the wall clock, so a machine
  that slept through a reset wakes to it.
- `awf allowance` reads with the same withheld environment as agents get (`allowanceReader`), so an
  `ANTHROPIC_API_KEY` in the operator's shell does not change what claude reports.

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Status `awaiting-human-review`, presented.
- [x] The operator approved it and marked it done (2026-10-05); index and status updated.
