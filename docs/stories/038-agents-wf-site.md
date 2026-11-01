---
id: "038"
title: "agents.wf shows what the project is and how to use it, for people and agents"
summary: "A VitePress site at agents.wf, deployed from main and naming the released version, built from Markdown in a standalone site/ folder: a landing page, a guide ordered agents, workflows, runs, then patterns and reference, each page also served as plain Markdown with an llms.txt, so an agent reads it as easily as a person."
type: story
status: ready
depends_on: []
---

# agents.wf shows what the project is and how to use it, for people and agents

## Outcome

`https://agents.wf` has a landing page that says what agents.wf is, and the docs a workflow author
and an operator need: getting started, the guide, patterns, the reference. The pages are Markdown
files in this repository's `site/`, so a change to the code and the docs it changes land in one
commit, and a push to main updates the site.

The site's purpose is different from the README's. A visitor browses it to learn what the project
does and how each feature works, and leaves trusting it enough to try it: the site says what awf
doesn't do and that it is in evaluation, and links the evidence on GitHub (what is tested and measured,
what runs today), where the code is open. The GitHub README keeps its own purpose; only its links
to the API page change.

An agent is a first-class reader. Every page is also served as plain Markdown, the site has an
`/llms.txt` index and an `/llms-full.txt` with every page, and what `awf init` writes points an
agent at those. An agent that writes a workflow reads the API from agents.wf, not by scraping HTML
or cloning the repository.

Why now: the packages are on npm as `agentswf@beta` and the repository is public, but the only
docs are the README and files under `docs/`, which mix the user's pages with stories, findings and
the design argument. `homepage` in every manifest and the link `awf init` writes still point at
GitHub ([[npm-launch]] already names `https://agents.wf` as the homepage).

## How it works

```
 this repository                           build (CI, on push to main)      agents.wf (Cloudflare)
 ───────────────                           ───────────────────              ──────────────────────
 site/   standalone, own package.json      VitePress, default theme  ──▶   /                 landing page
   *.md  the site's own structure:         + agent outputs                 /{page}           HTML for people
         guide, API, CLI, examples         (fails on a dead link)          /{page}.md        the same page, raw
   .vitepress/  config, theme                                              /llms.txt         index of pages
                                                                           /llms-full.txt    every page, one file
 packages/, examples/  ── the workspaces; never depend on site/
 docs/  foundation, stories, findings, adr, design  ── internal, never published
```

- **The Markdown is the source.** Pages are GitHub-flavoured Markdown with relative links. No
  Obsidian syntax (`[[…]]`, `%%…%%`), and VitePress-only syntax (custom containers, Vue
  components) only where a page gains a lot from it. Readers are on the site; a page read on
  GitHub shows an import directive where a sample goes, which is acceptable.
- **The site has its own structure.** Its pages are written for the site, and say more than the
  repository's files where a reader needs more: a pattern walks through an example. They are not
  copies of READMEs. The one thing taken from elsewhere is code: samples are imported from `.ts`
  files the repository's checks already run.
- **Enough guidance, not everything.** A page explains an idea so a newcomer gets it on one read,
  and stops there. What only a contributor needs (how awf is tested, the measurements, the design
  record, lab, contributing) stays on GitHub, and the site links to it.
- **User docs live only in `site/`.** A doc written for someone using awf moves there and its old
  copy goes, so there is one to keep current. `docs/` keeps what is for developing awf
  (foundation, stories, findings, ADRs, design notes), where AGENTS.md and the stories link to
  it; the site never reads it.
- **`site/` is not part of the monorepo.** It has its own `package.json` and `bun.lock`, outside the
  root workspaces, so VitePress and its dependencies never enter the packages' install or lockfile.
  It imports no `@agentswf/*` package.
- **The agent outputs are built from the same files**, not written by hand, so they can't drift
  from the HTML.
- **The look can change later** without touching a page: VitePress's default theme takes CSS
  variables and layout slots, and can be extended or replaced by a custom theme in
  `.vitepress/theme`. The story ships the default theme.

## Scope

In scope:

- `site/` as a standalone VitePress project: a landing page and the user docs, deployed from
  main, whose header names the released version.
- The site map below, written from the README, `docs/workflow-api.md`, `docs/holder-cli.md`,
  `docs/status.md` and the examples.
- Reorganizing the existing docs so each user-facing fact has one home: `docs/workflow-api.md`
  moves to `site/reference/workflow-api.md`, its testing section to `/reference/testing-api`, and
  `docs/holder-cli.md` into `/guide/people`; links to them in `docs/`, `examples/README.md` and the
  README point at their new home. The old `workflow-api.md` path keeps one line pointing at the
  site, for folders `awf init` already set up. `examples/README.md` becomes an index whose guide
  prose moves to the site.
- Agent support: `{page}.md`, `/llms.txt`, `/llms-full.txt`, and a pointer from `awf init`'s
  `AGENTS.md` template.
- A CI job that builds `site/` and deploys it to Cloudflare at agents.wf on every push to main.
- Each `awf` command's help moved into a text file the command and `/reference/awf` both read.
- `homepage` in every manifest.

Out of scope:

- Any change to the GitHub README beyond its three links to `docs/workflow-api.md`.
- A runnable example of a chat app (Slack) answering for a participant: `/guide/people` shows how
  one connects through `awf inbox`, `awf reply` and `awf send`; the example is a todo. The chat
  app is its own program on awf, not part of it.
- Docs for more than one version: there is one release line, beta. A `beta.agents.wf` beside a
  stable site waits for a stable release.
- Error messages that link to their troubleshooting entry, as Next.js's do: an engine change, a
  todo once the anchors exist.
- A custom theme or design work beyond the default theme's settings.
- A blog, changelog page, i18n, analytics, a search service beyond VitePress's local search.
- Markdown lint or format: VitePress has none, and the root Biome skips `site/`.
- Publishing `docs/` internals (foundation, stories, findings).
- An MCP server for the docs: `llms.txt` and raw Markdown first; revisit if agents still struggle.

## Context and evidence

- Fact: the repository is public (`gh repo view`, 2026-10-31) and `agentswf` is on npm at
  `0.1.0-beta.3`. Every `packages/*/package.json` has `homepage:
  https://github.com/romanlv/agentswf`.
- Fact: `packages/engine/src/init-template/AGENTS.md.template` links lines 3 and 10 to GitHub,
  line 10 to `docs/workflow-api.md` on main. Folders `awf init` already set up keep that link, so
  the old file stays as a pointer to the site.
- Fact: user-facing pages today: `README.md` (365 lines), `docs/workflow-api.md` (1,106),
  `docs/holder-cli.md` (136), `examples/README.md`, `packages/lab/README.md`,
  `packages/agentswf/README.md`. `docs/adding-a-harness.md` and `docs/testing.md` are for
  contributors and stay.
- Fact: `tests/workflow-api-samples.test.ts` reads `docs/workflow-api.md` and runs its samples: a
  block whose first line names a file is written out and run with `awf test`, and one quoted from
  an example must still be in it. The API page's samples are already checked code.
- Fact: links to `docs/workflow-api.md`: `README.md` lines 104, 128 and 356, `docs/testing.md`,
  `docs/holder-cli.md`, `docs/adding-a-harness.md`, the init template; to `docs/holder-cli.md`:
  `docs/status.md`, `docs/workflow-api.md`, `docs/design/messaging.md`. Stories cite both as
  history and stay as written.
- Fact: the root `package.json` workspaces are `packages/*`, `examples` and `experiments/*`, so
  `site/` is outside them as it stands. Root `tsconfig.json` includes only those and `scripts`,
  `tests`. Biome's `files.includes` is `**` minus a list, so it would lint `site/` unless `!site` is
  added.
- Fact: VitePress's `ignoreDeadLinks` defaults to `false`: the build fails on a dead link
  ([site config](https://vitepress.dev/reference/site-config), checked through Context7
  2026-10-31). That is the link check; no tool of our own.
- Fact: VitePress's default theme is extended in `.vitepress/theme/index.ts` with `extends:
  DefaultTheme`, and takes layout slots and CSS overrides
  ([extending the default theme](https://vitepress.dev/guide/extending-default-theme)).
- Fact: there is no CI in the repository (`.github/` doesn't exist), and a release makes a commit
  (`chore(release): 0.1.0-beta.3`) and no git tag.
- Fact: each command's help is a string constant beside its code (`emitUsage` in
  `packages/engine/src/emit-command.ts`, eleven in all), listed in `COMMANDS` in `commands.ts`;
  `awf help reference` prints each one's usage lines. The help is plain text with `<file>`-style
  placeholders, which Markdown prose would read as HTML tags. `agentswf` is published as
  TypeScript source for Bun.
- Fact: VitePress's `<!--@include: {path}-->` runs before code blocks are parsed, so it works
  inside a fence and inserts the file verbatim
  ([Markdown file inclusion](https://vitepress.dev/guide/markdown), checked through Context7
  2026-11-01).
- Fact: a page with `layout: page` gets an empty page with only `page-top` and `page-bottom` slots,
  and a theme can render its own component for `layout: home`; Vue components can be used in any
  page ([custom theme](https://vitepress.dev/guide/custom-theme), checked through Context7
  2026-11-01). A fully designed landing page needs no other generator.
- Fact: no process keeps a parked run alive. `awf tick` wakes runs whose timer is due, run on any
  schedule (`--all` for every project in `~/.awf/projects`); an event arrives only through
  `awf emit`.
- Assumption: the operator controls the agents.wf domain and will add it to Cloudflare.

### Reference sites, checked 2026-10-31

Generator read from each page's `<meta name="generator">` or its bundle; agent support from
`/llms.txt` and `/llms-full.txt` returning 200. The VitePress ones are the models for this site.

| Site | Generator | llms.txt / full | Why look at it |
| --- | --- | --- | --- |
| [hono.dev](https://hono.dev/docs/) | VitePress 1.6 | yes / yes | small TS framework, plain and fast; the closest in scale |
| [vitest.dev](https://vitest.dev/guide/) | VitePress 2 alpha | yes / yes | dense API reference that stays readable |
| [elysiajs.com](https://elysiajs.com/) | VitePress 2 alpha | yes / yes | a Bun framework with a front page that has personality |
| [opencode.ai/docs](https://opencode.ai/docs/) | Starlight 0.41 | redirect / no | a coding-agent CLI: the same audience |
| [biomejs.dev](https://biomejs.dev/guides/getting-started/) | Starlight 0.42 | no / no | a CLI tool with clean reference pages |
| [herdr.dev](https://herdr.dev/) | Astro | yes / yes | the multiplexer awf runs agents in |
| [zod.dev](https://zod.dev/) | Next.js (Fumadocs) | yes / yes | a schema library's docs; awf's typed results lean on schemas |
| [ai-sdk.dev](https://ai-sdk.dev/docs/introduction) | Next.js, custom | yes / yes | the best agent support seen: `{page}.md` returns `text/markdown` |
| [trigger.dev/docs](https://trigger.dev/docs), [modelcontextprotocol.io](https://modelcontextprotocol.io/docs) | Mintlify (hosted) | yes / yes | agent features built in; hosted, so the Markdown isn't fully ours |

### How the reference sites are organized, checked 2026-11-01

Read from each site's `llms.txt` (Hono, Vitest, Elysia, Herdr, Mastra, Trigger.dev, Zod, opencode).

- **A short front door.** Vitest: Why, Getting started, Features. Elysia: At a glance, Quick
  start, Key concept. Trigger.dev: Introduction, Quick start, How it works, Limits. A page that
  says what the product won't do builds trust cheaply.
- **The guide follows what the reader is doing**, not the API's layout: Vitest's Learn, Authoring,
  Workflow, Quality and Debugging; Elysia's Essential, then Patterns.
- **Patterns or recipes**, one problem each: Vitest's Recipes, Elysia's Patterns, Trigger.dev's
  agent patterns (human in the loop, sub-agents, compaction).
- **A section for building with AI.** Trigger.dev: Building with AI (MCP, skills, agent rules).
  Mastra's `llms.txt` opens with "When to use Mastra" and "How agents should use Mastra" (append
  `.md` to any URL, read the Reference before writing code), then common starting points and a
  one-line skill install. Herdr: an agent skill page, `agent-guide.md`, `llms-small.txt` and
  `llms-full.txt`. Hono: "Tiny Docs".
- **Troubleshooting or common errors** (Vitest, Herdr).
- **Reference is separate and terse** everywhere, with the CLI and configuration on their own
  pages.

## Code map

- `site/` — new: `package.json`, `bun.lock`, `.vitepress/config.ts`, `AGENTS.md` with the
  writing rules, the pages.
- `biome.json` — `!site` in `files.includes`.
- `README.md` — keeps its own purpose; only its three links to `docs/workflow-api.md` change.
- `docs/workflow-api.md` — moves (`git mv`) to `site/reference/workflow-api.md`, its "Testing a
  workflow" section to `site/reference/testing-api.md`; the old path keeps one line pointing at
  the site.
- `docs/holder-cli.md` — moves into `site/guide/people.md` and is deleted.
- `tests/workflow-api-samples.test.ts` — reads both pages at their new paths.
- `docs/status.md`, `docs/testing.md`, `docs/adding-a-harness.md`, `docs/design/messaging.md`,
  `examples/README.md` — links to the moved files point at their new home.
- `examples/README.md` — becomes the examples' index: what each shows and the page that explains
  it; its guide prose (run deadline, default nudge) is replaced by links.
- `examples/` — stay as they are, for running from a clone. The Patterns pages link them, and
  page samples are imported from checked `.ts` files here or in a snippets folder (M3).
- `packages/*/package.json` — `homepage: https://agents.wf`.
- `packages/agentswf/package.json` — its `version`, stamped by the release, is the version the
  site's header shows; the site's config reads the file, it doesn't import the package.
- `packages/engine/src/init-template/AGENTS.md.template` — points at `https://agents.wf/llms.txt`
  and the API page's `.md`; its rules (typecheck, `awf test`, no `awf run` unless asked) are
  repeated in `llms.txt`.
- `scripts/release.ts` — checked, no change: its version commit on main redeploys the site, so
  the header follows the release.
- `packages/engine/src/*-command.ts` — each command's help (`emitUsage` and ten more) moves to
  `packages/engine/src/help/{command}.txt`, imported as text; `commands.ts` and its tests keep
  reading the same strings.
- `AGENTS.md` — its table gains `site/`, says it is standalone, and how to build it.
- `scripts/check-boundaries.ts`, root `tsconfig.json`, root workspaces — checked, no change:
  none of them reach `site/`.

## Proposed design

- **Generator:** VitePress with its default theme. Config in `site/.vitepress/config.ts`, pages at
  `site/` itself (`srcDir` the default), so a page's path in the repository is its URL. Its
  built-in `lastUpdated` and `editLink` are on (`lastUpdated` needs full git history in CI).
- **Standalone:** `site/` installs with `bun install` in that folder and builds with
  `bun run build` there. Root `bun install`, `bun test` and `bun run check` never touch it. The
  site's CI job is the only thing that installs its dependencies.
- **One version, deployed from main.** Docs evolve on their own: a fix or a new pattern is live
  minutes after it lands. The header names the released version (`v0.1.0-beta.3`), read from
  `packages/agentswf/package.json` at build, so a reader can tell what `agentswf@beta` installs.
  The cost is a window where a page describes a call the installed release lacks; it is kept
  short by releasing soon after an API change lands, which in beta is one command. Docs for
  another line (a `beta.agents.wf` beside a stable one) come when there is a stable release.
- **The CLI reference has one copy.** Each command's help lives in
  `packages/engine/src/help/{command}.txt`. The command imports it as text (Bun's text import;
  `agentswf` ships source, so no build step) and prints it as before. `/reference/awf` is written
  for the site around those files: a heading and a sentence or an example per command, then its
  help included verbatim in a fenced block with `<!--@include: -->` (M5). The files are text,
  not Markdown: the terminal prints them as they are, and `<file>` in Markdown prose is an HTML
  tag. A Node build ([[node-runtime]]) would have to bundle them.
- **Site map:** below. The reader's path is: what it is and whether to trust it (landing page,
  Get started), one workflow running (Quick start), how to do a thing (Learn, Patterns), the
  exact options (Reference). Learn is ordered by idea: **agents** do the work, **workflows**
  orchestrate them, **runs** make it durable, and the in-depth topics build on durable runs.
  Pages are few and long, so an API change touches few of them.
- **Site basics, all VitePress settings:** `cleanUrls` (`/guide/agents`, no `.html`), a
  `sitemap` for agents.wf, a 404 page that links the guide and search, and every page's
  frontmatter `title` and `description`, which become its `<title>`, meta description and
  link-preview text, and its line in `/llms.txt`. A build check fails on a page without them.
- **Writing rules,** in `site/AGENTS.md` so every agent writing a page follows them: second
  person and present tense; code before prose; one word per idea, the ones How it works defines
  (a run is never also a "job"); `wf` is a workflow's context and `wfa` the agent's command;
  placeholders as `{name}` in prose and `<name>` only inside CLI usage; no claim about spend
  beyond the records' own words; no private project's name. Links to files in the repository are
  full GitHub URLs on `main`, which the dead-link check doesn't follow, so a moved file is found by
  `grep`, not the build.
- **A guide page's shape:** what it is for, the smallest working example, the details, the
  catches, then links to its Reference entry and a Pattern.
- **Samples are checked code.** The API page keeps today's check: the samples test runs every
  sample on it. On other pages a sample longer than a line is imported from a `.ts` file that tsc
  and `awf test` already check (VitePress's `<<<` code import), or checked by the same test
  extended to every page, whichever M3 shows is simpler. Either way a sample can't go stale
  without a red check.
- **Trust is in the content,** not a badge:
  - Each page's catches say what awf doesn't do there; Durability says what survives what; Security lists the known
    gaps from `docs/status.md` (an agent outside a sandbox has the operator's authority; a
    sandboxed agent still spends the operator's login).
  - The landing page's "Where it is" says it is in its evaluation phase and invites an issue on
    GitHub for a missing use case or a design idea; the overview's "Help shape it" says the same.
    It links what runs today (`docs/status.md`), how awf is tested (`docs/testing.md`) and what
    was measured (`docs/findings/`) on GitHub. The site doesn't restate them.
  - Patterns give each workflow's estimated cost and time from a recorded run.
  - Claims about spend follow the records' own words: a headless claude being "metered" is a
    rule, not a bill.
- **One home per fact.** Subscription and metered billing are explained on `/guide/harnesses`
  and linked from cost, troubleshooting and the reference; "not built yet" lives in
  `docs/status.md`, linked from the landing page and the API page.
- **Agent outputs:** nothing is written twice. Each page has one `.md` source, and the build makes
  everything else from it: the HTML page, the same Markdown served at `{page}.md`, its entry in
  `/llms.txt` and its part of `/llms-full.txt`. `{page}.md` is the source as a reader needs it, not
  as stored: frontmatter stripped, every `<<<` import and `<!--@include: -->` expanded into the code
  it names, Vue components dropped. A raw file would hand an agent an import line where the
  sample should be. `/llms.txt` opens with written
  guidance, as Mastra's does: when to use agents.wf, how an agent should use these docs (append
  `.md` to any page; read the Reference before writing code), the rules `awf init`'s AGENTS.md gives
  (typecheck, `awf test`, no `awf run` unless asked), and the common starting points. Then every
  page with its one-line description (from frontmatter) and its `.md` URL. `/llms-full.txt`
  concatenates every page but the landing page in sidebar order. A section's index page, `/guide/`,
  is `/guide/index.md`. Every HTML page links its `.md` in a
  `<link rel="alternate" type="text/markdown">`. A community VitePress plugin or a build script of our own, whichever M1
  shows is simpler. `/reference/workflow-api` stays one page with a stable anchor per call
  (`#agent-run`), so an agent gets the whole API in one fetch.
- **Deploy:** GitHub Actions on every push to main, and by hand: build `site/` and deploy
  `site/.vitepress/dist` to Cloudflare, with agents.wf as its custom domain. Not filtered by
  path: the site reads `site/`, the help files, `examples/` and the agentswf manifest, and a
  filter that misses one leaves the site stale; a build takes seconds. A newer push cancels a
  running deploy. A failed build deploys nothing, so the live site stays as it was. No preview
  deploys until there is a second contributor.

### Site map

```
/                         Landing page, below

Get started
  /guide/                 Why agents.wf: the problem, who it's for, when not to use it; why not
                          a loop over `claude -p`, why not an agent's own subagents
  /guide/install          Bun, macOS or Linux; a table of harness × what it needs (login,
                          Herdr for panes, claude subscription in panes only); srt or docker;
                          editor types; updating
  /guide/quick-start      awf init → first run → read the result, in 10 minutes
  /guide/how-it-works     the words (workflow, run, agent, turn, outcome, harness, pane,
                          stage) and the engine's side: the agent's socket, the wfa commands an
                          agent uses in its session, the record

Build with AI
  /ai/                    a coding agent writes the workflow: llms.txt, a .md for every page,
                          the AGENTS.md awf init writes, typecheck and awf test as the safety
                          net, reviewing what the agent wrote

Learn: agents, who does the work
  /guide/agents           calling an agent: opening one, giving it work, a typed answer
                          (schemas), what each ending means (the outcome kinds and reasons),
                          several turns, compact, set, fork; instructions and skills
  /guide/harnesses        claude, codex, pi, cursor; models and effort; subscription and
                          metered (the one home); panes in Herdr or headless, layout, keepPane
  /guide/sandboxes        srt and docker: what an agent can write and reach; shared or private
  /guide/tools            an agent calls your code mid-turn

Learn: workflows, orchestrating agents
  /guide/workflows        a workflow file: args, result, report; control flow is plain TypeScript
  /guide/parallel         fan out, concurrency, results in order, fan in
  /guide/loops            loop until approved, branch on an outcome, one agent checks another
  /guide/deadlines        Deadlines and nudges: timeouts, check-ins, nested deadlines, stopping
                          a run on purpose
  /guide/messaging        agents talking on routes the workflow grants
  /guide/decisions        fast typed questions to a decision model
  /guide/testing          awf test: scripted answers, no agents, free

Learn: runs, durable, named, resumable
  /guide/runs             a run's id, attempts and status; how it ends; stages; continuing a
                          stopped run, --from-stage, starting part-way; its record in .awf/runs
  /guide/durability       what survives what: a failed step, a stop, a crash, a closed laptop, a
                          code change between attempts; what a continue reuses and redoes
  /guide/following-runs   awf runs, awf logs: watching a run, yourself or from another agent

In depth
  /guide/events           runs that wait, parked with no process; event workflows, awf emit,
                          the mailbox, a run per key; timers, race, select, sleep
  /guide/people           a person or app outside the run: questions, waiting hours, an agent
                          kept warm between turns; answering from outside with awf inbox,
                          reply and send (holder-cli.md, moved here); how a chat app such as
                          Slack connects, with a sketch
  /guide/hosting-events   what keeps a waiting run alive: awf tick on a schedule (cron,
                          launchd, --all), a webhook or CI job calling awf emit
  /guide/calling-session  a workflow driving the session that started it: awf run --here,
                          forkCaller; writing a skill so a session calls your workflow

Running: the operator's side
  /guide/cost             time, tokens, estimated cost; plan allowance
  /guide/security         a workflow is trusted code; .env; what awf refuses; the known gaps
  /guide/troubleshooting  login, Herdr, metered claude, an agent that never answers

Patterns: one problem, one workflow, why it's shaped that way, its cost and time; each links a
runnable, tested example
  /patterns/review-loop          implement, review, revise until approved
  /patterns/plan-implement       plan, implement, review, as stages
  /patterns/review-on-event      review a merge request when it opens (event-sketches/mr-review)

Reference
  /reference/workflow-api   every call, its options and defaults; one page, an anchor per call
                            (docs/workflow-api.md, moved here)
  /reference/testing-api    agentswf/testing (the API page's "Testing a workflow", moved here)
  /reference/awf            every awf command, options, exit codes, from its help file
  /reference/wfa            every wfa command an agent runs: flags, exit codes, refusals, limits
  /reference/data           where awf keeps what: .awf/runs and a run's record (output.json,
                            events), ~/.awf (projects, coordinator), what is safe to delete
  /reference/configuration  environment variables, files awf reads
```

### Landing page

VitePress's home layout, its content written to make the case in one scroll; the visual design is
a later task (Q11). Top to bottom:

1. **Hero.** Name "agents.wf". Headline: "Workflows for coding agents, in TypeScript." Tagline:
   "Hand work to Claude Code, Codex, pi or Cursor. Have one check another, loop until the
   reviewer is happy, and get typed answers back." Actions: Get started (quick start), Why
   agents.wf, GitHub. Beside it, `bun add -g agentswf@beta` with a copy button.
2. **The code first.** A review loop of about 15 lines, imported from a checked example: open an
   implementer and a reviewer on another model, loop until the reviewer's typed answer approves.
   One line under it: "Control flow is yours: `for`, `if`, `Promise.all`. The engine handles the
   agent that goes quiet, answers in prose, or hangs."
3. **Six feature cards,** each linking its guide page:
   - **Typed answers.** A schema in, a validated value or a reason out; never prose to parse.
   - **The agents you already use.** claude, codex, pi, cursor, on your own logins; Claude Code
     in a pane runs on your subscription.
   - **Watch them work.** Each agent in a Herdr pane you can read and type into, or headless.
   - **Runs that survive.** Ids, stages, continue after a crash or a closed laptop.
   - **Runs that wait.** Events, timers and people, for days, with no process left running.
   - **Tested for free.** `awf test` runs a workflow on scripted answers: no agents, no cost.
4. **How it works.** The README's diagram: your workflow, `awf run`, the agents, and the typed
   answer coming back over the agent's socket.
5. **Built for agents to write.** "Point your coding agent at `agents.wf/llms.txt`": every page
   as Markdown, the API on one page, `awf init`'s AGENTS.md, typecheck and `awf test` as the
   safety net. Links `/ai/`.
6. **Honest about where it is.** MIT and open on GitHub; in evaluation, an issue on GitHub
   for a missing use case or a design idea; how it is tested and what was measured, on GitHub.
7. **Closing call.** "Your first workflow in 10 minutes", to the quick start.

Top navigation: Guide, Patterns, Reference, the version, and GitHub and npm icons. The
sidebar shows only pages that exist.

Alternatives rejected:

- **Group the guide by API area** (agents, parallel, stages, sandboxes, …), the first draft. It
  mirrors the reference, and a newcomer can't tell which pages are the core.
- **Many short pages** (sessions, skills, panes, timers, keep-alive each alone), the second
  draft. Every API change in beta would touch more of them.
- **An Examples section named after the examples.** A reader looks for "review loop", not
  `catalogue-review`; Patterns name the problem and link the example.
- **A Project section** (how awf is tested, measurements, status, lab, contributing), the third
  draft. That is for developing awf and would overwhelm a visitor; the landing page links it on GitHub.
- **Separate pages for typed answers, outcomes, participants and the `wfa` commands.** Each is
  part of one idea a reader learns once: calling an agent, people outside the run, how it works.
- **Keep `docs/workflow-api.md` and write a site page from it.** Two copies of 1,100 lines drift;
  the file moves instead.
- **A "compared with" page.** Trust when fair, but it goes stale and invites argument; Why
  answers "why not a script" without naming anyone.
- **`/llms-small.txt`.** A third file to curate; the whole site likely fits an agent's context.
  Added only if M2 shows agents need it.
- **Deploy on a release, from a `v{version}` tag.** The site would always match the installed
  release, but a docs-only fix or a new pattern would wait for one, and a manual deploy between
  releases would publish main's pages anyway.
- **Generate `/reference/awf` from `awf help reference` and check it for staleness.** No engine
  change, but a second copy kept equal by a check, and no room for prose around the help.
- **`site/` as a workspace.** One install for everything, but VitePress, Vue and their tree land
  in the root lockfile every package installs against.
- **Publish selected files from `docs/` via a list.** No new copy, but public and internal sit
  side by side, and the pages keep the repository's structure instead of the site's.
- **Move internals out of `docs/` and make `docs/` the site.** Breaks every link in AGENTS.md,
  the stories, the ADRs and memory, for a name.
- **Mintlify or another hosted docs product.** Agent support out of the box, but the pages live
  in their format and their build.
- **Starlight.** As capable, and its references (opencode, biome) are close in audience;
  VitePress chosen 2026-10-31 for a lighter build and the most reference sites with llms.txt.

## Tasks at a glance

- [x] 1. `site/` builds locally with VitePress, standalone, with the version in its header
- [x] 2. The existing docs are reorganized: the user docs and each command's help move into their
  one home, and every link follows
- [x] 3. The landing page and Get started are written
- [x] 4. The build serves each page's source as `{page}.md`, with `/llms.txt` and `/llms-full.txt`;
  Build with AI is written
- [x] 5. Learn: agents — agents, harnesses, sandboxes, tools
- [x] 6. Learn: workflows — workflows, parallel, loops, deadlines, messaging, decisions, testing
- [x] 7. Learn: runs — runs, durability, following runs
- [x] 8. In depth — events, people, hosting events, calling session
- [x] 9. Running — cost, security, troubleshooting
- [x] 10. Patterns — review loop, plan-implement, review on event; the examples' README follows
- [x] 11. Reference — workflow API edited for the site, testing API, awf, data, configuration
- [ ] 12. The whole site is reviewed locally for content and UX, with the operator, before it is
  public
- [ ] 13. A push to main deploys agents.wf on Cloudflare; manifests and `awf init` point at it

Nothing is public until task 13: the site is built and read locally first, so content and UX are
settled before agents.wf, npm's `homepage` and `awf init`'s template point at it.

## Open questions

None.

Settled 2026-10-31 and 2026-11-01:

- Q1. VitePress with its default theme; the look can change later through its theme.
- Q2. `site/`, standalone: own `package.json` and lockfile, outside the workspaces.
- Q3. No Markdown lint or format beyond what VitePress does: its build fails on a dead link.
- Q4. The GitHub README keeps its purpose; only its links to the moved API page change. The site
  is for browsing the docs, learning about the project and its features, and giving a visitor
  trust and confidence in it.
- Q5. The site has its own structure and may say more than the repository's files. Examples'
  READMEs are not copied.
- Q6. Cloudflare, for the custom domain.
- Q7. Each `awf` command's help moves to a text file the command imports, and `/reference/awf`
  includes the same files: one copy, no generated page.
- Q8. The site documents no skill: no new one for writing workflows, and not the two in
  `packages/engine/skills/`.
- Q9. The site deploys on a push to main, so docs evolve on their own; the header names the
  released version. It goes live once, after the whole site is read and approved locally
  (2026-11-01); deploying is the last task.
- Q10. One release line, beta, and the header names its version. Docs for other lines (a
  `beta.agents.wf`) wait for a stable release.
- Q11. This story writes the landing page's content on VitePress's home layout (above); its
  visual design is a separate task.
- The site map above: Learn ordered agents, workflows, runs, then in depth; sandboxes and panes
  in agents; orchestration (parallel, loops, deadlines) in workflows, apart from what makes a run
  durable. The subagent review of 2026-11-01 merged short pages, added install, hosting events,
  an event pattern and the trust content, and cut lab, contributing, beta and llms-small as
  pages.
- The site gives enough guidance, not everything: no Project section (testing, measurements and
  status stay on GitHub, linked from the landing page); typed answers and outcomes fold into
  `/guide/agents`, participants into `/guide/people`, the `wfa` commands into how it works;
  calling the session that started a run is in depth, not in Build with AI.
- User docs live only in `site/`: `docs/workflow-api.md` and `docs/holder-cli.md` move there;
  `docs/` keeps what is for developing awf.

## To measure

- **M1.** Does a VitePress llms plugin produce `{page}.md` with imports and includes expanded,
  `/llms.txt` with a written preamble, and `/llms-full.txt` as above, or is a build script simpler?
  Does it offer a "copy page as Markdown" button, as ai-sdk.dev has? Take it only if it comes free.
- **M2.** Does a fresh claude or codex session, told only "agents.wf documents awf", find and use
  the API page's Markdown to write a working workflow? The cheapest proof the agent support works.
- **M3.** For pages other than the API page: does VitePress's `<<<` import read `.ts` files
  outside `site/` (from `examples/` or a snippets folder the root tsc checks), or is extending
  the samples test to every page simpler?
- **M4.** Which Cloudflare product serves the static build (Pages, or Workers static assets), and
  does it serve `{page}.md` as `text/markdown`, or does it need a `_headers` rule?
- **M5.** Does `<!--@include: -->` read a file outside `site/` (`../packages/engine/src/help/`),
  and does the dev server reload when one changes? The CLI reference depends on it.

## Task details

### 1. `site/` builds locally with VitePress, standalone, with the version in its header

Outcome: `bun install && bun run build` in `site/` produces a site with a placeholder landing page
and one guide page, the header names the version from `packages/agentswf/package.json`, and the
root install, lockfile and checks are untouched.

Execution: the template's Plan, Implement, Review, Resolve and Verify steps.

Work:

- `site/package.json` (private, not a workspace), `bun.lock`, `.vitepress/config.ts` with the
  default theme, title, nav with the version, sidebar, local search, `lastUpdated` and
  `editLink`; `site/.gitignore` for `dist` and `cache`.
- `site/AGENTS.md` with the writing rules and the guide page's shape from Proposed design.
- One sample imported with `<<<` from a checked `.ts` file (M3), and one help file included from
  outside `site/` (M5).
- `!site` in `biome.json`; `site/` in AGENTS.md's table with how to build it.

Done when:

- The build passes and fails on a deliberately dead link.
- Root `bun install` leaves `bun.lock` unchanged; `bun run check` passes.

### 2. The existing docs are reorganized: the user docs and each command's help move into their one home, and every link follows

Outcome: every user-facing fact that will be on the site has one home before any page is
written, so no page is written from a copy that then drifts. `docs/` holds only what is for
developing awf.

Execution: the template's steps. Content is moved, not rewritten: the edit for the site happens
in the task that owns the page (8 for people, 11 for the API page).

Work:

- `git mv docs/workflow-api.md site/reference/workflow-api.md`. Its "Testing a workflow" section
  moves to `site/reference/testing-api.md`: it documents `agentswf/testing`, its own import. The
  old path keeps one line pointing at the new file on GitHub, for folders `awf init` already set
  up. `tests/workflow-api-samples.test.ts` reads both pages.
- `git mv docs/holder-cli.md site/guide/people.md`, as is; task 9 writes the page around it.
- Each command's help, `emitUsage` and the ten more in `packages/engine/src/*-command.ts`,
  moves to `packages/engine/src/help/{command}.txt`, imported as text; `commands.ts` and its tests
  read the same strings.
- Links to the moved files follow, as repository paths so they work in a clone and on GitHub:
  the README's three, `docs/status.md`, `docs/testing.md`, `docs/adding-a-harness.md`,
  `docs/design/messaging.md`, `examples/README.md`, and the moved files' links to each other. The
  moved files' links into `docs/` and the repository become full GitHub URLs, per the writing
  rules. Mentions in `docs/design/pane-layout.md`, `docs/research/` and the stories
  are history and stay.
- `docs/status.md` keeps "What runs today" and "Known gaps": they are the state of development,
  which the landing page links; the site's pages say what a user can do, not what changed when.

Done when:

- `grep` finds no link to `docs/workflow-api.md` or `holder-cli.md` outside stories, research and
  design history; the samples test passes on both pages; `awf {command} -h` and
  `awf help reference` print exactly what they did and the help tests pass unchanged;
  `bun run check` and the site build pass.

### Writing a section: tasks 3, 4's `/ai/`, and 5–11

Each writing task lists its pages and what each is written from. The sources are inputs, not
copies: a page says what a user needs, in the site's words, and is checked against the code,
because the design docs describe intent and may be behind it. Every page is in the guide page's
shape, has a `description`, and its samples are checked `.ts` files, imported.

Execution: the template's steps, a section at a time. Its review is two fresh agents with
different lenses: one checks every claim and option against the code; one reads as a newcomer who
has never seen awf and marks every place it had to guess, every word used before it was
explained, and every page it couldn't finish. Their findings are fixed before the section is
committed.

Every writing task is done when the build passes, both reviews have no open finding, and the
sidebar shows the section's pages.

### 3. The landing page and Get started are written

Outcome: a newcomer can go from the landing page through install and the quick start to a first
run, and knows what awf is, how it works and what it doesn't do.

| Page | Written from |
| --- | --- |
| `/` | the landing page plan above; the README; the review loop from `examples/minimum-review/` |
| `/guide/` | the README's opening; `docs/foundation.md` §1; `docs/design/writing.md`'s motivation |
| `/guide/install` | the README's install; each harness's requirements in `packages/harness/`; `docs/findings/` for metered claude |
| `/guide/quick-start` | `awf init` and its template; `examples/quick-check/` |
| `/guide/how-it-works` | the README's diagram; `docs/design/README.md`'s three interfaces; `engine/src/agent-cli` for the `wfa` commands |

Done when, beyond the shared bar: the quick start, followed word for word in an empty directory
with `agentswf@beta` from npm, ends with the result it shows, in the time it claims.

### 4. The build serves each page's source as `{page}.md`, with `/llms.txt` and `/llms-full.txt`; Build with AI is written

Outcome: the build output has the agent files described in Proposed design, and `/ai/` tells a
reader how to point their agent at them.

Execution: the template's steps; M1 settles plugin or script first.

Work:

- The llms plugin or a build step; the written preamble; frontmatter `description` on every
  page; the `rel="alternate"` link.
- `/ai/`, a writing task (below), from `awf init`'s `AGENTS.md.template` and the files this task
  builds.

Done when:

- A build check asserts every HTML page has its `.md`, no `.md` holds a `<<<` or `@include`
  directive, and `/llms.txt` lists every page with its description.

### 5. Learn: agents, who does the work

| Page | Written from |
| --- | --- |
| `/guide/agents` | the API page's "Agents"; `examples/output-schema/`, `single-agent-review/`, `compaction/`, `fork/`, `skills-probe/` |
| `/guide/harnesses` | the API page's harness options; `packages/harness/`; `docs/design/pane-layout.md`; `examples/effort/`, `pane-layout/`; `docs/findings/` for subscription and metered |
| `/guide/sandboxes` | the API page's "Sandboxes"; `docs/design/permissions.md`; `examples/sandboxes/` |
| `/guide/tools` | the API page's "Tools"; `examples/tools/` |

### 6. Learn: workflows, orchestrating agents

| Page | Written from |
| --- | --- |
| `/guide/workflows` | the API page's "A workflow file"; `examples/minimum-review/` |
| `/guide/parallel` | the API page's `parallel`; `examples/catalogue-review/` |
| `/guide/loops` | `examples/minimum-review/`, `single-agent-review/`, `triage/` |
| `/guide/deadlines` | the API page's "Deadlines"; `examples/nudges/` |
| `/guide/messaging` | the API page's "Messaging"; `docs/design/messaging.md`; `examples/messaging/` |
| `/guide/decisions` | the API page's "Decisions"; `examples/triage/` |
| `/guide/testing` | the testing API page; the examples' `workflow.test.ts` |

### 7. Learn: runs, durable, named, resumable

| Page | Written from |
| --- | --- |
| `/guide/runs` | the API page's "Stages"; `docs/design/runs-and-stages.md`; `examples/feature-delivery/`; `awf run`'s help |
| `/guide/durability` | `docs/design/runs-and-stages.md` and `reconciled-runs.md`, checked against the engine's code for each claim |
| `/guide/following-runs` | `awf runs` and `awf logs` help |

### 8. In depth

| Page | Written from |
| --- | --- |
| `/guide/events` | the API page's "Events"; `examples/event-sketches/`, `approval-reminders/` |
| `/guide/people` | the moved holder page; the API page's coordinator; `docs/design/messaging.md`; `examples/keep-alive/`; a Slack sketch, prose only |
| `/guide/hosting-events` | `awf tick` and `awf emit` help; `examples/event-sketches/*-tick.ts` |
| `/guide/calling-session` | `examples/calling-session/`, `fork-caller/`; `awf run --here`'s help |

### 9. Running: the operator's side

| Page | Written from |
| --- | --- |
| `/guide/cost` | the API page's "Logging and usage" and "Plan allowance"; `awf allowance`'s help; `docs/findings/`; never "charged" or "spent" from awf's records |
| `/guide/security` | `docs/design/permissions.md`; `docs/status.md`'s "Known gaps"; `docs/foundation.md` on trusted code |
| `/guide/troubleshooting` | the refusals the engine and harnesses print, found in the code |

Done when, beyond the shared bar: every refusal named on `/guide/troubleshooting` is one the code
prints.

### 10. Patterns: one problem, one workflow

| Page | Written from |
| --- | --- |
| `/patterns/review-loop` | `examples/minimum-review/` and its recorded runs |
| `/patterns/plan-implement` | `examples/feature-delivery/` and its recorded runs |
| `/patterns/review-on-event` | `examples/event-sketches/mr-review.ts` |

A pattern's cost and time come from a recorded run of its example; where none exists, the task
stops and asks the operator before a live run, which spends their login.

`examples/README.md` becomes the examples' index for running from a clone: what each example
shows and the page that explains it. Its guide prose, such as the run deadline and the default
nudge, is now on the site and is replaced by links.

### 11. Reference

| Page | Written from |
| --- | --- |
| `/reference/workflow-api` | the moved page, edited for the site: an anchor per call, links into the guide, no repository-relative links |
| `/reference/testing-api` | the moved "Testing a workflow", edited the same way |
| `/reference/awf` | the help files, included, with prose between them |
| `/reference/data` | `docs/design/runs-and-stages.md`; the record formats in `packages/contract/`; the engine's run-directory code |
| `/reference/configuration` | every `AWF_*` variable and file the code reads, found in the code |

Done when, beyond the shared bar: every call in the API page's "At a glance" has an anchor, and
every command in `COMMANDS` has its help file included on `/reference/awf`.

### 12. The whole site is reviewed locally for content and UX, with the operator, before it is public

Outcome: the operator has read the site on `bun run dev` and approved it; every finding below is
fixed or recorded as out of scope.

Execution: fresh agents first, the operator last.

Work:

- An editor agent reads the whole site in order, as one text: one word per idea across pages, no
  fact with two homes, every page reachable from the sidebar and linked to its neighbours, the
  writing rules in `site/AGENTS.md` kept.
- A UX pass in a browser on the dev server, desktop and mobile widths: navigation, search finds
  each page by its obvious word, code blocks fit, the landing page reads in one scroll, nothing
  rendered wrong (Vue, tables, anchors). Screenshots go to the operator.
- An examples pass: every sample on every page is traced to a checked file or the samples test;
  any that isn't is fixed.
- M2 run locally: a fresh claude or codex session pointed at the preview's `llms.txt` writes a
  working workflow, checked by `awf test`.
- The operator reads the site and lists changes; they are made and read again.

Done when:

- The operator approves the site, recorded here with the date.

### 13. A push to main deploys agents.wf on Cloudflare; manifests and `awf init` point at it

Outcome: a push to main updates agents.wf, with the site task 12 approved.

Execution: the template's steps; M4 settles the Cloudflare product first. The operator adds the
domain and the API token secret; the story says exactly which.

Work:

- `.github/workflows/site.yml`: on every push to main and by hand, with full history and a
  concurrency group that cancels an older run; a `_headers` file if M4 needs one.
- `homepage: https://agents.wf` in every `packages/*/package.json`; the `awf init` template points
  at `https://agents.wf/llms.txt` and the API page's `.md` (no test reads its links).
- The README's three links and the old `docs/workflow-api.md` pointer move to agents.wf URLs: the
  README is also npm's page, where a repository path doesn't resolve.

Done when:

- agents.wf serves the landing page, a docs page and its `.md` over HTTPS, with the released
  version in the header; a docs-only push redeploys it; M2 run once more against agents.wf.

## Verification

Automated:

- [ ] `bun run build` in `site/` passes, so no page has a dead link.
- [ ] The build has `/llms.txt`, `/llms-full.txt` and a `.md` for every page, with imports
  expanded.
- [ ] Every page has a title and description.
- [ ] Root `bun install` leaves `bun.lock` without VitePress; `bun run check` passes.

Manual or live evaluation:

- [ ] agents.wf serves the landing page, a docs page and its `.md` over HTTPS, naming the
  released version.
- [ ] M2 run once, on a cheap model.
- [ ] The quick start followed word for word in an empty directory works.
- [ ] Each section's newcomer review has no open finding.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

- 2026-11-01, task 1: VitePress 1.6.4. The sidebar is the site map filtered at config load to
  pages whose `.md` exists; a nav section (Guide, Patterns, Reference) shows once it has a page.
  The version links its npm page. `srcExclude` keeps `AGENTS.md` and `README.md` off the site.
- 2026-11-01, M3 settled: `<<<` reads files outside `site/`, in build and dev, and a missing file
  fails the build. A page's own samples live in `examples/site/{page path}.ts`, so root tsc,
  Biome, the boundaries and `bun test` check them as examples, with no new tsconfig, workspace or
  lockfile change; pages import them, or a whole example, as `<<< @/../examples/….ts#region`.
  Examples import the workspace names, so the config rewrites `@agentswf/contract/workflow` and
  `@agentswf/engine/workflow-testing` to `agentswf/workflow` and `agentswf/testing` in every code
  block, the mapping the samples test already uses. Task 4's `{page}.md` must apply the same
  rewrite. Extending the samples test to every page was not needed.
- 2026-11-01, M5 settled: `<!--@include: @/../packages/engine/src/help/{command}.txt-->` inside a
  fenced block works from outside `site/`, and the dev server sends an HMR update when the file
  changes. Surprise: VitePress leaves an include it cannot read in the page silently, so the
  config fails the build on any unresolved `@include`.
- 2026-11-01, task 2: the ten help strings are `packages/engine/src/help/{command}.txt` (reply's
  covers send), each ending in a newline; the command exports `help.trimEnd()`, so the strings,
  `awf {command} -h` and `awf help reference` are byte-identical to before (diffed). `bun-types`
  already declares `*.txt`, and the engine's `files: ["src"]` ships them (checked with
  `bun pm pack`). `awf allowance`'s help interpolated `HARNESS_NAMES` and `PLAN_BASIS`; the file
  holds their text and a test in `allowance-command.test.ts` fails when either changes.
- 2026-11-01, task 2: `testing-api.md` heads with `# Testing a workflow`, its subsections one level
  up; anchors are unchanged. Site-internal links are relative without `.md` (`../guide/people`),
  VitePress's recommended form; links into the repository are GitHub URLs on main. The API page's
  intro gained one sentence linking the testing page. `docs/design/messaging.md`'s Obsidian
  `[[workflow-api#Outcomes]]` became a Markdown path.
- 2026-11-01, M1 settled: a build step of our own, not `vitepress-plugin-llms` (1.14.0, tried on
  this site). The plugin reimplements `<<<` and `@include` itself: it left an `@include` inside a
  fence unexpanded, skipped the config's import rewrite, served `/guide/` as `/guide.md`, kept a
  frontmatter block and added no `rel="alternate"` link, each needing a workaround. Instead
  `site/.vitepress/llms.ts` wraps the Markdown renderer and records each page as VitePress renders
  it: the source after `@include`, with every fence's content as rendered (the `<<<` sample read,
  imports rewritten) and Vue components and SFC blocks dropped. `buildEnd` writes `{page}.md`,
  `/llms.txt` (`.vitepress/llms-preamble.md`, then the pages by site-map section, links
  root-relative so a local preview works) and `/llms-full.txt`; `transformHead` adds the
  alternate link. `bun run build` then runs `scripts/check-agent-files.ts`. No copy-as-Markdown
  button: it needs a custom theme component, not free.
- 2026-11-01, task 10: `/patterns/review-loop` walks `examples/messaging`, not `minimum-review`.
  The page's problem is implement, review, revise until approved, and `minimum-review` is one
  review round with no implementer and no revision; it is linked as the review step on its own.
  The messaging reviewer's prompt now sends the rule and each wrong slug with the expected one:
  its only recorded run sent the route's purpose alone, and the slugs stayed wrong.
- 2026-11-01, how the pages were made: one writer agent per page, from the sources in its task's
  table, checked against the code; then per page an accuracy reviewer (every claim, option and
  sample against the code) and per section a newcomer reviewer (reads cold, in sidebar order);
  the writer fixed every finding. Then an editor read the whole site in order, an examples pass
  traced every sample to a checked file or test (91 `<<<` imports; inline TypeScript only on the
  two reference pages, run by the samples test, and one-liners), and a UX pass in a browser at
  desktop and mobile widths. The reviews found and fixed, among others: a run without `present`
  prints its whole `output.json` record, not the value; claude runs any shell command
  (`--allowed-tools Bash`); a crashed run's panes are closed by the next pane run; npm's `beta`
  tag is stale, so the site installs `agentswf`.
- 2026-11-01, added to the site map: `/reference/wfa`, every `wfa` command's flags, exit codes,
  refusal codes and limits, so the Tools and Messaging guides teach and link instead of listing.
  `site/AGENTS.md` gained a "Where each fact lives" table and a schema-typing rule, the reviews'
  main finding being one fact on several pages.
- 2026-11-01, the help files were corrected where the reviews found them wrong (tick, emit, init
  and run exit codes; allowance's readers; reply's `accepted`); their tests updated where they
  pinned the old words. The root `.gitignore`'s `reference/` ignored `site/reference/`; it is now
  `/reference/`.
- 2026-11-01, the build also checks every internal link's `#anchor` and the landing page's
  frontmatter links (`site/scripts/check-links.ts`); VitePress checks neither.
- 2026-11-01, Patterns carry no cost or time yet: no recorded run of the current examples exists
  (the messaging run on disk predates the prompt fix; plan-implement's figures were for an older
  route). Each page marks the spot `TODO(operator)`; recording needs the operator's live runs.
- 2026-11-01, the operator's review: `/guide/limits` is cut. It mostly repeated catches other
  pages own, and it framed beta as a warning. The site says instead that agents.wf is in its
  evaluation phase and invites an issue on GitHub for a missing use case or a design idea (the
  landing page and the overview); Install's "Updating" runs the checks and hands what they find to
  the coding agent.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, decisions, review
  findings, verification results, deviations, and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
