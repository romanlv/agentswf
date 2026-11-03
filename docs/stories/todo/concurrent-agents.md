---
title: Many agents at once stay reliable
type: story
status: todo
priority: P1
epic: long-runs
discovered_in: "the fork eval, 2026-11-03, after story 039"
depends_on: []
---

# Many agents at once stay reliable

Measure where running many agents at once breaks (E4), then make awf hold up there: a turn's start
and end read from its harness's own records, an answered agent past its release stopped rather than
the run failed, and whatever limit on concurrent agents the measurement calls for.

Why it matters: a workflow that fans out a dozen agents is ordinary use, and today it fails. The
fork eval (16 agents at once, 32 in all) fails on every run on a 10-core machine; compaction (8)
passes alone and failed beside another eval. Each failure ends the whole run, as `cleanup-unresolved`
or `prompt delivery could not be confirmed`, with the agents' answers already saved.

## What was seen

On 2026-11-03, claude 2.1.317, codex 0.166, Herdr 0.9.1, load average about 2 at rest and 9–10
during a fork run. Herdr itself stayed fast, 0.2 s or less a call.

- **claude drops the Enter after a paste.** The prompt sits unsent in its input box, marked with its
  `awf-delivery` id, until the receipt deadline fails the turn.
- **codex draws its turn late.** Its screen showed a turn 10–15 s after the process ran it, so Herdr
  answered `agent_prompt_stalled` for a delivered prompt, and the host waited out the deadline.
- **Herdr can miss a turn whole.** One codex answered while Herdr reported it `idle`, its
  `state_change_seq` unchanged, for more than 30 s after.
- **A model can be slow after the answer.** A headless codex ran `wfa result`, then waited over 30 s
  on its model's next response; the 30 s release ran out and failed the run.
- **A provider can refuse.** cursor answered `resource_exhausted` once and worked minutes later.

The first three are a starved terminal; the last two are the provider, and grow with sessions on
the account rather than with load on the machine.

## Measured

On 2026-11-03, the same versions, cursor-agent 2026.10.22 and pi 1.5.0, each harness's TUI in a
Herdr pane, against its session file and hooks. The raw runs were scratch and are gone; the numbers
are here.

- **CPU alone is not the ceiling.** One codex pane at load average 23–32 from 40 busy loops: Herdr
  saw `working` and `done` 0.3–0.4 s after the session file's `task_started` and `task_complete`,
  as at rest, and no prompt stalled.
- **Many agents at once are.** Twelve codex panes prompted together, load average 25–28, twice; the
  second polled Herdr once a second, so the probe was not the load:
  - the session file had every turn's start and end, all 24;
  - Herdr never showed the turn in 7 of 12 and 6 of 12: the pane stayed `idle` or `done`, and its
    `prompt --wait` returned after about 5.4 s, 1–3 s before the turn ended;
  - where it did, `done` came 22–43 s after `task_complete`, past story 021's 30 s release;
  - 3 of 12 prompts began 16–19 s after they were sent, which only the session file shows.
- **Each harness records its own turn**, interrupted ones included:

| Harness | Start and end | On Escape | awf can add it to its own sessions |
| --- | --- | --- | --- |
| claude | transcript: the prompt, then `system` `turn_duration`; hooks `UserPromptSubmit` and `Stop` | transcript `[Request interrupted by user]`; `Stop` does not run, as its hooks reference says, and no hook does | hooks through `--settings`, which fired in the pane |
| codex | session file `task_started`, `task_complete` | `turn_aborted` | the file needs nothing; hooks given by `-c` open a "Hooks need review" dialog that blocks the pane until trusted, a trust written to `~/.codex/config.toml` or skipped by `--dangerously-bypass-hook-trust` |
| cursor | hooks `beforeSubmitPrompt`, `stop` | `stop` with `aborted`, then again with `error` | only from `~/.cursor/hooks.json` or the project's `.cursor/hooks.json`, which ran with no trust prompt; its chat store not checked |
| pi | extension `agent_start`, `agent_settled` | yes | `-e`; Herdr's own pi integration reports its state this way, and pi had no delivery failure |

- **A blocking dialog shows only on the screen.** cursor's shell allowlist prompt left Herdr
  `blocked` with no hook; claude's auto-mode offer was the same.
- **The operator's own hooks run in awf's agents.** A codex agent on the operator's home ran its
  `Stop` hook, a review tool with a four-day timeout; whether it slowed a turn's end was not
  measured. It has since been removed.

## To measure (E4)

[`experiments/e4-concurrency/`](../../../experiments/e4-concurrency/) already holds the question.
Fan out 4, 8 and 16 agents per harness, headless and in panes, and record:

- M1. Which ceiling comes first, per harness and placement: CPU, the harness's terminal, or the
  provider. Delivery failures, late screens and release times against load and provider errors.
  For codex panes, CPU is not it (Measured); claude, cursor, pi and headless agents are open.
- M2. Whether the failures come from agents starting at once or from agents running at once:
  the same 16 started in batches of 4.
- M3. Model latency after an answer, per harness: how long an answered turn takes to end, to
  choose the release bound story 021 left unmeasured.
- M4. Provider limits: at what count each provider throttles, and whether per process, machine or
  account.
- M5. E4's own questions: per-call cost and latency at N, the result gate settling exactly once,
  a pane's usage attribution under concurrency.

## Open questions

- Q1. What a limit counts: turns executing, or sessions open. An idle pane costs nothing; a turn
  left finishing after its answer still calls its model.
- Q2. Its scope: one run, or every awf run on the machine through the coordinator. Throttling is
  per account, so a per-run limit does not stop two runs exceeding it.
- Q3. Whether time spent waiting for a slot counts against an operation's deadline. If it does,
  queued turns time out; if not, a deadline no longer bounds wall-clock time.
- Q4. How a limit avoids deadlock: an agent waiting on another's reply must not hold the slot that
  other needs, so a turn parked in a wait probably gives its slot back.
- Q5. Whether starting terminal agents needs a cap of its own, separate from any per-provider one.
- Q6. Whether an answered agent past its release bound is stopped, keeping the answer, and the run
  fails only if the stop cannot be confirmed. That changes story 021's "fail with
  `cleanup-unresolved`", and matches a pane agent stopped past its grace.

## Independent of the limit

Reading a turn off the screen fails under load whatever the limit, which
[[herdr-pane-settlement]] already says: screen and quiet signals are diagnostics, not authority.

- A turn's start and end come from the harness's own records: claude's transcript, which already
  confirms delivery by the marker, and codex's session file, which need nothing added and hold an
  interrupted turn too. That is the turn-scoped completion [[herdr-pane-settlement]] found no
  provider reported. Where there is no file, a hook: pi's through an awf extension, cursor's in a
  sandbox, whose home awf writes; outside one, cursor's hooks are the operator's or the project's
  files.
- Herdr stays the pane's host, its keys and the only sign of a blocking dialog; its state is a
  diagnostic.
- claude's dropped Enter is pressed again only when its receipt shows the prompt never arrived and
  its input box still holds the marked prompt. A record of the turn finds the drop; it does not
  prevent it.
- The transcript and session file are not published formats, unlike claude's hooks: a fixture per
  harness version catches a change.

Notes: [[021-turn-liveness-and-limits]] holds the release design; [[herdr-pane-settlement]] the
stall design and what Story 001 settled; foundation §12 schedules E4. A screen-based late-turn wait for codex and the claude Enter
re-press were tried in `packages/harness/src/adapters/herdr.ts` and `herdr-protocol.ts` and set
aside, unreleased: they read the turn off the screen.
