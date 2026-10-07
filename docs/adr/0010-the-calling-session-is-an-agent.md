# 0010 — The calling session is an agent of the run it started

**Decided:** 2026-10-01, in [[014-workflow-in-current-session|story 014]]. **Replaces:** [`composition.md`](../design/composition.md)'s rule that a session the
engine did not start is a messaging participant only, which never answers `result` and which the
engine has no operation to run; for one session, the one the run was started from.

**Amended:** 2026-10-05, [[021-turn-liveness-and-limits|story 021]]: a saved answer waits for
bounded natural release before success; caller interrupt authority is unchanged.
2026-10-06, [[027-caller-fork|story 027]]: `forkCaller` forks the session a run was started from,
handed over or waiting on it, which replaces "a run does not fork it".

## What was decided

- **Only the calling session.** A run started with `awf run --here` from an agent session in a
  Herdr pane may drive that one session as an agent. That is the session the command was typed
  into, at that moment. Any other session the engine did not start stays an outside participant
  as `composition.md` describes it. One run drives a calling session at a time.
- **A workflow gets it with `agents.caller({ key })`, at the root scope only.**
  - It returns an `AgentRef` under the key the workflow names. It returns `null` when the run has
    no calling session, so a workflow can refuse, or open an agent of its own instead.
  - A second call with the same key returns the same ref. A call with another key rejects.
  - The key is in the run's agent namespace. `agents.open` with it rejects. `agents.attach` with it
    returns the caller's ref, and a runtime constraint on it rejects.
  - In a child workflow's scope (`workflow.call`, not built), `caller` rejects. Relaxing that
    later is cheap; a child that quietly got `null` and changed behaviour when it later got the ref
    would not be.
- **Its ref has the `AgentRef` type, but five behaviours differ from an opened agent's.** They are
  listed on `caller` in `agents.ts`:
  - `compact` settles `failed`, not retryable, because the context belongs to the operator.
  - A turn that fails, is cancelled or times out leaves the agent usable when native release is
    confirmed. Unresolved cleanup ends automated use in this run. The pane is never closed.
  - An operator's interrupt settles a turn `cancelled`.
  - Where that interrupt cannot be recognised, an unanswered turn is not nudged by default.
  - `execution.model` is `""`.
- **Its execution is what the run found, and the record says so.**
  - The execution has the harness Herdr detected in the pane, the default placement `pane`,
    `model: ""` and `caller: true`. `caller` is a new optional field on `AgentExecution`, so the
    usage records can tell the operator's session from agents the run opened.
  - The operator chose the model, and awf cannot read it before the first turn. Spend records
    already carry the model from the harness's own files.
  - pi's billing, which falls back to `execution.model` for the provider, takes the provider from
    the session's file instead, and is `unknown` when that names none.
  - The native session for accounting comes from the session's own environment, which the `wf`
    launcher reports with every answer (`CODEX_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`,
    `PI_SESSION_ID`), and from Herdr's `agent_session` except under codex, where E8 found it
    names another pane's thread.
  - Its spend is what its files log from the run's first prompt to it until the run's own work
    ends, just before the hand-back. The turn that replied with the code is the operator's, and
    so is anything the operator types between steps, which this window still counts.
- **The engine drives it but never owns it.**
  - Every turn goes through the run host like any other agent's. It is delivered with Herdr's
    prompt once the session has settled (ADR 0008) and answered through `wf result` over the
    agent's own socket. It is validated against the turn's schema and bounded by its deadline.
  - A separate Herdr backend serves it. That backend has no close: it never starts, closes,
    compacts or kills the pane, and the run's final cleanup leaves the pane alone.
  - A saved answer is acknowledged, then the engine waits for bounded natural completion before
    returning success. The caller never gets the host's "stop finishing" Esc, because once the
    run's turn is answered, the work in the pane may be the operator's. If natural release cannot
    be proved, preserve the answer, fail the operation and hand back control. Ending the host's
    observer is not native release.
  - Repeated `wf waiting` recovery requires separately measured receipt support. Host-pane
    evidence does not automatically enable it for the caller; unsupported requests are refused.
  - `TurnRef.cancel`, a turn's deadline, and the run stopping each send the harness's interrupt
    once, but only while the agent is working on that turn. The turn then settles `cancelled` or
    `timed-out`, and the next operation waits for the session to settle as usual.
- **An operator's interrupt settles the turn `cancelled`, where it can be recognised.**
  - If the operator stops a driven turn in the pane and the harness's interrupt marker appears
    after that turn's prompt, the turn settles `cancelled` with the reason "interrupted by the
    operator". A marker from an earlier turn, or from the host's own interrupt, does not count.
  - A cancelled turn is never nudged; the workflow decides what follows.
  - A turn that ends with no answer and no such marker is `unanswered`, as for any agent.
  - claude's, codex's and pi's markers are recognised; cursor's is not (E8's follow-up). Where the
    marker cannot be recognised, an interrupt reads as `unanswered`, and that harness's caller
    turns are not nudged by default.
- **A run the engine survives hands the session back.**
  - Whether the run is answered, failed, timed out or stopped by a signal, the engine sends one
    message once the session settles. It says how the run ended and where the run directory is.
    The message is not an operation and has no record. A reply to it is the operator's turn, after
    the run's spend window.
  - If the session does not settle within a short grace, the message is sent anyway and queued;
    claude folds a queued prompt into the running turn (E8).
  - A run that is killed, crashes, or whose tab is closed sends nothing. The `--here` command's
    own output names the run's tab, which shows how the run ended.
  - `agents.stop` is not built. When it is, stop on the caller's key sends the hand-back then,
    nothing is sent at run end, and every later call on that key rejects.
- **A workflow can fork the session that started the run, and only by asking** (story 027).
  `agents.forkCaller(spec)` opens a new agent on a copy of it, as ADR 0009's fork does, or answers
  `null`. `caller()` is unchanged: the session as an agent of the run, which needs it handed over.
  - **Either start.** The session may be handed over with `--here`, or waiting on an `awf run` it
    started as a command. Only the first is ever driven. A workflow that never calls `forkCaller`
    behaves the same whichever way it was started.
  - **Found from the session's own variable.** Each harness sets it in its tool calls' shells
    (`CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID`, `PI_SESSION_ID`, `CURSOR_CONVERSATION_ID`).
    `--here` passes it to the run's tab; a run started as a command has it in its own environment.
    A session whose file was not written in the last few minutes is not taken: an inherited
    variable can name one long gone. Agents never get the operator's variables; an agent's own
    `awf run` finds that agent.
  - **No turn of the run's first.** The session holds what it knows already, so ADR 0009's refusal
    before an agent's first turn does not apply. Under `--here` the copy is taken once its pane has
    settled and, once the workflow holds `caller()`, in the caller's queue, so `caller().fork()` is
    the same copy. A waiting session is mid-turn, on the command that started
    the run; its copy holds the session up to that call.
  - **Its model and directory are read from the session's file**: its last request's model, as the
    usage reader finds it, and the directory it records. A resume without a model takes the
    harness's default, and the cache is per model. Where the file names none, as an operator's
    cursor chat's does not, `forkCaller` answers `null`, so a workflow can open an agent instead. The effort is the harness's default unless the fork names
    one: no harness logs it.
  - **It runs where awf opens agents**, with awf's launch flags and environment, not the operator's
    settings or MCP servers its context was built with; its skills are the operator's. Under
    `--here` the run is outside the session's sandbox; started as a command, it is the session's
    child, inside it.

  Spend follows ADR 0009: what the fork copied stays the session's, so a fork's requests are
  counted only from when it was made. Its own turns are the run's.
- **No first turn of instructions, and no declaration.**
  - The caller is not opened, so it has no `instructions`. What it needs goes in its turn prompts.
  - A workflow does not declare that it needs a calling session: `caller()` returning `null` is
    how it finds out. A declaration can come later as an optional field, if a workflow is shown to
    spend before it checks.
- **It is an operator command, run from the agent's shell.**
  - `awf run --here` starts a run, which is the operator's authority (ADR 0005). `wf` stays the
    agent's command for answering and messaging.
  - The operator invokes it with `!`, a skill or a slash command. Nothing proves the operator asked
    rather than the agent: an agent with a shell can already start `awf run` today, so `--here`
    adds only that the run drives the agent itself. This risk is accepted, not closed.
  - `--here` only asks Herdr to start `awf run --session {code}` in a new tab. The engine never
    runs inside the sandbox of the session it drives.
  - That needs the session's sandbox to reach Herdr. Under codex's default sandbox it cannot, and
    `--here` refuses with the fix (`sandbox_workspace_write.network_access`).
  - That a process Herdr starts runs outside the caller's sandbox is assumed, not measured. E8's
    driver was started by hand. Task 3 measures it.
- **Its workflow tests script it.** `testWorkflow` gains an option for a scripted caller, typed
  like any scripted agent, so a workflow that uses `caller` is testable on the second composition
  root (ADR 0006). The option lands with the type.

## Why

E8 drove a claude, codex, pi and cursor session through four dependent steps from outside, each
session started by someone else. A step pushed while the session was busy was queued in all four.
Context stayed warm, and claude's and codex's caches measurably did. What `composition.md` ruled
out was the engine taking any session it did not start. That rule protects the operator's sessions
from a workflow. Here the operator asks for it, in the session concerned, so the rule's reason
does not apply.

The pull alternative was an outside participant running a blocking `wf inbox --wait`. A blocking
command is limited by how long the harness lets a shell command run. The session also stops at
every end of turn unless a hook keeps it going.

Why a method and not a reserved key: the workflow names the key, so no key is taken from authors.
The session also cannot be confused with an agent the run opened.

Two other shapes were rejected:

- A new placement. A placement is the workflow's choice of how to start an agent, and nothing is
  started here; the `caller` marker records the fact instead.
- Making the caller a connected participant. That would make one outside participant runnable and
  leave the rest not, behind the same type.

Refusing `compact`, and never sending the host's stop-finishing Esc, limit what the run does to
the operator's session to what they can see happen: turns in their pane.

## What changes elsewhere

- `composition.md`: an outside participant is still never run. The calling session is not an
  outside participant.
- `foundation.md` §6: the run host's terminal group does not include the calling session's pane,
  and final cleanup leaves it alone.
- `AgentDirectory` gains `caller`, `AgentExecution` gains `caller?: true`, and `testWorkflow`
  gains a scripted caller. Each lands with its implementation (ADR 0001).

## Not decided

- What an operator typing into the pane mid-turn does to settlement, and whether the run's
  interrupt then reaches the operator's turn. Not measured; ADR 0008 has the same gap.
- Whether a child workflow can ever be given the caller; until then `caller` rejects there.
- Sessions outside Herdr, through a hook or extension instead of pane delivery.
- A caller fork's model when the session's files name it differently from how it was chosen, such
  as a context-size variant, and its effort, which no harness logs.
