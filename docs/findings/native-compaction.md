# Native compaction, C1–C10

What each harness's own compaction does when awf drives it, measured 2026-10-01 for
[story 015](../stories/015-native-compaction.md) on claude 2.1.286, codex-cli 0.159.3, pi 0.87.1,
cursor-agent 2026.09.28 and Herdr 0.9.1, on the cheapest models. The probes were throwaway
scripts; the eval that holds the result is `tests/compaction.eval.ts`.

| | question | verdict |
|---|---|---|
| C1 | does headless claude compact on resume? | **yes**: `/compact {focus}` on stdin of `claude -p --resume` |
| C2 | does a claude pane compact, and when is it done? | **yes**: Herdr's prompt wait returns when it is; the screen says `Compacted` |
| C3 | does codex `exec` compact? | **no**: `/compact` goes to the model as text |
| C4 | can codex compact headless, with a focus? | **yes, on its app-server**; the focus only as a message before it |
| C5 | does a codex pane compact, with a focus? | **bare `/compact` only**; the focus as the message before it |
| C6 | does pi compact headless, with a focus? | **yes, in rpc mode**; nothing younger than its last 20k tokens |
| C7 | does cursor compact? | **only in its TUI**: `/summarize`; headless, it goes to the model |
| C8 | where is the summary? | **claude's transcript and stream; pi's answer; codex's is encrypted** |
| C9 | does the focus reach the summary? | **yes on every harness that compacts** (eval, below) |
| C10 | can a compacted session be forked? | **yes, natively, on claude, codex and pi** |

## C1, C2 — claude

- `claude -p --resume {id}` with `/compact {focus}` on stdin compacts: `num_turns` 0, an empty
  `result`. The compaction itself cost $0.02–0.03 on haiku for a ~24k-token session; the
  `total_cost_usd` it prints is the session's running total ([F9](fork-cache.md#f9--claudes-printed-cost)).
- The transcript gains a `system` row `compact_boundary` (`trigger: manual`, `preTokens`,
  `postTokens`), the focus as the `/compact` command's `command-args`, and a `user` row with
  `isCompactSummary: true` holding the summary. `--output-format stream-json --verbose` prints the
  boundary and the summary, as a synthetic `user` row, on stdout; `json` prints only the empty
  result.
- In a pane, `herdr agent prompt {name} "/compact {focus}" --wait` returned when compaction ended,
  13 s on haiku, and the screen showed `⎿ Compacted (ctrl+o to see full summary)` under the echoed
  command.
- Asked afterwards, with the focus "keep the path length; drop the shed colour", the agent gave the
  path and called the colour unknown.

## C3–C5 — codex

- `codex exec resume {id}` with `/compact …` ran a model turn on the text.
- `codex app-server --listen stdio://`: `initialize`, `thread/resume`, then `thread/compact/start`
  compacted in about 4 s, ending with `item/completed` of type `contextCompaction` and
  `turn/completed`. The server exits as soon as stdin closes, before compacting.
- `thread/compact/start` takes only a thread id. `-c compact_prompt=…` changed nothing on a ChatGPT
  login: asked to write the summary in French, it was written in English. The compaction is
  remote: the rollout's `compacted` row keeps every user message verbatim, and the rest as one
  `compaction` item with `encrypted_content`.
- `thread/inject_items` with a user message before compacting did reach it: asked afterwards, the
  agent answered in French. The message also stays in context, as every user message does.
- In a pane, `/compact {text}` ran a model turn on the text. A bare `/compact` compacted, and showed
  `• Context compacted · 2s`, but is not echoed as a prompt line. Sent the focus as a message first,
  then `/compact`, the agent kept what the focus kept and lost what it dropped.
- codex-cli 0.159's folder trust screen is new: `Folder access … Trust this folder?` with `› 1. Trust
  and continue`. The digit only moves its cursor; enter confirms.

## C6 — pi

- `pi --print` with `/compact …` ran a model turn on the text.
- `pi --mode rpc --session-id {id}` with `{"type":"compact","customInstructions":…}` answered
  `{"type":"response","command":"compact","success":true,"data":{"summary":…}}`. Like codex's
  server, it exits when stdin closes.
- It keeps the last `keepRecentTokens`, 20k, unsummarized, and refuses with "Nothing to compact
  (session too small)" when nothing is older. A project's `.pi/settings.json` would lower that only
  once the project is trusted.
- The instructions go to the history summary as "Additional focus". A turn split at the cut is
  summarized by another prompt that takes none. On the operator's pi, an extension (`plannotator`)
  logs a `custom` entry before every turn; a cut landing there was taken for a split turn, and the
  turn before it was summarized without the focus and then forgotten. A short turn between the
  facts and the filler was enough to keep the facts in the history. A sandboxed pi runs
  `--no-extensions` and logs no such entry.

## C7 — cursor

- Cursor's compaction is `/summarize`, `/compress` its alias
  ([docs](https://cursor.com/docs/cli/reference/slash-commands)).
- `cursor-agent -p --resume` with `/compress`, `/compact` or `/summarize` answered as a model:
  "**Compressed context:** Shed colour is blue." Headless, there is none.
- In a Herdr pane, `/summarize Keep the path length; drop the shed colour.` summarized: a boxed,
  numbered summary on screen, ending with the path of the session's transcript for the agent to
  consult. It kept the colour the text asked to drop, so the text after the command looks
  ignored. The transcript holds no summary row. Afterwards the agent knew both facts.
- Its trust screen (`⚠ Workspace Trust Required … [a] Trust this workspace`) swallowed the first two
  prompts when they were sent at once; after a 6 s wait, nothing was lost. awf does not run cursor
  in panes.

## C10 — forking a compacted session

Each harness's own fork, run on a session compacted with "keep the path length; drop the shed
colour", then asked what it knows:

| harness | fork | new session | answered |
| --- | --- | --- | --- |
| claude | `claude -p --resume {id} --fork-session` | new id | the path only |
| codex | `codex exec fork {id}` | new thread | the path only |
| pi | `pi --fork {id} --session-id {new}` | new id, `parentSession` set | both (its split-turn summary kept both) |

So a compacted session can be the shared base for several agents without awf reading the context
out: the summary is readable for claude and pi, but codex's is encrypted, and the fork carries it
anyway. The original session is untouched by each fork. What a fork costs against the prompt cache is
[`fork-cache.md`](fork-cache.md).

## C9 — the eval

`tests/compaction.eval.ts` runs `examples/compaction`: an agent per harness and placement notes a
colour, is compacted with a focus naming a codename it was never told, then is asked both.

| runtime | compacted | summary holds the codename | recalled |
| --- | --- | --- | --- |
| claude, pane | answered | yes | codename and colour |
| claude, headless (metered) | answered | yes | codename and colour |
| codex, pane | answered | `""`, encrypted | codename and colour |
| codex, headless | answered | `""`, encrypted | codename and colour |
| pi, headless | answered | yes | codename and colour |
| cursor, headless | failed: no compaction of its own | — | colour only |

Six agents at once: 46 s, ~$0.32 at list prices, $0.15 charged. Before the eval's prompts settled,
headless haiku answered "remember this… do not write it anywhere" by printing the `wf result`
command instead of running it.

## Not measured

- Whether a session's usage read adds up across a compaction. Claude's transcript logs no
  assistant row for the compaction request, so its tokens are not in the read; a headless claude's
  charge is, from its stream. Codex logs a response for it.
- A compaction of a long session: every one here was under 60k tokens.
