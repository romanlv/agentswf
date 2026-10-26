---
title: A fork has a session of its own, and an agent's usage isn't read from the shell
type: story
status: todo
priority: P2
epic: agent-config
discovered_in: "story 035, 2026-10-25: a fork's copied command reaching its parent's socket"
depends_on: []
---

# A fork has a session of its own, and an agent's usage isn't read from the shell

A fork is a session of its own that sends its parent's cache key, so it reads the parent's prompt
cache. That is how awf's claude, codex and cursor forks already work; pi's doesn't, because pi has
one id for both. And awf stops taking an agent's sessions from the harness's session variable in its
shell, which in a fork holds the parent's cache key.

## How forks work today

A session id does three jobs, and awf mixes them:
- **the history**: what awf resumes, and where it reads the agent's usage;
- **the cache key**: what the provider routes its prompt cache by;
- **the agent**: which agent a `wf` request comes from.

Checked against the code, `docs/findings/fork-cache.md`, and a probe on 2026-10-25 (codex
`gpt-6-luna` and cursor `composer-2.5`, headless, two forks each):

| harness | the fork's history | its cache key | its shell's session variable |
| --- | --- | --- | --- |
| claude | its own, native `--fork-session` | none: claude's cache is keyed by content (F1–F3) | its own |
| codex | its own thread, native `thread/fork` | the parent's: awf writes it into the rollout's `session_meta.session_id` (`inheritCodexSessionId`, F10) | `CODEX_SESSION_ID`, the parent's |
| cursor | its own chat directory, a `cp -R` of the parent's | the parent's `agentId`, kept in the copy (F11) | `CURSOR_CONVERSATION_ID`, the parent's |
| pi | the parent's id, in a directory of its own, `sessions/awf-forks/{uuid}/`, found only by its file (`piForksDirectory`, `packages/harness/src/usage/pi.ts`) | the parent's, since pi's session id is its cache key (F6) | `PI_SESSION_ID`, the parent's |

In the probe, each codex fork had a thread id of its own in awf's records, was costed apart, and
read 61–68k of its prompt from the cache; each cursor fork had a chat id of its own. Inside every
fork, the shell's variable printed the parent's id.

So two things are wrong:
1. **A pi fork has no history id of its own.** It is the parent's id in a hidden directory, which
   pi's lookup by id never reaches, and awf finds it only by path.
2. **The shell's session variable is read as the agent.** `wf` sends it with every request
   (`--session`, `launcherScript` in `packages/engine/src/agent-launcher.ts`), and it is the main
   source of an agent's sessions for its usage (story 002, ADR 0010). In a fork, on codex, cursor
   and pi, it holds the cache key, which is the parent's, so the engine subtracts a parent's
   sessions from its fork's (`reportedSessions`, `packages/engine/src/workflow-runner.ts:762-773`).

## The shape

- **A pi fork is native**: `pi --fork {parent file}` into the sessions directory, with a new id of its
  own, and an awf extension, loaded with `--extension {path}`, that sends the parent's id as the
  cache key: `prompt_cache_key` in the payload and the `session-id` header, through pi's
  `before_provider_request` and `before_provider_headers` hooks. The parent's id reaches it in an
  environment variable awf sets. `awf-forks/` goes. The extension loads even under the
  `--no-extensions` a sandbox passes, or this is checked.
- **The shell's session variable is no longer the agent.** For an agent awf opened, its sessions come
  from its harness (the fork's id, the headless output, Herdr's `agent_session`), not from `wf`. The
  variable is kept only where nothing else names the session, as for the calling session of
  `awf run --here` (ADR 0010), which isn't forked from anything. `reportedSessions`' subtraction
  goes.
- **Unchanged**: a fork keeps reading its parent's cache by default (ADR 0009). Sharing the cache
  isn't the problem; identifying agents by the cache key is.

## To check

- pi with the extension: a native fork with its own id reads its parent's cache as F6's recipe does
  (30,208 of 31,008), headless and in a pane, with an OpenAI and an Anthropic model. pi's login had
  expired on 2026-10-25, so it isn't measured.
- Which source names a pane agent's session without the shell's variable, per harness, now that
  Herdr's `agent_session` is unreliable under codex (E8).
- Whether many forks under one cache key at once route to one place, and whether that limits them.

## Not in it

A fork's copied command reaching its parent's socket, and acting as the parent while the parent is
in a turn, is accepted, for `wf send`, `wf reply` and `wf tool` alike ([[035-workflow-tools|story
035]], Q4). The guards weighed there: `AWF_AGENT` in the environment, which a codex pane's shell
commands never see (commit `38dd03a`) and a sandboxed pane drops; the call id on every command; the
parent's launcher replaced at each fork; a launcher per operation. Pick one up only if a run is seen
to go wrong this way.
