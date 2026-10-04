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
- **A provider gives an agent a short directory of its own** when its harness asks
  (`HarnessSandboxNeeds.shortDirectory`, operator, 2026-10-04): cursor's worker binds a socket under
  its data directory, and where that path passes 84 characters, as every sandbox home's does, it
  falls back to `/tmp/.cursor`, shared by every cursor on the host. srt makes
  `/private/tmp/awf-{random}` (0700), which the agent alone reads, writes and binds in, and removes
  it on release; docker makes one in the box.
- **cursor's resume lock is shared** (`HarnessSandboxNeeds.sharedWrites`, operator, 2026-10-04).
  Every `--resume` takes a lock under `/tmp/cursor-agent-persist-{uid}`, which no variable, flag or
  setting moves (cursor-agent 2026.10.01). srt lets the agent write that directory, shared with the
  operator's own cursor and every sandboxed one, and read the `/tmp` link it names it through, which
  opens nothing else of `/tmp`. An agent could so block or see the locks and `agent persist`
  bindings of chats whose ids it knows. Rejected: a `NODE_OPTIONS` preload rewriting the path to
  the short directory, private but tied to cursor's minified internals; and cursor in docker only.
- **Cursor's tokens are read from its turn's output**, which awf keeps beside the chat in
  `awf-usage.jsonl`, since cursor logs none. The session readers stay the one path usage comes in
  by, and a fork's copy carries its parent's records, which the parent, read first, claims.

## Measured (cursor-agent 2026.10.01, Herdr 0.9.1, `composer-2.5`)

- **Headless.** The shell of a turn has `CURSOR_CONVERSATION_ID`, the chat id the output names, and
  `CURSOR_AGENT=1`. The JSON ends with `request_id` and the turn's `usage`; with it kept, the fork
  eval read 0.98 of a headless fork's first prompt from its parent's cache.
- **A pane.** `--trust` skips the trust screen, and no other screen showed. Herdr names the chat as
  the pane's session, the same id as `CURSOR_CONVERSATION_ID`. The screen shows no usage.
- **Compaction in a pane.** The focus sent as a message, then `/summarize`: the summary, drawn in a
  box ending `Transcript location:` and the transcript's path, kept what the focus kept, and asked
  afterwards the agent called the dropped fact unknown. The box quotes every prompt, the focus
  included, so the screen is read for a new box, not for text after the focus.
- **An interrupt.** Escape during a tool ended its line `Cancelled • 4.8s`; during a reply, the prompt
  went back into the input. Neither is a line of its own to tell an interrupted turn by.
- **In a sandbox** (2026-10-04, `CURSOR_API_KEY`). Its own `HOME`, config directory and
  in-memory credentials: with the key alone it runs, and without the memory store it tries the
  keychain and warns. Docker ran it headless and in a pane, with a skill it found under
  `HOME/.cursor/skills`, its usage read from its home, on `*.cursor.sh` alone. Under srt it needed
  the short directory and the shared lock directory above.
- **Why it seemed slow under srt, and was not cursor's doing.** Every `/usr/bin/git` is macOS's
  `xcrun` stub, which reads its cache in the operator's temp directory, denied with the rest of
  `/private/var/folders`: each call started `xcodebuild`, 1.2 s instead of 0.01 s. srt now reads
  that one file, for every harness. And Herdr reports a pane idle about 3.5 s after the harness
  starts, drawn or not; cursor drew 2.5 s later under srt and lost the prompt typed meanwhile. A
  harness's `paneReady` names what its screen shows once it takes input, and a sandboxed pane waits
  for it.
- **The evals.** `harnesses` (cursor headless and in a pane), `compaction` (`cursor` compacts,
  `cursor-headless` refuses and goes on) and `fork` (four cursor cases) passed live on 2026-10-04.

## Tasks

- [x] 1. The harness definition: one file per harness, `defineHarness` with `absent`, the scattered
  tables made `Record<Harness, …>` or spec fields, single-harness comparisons made fields.
  `docs/adding-a-harness.md`.
- [x] 2. Cursor headless: its session in the agent's shell, launch arguments, tokens per turn, a
  login check.
- [x] 3. Cursor in a pane: its startup block, interactive resume, interrupt, session lookup,
  `/summarize` with the focus as a message before it.
- [x] 4. Cursor's skills in a sandbox, under its own `HOME`'s `.cursor/skills`. On the host it is
  refused: it reads skills under `HOME`, the operator's own there, and a `HOME` of its own on the
  host would be git's and every tool's too, and loses its login.
- [x] 5. Cursor in a sandbox, srt and docker, with `CURSOR_API_KEY`; `cursor-agent` 2026.10.01 in
  the image, by checksum; a short directory and shared writes in the sandbox seam; srt reads the
  `xcrun` cache; a sandboxed pane waits for its harness's `paneReady`.
- [x] 6. Evals: cursor in `harnesses`, `compaction`, `fork` (its cache asserted but in a pane) and
  `skills` (in a sandbox of its own); docs. The sandboxed fork cases, `cursor-headless+sandbox`,
  `cursor+sandbox` and `cursor-headless>pane+sandbox`, passed live from a working directory apart
  from the run root, which `fork.eval.ts`'s own does not allow a sandbox. `sandbox-srt`,
  `sandbox-panes-srt`, `sandbox-docker` and `sandbox-panes-docker` passed after the srt profile
  changed. The sandbox probe evals do not include cursor.
