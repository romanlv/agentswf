# Agent Workflow Engine

The engine runs workflows whose work is performed by retained coding-agent sessions. These terms
separate what a workflow asks for from how an operator's machine provides it.

## Language

**Workflow**:
Ordinary TypeScript that opens logical agents, gives them work, and composes their outcomes.

**Logical agent**:
A workflow-owned identity that may survive multiple turns, session replacement, or recovery.
_Avoid_: Pane, process, session

**Harness**:
The coding-agent runtime being driven, such as Claude Code, Codex, Pi, or Cursor.
_Avoid_: Backend, provider

**Backend kind**:
The execution behavior a workflow may require: a retained interactive pane or a direct headless
process. It does not identify the tool used to provide that behavior.
_Avoid_: Herdr backend, tmux backend

**Session adapter**:
An operator-supplied implementation that hosts and drives harness sessions for one backend kind.
Herdr, tmux, and direct-process implementations belong behind this seam.
_Avoid_: Harness, runtime
