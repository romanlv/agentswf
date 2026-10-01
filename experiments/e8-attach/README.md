# E8 — driving the session you are in

Run 2026-09-30 to 2026-10-01 for [story 014](../../docs/stories/014-workflow-in-current-session.md):
can a workflow take over an interactive agent session it did not start, from the moment the
operator asks, and drive it turn by turn?

## Setup

- `attach.sh` stands in for the in-session command. It runs in the agent's shell, so it only files
  a request in `spool/` and asks the agent to end its turn by replying with a one-time code.
- `host.ts` runs outside any agent sandbox. It finds the one pane whose screen shows the code,
  waits for the attaching turn to settle, then pushes four steps with `herdr agent prompt`:
  pick a number, double it, run `sleep 25`, and, pushed while that step is still working, recall
  the number. Each answer comes back through a stand-in `wf result` named by absolute path.
- `run-all.sh` starts claude, pi and cursor in Herdr tabs and attaches each. Codex was attached
  the same way by hand.
- `probe/` checks which local sockets a sandboxed session can reach.

Herdr 0.9.1, claude 2.1.286, codex-cli 0.159.3, pi 0.87.1, cursor-agent 2026.08.11.

## Results

Every harness answered all four steps correctly (`results/answers-*.txt`):

| Harness, model | s1 | s2 = 2 × s1 | s3 | s4, pushed while s3 ran |
| --- | --- | --- | --- | --- |
| codex, gpt-6-luna | 4827, ~4s | 9654 | slept | 4827, queued, 3s after s3 |
| claude, sonnet-5.5 | 6284, 3s | 12568 | slept | 6284, same second as s3 |
| pi, gpt-5.6-terra | 6284, 4s | 12568 | slept | 6284, queued, 2s after s3 |
| cursor, composer-2.5 | 7150, 10s | 14300 | slept | 7150, queued, 3s after s3 |

- **Delivery.** A prompt pushed while a turn is working is queued, not lost, in all four. Claude
  takes it into the running turn instead of starting a new one: its transcript dequeues s4 a
  second after it arrived and attaches it as a `queued_command` to s3's turn.
- **Cache.** Context stays warm across driven steps. Claude's `cache_read` grows 25k → 45k with
  100–550 tokens written per request; codex caches 95–97% of input on every request.
- **Finding the pane.** `$HERDR_PANE_ID` is wrong under codex: every codex TUI runs its tools in
  one shared `codex app-server --managed-daemon`, so a tool sees the environment of whichever
  pane started the daemon. Herdr's codex integration reports from the same daemon, so
  `agent_session` moved this session's thread id onto that other pane. `CODEX_THREAD_ID` itself
  is right. A code printed by the command is found on the right pane except under claude, which
  folds tool output to "Ran 1 shell command"; a code the agent repeats in its reply is found in
  all four. The scan took ~20s polling every agent pane once a second.
- **Sandbox.** The first codex run drove nothing: the driver, started from the agent's shell,
  inherited codex's `workspace-write` sandbox and every `herdr` call failed with
  `PermissionDenied`. Under that sandbox `probe/client.ts` is refused on a Unix socket inside the
  workspace, one outside it, and TCP on localhost. With
  `-c sandbox_workspace_write.network_access=true` all three connect. Unsandboxed, as the engine
  starts codex today, all three connect.
- **Interrupt.** Esc during a step leaves codex `done` within ~2s with no answer, which a driver
  cannot tell from an agent that forgot to answer; the screen says "Conversation interrupted",
  and the interrupted `sleep` kept running as a background terminal.
- **Startup dialogs.** A fresh claude sat on a first-run dialog past a 90s `agent start`, and
  codex asked to trust each new folder; both are the operator's to clear, once.

Not measured: a step longer than a few minutes, an operator typing into the pane mid-step, pi and
cursor under their own sandboxes, and the spend read for a session that existed before the run.

## Follow-up for the implementation, 2026-10-01

Measured while building [story 014](../../docs/stories/014-workflow-in-current-session.md), on
the same versions with claude 2.1.287:

- **Interrupt markers.** Esc during a turn leaves on screen: claude `Interrupted · What should
  Claude do instead?`, codex `Conversation interrupted`, pi `Operation aborted`. Cursor stopped at
  its command approval, which Herdr reports as `blocked`, and showed no marker of its own; it is
  treated as one whose interrupt cannot be read.
- **The prompt stays on screen.** A long multi-line prompt pushed with `herdr agent prompt` showed
  its call id in `agent read --source recent-unwrapped` afterwards in all four, so a marker can be
  placed after the turn's own prompt.
- **Codex's session variables.** A codex tool shell has both `CODEX_SESSION_ID` and
  `CODEX_THREAD_ID`, so the launcher's existing `CODEX_SESSION_ID` names the calling session.
- **Claude refuses a standalone `sleep`.** Its Bash tool blocks one, so a long step to interrupt
  has to be work, such as a long essay, not a wait.

