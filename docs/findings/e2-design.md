# E2 — return channel reliability: the harness

The code, not the numbers. No live matrix has been run: E1 is on the machine, and the harness
flags for codex, pi and cursor are what E1 is discovering.

## What is here

- `wf` (`cli.ts`, `bin/wf`) — the callback. `wf result '<json>'`, call identity from `WF_RUN`
  and `WF_CALL` in the pane environment. Validates against the schema recorded for that call,
  exits 1 and prints the error on a mismatch, never repairs a value.
- `schema.ts` — a small JSON Schema subset. The error text is the product here, so it is a
  hand-written subset rather than a library: every line names one path, what was expected, and
  what arrived, because a model has to act on it unaided.
- `result-layer.ts` — the one place a candidate becomes a result, whichever channel carried it.
  Parse, validate, semantic hook, record the attempt either way.
- `semantic.ts` — the hook. `SemanticCheck` takes the question recorded with the call and the
  value; `acceptAny` is the default. A small-model call goes in by passing a different function
  to the CLI or the collectors. Nothing else changes.
- `trial.ts` — one measured trial: prompt, settle, collect, nudge once, collect again, classify.
- `runner.ts` — matrix expansion, sequential execution, JSONL per trial, tally.
- `backends/fake.ts` — scriptable stand-in. Its reporting helpers drive the real `wf` and the
  real collectors, so a green test says the channel works rather than that the double works.
- `backends/pane.ts`, `backends/headless.ts` — structurally real, one file each.
- `harness.ts` — every harness-specific string in the project. `confirmed: false` marks a row
  E1 has not driven yet.

`bun test` runs 80 tests, no live agent. Two headless `claude -p` smoke calls were made against
the real thing (n=1, not a measurement): the callback round trip landed unprompted in 8.0s, and
a deliberately unreported turn was recovered by one nudge over `--resume`.

## What each return method costs to set up

**cli-callback.** The most machinery and the only one that can refuse. Needs `bin/wf` on the
agent's PATH, `WF_RUN`/`WF_CALL` in its environment, and shell permission — for claude headless
that is `--allowed-tools Bash`, without which the trial measures a permission prompt rather than
a return channel. In exchange the validation happens inside the agent's turn, so a bad value
costs the agent one retry instead of costing the engine a round trip.

**write-a-file.** Cheapest to set up: a writable path in the prompt and nothing else — no PATH,
no environment, no tool allowlist beyond writing. It buys nothing back. A wrong value is
discovered after the turn has ended, and the only correction is a nudge.

**delimited-line.** Free where stdout is captured, unusable where it is not. A pane runs on the
alternate screen, so the pane backend returns a null transcript and every delimited trial there
is lost by construction — that cell measures the terminal, not the agent. Also the only method
where the harness's own output format can eat the value: claude's `--output-format json` wraps
the transcript, so `harness.ts` unwraps it before the markers are looked for.

## Decisions the plan did not settle

**The seam had to be split to hold a nudge.** `AgentBackend.run(step, callId)` is one shot and
cannot express two turns against one live agent, which is exactly what the nudge is. Backends
implement `AgentSessionBackend` — `open()` returns a session with `prompt`, `transcript`, `close`
— and `runTrial` plus `toCallResult` rebuild the plan's `run(step, callId) => CallResult` on top.
The engine still never learns which backend ran.

**"Nothing came back" is two states, not one.** The plan has answered / finished. A turn that
called `wf` and was refused is a different animal from a turn that said nothing: the first proves
the agent knows the channel. Trials record `firstAttempt` as accepted / malformed / absent, and
the nudge for a malformed attempt carries the validation error.

**One nudge, then lost, even for a malformed attempt.** A rejection that survives its own turn is
counted like silence for delivery accounting. Whether an agent self-corrects inside the turn is
E5's question, not this one.

**A null transcript is absent, never a value.** Same fail-closed rule as `liveness.ts`: an
unreadable pane must not read as an agent that answered.

**A headless nudge needs a resume, and only claude has one we have confirmed.** For the others
the second turn returns `unknown` with a reason rather than pretending. Those cells will show
losses for a mechanical reason, and the tally must be read with that in mind — `harness.ts` is
where a confirmed resume gets filled in.

**The agent never sees the schema, only a one-line shape.** The schema lives in the run directory
keyed by call id; `describe()` renders `{ count: integer, even: boolean }` into the prompt. Two
reasons: the prompt cannot carry anything the agent could paraphrase back at us, and the error
text and the prompt text then come from one source.

**The semantic hook sits in the result layer, not in the CLI.** All three methods pass through
`acceptResult`, so a semantic check added later applies to files and printed lines too.

**Trials run sequentially.** One laptop, one Herdr server, and a concurrency effect on the return
rate would be indistinguishable from the thing being measured. E4 owns that question.

## Open questions

- Whether a pane nudge needs the Enter/Ctrl-C dance `review-loop` does, or whether
  `prompt --wait` alone lands it. E1.
- What settled states Herdr actually reports for non-claude panes. The pane backend maps
  idle/done/blocked and calls everything else `unknown`.
- Whether a delimited value can be recovered from a pane at all — `agent read --source detection`
  is implemented and expected to return nothing useful.
- Whether the nudge should be allowed twice when the first one produced a malformed value.
