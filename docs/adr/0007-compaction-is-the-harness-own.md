# 0007 — Compaction is the harness's own, with the workflow's focus

**Decided:** 2026-10-01, in [[015-native-compaction|story 015]]. **Replaces:** the design's
compaction as a prompt the agent answers, whose accepted answer became its context
(`docs/design/README.md`, "What an agent inside a session sees").

## What was decided

- **`CompactSpec.prompt` is a focus for the harness's own compaction.** It is what an operator
  types after `/compact`: what to keep, what to drop. The engine never asks the agent to write a
  summary, and no `wf result` is involved. `CompactSpec` keeps its shape: `{ id, prompt, deadline }`.
- **Each harness takes the focus its own way.** Claude: `/compact {focus}`, in a pane or on a
  resumed headless session. Codex: the focus as a user message, then its native compaction
  (`/compact` in a pane; `thread/inject_items` and `thread/compact/start` on its app-server
  headless). Pi: its rpc `compact` with the focus as `customInstructions`. A harness with no native
  compaction, cursor, settles the call `failed` before anything is sent.
- **`answered` means the harness compacted, confirmed by its own record**: claude's transcript,
  pi's rpc answer, codex's app-server or its screen. Its value is the summary where the harness
  exposes one, and the empty string where it does not: codex on an OpenAI login keeps it
  encrypted. Every other outcome leaves the agent's context as it was.
- **A compaction is an operation of its own.** It queues after the agent's earlier operations,
  is idempotent by id, has its own deadline and usage record, and is never nudged.

## Why

The operator's working pattern, one session compacted between stages, is the evidence: it works,
and the harness's compaction is what it uses. A summary the agent writes through `wf result` does
not replace its context; only the harness can. Each harness's compaction is a different
primitive, and only one of them, claude's, accepts the focus in the same command, so the contract
names the intent and the harness adapter says how it is delivered.

Refusing an agent at `agents.open` because its harness cannot compact was considered: it needs
the open spec to declare compaction, a published type change, for the one harness that cannot.

## Not decided

- Whether the answer should carry more than the summary, such as tokens before and after. Every
  harness reports something different; nothing reads it yet.
- Compactions the harness starts on its own. They happen inside turns and awf does not report them.
