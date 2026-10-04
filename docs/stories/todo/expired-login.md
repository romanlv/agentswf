---
title: Stop and tell the operator when a harness's login has expired
type: story
status: todo
priority: P1
discovered_in: "story 016, task 4's live run, 2026-10-03"
depends_on: []
---

# Stop and tell the operator when a harness's login has expired

An agent whose harness cannot sign in fails as an unanswered turn, is nudged, and the run goes on;
awf should recognise an expired login, stop, and say which harness to log in again.

Why it matters: an expired login is a common failure, and awf reports it as something else. On
2026-10-03 pi's OpenAI Codex refresh token had been invalidated. Every pi agent in `examples/fork`,
headless and in a pane, ended in 2–5 s as `unanswered: agent settled without an accepted result`.
The cause was only in pi's own output: a `turn_end` with `stopReason: "error"` and `errorMessage:
"OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401) … Your refresh token
has been invalidated."`. awf nudged each turn, which could not help, and went on with the rest of the
run. Finding the cause took running pi by hand. Nothing awf can do fixes a login: the operator has to
sign in again, so the run should stop and say so.

Notes:

- **Recognise it per harness, in the harness spec,** beside `interrupted`: pi's `errorMessage` in
  json mode and on its screen; claude's `result` with `is_error` and its "Please run /login"; codex's
  error event. A pane shows the same text on its screen. What each prints when its login has expired
  should be captured as fixtures, not guessed.
- **What it ends as:** a failed outcome with a reason that names the harness and what to run (`pi`,
  then `/login`; `claude /login`; `codex login`), not `unanswered`. No nudge.
- **The run stops**, since every other agent on that harness will fail the same way: a `parallel`
  should not spend its other items first. Whether this is a run-level stop or an outcome the
  workflow sees is a design question; an engine-raised stop is the simpler first step.
- **Tell the operator** in `awf run`'s output, plainly and once. For `awf run --here`, also in the
  calling session's hand-back.
- **Optionally check first:** `billing` already runs each harness's status command
  (`readCodexBilling`, `readClaudeBilling`), which can tell a missing login before any agent runs;
  pi has no such command. A refresh token that is invalid but present may only show at the first
  request, so the check before the run is not enough on its own.
- Related: [[billing-provenance]] reads login state for billing; the seeding error in
  `sandbox-homes.ts` already says "log the harness in first" when a credential file is missing.
