---
title: Choose an agent's permission mode
type: story
status: todo
priority: P1
discovered_in: "eval timing, 2026-10-01; [[permissions]]"
depends_on: []
---

# Choose an agent's permission mode

awf fixes each harness's permission handling in code, so a host claude now runs in Claude Code's
auto mode, a classifier call on every shell command and `wf result` too, and no workflow or operator
can choose otherwise.

Why it matters: an agent's permission mode changes its time, what it may do unasked, and whether a
turn stalls on a prompt nobody answers, and awf neither chooses nor records it. Each harness's
handling is fixed in `packages/harness/src/spec.ts`: codex `--ask-for-approval never` with its own
sandbox off, cursor `--force`, claude `--allowed-tools Bash`, pi none. In a sandbox, claude's home
sets `bypassPermissions` ([[permissions#Bypass only inside a sandbox]]).

On the host, claude gets no mode, so it starts in whatever its version defaults to. Since Claude
Code 2.1.283 that is auto mode for an interactive session on a model that has it. Auto mode drops a
blanket allow rule such as `--allowed-tools Bash`, so every shell command, `wf result` included,
waits for its classifier. Every host claude in the 2026-10-01 evals (`harnesses`, `skills`,
`minimum-review`, `review-judge`) ran in `auto` on `claude-sonnet-5-5`, and the same sessions on
haiku, which has no auto mode, ran in `default`. So the switch to sonnet changed both the mode and
the latency, unrecorded. The classifier can also refuse a command the workflow needs, which reads
as an unanswered turn.

Notes:

- A choice per agent, beside `effort` ([[runtime-effort]]) in `ExecutionConfig`, is a published
  type change: decide its values (one awf vocabulary mapped per harness, or each harness's own),
  which a harness without the concept rejects, and whether the operator may override a workflow's.
- The mapping: claude `--permission-mode` (`default`, `acceptEdits`, `auto`, `dontAsk`,
  `bypassPermissions`); codex `--ask-for-approval` with `--sandbox`; cursor `--force` or not; pi
  none. A mode that asks a person must be refused or stall visibly, since nobody is at the pane.
- Outside a sandbox, bypass is what [[permissions]] rules out; the designed harness-level grant
  (`Grant`, [[permissions#The harness level]]) may be where this belongs, rather than a mode name.
- Inside a sandbox, keep the prompts off whatever the workflow says, or let a workflow turn them on.
  Today's setting is the home's settings, which a repository's own `.claude/settings.json` can
  turn back to another mode; a command-line flag would win over it.
- Whatever the mode, `wf` is allowed by default: answering and messaging are the return channel,
  run with the run's own authority, and never need an approval. A narrow allow rule for the
  launcher's path, as `Bash({launcher} result *)`, survives auto mode where the blanket `Bash` rule
  does not, so the answer skips the classifier. Unmeasured: whether the rule matches the heredoc
  form `wf result {id} <<'WF_JSON'` the prompt asks for, and the launcher's path changes per run
  (`/tmp/awf-{id}/{id}/wf`), so the rule is written per agent.
- `output.json` should record each agent's mode as it ran: claude writes it into its transcript
  (`"permissionMode"`), and the sandbox probe already checks it there.
- Measure first: one host claude turn of several shell commands in `auto` against `dontAsk` with
  the same allow rule, to price the classifier before choosing a default.
