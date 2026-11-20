---
title: A harness prompt that denies itself is not a block
type: story
status: todo
priority: P1
epic: long-runs
discovered_in: "workday-web's replay (R-0010) and its lab baseline (attachments, both columns)"
depends_on: []
---

# A harness prompt that denies itself is not a block

A pane showing a prompt that the harness will answer "no" on its own, for an unattended session,
ends its turn as something other than `blocked`, so the agent gets the denial and carries on.

Why it matters: Claude Code asks "can't be sure it read this command the way the shell will … Do
you want to proceed?" on a shell command it can't parse (a heredoc writing a file, then a test run;
a zsh one-liner with `${=a}`), and permission settings don't skip it. It says "Claude Code will
automatically block this request in 1:54, to avoid holding up an unattended session". awf's Herdr
adapter confirms the dialog after a moment and ends the turn `blocked`, which a workflow reads as
"only a person can answer": web-to-cli's build then blocks the request. Had the prompt denied
itself, the agent would have rewritten the command. Three of workday-web's builds stopped this way
(replay R-0010, and the lab's attachments case in both columns of one round), more than any other
cause once case faults were out.

Notes:
- Where: `dialogWait` and `confirmedDialog` in `packages/harness/src/adapters/herdr.ts`, which see
  Herdr's `blocked` state; `blockedBy` in `herdr-protocol.ts`.
- Choices to design, not yet settled:
  - answer it "no" at once (Esc, or the "No" item) versus wait for its countdown to run out and keep
    watching the turn: the first saves two minutes and writes to the pane, the second only reads;
  - how a harness names such a prompt: matching the pane's text ties awf to Claude Code's wording,
    so it belongs in the harness's definition beside its other screens, with a fallback to
    `blocked` when the wording isn't found, and a test on the saved screens;
  - whether other harnesses have the same kind of prompt, and whether a self-denial is recorded as
    an event so a workflow (and a lab report) can count them.
- Related: [[non-answered-evidence]] keeps the screen that showed it was this prompt;
  [[agent-permission-mode]] is the other way a prompt reaches an unattended claude.
- Evidence: workday-web `.state/runs/op-build/R-0010/ops/builder.1/screen.txt`; lab runs
  `case-env-builds/20261120T195859Z-bd7a4cb7/ops/builder.4/screen.txt` and
  `case-env-builds/20261120T202717Z-2ba2ead8/ops/builder.3/screen.txt` under
  `~/.awf/lab/workday-web-…/awf-runs`.
- Stopgap on the workflow's side: web-to-cli tells agents to write files with their file tools and
  put long commands in a script, which lowers the odds without removing them.
