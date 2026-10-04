# Forking a session and the prompt cache, F1–F11

Whether a forked session reads its parent's prompt cache, measured 2026-10-01 for
[story 016](../stories/016-fork.md) on claude 2.1.286 (`claude-haiku-4-5`), codex-cli 0.159.3
(`gpt-6-luna`, ChatGPT login), pi 0.87.1 (`openai-codex/gpt-5.6-terra`) and Herdr 0.9.1. A parent
read a ~25k-token manual with its tools and answered one question; each fork was asked another.
The probes, what they wrote and the rows read back are in
[`experiments/_archive/f-fork-cache/`](../../experiments/_archive/f-fork-cache/). Numbers are the
fork's **first request**, as its session file logged it: uncached input / cache read / cache write.
That request is the one that either reads the parent's context from the cache or pays for it
again.

A fork that answered in one request answered from its parent's context. Some made a second request,
re-reading the manual with a tool: claude's first fork after compaction, codex's two plain forks and
pi's first fork after compaction. The first request is still the one that shows the cache.

E7 asked the same question by hand before claude recorded its system prompt; its pane result is
superseded here.

| | question | verdict |
|---|---|---|
| F1 | does a headless claude fork read its parent's cache? | **yes**: 10 / 48,020 / 167, twice |
| F2 | does a pane claude fork, and a fork changing placement? | **yes** from a pane parent: 10 / 60,377 / 793 in a pane and 10 / 60,377 / 1,010 headless; **in part** from a headless parent into a pane: 2 / 26,454 / 17,502 |
| F3 | after compaction? | **the system prompt and tools, not the summary**: every child writes the summary once |
| F4 | does a codex fork read its parent's cache? | **no**, in every placement; 7–17k of it, never the conversation |
| F5 | can it? | **by codex's own means only an ephemeral fork**: 807 / 24,320; it is never saved. A persisted one given its parent's session id does (F10) |
| F6 | does a pi fork read its parent's cache? | **not by default**: 31,102 / 0; **yes keeping the parent's session id**: 800 / 30,208 |
| F7 | can a fork be made without a model call? | **yes on all three** |
| F8 | does a fork's session double-count its parent's usage? | **claude and pi copy the parent's rows; codex refers to them** |
| F9 | what does claude's `total_cost_usd` count? | **the whole session, the parent's turns included** |
| F10 | does a persisted codex fork given its parent's session id read its parent's cache? | **yes**, in every placement, compacted and sandboxed too: 3,727 / 45,824 against 37,519 / 12,032 |
| F11 | does a cursor fork read its parent's cache? | **as `/fork` makes it, no**: 33,354 / 3,879; **keeping the parent's `agentId`, yes**: 54 / 37,152, each history its own |

## F1–F3 — claude

- `claude -p --resume {id} --fork-session` read the parent's whole context from the cache. Two
  forks back to back each read 48,020 tokens and wrote 167, the cost of a resume. A cold agent
  asked the same question grepped the manual and never read it whole, so it is no baseline.
- Claude now records its system prompt in the transcript (`prompt_snapshot`, with the
  `environment`, `session_context` and `date` attachments) and resends the record on every resume
  until the session is compacted (`--system-prompt-snapshot`, on by default). A fork copies the
  record, so its prefix is byte for byte the parent's. That held across placements. A parent
  started in a Herdr pane, forked with no model call (F7), then resumed in a new pane and headless,
  read 60,377 from the cache both times. E7's six pane forks with no cache hits may predate the
  record; that is inferred, not measured.
- A headless parent forked into a pane hits only in part. Measured through awf on 2026-10-03
  (story 016, task 3; claude 2.1.288, `claude-sonnet-5-5`), each fork's first request:
  - pane to pane: 42,699 read, 1,127 written;
  - pane to headless: 42,682 read, 1,501 written;
  - headless to pane: 26,454 read, 17,502 written.

  The interactive launch's prefix differs from `-p`'s, so a pane fork of a headless parent writes
  most of the parent's conversation once.
- After `/compact`, two forks and the parent's own resume each read 17,815 (system prompt and
  tools) and wrote 7,317 (the summary and the question). The summaries and the recorded prompts
  were identical across the three. A cache entry is read only at a breakpoint an earlier request
  wrote: the end of the tools and system prompt (the 17,815 read) and the end of each request. The
  parent never sent the summary as a prefix, and each child's request ended after its own question,
  so no child's write fits the next. Before compaction the parent's last request ended exactly at
  the fork point, which is why F1 hits. The loss is one summary per child, small by construction.
- The docs say the same: a fork "inherits the parent's system prompt, tools, and conversation
  history exactly, so its first request reads the parent's cache"
  ([prompt caching](https://code.claude.com/docs/en/prompt-caching)). The cache is per model; its
  TTL is 5 minutes, or 1 hour for the main conversation on a subscription.

## F4, F5 — codex

- Persisted forks missed in every placement: `codex exec fork {id}` 18,216 / 6,912; app-server
  `thread/fork`, then a turn, 7,975 / 17,152; `codex resume` of a `thread/fork` in a pane
  17,350 / 7,936; headless off a pane parent 20,890 / 7,936. Every codex session's first request is
  about 17.8k (5,813 / 12,032 for the parent), so the forks read 7–17k of their instructions and
  tools from the cache and none of the conversation. Each later request of the fork hits its own
  cache. Codex cut the parent's `cat` short, so its conversation grew by only about 7k: these
  sessions were smaller than claude's and pi's.
- The cause is in its source (`core/src/client.rs`, `prompt_cache_key()`, tag `rust-v0.159.3`). The
  cache key is the thread's session id, which is the root thread's id. The ChatGPT backend also
  routes by the `session-id` header carrying it. A fork is a new thread, so a new key, and a request
  routed where the parent's prefix is not cached. A resume keeps the key. There is no config to pin
  it, but the rollout does (F10).
- The one exception is an ephemeral root fork, which reuses its parent's key ("Ephemeral forks
  reuse cache routing…"). `thread/fork` with `ephemeral: true`, then a turn on the same app-server,
  read 24,320 of 25,127 from the cache, twice. An ephemeral thread is not written to disk, so it
  lives only as long as that app-server process. openai/codex#44716 tracks forks losing the cache
  (it measured 0–12.9k cached for a native fork, 40k with the parent's header), and #44862 made
  only ephemeral forks inherit the key.
- After compaction, forks and the parent's resume alike sent 6,147 / 12,032. Codex's compacted
  context is not cached for anyone, so a fork there costs what a resume costs.

## F6 — pi

- `pi --fork {id} --session-id {new}` missed entirely: 31,102 / 0. pi passes its session id as the
  provider's cache key (`sdk.js`, `getSessionId()`): `prompt_cache_key` and the `session-id` header
  for OpenAI and codex, a compat-gated affinity header for Anthropic, whose cache is content-keyed.
- `--fork` refuses an id that already exists in the session directory it writes to, but not one
  that exists elsewhere. `pi --fork {parent file} --session-dir {a directory of the fork's own}
  --session-id {the parent's id}` made a full copy whose header carries the parent's id. Two such
  forks each read 30,208 of 31,008 from the cache, and answered from the parent's context.
- The whole recipe awf would use was then run as one: a turnless rpc fork (F7) keeping the
  parent's id in `~/.pi/agent/sessions/awf-forks/{uuid}/`, then a separate `pi --print --session
  {that file}`. It read 30,208 of 31,008 from the cache and appended to the same file. pi's lookup
  by id scans one directory below its sessions root, so a fork two levels down is found only by its
  path.
- After compaction, a default fork sent 10,788 / 6,656. It was not tried keeping the id.
- From a pi parent in a Herdr pane, compacted, three forks keeping its id: a pane fork missed
  entirely (12,777 / 0), then a headless fork and a second pane fork read 11,776 of 12,770. The
  provider's cache is best-effort, so one miss in six pi forks that kept the id is noise to watch,
  not a rule.
- Not measured: pi on an Anthropic model, where a default fork should hit as claude's does.

## F7 — a fork with no model call

| harness | how | what it leaves |
|---|---|---|
| claude | `claude -p --resume {id} --fork-session --session-id {new}`, `/cost` on stdin | `num_turns` 0, no tokens; the copied transcript under `{new}` |
| codex | app-server `thread/fork` (`excludeTurns: true`) | a two-line rollout naming its parent and `forked_from_ordinal_exclusive`: a fixed point |
| pi | `pi --mode rpc --fork {id} --session-id {new}`, `get_state` on stdin | the copied session file |

Each fork is then an ordinary session, resumed headless or in a pane like any other. So the point a
fork is taken is fixed when it is asked for, not when its first turn runs. `/cost` is a local
command: claude prints the session's cost and sends nothing to the model.

## F8 — usage in a fork's files

- Claude: a fork's transcript copies the parent's rows, `requestId`, `uuid` and `timestamp` kept
  and `sessionId` rewritten. After a compaction it copies from the `compact_boundary` on, plus the
  last request before it with its usage zeroed (8 / 48,187 / 271 in the parent, 0 / 0 / 0 in the
  fork, same `requestId`).
- pi: it copies every entry verbatim, ids and timestamps kept, under a new header with
  `parentSession`.
- Codex: a thread fork writes `ForkPersistence::Referenced`, a `session_meta` with
  `forked_from_id` and its `history_base`, and copies no `token_count` events.
- awf's run-end read claims each request key once per harness, for the first agent read, in the
  order agents opened (`packages/engine/src/run-usage.ts`). A parent opens before its forks, so
  copied rows stay the parent's.

## F9 — claude's printed cost

`total_cost_usd` in `claude -p --output-format json` is the session's running total, not the turn's:
- a resume printed $0.0871 after a first turn of $0.0753; its own tokens at haiku's list price,
  1-hour cache writes, are exactly the $0.0118 between;
- a headless fork printed $0.0810, the parent's $0.0753 and its own $0.0057;
- the turnless fork in F7 printed $0.123, its parent's whole cost, having spent nothing.

Claude keeps the total in the transcript, as `cost-state` rows with `totalCostUSD`, which a fork
copies. awf reads the printed total as the turn's charge (`HarnessSpec.readCharge`), so a headless
claude agent's second and later turns already report what the earlier ones charged again: a nudge
in the same operation adds two totals, and a compaction printed $0.1017 where it cost about $0.015.
pi's `readCharge` errs the other way: it takes the last `turn_end`'s cost, which is one request's of
several.

## F10 — a codex fork under its parent's session id

Measured 2026-10-04 on codex-cli 0.160.0 (`gpt-6-luna`, ChatGPT login); the probe and its output
are in [`experiments/_archive/f-fork-cache/`](../../experiments/_archive/f-fork-cache/)
(`scripts/sessionid.ts.txt`, `results/sessionid.txt`).

- What F4 missed: a resumed thread takes its session id, and with it its cache key and `session-id`
  header, from its rollout's `session_meta.session_id` (`core/src/session/session.rs`, tag
  `rust-v0.160.0`), not from its thread id. Codex's own subagents write the root's there and hit;
  a `thread/fork` or `exec fork` writes its own thread id there and misses.
- Two persisted forks of one parent, each resumed on a fresh app-server: one as codex left it, one
  whose `session_meta.session_id` was rewritten to the parent's. The parent's prompt was ~42k. The
  rewritten fork's first request read 3,727 / 45,824, twice; the plain fork 37,519 / 12,032 and
  37,525 / 12,032, as in F4, whichever was resumed first. Both answered from the parent's context.
  openai/codex#44716 saw the same through the header: 40,064 cached with the parent's `session-id`,
  12,928 without.
- awf's whole recipe, in `tests/fork.eval.ts` and `examples/fork`: the fork's first operation read
  0.97 of its prompt from the cache in a pane, 0.90 headless, 0.97 and 0.94 after compaction, and
  19,968 of about 22k in a pane and headless in an srt sandbox. F4's miss after compaction does not
  recur under the parent's key.
- The fork keeps its own thread id, so the two threads do not collide; they share a cache key, as
  a root and its subagents do. A rollout whose `session_id` names another thread is not always a
  subagent: codex writes a subagent's `source` as an object (`{"subagent": …}`) and a root
  session's as a string, which tells the two apart.

## F11 — cursor

Measured 2026-10-04 on cursor-agent 2026.10.01 (`composer-2.5`, headless); the probes and their
output are in [`experiments/_archive/f-fork-cache/`](../../experiments/_archive/f-fork-cache/)
(`scripts/cursor*.ts.txt`, `results/cursor.txt`).

- Cursor's CLI has no fork flag, but its TUI has `/fork` ("Fork Chat"). It calls no model: it
  copies every blob of the chat's `store.db`, under `~/.cursor/chats/{md5 of the cwd}/{id}/`, into
  a new chat directory and gives the copy a new `agentId` in its `meta` row. The TUI then goes on
  as the fork, the parent left to `--resume`.
- A fork made that way misses: its first request read 33,354 / 3,879, twice, where a resume of the
  parent read 109 / 37,004. Cursor keys its cache by the chat's `agentId`, as codex does by its
  session id (F10).
- A copy of the chat's directory under a new id that keeps the parent's `agentId` read 54 / 37,152
  on its first request, and 19 / 37,184 for a second such fork. `--resume` takes the directory's
  name, and the output names it as the session.
- Sharing an `agentId` does not share a history: the parent and two such forks, each told a
  different release, each recalled only its own.
- Cursor's headless JSON reports each turn's tokens, `cacheReadTokens` included, which awf keeps
  since story 019: in the fork eval on 2026-10-04 the fork's first turn read 0.98 of its prompt
  from the cache. Only `composer-2.5` was measured: cursor sends other models to their own
  providers, whose caches may key otherwise.
