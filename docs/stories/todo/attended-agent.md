---
title: An agent the operator watches and talks to during a run
type: story
status: todo
priority: P2
epic: observability
discovered_in: "agent/workflows/review, first live run (2026-10-06)"
depends_on: []
---

# An agent the operator watches and talks to during a run

The review workflow's fixer should sit in a pane beside the operator's main session, below the
`awf run` progress view, and the operator should be able to watch it and type into it while the run
goes on. The other agents (about eight reviewers) stay out of sight as today.

```text
| main session | awf run progress   |
|              | fixer (attended)   |
```

Placing it is built: story 026's `layout` puts a TUI agent in the workspace `awf run` was typed
in (`workspace: "origin"`), beside another pane, and `keepPane` keeps it after the run. What is
missing is the agent being the operator's to talk to while the run drives it.

## What is missing

1. **Attended lifecycle.** The real work, and it needs an ADR amending ADR 0008 and story 021 §5.
   [[stopped-run-recovery]]'s debug mode, a failed turn's agent kept open for a person, is the
   same lifecycle; design them together.
   Today an opened agent is treated as the run's alone:
   - any outcome but answered closes its pane, never reopened (`session-core.ts` cancel,
     `closeAfterFailure` in `workflow-runner.ts`);
   - an Esc or an unanswered end is nudged after 30 s, pasted into whatever the operator is saying;
   - the operator keeping it busy past `releaseMs` (30 s) after it answered fails the run
     `cleanup-unresolved`;
   - the pane closes at run end, and the conversation with it (`claude --resume` recovers it by hand).

   The calling session (`--here`, ADR 0010) already has the rules an attended agent needs: an
   interrupt settles `cancelled`, nudges are off where an interrupt can't be told apart, no
   stop-finishing Esc, and its pane is never closed. Generalise them. (L)
2. **Progress.** One line saying where the shown agent is (`describeRunSession`). (S)
3. **Accepted risks, recorded.** The shown agent's notifications and sound play in the operator's
   session, which is wanted here. An unsandboxed agent there can drive the operator's panes through
   `$HERDR_SOCKET_PATH`, the exposure story 024 removed. (S)

Operator typing into a driven pane mid-turn is unmeasured (ADR 0008, ADR 0010); measure it first.

## Later

The fixer as a fork of the operator's own session (`agents.forkCaller`, story 027), with a summary
folded back into the main thread when the run ends. Close to `docs/design/ideas.md`'s fork by
summary.
