# Claude's own messaging: who sees and reaches whom

Tried 2026-10-12 on claude 2.1.296, for [story 029](../stories/029-agent-messaging.md)'s M1, by
hand: test claudes on haiku in Herdr panes and as `claude -p`, sending to each other and to the
operator's session with claude's `ListAgents` and `SendMessage`. Not kept as a script, so these
can be re-run but not re-derived from this repository. What awf does about it is in
[[messaging#Claude's own messaging]].

| # | Question | Result |
|---|---|---|
| CS1 | Is it on without any setting? | **Yes.** A new claude, in a pane or `claude -p`, was listed by others within seconds. |
| CS2 | Whom does a claude see? | **Every claude sharing its setup folder, in any folder, plus the account's cloud and Remote Control sessions.** The operator's session listed 57 to 60. |
| CS3 | Can any claude write to any other? | **Yes.** A `claude -p` reached a pane claude it never started; a message woke an idle pane claude, which answered it as a request. |
| CS4 | Does removing `CLAUDE_CODE_MESSAGING_SOCKET` and `_TOKEN` stop it? | **No.** A `claude -p` with both removed listed the same 42 peers and its message arrived. |
| CS5 | Does a setup folder of its own stop it? | **Yes.** With its own `CLAUDE_CONFIG_DIR`, a `claude -p` listed 0 peers and sending by name failed: "No agent named 'plain-a2' is reachable." |
| CS6 | What does `crossSessionInbound: "refuse"` do? | **Stops receiving only.** Set by `--settings`, the claude was still listed; a message to it never showed, the send succeeded, and a refusal notice reached the sender minutes later. |
| CS7 | Does a different permission mode hold a message? | **Not from auto to manual.** A message from an auto-mode session reached a manual-mode one and was answered. |
| CS8 | Can a subagent write? | **Yes, as its parent.** It has `SendMessage` and no `ListAgents`; its message arrived under the parent session's name. |
| CS9 | And a claude agent awf runs, by where? | **On the host it lists every claude, in a sandbox none.** Run through awf 2026-10-12, headless haiku asked to call `ListAgents`: on the host it listed 39; under srt, 0; under docker, "No reachable agents". |
