---
title: Expose operator run progress
type: story
status: todo
priority: P2
discovered_in: "001 Task 8 audit"
depends_on: []
---

# Expose operator run progress

Let an operator observe an active workflow without coupling the CLI to Herdr internals.

Why it matters: `startWorkflow` exposes an inspectable and stoppable run handle. `awf run` shows
its progress live on standard error (`progress-view.ts`), redrawn in place on a terminal and a line
per change otherwise, but as text for a person, not structured state, and there is no separately
addressable status command. Scripts and other host adapters cannot observe the same lifecycle
through the operator interface.

Known context: the engine-owned `WorkflowRunSnapshot` is intentionally independent of Herdr. The
operator command already owns signals, the workflow deadline, structured final output, and retained
artifact reporting. Story 001 does not need a daemon, event stream, or remote control plane to prove
one local run.

Refinement must compare a small same-process progress stream with a separately addressable status
command. Keep the module deep: callers should consume stable run state while the implementation
owns polling, throttling, terminal transitions, redaction, interrupted output, and adapter-specific
details. Do not expose Herdr workspace, tab, pane, session, operation, or capability identifiers as
portable workflow state.

Open questions:

- Is structured progress on standard error sufficient for the first operator interface, or is
  querying a running command a demonstrated requirement?
- Which snapshot fields are durable operator semantics, and which remain best-effort diagnostics?
- How should progress output coexist with machine-readable final JSON and shell interruption?
