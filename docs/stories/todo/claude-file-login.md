---
title: A sandboxed claude runs on a login file, as codex and pi do
type: story
status: todo
priority: P1
epic: sandbox
discovered_in: "investigation, 2026-10-18"
depends_on: []
---

# A sandboxed claude runs on a login file, as codex and pi do

A sandboxed claude, under srt or docker, signs in with a claude.ai login awf keeps in a file, one
login for every sandbox, instead of a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.

Why it matters: codex and pi copy their login file into a sandbox's home; claude on macOS keeps
its login in the keychain, which a sandbox does not reach, so today it needs a setup token: one
the operator makes by hand, that only makes model calls, and that `awf` refuses to run without.

## Proposed design

```
awf login claude ── srt, local binding ──► ~/.awf/logins/claude/.credentials.json   (the main login)
                                                       │
            keeper: when < 30 min is left, and before seeding an agent:
              1. take .oauth_refresh.lock in every live claude home
              2. `claude mcp list` in the main login's folder, under srt (refreshes it, no model call)
              3. push the refreshed file into every live home (temp file and rename, no links)
              4. release the locks
                                                       │
       ┌───────────────────────┬───────────────────────┴──────────┐
  agent home (srt)        agent home (docker)               agent home (…)
  its own CLAUDE_CONFIG_DIR, a copy of .credentials.json, disableClaudeAiConnectors
```

- **One login, copied into each agent's own home.** Every agent keeps a home of its own: awf
  counts an agent's usage as every session in its home, finds a pane's session by scanning it, and
  forks from it, so a shared `CLAUDE_CONFIG_DIR` would mix agents and runs. A shared file inside
  separate homes is impossible: claude replaces `.credentials.json` by rename (M3).
- **awf is the only refresher.** Copies are kept fresh enough that no agent refreshes: claude
  refreshes on its own only within about 5 minutes of expiry (T6). awf refreshes the main login
  with claude itself (`claude mcp list`, T1), so it never speaks claude's OAuth protocol, and
  under srt, so the refresh lands in the file and not the keychain.
- **The locks close the race.** A refresh revokes every outstanding token at once. An agent whose
  request lands between the refresh and the push gets a 401; with its home's `.oauth_refresh.lock`
  held it retries rather than refreshing with the dead token, and picks up the pushed file (T5, srt
  and docker). Without the lock it refreshes, fails, and the turn ends (T3 control). Its 401
  retries last about 17 s (T4), so the push must land well inside that.
- **Concurrent awf processes** each run the keeper; the main login's own lock serializes their
  refreshes (M2), and each pushes to its own run's homes when the main file changes.
- **Write-back stays a safety net**: an agent copy that refreshed anyway becomes the main login and
  is pushed. A copy whose tokens are blank is never written back: claude blanks them when a refresh
  fails (M2, copies).
- **The login's own end.** `refreshTokenExpiresAt` is fixed by the server, about 29 days after the
  login, and a refresh does not extend it (M9). awf warns ahead of it and says to run
  `awf login claude`.
- **Each agent's settings carry `disableClaudeAiConnectors: true`.** A full login fetches the
  operator's claude.ai connectors (Slack, Atlassian, Docs were connected in T2), which act on the
  operator's accounts past the sandbox. A setup token never fetched them.
- **The allowlist gains `platform.claude.com`**, the refresh host (M7).
- **The setup token stays** as the fallback; see below.

## Fallbacks

awf picks one login per agent, at its launch, by a fixed order, and says which. An agent never
gets two: `CLAUDE_CODE_OAUTH_TOKEN` takes precedence over stored credentials, so an agent given
both would run on the token while the keeper pushed files it never reads.

| Order | Login | Used when | An agent gets |
| --- | --- | --- | --- |
| 1 | awf's file login | it exists, its `refreshTokenExpiresAt` has not passed, and the keeper's last refresh succeeded | a copy of the file; no token in its environment |
| 2 | the setup token | the file login is missing or failing, and `CLAUDE_CODE_OAUTH_TOKEN` is set | the token, as today; no file in its home, so no claude.ai profile |
| 3 | none | neither | the run is refused before it starts, naming both remedies: `awf login claude`, or `claude setup-token` |

- **Said once.** The run's start says which login claude agents get, and how long a file login
  has left: `claude: awf login, 12 days left` or `claude: setup token (awf login expired)`. A run
  whose agents get different logins says so when it changes.
- **Recorded.** Each agent's record names its login, `file` or `token`, so a failed turn's cause
  can be read afterwards.
- **A refresh that fails mid-run** changes nothing for running agents: their access tokens stay
  valid until they expire, and a failed refresh revokes nothing. The keeper retries; agents
  launched meanwhile take the setup token if there is one. An agent that then reaches expiry
  fails its turn with a `login` reason (story 023), never silently.
- **A forced choice.** The operator can pin one login, so the fallback never decides for them.
- **When claude changes underneath.** The keeper checks what it relies on, and falls back to the
  setup token, said once, if any check fails: the file parses with the fields it needs,
  `claude mcp list` actually moved `expiresAt`, and the refreshed file landed in the file rather
  than the keychain. The lock is the one thing it cannot check from outside; a live eval does
  (T5, T7), and a lock claude stopped honoring reopens a race of milliseconds, not a failure.

## What was measured

2026-10-18, claude 2.1.302 (macOS, srt 1.0.0) and 2.1.283 (the `awf-agent` image, OrbStack 7.0),
a probe login of the operator's Max plan. Scripts and logs are throwaway, in the session
scratchpad.

| ID | Probe | Result |
| --- | --- | --- |
| M0 | macOS claude, a `.credentials.json` in an empty `CLAUDE_CONFIG_DIR` | **Read**: `auth status` logged in from the file alone. |
| M0b | `claude auth login` inside srt | **Writes the file** (0600, full scopes: `user:profile`, `user:inference`, `user:sessions:claude_code`, `user:mcp_servers`, `user:file_upload`, `user:plugins`). Needs `network.allowLocalBinding` for the OAuth callback, and a terminal of its own. |
| M0c | Turns on it | `auth status` names account, org and plan; `claude -p` answers under srt and in docker on the same file. |
| M1 | Shared `CLAUDE_CONFIG_DIR`, A waits 40 s while B refreshes | **A recovers** on B's tokens, no refresh of its own. The same in a private copy: **A fails**, "OAuth session expired and could not be refreshed". |
| M2 | Two claudes, both expired, start together | Shared folder: **both answer**, one rotation. Private copies: **one fails** and blanks its `accessToken` and `refreshToken`; no reuse grace. |
| M3 | `.credentials.json` a symlink to a shared file | **Replaced by a real file** on refresh (temp file and rename); the shared file was left stale. |
| M5 | Shared folder across srt and docker (OrbStack bind mount) | A in docker recovers from B's srt refresh and the reverse; 25 of 25 turns answered across 5 rounds of 3 srt and 2 docker claudes refreshing at once. The lock holds across the mount. |
| M6/T1 | A refresh without a model call | `claude auth status` does not refresh; **`claude mcp list` does**, as do `doctor` and `-p /cost`. |
| M7 | The refresh host | `platform.claude.com`. A full login also reaches `mcp-proxy.anthropic.com` (claude.ai connectors); `disableClaudeAiConnectors` stops it. A turn and a refresh work with only `api.anthropic.com` and `platform.claude.com` allowed. |
| M8 | Where a refresh under srt lands | Always the file, in every probe; no keychain fallback was seen. |
| M9 | `refreshTokenExpiresAt` in the past | **Not enforced by claude**; the server answered with the same fixed date (2026-11-16, login + ~28.6 days). |
| M10 | The operator's own claude through all of this | Still answers: the second login does not sign it out. |
| T2 | A private copy, refreshed main pushed during A's wait | **A recovers**, no 401: claude re-reads the file before a request. |
| T3 | As T2, but A's request lands after the refresh and before the push, its lock held by awf | **A recovers**: 401, retries, picks up the push. Without the lock: **A fails** at once, refreshing with the revoked token. |
| T4 | T3 with A in docker, lock held 40 s | A respected the lock but **gave up after ~17 s** of 401 retries. |
| T5 | Lock held, push 3 s after A's first 401, srt and docker | **Both recover.** |
| T6 | Proactive refresh margin | Kept at 240, 60, 30 and 10 minutes left; **refreshed at 4**. |
| M12 | A held lock, an expired token, a turn | A fresh lock, its owner's pid dead or alive, is **respected**: the turn waits ~10 s and fails, "another Claude Code process is refreshing it or exited mid-…". A lock 1, 5, 15 or 60 minutes old is **broken by age** and the turn refreshes. Owner liveness is not checked; the threshold is between 40 s (T3's lock held) and 60 s. |
| M12b | Which age claude goes by | **The lock's mtime**, not the owner's `lockBirthtimeMs`: birth now and mtime an hour old is broken; birth an hour old and mtime now is respected. Respected at 15, 25, 35 and 50 s of mtime age (plus the ~9 s wait), broken at 60 s. |
| T7 | A lock held for an agent's life: its copy expired, a refreshed login pushed ~5 s into its turn, srt and docker | **Both answer** on the pushed login, no refresh of their own. So awf can hold every home's lock throughout, touching it every ~15 s, and be the only refresher. |
| — | The lock | `.oauth_refresh.lock`, a directory, and `.oauth_refresh.lock.owner`, `{"pid", "pidDomain", "pidSpace", "lockBirthtimeMs"}`, both in `CLAUDE_CONFIG_DIR`; a legacy lock, `{CLAUDE_CONFIG_DIR}.lock`, beside it. |

## To measure

- **M11 The plain-host refresh.** Whether a claude outside any sandbox, on macOS, moves a file
  login into the keychain on refresh. Assumed so, from the docs; not run, as it would strand the
  probe login.
- **M13 A pane agent across a real 8-hour expiry**, rather than a forced one.
- **M15 Token over file.** That an agent with both a `CLAUDE_CODE_OAUTH_TOKEN` and a
  `.credentials.json` runs on the token, as the docs say of the keychain.
- **M14 claude versions.** The lock and re-read behavior on the oldest claude awf supports.

## Open questions

None yet: they follow the reviews.
