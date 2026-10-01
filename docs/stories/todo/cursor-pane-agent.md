---
title: Run cursor in a Herdr pane, and compact it there
summary: Cursor compacts only in its interactive TUI, so compaction for cursor needs cursor as a pane harness first.
type: story
status: todo
discovered_in: "story 015, the operator's review, 2026-10-01"
depends_on: []
---

# Run cursor in a Herdr pane, and compact it there

Why it matters: cursor's compaction, `/summarize` (alias `/compress`), exists only in its
interactive TUI; headless it reaches the model as text. awf runs cursor headless only
(`PLACEMENT_HARNESSES.pane` is claude and codex), so `agent.compact` on a cursor agent fails.

What is measured ([`findings/native-compaction.md`](../../findings/native-compaction.md), C7):

- In a Herdr pane, `/summarize` summarized and the agent went on in the same session.
- The text after `/summarize` looked ignored: asked to drop a fact, the summary kept it. A focus
  sent as a message just before, as for codex, is untested.
- The summary is on the screen only; cursor's transcript keeps no summary row.
- Its trust screen, `⚠ Workspace Trust Required` with `[a] Trust this workspace`, swallowed prompts
  sent while it was dismissed. E8 drove cursor panes through dependent steps.

To do: cursor's startup blocks in `herdr-startup.ts`, `cursor` in the pane placement, a
`compactPane` for it with the screen that confirms it, and the eval's runtime list.
