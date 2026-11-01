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
doesn't do and what beta means, and links the evidence on GitHub (what is tested and measured,
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
- `docs/workflow-api.md` moves to `site/reference/workflow-api.md`, and `docs/holder-cli.md` into
  `/guide/people`; links to them in `docs/` and the README point at their new home. The old
  `workflow-api.md` path keeps one line pointing at the site, for folders `awf init` already set
  up.
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
- `docs/workflow-api.md` — moves (`git mv`) to `site/reference/workflow-api.md`; the old path
  keeps one line pointing at the site.
- `docs/holder-cli.md` — moves into `site/guide/people.md` and is deleted.
- `tests/workflow-api-samples.test.ts` — reads the page at its new path.
- `docs/status.md`, `docs/testing.md`, `docs/adding-a-harness.md`, `docs/design/messaging.md` —
  links to the moved files point at their site pages.
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
  - Limits says what awf doesn't do; Durability says what survives what; Security lists the known
    gaps from `docs/status.md` (an agent outside a sandbox has the operator's authority; a
    sandboxed agent still spends the operator's login).
  - Limits also says what beta means, and links what runs today (`docs/status.md`), how awf is
    tested (`docs/testing.md`) and what was measured (`docs/findings/`) on GitHub. The landing
    page's trust strip links the same. The site doesn't restate them.
  - Patterns give each workflow's estimated cost and time from a recorded run.
  - Claims about spend follow the records' own words: a headless claude being "metered" is a
    rule, not a bill.
- **One home per fact.** Subscription and metered billing are explained on `/guide/harnesses`
  and linked from cost, troubleshooting and the reference; "not built yet" lives in
  `docs/status.md`, linked from Limits.
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
  /guide/limits           what awf doesn't do, by design; what beta means; links to what runs
                          today, how it is tested and what was measured, on GitHub

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
  /reference/testing-api    agentswf/testing
  /reference/awf            every awf command, options, exit codes, from its help file
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
6. **Honest about where it is.** MIT and open on GitHub; beta, interfaces change between
   versions; what it doesn't do (Limits); how it is tested and what was measured, on GitHub.
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
  draft. That is for developing awf and would overwhelm a visitor; Limits links it on GitHub.
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

- [ ] 1. `site/` builds locally with VitePress, standalone, with the version in its header
- [ ] 2. The landing page, Get started, Build with AI and Learn are written
- [ ] 3. In depth, Running, Patterns and Reference are written; the user docs move into `site/`
- [ ] 4. The build serves each page's source as `{page}.md`, with `/llms.txt` and `/llms-full.txt`
- [ ] 5. A push to main deploys agents.wf on Cloudflare; manifests and `awf init` point at it

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
  released version. It goes live with the pages written so far.
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
  status stay on GitHub, linked from Limits); typed answers and outcomes fold into
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
- One sample imported with `<<<` from a checked `.ts` file (M3).
- `!site` in `biome.json`; `site/` in AGENTS.md's table with how to build it.

Done when:

- The build passes and fails on a deliberately dead link.
- Root `bun install` leaves `bun.lock` unchanged; `bun run check` passes.

### 2. The landing page, Get started, Build with AI and Learn are written

Outcome: a newcomer can go from the landing page through install and the quick start to any
Learn page, and from each to its reference.

Execution: the template's steps, a section at a time. Each section's review is two fresh agents
with different lenses: one checks every claim and option against the code, not only the old
docs; one reads as a newcomer who has never seen awf and marks every place it had to guess, every
word used before it was explained, and every page it couldn't finish. Their findings are fixed
before the next section.

Work:

- The pages in the site map's first five groups, each in the guide page's shape, from the
  README, `docs/workflow-api.md`, the examples and `docs/status.md`.
- Samples as checked `.ts` files, imported.

Done when:

- The build passes; `/guide/durability` is checked against the code, not only
  `docs/design/runs-and-stages.md`; every `awf` refusal named on `/guide/troubleshooting` is one
  the code prints.
- The quick start, followed word for word in an empty directory with `agentswf@beta` from npm,
  ends with the result it shows, in the time it claims.

### 3. In depth, Running, Patterns and Reference are written; the user docs move into `site/`

Outcome: every page in the site map exists.

Execution: the template's steps, with task 2's two reviews. A pattern's cost and time come from
a recorded run of its example; where none exists, the task stops and asks the operator before a
live run, which spends their login.

Work:

- The pages, from `docs/holder-cli.md`, `docs/status.md` and the examples' recorded runs.
- `git mv docs/workflow-api.md site/reference/workflow-api.md`, edited for the site; the old path
  keeps one line pointing at the page. `docs/holder-cli.md` folded into `/guide/people` and
  deleted. The samples test reads the new path; links in `docs/` and the README's three point at
  the site.
- Each command's help moved to `packages/engine/src/help/{command}.txt`, imported as text;
  `awf {command} -h` and `awf help reference` print exactly what they did. `/reference/awf`
  includes every file.

Done when:

- The build passes; every call in `workflow-api.md`'s "At a glance" has an anchor on
  `/reference/workflow-api`, and every command in `COMMANDS` has its help file included on
  `/reference/awf`; the help tests pass unchanged; the samples test passes on the moved page;
  `grep` finds no link to `holder-cli.md` outside stories.

### 4. The build serves each page's source as `{page}.md`, with `/llms.txt` and `/llms-full.txt`

Outcome: the build output has the agent files described in Proposed design.

Execution: the template's steps; M1 settles plugin or script first.

Work:

- The llms plugin or a build step; the written preamble; frontmatter `description` on every
  page; the `rel="alternate"` link.

Done when:

- A build check asserts every HTML page has its `.md`, no `.md` holds a `<<<` or `@include`
  directive, and `/llms.txt` lists every page with its description.

### 5. A push to main deploys agents.wf on Cloudflare; manifests and `awf init` point at it

Outcome: a push to main updates agents.wf.

Execution: the template's steps; M4 settles the Cloudflare product first. The operator adds the
domain and the API token secret; the story says exactly which.

Work:

- `.github/workflows/site.yml`: on every push to main and by hand, with full history and a
  concurrency group that cancels an older run; a `_headers` file if M4 needs one.
- `homepage: https://agents.wf` in every `packages/*/package.json`; the `awf init` template points
  at `https://agents.wf/llms.txt` and the API page's `.md` (no test reads its links).

Done when:

- agents.wf serves the landing page, a docs page and its `.md` over HTTPS, with the released
  version in the header; a docs-only push redeploys it; M2 run once.

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

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, decisions, review
  findings, verification results, deviations, and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
