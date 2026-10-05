---
title: Story 021 implementation proof
type: research
status: active
---

# Story 021 implementation proof

Evidence captured on **2026-10-05 UTC** for [[021-turn-liveness-and-limits]]. This note separates
provider measurements from offline implementation tests. Final host/SRT acceptance, supported caller checks, targeted failure cases and the offline suite
pass. Cursor-dependent full live matrices remain blocked by authentication; human review is open.

## What the pane probes establish

Five disposable host-pane probes used Claude Code **2.1.289**, model `claude-sonnet-5-5`.
The source-survey Herdr baseline is **0.9.1**; the native transcripts independently record the
Claude version. These probes use the existing Herdr transport, not an SDK replacement.

| Probe | UTC start–end, 2026-10-05 | Observed result | Final reported USD |
| --- | --- | --- | --- |
| Sequential prompts | 03:43:21.350–03:43:34.008 | Two successor prompts answered in one pane; cleanup occurred before the background wait completed. | 0.0872988 |
| Native wake-up race | 03:45:22.383–03:45:51.154 | Native task notification and first check-in were handled in the same continuation; the second check-in also answered. | 0.1054440 |
| Forced dispatch race | 03:47:07.556–03:47:43.354 | Check-in queued while Claude was working, then was absorbed after a foreground tool finished. | 0.1313112 |
| Intended 40-second foreground wait | 03:52:30.600–03:52:59.870 | **Inconclusive for a long queue:** Claude rejected standalone `sleep 40` immediately. Two short check-ins still answered. | 0.1153796 |
| Multiline prompt | 04:01:48.335–04:02:02.015 | Delivery marker survived the multiline paste route and was followed by linked assistant output for the initial prompt and both check-ins. | 0.0689586 |

The sum of each session's final `cost-state.totalCostUSD` is **$0.5083922**. These are reported
session costs, not an assertion about money charged to the account. Cumulative snapshots within
a session were not summed. They exclude other story experiments and any later acceptance runs.

### The delivery distinction that matters

The forced dispatch race has the clearest ordered trace:

1. The check-in dispatch command began at approximately **03:47:20.570Z**, derived from the
   command's completion time minus its logged duration.
2. Claude recorded matching queue acceptance at **03:47:20.877Z**.
3. The existing foreground tool completed at **03:47:28.493Z**.
4. Queue removal with reason `absorbed_mid_turn` appeared at **03:47:28.498Z**. Its command and
   delivery IDs match the following `queued_command` attachment.
5. The first assistant output linked through that attachment appeared at **03:47:29.778Z**.
6. The combined response ended at **03:47:35.190Z**; Herdr returned at **03:47:35.378Z**.

The attachment retains the **earlier enqueue timestamp**, although it is inserted after the tool
result. A reader must use append order and parent ancestry, not timestamp sorting. A queue entry
proves that Claude accepted input; an assistant descendant of the inserted input proves model
receipt. Herdr command completion is a later event and cannot start the response window.

This supports three internal delivery facts: `dispatched`, `accepted` and `received`. Unknown
acceptance gets a 30-second transport grace. After native acceptance, receipt can wait under the
fixed operation deadline. A new waiting declaration or accepted result satisfies the check-in
without waiting for a separate receipt callback. If an answer wins while a dispatched check-in
is still queued, native release still waits for that check-in's receipt and subsequent completion.

The intended long-wait experiment does **not** establish a receipt delay beyond 30 seconds:
queue acceptance was **03:52:43.927Z** and absorption **03:52:45.492Z**. The tool error explicitly
blocked standalone `sleep 40`. The longer-queue timing rule currently has deterministic test
coverage; a successful live long-foreground case remains unmeasured.

## Selected architecture and compatibility

Task 1's focused plan was to prove the existing prompt path before adding a provider-neutral
receipt interface, then settle admission and compatibility before enabling repeated recovery.
The measurements and code review selected the following boundaries:

- The harness owns marker placement, transcript reading, ancestry and native release. The engine
  sees the three delivery facts and owns one conversation, deadline and result slot.
- `wf waiting` is a cooperative declaration. It neither discovers tasks nor verifies their purpose.
  Sequential native handles retain the existing result authority; each handle permits one successor.
- Wire **v3** uses explicit `result` and `waiting` discriminants. The result CLI signature remains
  unchanged. Installed engine and client must match; old wire requests fail explicitly.
- Waiting declarations follow engine admission order. No transport retry silently renews a grant.
- Admission is synchronous after validation and uses the same timestamp for eligibility and
  `admittedAt`. Persistence completion has its own timestamp and bound. A late successful write
  can remain evidence without changing an already terminal operation.
- Optional `calls/{operationId}/liveness.jsonl` records have independent version **1**.
  `TurnRecord` and `output.json` versions stay unchanged. Missing or truncated diagnostics are
  informational; existing readers need not understand this file to run a workflow.

Initial policy uses a 30-second quiet interval/minimum wait, a two-minute default wait and response
window, and a 30-second unknown-acceptance/release grace. These are conservative internal values,
not measured optimal defaults or new author options. Call/result persistence is bounded to five
seconds and candidate auditing to one second. Diagnostic flushing is bounded to one second.

## Current support boundary

| Combination | Delivery and waiting status | Release guarantee |
| --- | --- | --- |
| Host Claude pane, 2.1.289 | Complete workflow measured with two check-ins, answer and same-session follow-up. | Latest dispatched input must be consumed, then fresh native completion must be observed. |
| Fake/scripted host | Deterministic and workflow integration checks passed. | Scripted release through the same engine policy. |
| Claude pane inside SRT | Installed launcher and control forwarding measured with two check-ins and same-session follow-up. | Same native-release boundary; no new process-tree containment claim. |
| Other provider/placement combinations | Existing foreground behavior; cooperative waiting is refused where receipt support is absent. | Existing ownership restrictions apply; no inferred background-task coverage. |
| Caller session | New receipt loop remains unsupported unless separately proved. | Existing caller authority remains: no pane kill, unrelated-task kill or stop-finishing interrupt after an accepted answer. |

Native release does not prove that detached children, development servers or remote deployments
have stopped. The agent must finish answer-related work before submitting its result; stronger
process-tree guarantees remain with [[headless-orphans]] and measured containment.

## Review findings and dispositions

Independent reviews covered architecture, correctness and readability. Accepted findings included:

- Queue acceptance and model receipt are different: split their timers instead of failing a
  legitimate queued prompt after a fixed receipt grace.
- Release must cover the latest queued check-in, even when an earlier answer arrives first.
- Cancellation must close admission synchronously; deferred starts must recheck cancellation.
- Answer admission must start release handling before persistence can cross the original deadline.
- Late acquired native handles need cleanup even when the main teardown has already started.
- One admission timestamp must drive both the deadline check and its record.
- A timed-out call-record write must retain its operation-ID reservation against a late write.
- Receipt ancestry and cumulative file tracking need bounds. A review found that rotating empty
  transcript filenames could grow the cursor map despite the per-listing file limit. The
  cumulative cap is now implemented and regression-tested. Canonical working-directory lookup
  and the multiline wrapper marker were also corrected; the architecture agent reported 70
  focused tests passing after those fixes.

Earlier task-registry-based claims and proof requirements are superseded. No review establishes
universal background supervision or an exact financial ceiling.

## Verification recorded so far

These are focused results during implementation, not story completion:

- `bun test packages/contract/src/wire.test.ts packages/wf/src` — **34 passed, 144 assertions**.
  An initial sandbox run could not bind test Unix sockets; the outside-sandbox run passed.
- `bun test packages/engine/src/result-slots.test.ts packages/engine/src/control-plane.test.ts` —
  **30 passed, 103 assertions**, reported by the slot implementation agent and reviewed against
  the tests and diff.
- `bun test packages/engine/src/operation-events.test.ts` — **8 passed, 29 assertions**.
- `bun test packages/harness/src/adapters/claude-receipt.test.ts packages/harness/src/session-core.test.ts packages/harness/src/adapters/herdr.test.ts packages/harness/src/adapters/herdr-caller.test.ts packages/harness/src/adapters/direct-process.test.ts`
  — **149 passed, 443 assertions** in the independent harness review.
- `bunx tsc --noEmit` and `bun run scripts/check-boundaries.ts` — passed at this checkpoint.

The first full host workflow attempt exposed wrapper-marker and working-directory lookup
failures; both were corrected. These focused results are historical checkpoints. The final
post-correction verification results appear below; failures were retained rather than counted
as passes after a retry.

## Complete workflow measurements

Both runs used Claude Code 2.1.289 / `claude-sonnet-5-5` and returned
`{first: "done", next: "follow-up"}`. Per-operation diagnostics show waiting declarations,
check-ins 1 and 2, their dispatch/acceptance/receipt, answer admission, release and terminal
completion. The follow-up used the same native session. This proves the installed command path
and sequential reuse for these combinations; it does not prove arbitrary background cleanup.

| Placement | UTC start–end, 2026-10-05 | Run ID | List-price estimate |
| --- | --- | --- | --- |
| Host | 04:15:26.526–04:16:50.953 | `20261005-0015-236a` | $0.1358688 |
| SRT | 04:17:13.747–04:18:31.322 | `20261005-0017-7383` | $0.1101196 |

Combined list-price estimate: **$0.2459884**, subscription billing. These estimates are separate
from the native session cost-state totals above; they are not actual charges.

Logs: `/private/tmp/awf-021-live-host-v2.log` and
`/private/tmp/awf-021-srt-waiting-final.log`. Run artifacts are under
`/var/folders/4g/s95glx9x6n71bq4hc08ly2gm0000gn/T/awf-liveness-{root}/runs/turn-liveness-proof/{runId}`,
with root `irvvXM` for host and `hZoJGy` for SRT. Native session IDs are
`146255be-f75b-4a16-8875-3171d6bbf2cb` and `374b3791-d3fe-4e04-bcae-b80d5076fc5e` respectively.

## Broader verification checkpoint

**Story implementation checks pass; the global live matrix remains incomplete.** Cursor
authentication blocks its dependent cases. The table preserves earlier failures and their
verified resolutions, distinguishing available-provider passes from full-matrix passes.

| Evaluation | Observed status | Evidence log under `/private/tmp/` |
| --- | --- | --- |
| Waiting on host and SRT | Passed: two check-ins, answer and same-session follow-up. | `awf-021-live-host-v2.log`, `awf-021-srt-waiting-final.log` |
| Hard timeout | Passed: operation returned `timed-out`. | `awf-021-timeout-live.log` |
| Cancellation | Passed: cancelled after dispatch, no successful workflow result. | `awf-021-cancel-live.log` |
| Lost result route | Passed: route removed after waiting; operation ended `unanswered`. | `awf-021-lost-route-live.log` |
| Silence | Initial run failed the intended scenario: the agent answered. Corrected fixture retry passed with `unanswered`. | `awf-021-silent-live.log`, `awf-021-silent-retry-live.log` |
| Failed-run accounting | Passed crash and cancellation checks. | `awf-021-failed-run-live.log` |
| Harness matrix | Failed Cursor and Cursor-pane answers; Cursor usage unknown. | `awf-021-harnesses-live.log` |
| Decisions, review judge, Docker sandbox, Docker panes, SRT sandbox | Passed. | `awf-021-live-remaining.log` |
| Effort | Initial matrix failed at the Claude deadline. Isolated Claude host run using normal login passed; token-injection interference is a hypothesis, not established by the retry. | `awf-021-live-remaining.log`, `awf-021-effort-claude-host.log` |
| Calling session | Initial full matrix failed. Corrected supported Claude/pi/Codex subset passed in 74 seconds; Cursor remains blocked. | `awf-021-live-remaining.log`, `awf-021-calling-session-supported.log` |
| Compaction, fork, skills | Blocked by Cursor authentication, including a retry with the existing key. These runs cancelled other agents and do not prove those providers failed. | `awf-021-live-cursor-retry.log` |
| Run sandbox, SRT and Docker | Initial validators failed; corrected SRT and Docker reruns both passed. See below. | `awf-021-live-remaining.log`, `awf-021-run-sandbox-fixed.log` |
| Repository checks | `bun run check` passed. Final atomic-prompt suite: **1,387 passed, 2 skipped, 0 failed**, 4,807 assertions across 104 files in 147.16 seconds. Check covered 391 files, typecheck and boundaries. | `awf-021-final-atomic-check.log`, `awf-021-final-atomic-offline.log` |

Compaction subsequently passed across the six available non-Cursor runtimes
(`awf-021-compaction-available.log`, **$0.6171964**). Fork passed its twelve available cases
(`awf-021-fork-available.log`, **$1.26412966**). Isolated Claude host effort passed
(`awf-021-effort-claude-host.log`, **$0.2841476**). These subset passes do not satisfy the
Cursor-dependent full matrices.

Supported caller rerun reported **$0.06681172**; SRT panes passed at **$0.1246374**
(`awf-021-sandbox-panes-srt-live.log`).

The broad 12-evaluation batch reported **5/12 passed**, about **$1.11** in known list-price
estimates and **one unknown cost**. This is not a final total for the story. Dedicated lost-route
proof reported **$0.0620544**; the harness matrix **$0.16062576**; failed-run accounting
**$0.00206408**. Cursor retries reported zero known estimate with incomplete usage, so they do
not establish zero spend. No overall dollar total is claimed while usage remains incomplete.

The sandbox validator looked for transcripts below the run artifacts, while sandbox records
point to separate `~/.awf/sandboxes` directories. Reading those recorded locations recovered
10 native command executions per run without changing the transcript parser. Replaying the
SRT evidence satisfied all lab checks. Docker additionally exposed a fixture mistake: listing
the host-home path succeeded with empty output because Docker creates ancestors for its nested
mounts. The probe now requires the existing host `~/.codex` directory to be refused; that path
is separate from sandbox-native homes. Refusal assertions remain unchanged. The corrected
lookup has a sanitized native-transcript regression; **22 tests, 23 assertions** passed.
Corrected live reruns passed **2/2**: SRT in 43 seconds (about $0.08), Docker in 69 seconds
(about $0.09), about **$0.17** combined known list-price estimate.

Final focused progress verification passed **12 tests, 30 assertions**. It checks phase changes,
renewed grants and reasons, suppresses repeated countdown logging and sanitizes terminal control
characters. The client socket test's intentional timeout left its test peer writing into a
closed socket; the peer now handles that expected error. Its exact timeout assertion remains
unchanged, with **7 tests, 15 assertions** passing. Typecheck passed after these corrections.
The story's Mermaid diagram parsed successfully with the installed Mermaid parser.

## Final prompt-path correction

A later minimum-review run exposed lost prompt prefixes on the two-step raw paste path. A
separate long-prompt probe then sent full initial and successor prompts through Herdr's native
`agent prompt` submission. Both roughly 4 KiB prompts produced the exact requested sentinel
files through Bash and recorded receipt; release completed. Evidence:
`/private/tmp/awf-021-atomic-action-probe.log`, root `/private/tmp/awf-021-atomic-VnYUFt`.
This supports replacing the raw paste plus wrapper with one complete native prompt submission.
Final minimum-review passed in **21 seconds**, about **$0.10** list-price estimate, with the
complete workflow prompt (`awf-021-minimum-review-atomic-live.log`, artifact root
`/var/folders/4g/s95glx9x6n71bq4hc08ly2gm0000gn/T/awf-minimum-review-Tg4hi8`).
Post-correction host acceptance passed (`awf-021-atomic-host-waiting.log`, run
`20261005-0043-1521`, **$0.1267952** list-price estimate, **04:43:26.943–04:44:49.699 UTC**).
The strict evaluator confirmed two check-ins and native release before same-session follow-up.
Post-correction SRT acceptance also passed (`awf-021-atomic-srt-waiting.log`, run
`20261005-0044-2ee5`, **$0.1021136**, **04:44:50.990–04:46:11.945 UTC**).
The final host/SRT pair therefore reports **$0.2289088** known list-price estimate.
The atomic Claude caller check passed in **35 seconds**, **$0.0516286** list-price estimate
(`awf-021-atomic-caller-claude.log`, artifact root
`/var/folders/4g/s95glx9x6n71bq4hc08ly2gm0000gn/T/awf-calling-session-IY9V52`).
The final offline suite and check also passed, as recorded in the verification table.

Independent source review checked installed Herdr **0.9.1**, exact commit
`065ef9d6a531c49fb8bee7e818ef837065b21ee9`:

- [Native text encoding](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/app/api_helpers.rs#L25)
  applies the pane's active bracketed-paste mode.
- [Full prompt submission](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/app/api/agents.rs#L194)
  sends the encoded text through the native submission queue; the deferred handler waits for
  completion before reporting success.
- [PTY submission completion](https://github.com/herdrdev/herdr/blob/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/pty/actor/unix.rs#L860)
  starts its Enter delay after all text bytes drain, then acknowledges Enter completion. Partial
  writes keep an offset; submission data uses the same FIFO queue.

The native path already owns the paste/Enter barrier. Adding awf sleeps or a new transport
capability would duplicate that responsibility. FIFO source evidence rules out the proposed
queue-reordering explanation; raw input handling remains the likely explanation for lost text.
The live sentinel probe establishes behavior without depending on that unproven diagnosis.

Canonical working-directory resolution also now feeds Claude usage lookup. Its focused tests
passed **61 tests, 153 assertions**. Replaying an older silent run found two native requests
without new model calls; the already-published record retains its original unknown usage.
This correction improves future accounting without rewriting historical evidence.

## Local evidence locations

Probe command logs are under `/private/tmp/`:

- `awf-021-pane-probe.log`; root `awf-021-pane-DHgLUK`.
- `awf-021-pane-race.log`; root `awf-021-pane-mESLT8`.
- `awf-021-pane-dispatch-race.log`; root `awf-021-pane-FzznSh`.
- `awf-021-pane-long-queue.log`; root `awf-021-pane-81Dll4`.
- `awf-021-pane-multiline.log`; root `awf-021-pane-8EzhFe`.

Native transcripts are under `/Users/roman/.claude/projects/`, in the corresponding
`-private-tmp-{root}-work` directory:

| Probe | Session file |
| --- | --- |
| Sequential | `94927786-c536-4d51-a8ad-f3bc1ff3a123.jsonl` |
| Native wake-up | `de3c24cd-e819-41bc-bec7-b4de1bd550e9.jsonl` |
| Forced dispatch | `51ca7fda-7ed1-439e-a8a7-fdf44a0d0f98.jsonl` |
| Intended long wait | `65d0ed1b-83f6-41e9-9036-45f6593d4a26.jsonl` |
| Multiline | `b796e0d5-9723-4354-82bd-cffae57f5294.jsonl` |

Raw logs and provider-injected context remain local. These temporary paths are inspection
artifacts, not durable repository fixtures or prerequisites for the offline test suite.
