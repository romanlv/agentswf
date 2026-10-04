---
id: "019"
title: Cursor as a full harness, and a harness definition that cannot be half-added
summary: "Cursor runs in a pane, compacts, records its tokens, is given skills and runs in a sandbox, as claude, codex and pi do; each harness is one file whose every capability is either built or absent with a reason, which tsc checks."
type: story
status: in-progress
discovered_in: "the operator's review after story 016, 2026-10-04"
depends_on: []
---

# Cursor as a full harness, and a harness definition that cannot be half-added

## Outcome

A cursor agent is not a lesser agent. It opens in a Herdr pane by default, continues there,
compacts with the workflow's focus, forks, records its tokens, is given skills, runs in a sandbox,
and its `wf` calls name its session. Where cursor cannot do what the others do, the definition says
why, and the refusal quotes it.

Adding a harness is one file under `packages/harness/src/harnesses/`, plus what a compiler cannot
see, which [`docs/adding-a-harness.md`](../adding-a-harness.md) lists. Before this story only two
places forced an entry per harness; about twenty others were lists, `Partial`s, switches with a
default, or a single harness's name compared, so a new harness compiled and was quietly refused or
skipped in each.

## What cursor lacked (2026-10-04, cursor-agent 2026.10.01)

| Gap | Effect | Measured or found |
| --- | --- | --- |
| Panes | refused; `placement: "headless"` required | its trust screen, `Workspace Trust Required` / `[a] Trust this workspace`, is the startup block (C7) |
| Session in the agent's shell | `wf` calls name no session | cursor sets `CURSOR_CONVERSATION_ID` in its agent's shell |
| Tokens | none recorded | headless JSON ends with `usage {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`; nothing on disk |
| Login check, billing | none; billing `unknown` | `status --format json` says whether it is logged in; nothing says subscription or usage-based |
| Compaction | refused | `/summarize` (`/compress`, `/compact`) in its TUI only |
| Interrupt | not told from an unanswered turn | screen `Interrupted`; transcript `turn_ended` `status: "error"`, `User aborted request` |
| Skills | refused | reads `.cursor/skills`, `.agents/skills`, `.claude/skills`, `.codex/skills` in the workspace and under `~` |
| Sandbox | refused | `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` move part of its state; rules, MCP, hooks and more stay under `$HOME/.cursor`; the keychain login does not follow `HOME`; `CURSOR_API_KEY` does |
| Launch arguments | dropped by every plan | harmless while skills and sandboxes refused it |
| Docker image | no `cursor-agent` | |

## Decisions

- **Absent with a reason** (operator, 2026-10-04). Every optional field of `HarnessSpec` is either
  given or named in the harness's `absent` with why not; `defineHarness` makes tsc refuse a harness
  that does neither, or both. A behaviour flag that is not a capability, such as `pastesQuoted`, is
  required instead, `false` where it does not apply. A table that stays outside the spec, because
  its owner is another module (Herdr's startup screens, skills, sandbox needs, the operator's login
  checks, homes), is a `Record<Harness, …>` whose entries may be an `Absent` reason.
- **A sandboxed cursor logs in with `CURSOR_API_KEY`** from the operator's environment, as claude
  uses `CLAUDE_CODE_OAUTH_TOKEN` (operator, 2026-10-04).
- **A sandboxed cursor keeps its web tools** (operator, 2026-10-04): no hidden `--exclude-tools`.
  Its sandbox's network is still the domains it names.
- **Cursor's tokens are read from its turn's output**, which awf keeps beside the chat in
  `awf-usage.jsonl`, since cursor logs none. The session readers stay the one path usage comes in
  by, and a fork's copy carries its parent's records, which the parent, read first, claims.

## Tasks

- [x] 1. The harness definition: one file per harness, `defineHarness` with `absent`, the scattered
  tables made `Record<Harness, …>` or spec fields, single-harness comparisons made fields.
  `docs/adding-a-harness.md`.
- [x] 2. Cursor headless: its session in the agent's shell, launch arguments, tokens per turn, a
  login check.
- [ ] 3. Cursor in a pane: its startup block, interactive resume, interrupt, session lookup,
  `/summarize` with the focus as a message before it.
- [ ] 4. Cursor's skills, on the host and in a sandbox.
- [ ] 5. Cursor in a sandbox, srt and docker, with `CURSOR_API_KEY`; `cursor-agent` in the image.
- [ ] 6. Evals: cursor in `harnesses`, `compaction`, `fork` (its cache asserted), `skills`,
  `sandbox-*` and `calling-session`'s usage; docs.
