# site

The agents.wf site: VitePress, default theme. A page's path here is its URL: `guide/agents.md` is
`/guide/agents`, `guide/index.md` is `/guide/`. The site map and what each page covers are in
[the story](../docs/stories/038-agents-wf-site.md#site-map).

```sh
bun install        # in site/; the root install never touches it
bun run dev        # http://localhost:5173, reloads on a page, a sample or an included file
bun run build      # fails on a dead link, a missing sample or a missing include
bun run preview    # serves the build
```

`site/` is not a workspace: it has its own `package.json` and `bun.lock`, and imports no
`@agentswf/*` package. Biome skips it; the build is its check.

## Writing rules

- Second person and present tense.
- Code before prose.
- One word per idea, the ones How it works defines: workflow, run, agent, turn, outcome, harness,
  pane, stage. A run is never also a "job".
- `wf` is a workflow's context and `wfa` the agent's command.
- Placeholders are `{name}` in prose, and `<name>` only inside CLI usage, in a code block. A bare
  `<name>` in prose is an HTML tag.
- No claim about spend beyond the records' own words: a headless claude being "metered" is a rule,
  not a bill. Never "charged" or "spent".
- No private project's name.
- Enough guidance, not everything: a page explains an idea so a newcomer gets it on one read, and
  stops. What only a contributor needs (how awf is tested, the measurements, the design record)
  stays on GitHub, and the page links to it.
- One home per fact. Link the page that owns it instead of explaining it again.
- GitHub-flavoured Markdown. No Obsidian syntax (`[[…]]`, `%%…%%`). VitePress-only syntax
  (custom containers, Vue components) only where a page gains a lot from it.

## A guide page's shape

1. What it is for.
2. The smallest working example.
3. The details.
4. The catches.
5. Links to its Reference entry and a Pattern.

## Frontmatter

Every page starts with a `title` and a `description`. They become its `<title>`, meta description,
link-preview text and its line in `/llms.txt`, so the description is one sentence saying what the
page gives a reader.

```md
---
title: Agents
description: "Calling an agent: opening one, giving it work, and getting a typed answer back."
---
```

Quote a `description` (or `title`) that holds a `: `, or YAML fails the whole build.

A new page shows in the sidebar once its `.md` exists, if it is in `SITE_MAP` in
`.vitepress/config.ts`; the dev server picks up a new page after a restart.

## Links

- To another page: an absolute path without `.md`, `/guide/agents` or `/reference/workflow-api#agent-run`.
  The build fails on a dead one.
- To a file in the repository: a full GitHub URL on main,
  `https://github.com/romanlv/agentswf/blob/main/docs/status.md` (`tree/main/…` for a folder).
  The build doesn't follow these, so a moved file is found with `grep`, not the build.

## Samples are checked code

A sample longer than a line is imported from a `.ts` file that the root checks run, so it can't go
stale without a red check. Two sources:

- **An example**, as it is: `<<< @/../examples/{example}/workflow.ts`. Use this when a page walks
  through a whole example, as Patterns do.
- **A page's own sample**, in `examples/site/`, at the page's path: `examples/site/guide/agents.ts`
  for `/guide/agents`. Root `tsc --noEmit`, Biome and the boundaries check it as they check every
  example. A runnable sample is a workflow with a `*.test.ts` beside it, written as an example's
  test is (`@agentswf/engine/workflow-testing`); root `bun test` runs it, as `awf test` would.

Show part of a file with a region, and the import picks out the lines between the markers:

```ts
// #region open
const agent = await wf.agents.open({ key: "reviewer", runtime: "claude" });
// #endregion open
```

```md
<<< @/../examples/site/guide/agents.ts#open
```

`@/` is `site/`, so `@/../` is the repository root, from any page. An example's file imports
`@agentswf/contract/workflow` and `@agentswf/engine/workflow-testing`; the page shows
`agentswf/workflow` and `agentswf/testing`, the names a reader's workflow imports and `awf` serves.
A top-level declaration in a sample is exported, or `noUnusedLocals` fails it.

`/reference/workflow-api` keeps its own check instead: `tests/workflow-api-samples.test.ts` runs
the samples written on the page.

## Including a text file

A command's help is included verbatim, in a fenced block, from the file the command prints:

````md
```text
<!--@include: @/../packages/engine/src/help/run.txt-->
```
````

The build fails if the file is missing.
