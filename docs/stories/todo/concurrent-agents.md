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

Make awf hold up with many agents at once: a pane's turn read from its harness's own session file,
not Herdr's screen; an answered agent past its release stopped rather than the run failed; then
E4, and whatever limit on concurrent agents it calls for.

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

The first three are a starved terminal, which the plan answers; the last two are the provider, and
grow with sessions on the account rather than with load on the machine, which Q6 and E4 answer.

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

## Plan

The turn record first: it needs no measurement and answers the failures seen. Then Q6, then E4
and whatever limit it calls for. [[herdr-pane-settlement]] already says screen and quiet signals
are diagnostics, not authority; a harness's own record is the turn-scoped completion it found no
provider reported.

### 1. A turn read from its harness's record

One watcher, generalized from `claude-receipt.ts`, which already finds claude's transcript by the
prompt's `awf-delivery` marker and tails it within bounds. A harness's spec gives it a
`turnRecord`, beside `activityRow`: where its session files are, and a reducer over their rows
that says `accepted`, `received`, and `ended` as `completed` or `interrupted`.

- claude: the receipt's reducer, plus `system` `turn_duration` for the end and
  `[Request interrupted by user]` for an interrupt.
- codex: the `user_message` carrying the marker accepts, the `task_started` before it starts, and
  `task_complete` or `turn_aborted` ends; a subagent it waits on keeps the turn open, as `turnOpen`
  in `usage/codex.ts` already reads. Its prompt gains the marker; `findCodexSession` already finds
  the rollout by the operation id.
- pi: none. Herdr's pi state is pi's own extension reporting `agent_start` and `agent_settled`,
  not its screen, and stays.
- cursor: none in this story; Herdr's screen, as today. Its chat store is M7; hooks in a sandbox,
  whose home awf writes, come after it.
- A file the host cannot read, in a box whose home it does not hold, leaves Herdr as today.

### 2. The pane host waits on the record

In `adapters/herdr.ts`, for a harness with a record:

- `execute` sends with `agent prompt` and no `--wait`. The turn ends when the record says so,
  raced against Herdr showing `blocked` and the deadline. That removes the false completion seen,
  a `prompt --wait` returning while the turn ran on, and `agent_prompt_stalled` with its
  wait-out-the-deadline branch. The screen is still read after the end, for evidence and login.
- Before the next prompt, a fork or a relaunch, the record's last turn has ended, in place of
  `agent wait`; `untilWritten` already waits so on codex.
- `finishAnswered` waits on the record's end in place of `agent wait`: the `cleanup-unresolved`
  failures.
- `stopFinishing` and `release` press Escape only while the record shows the turn open, and the
  record's interrupt confirms it stopped.
- `blocked` is read with `agent get` every few seconds while a turn runs; a blocking dialog ends
  the turn `blocked`, as today. Whether that holds under load is M6.
- Compaction stays on the screen in this story.

### 3. claude's dropped Enter

When the receipt has not accepted a few seconds after the Enter, and `agent read` shows the marked
prompt still in the input box, Enter is pressed once more. A prompt accepted or queued, which the
reducer counts by `enqueue`, is never pressed again. Still nothing, the turn fails as today.

### 4. Tests

- A fixture per harness version, from a real session file: a turn, an interrupted turn, and for
  codex a turn with a subagent, in `usage/fixtures/{harness}`; the reducers are tested on them, so
  a harness release that changes its format fails a test, not a run.
- `herdr.test.ts`: the fake Herdr stays `idle` while the file records the turn, the measured miss,
  and the turn completes; a file that never ends times out; `blocked` ends it; the dropped Enter is
  pressed once.
- Live: the fork eval at 16 and compaction beside another eval, each three times, and the 12-pane
  codex fan-out as an eval.

## Built

Steps 1–4 are on the `concurrent-agents` branch, the turn record in `packages/harness/src/turns/`.
What the live suite added to the plan:

- **Herdr settles only what the record cannot.** A prompt whose record never shows it waits out
  its deadline: a 60 s fallback on Herdr's status failed a codex that began its turn 70 s after its
  prompt, Herdr still showing the last turn `done`. A record that fails mid-turn fails the turn,
  never handed to a Herdr that may not have seen it begin. A Herdr wait after a turn the record
  settled waits for Herdr to catch up first.
- **One dialog wait per turn**, `agent wait --until blocked`, shared by the turn's execute and
  release, and confirmed a moment later: claude's auto mode showed `blocked` for a moment under
  load. Herdr answered `agent_not_found` for live agents with eighteen panes busy, so an agent is
  gone only on three misses running.
- **Pane compaction ends on the record too**, claude's `compact_boundary` and summary or codex's
  prompt-less task that wrote `compacted`, or the screen, whichever comes first: Herdr's wait
  returned before a loaded codex began, and the screen showed none.
- **cursor is prompted only once drawn.** Herdr's `agent start` called a cursor ready before it
  drew; its prompt went to the shell and sat unsent in cursor's input until the deadline, the
  cursor timeouts the fork, compaction and harnesses evals showed under load. Every start now
  waits for `paneReady`.
- **The fan-out eval**, 12 codex, 6 claude and 4 cursor panes prompted together twice, passes alone
  and under the full suite's four evals at once.

The full suite under four evals at once passed 16–17 of 21 on the branch against 13 of 20 on
main, 2026-11-03. What still failed there passes alone: effort's pi and cursor panes, which still
read Herdr's state (M7, and pi's extension under load); calling-session, which fails the same way
on main, while the eval types into its caller sessions; and model answers, codex's compaction
summary once dropping its codename.

## To measure

M1–M5 are E4: [`experiments/e4-concurrency/`](../../../experiments/e4-concurrency/) already holds
the question. Fan out 4, 8 and 16 agents per harness, headless and in panes, and record:

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

M6–M7 the plan needs, before step 2 and after it:

- M6. Whether Herdr's `blocked` holds under load, the one screen signal the plan keeps: a blocking
  dialog in one of 12 busy panes, and how late Herdr shows it.
- M7. Whether cursor's chat store records a turn's start and end, so cursor needs no hook. A
  cursor pane still misses turns under load: two of four timed out in one fan-out run.
- M8. Why a pi pane relaunched by `set` timed out under the full suite's load, its state pi's own
  extension's.

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

Notes: [[021-turn-liveness-and-limits]] holds the release design; [[herdr-pane-settlement]] the
stall design and what Story 001 settled; foundation §12 schedules E4. A screen-based late-turn
wait for codex and an unguarded claude Enter re-press were tried and set aside, unreleased, in the stash
"concurrent-agents: herdr stall heuristics": they read the turn off the screen.
