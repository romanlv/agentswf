---
id: "009"
title: Run agents.wf on another machine from GitHub
summary: One naming rule across the repository, an engine that provides the author surface to a workflow in any folder, `claude.ts` rewritten from scratch, a README that marks it an early preview and says how to install from a clone, and v0.0.1 tagged and running on the operator's second machine. npm waits for the launch.
type: story
status: draft
discovered_in: "ADR 0005, 2026-09-27"
depends_on: []
---

# Run agents.wf on another machine from GitHub

## Outcome

On a machine that has never seen this repository, the operator runs:

```sh
git clone git@github.com:agentswf/awf.git ~/.agentswf
cd ~/.agentswf && git checkout v0.0.1 && bun install
(cd packages/engine && bun link)          # awf on PATH
cd ~/workflows && awf run ./review.ts     # review.ts imports agentswf/workflow; nothing installed here
```

The workflow runs its agents the same way it would from a clone on the first machine. Updating
means `git pull && bun install`.

That is 0.0.1: a tag on GitHub, for the operator's own machines. Nothing is published to npm. That
is a launch, which happens once, when the repository and its docs are fit for strangers
([[npm-launch]]).

Getting there means four things that don't exist yet:

- **One naming rule.** The repository is `awf`, its packages are `@wf/*`, the domain is agents.wf,
  and the npm names will be `agentswf` and `@agentswf/*`. A reader should be able to tell which
  name means what.
- **A surface the engine provides.** Today a workflow outside the repository fails on its first
  import. It only works through `bun link` of `packages/contract` and a `link:` dependency in the
  workflow's folder.
- **Code that is ours.** `packages/harness/src/usage/claude.ts` was lifted from the private work
  agents.wf grew out of.
- **An install anyone could follow.** Nothing says what to install first, or how to write a
  workflow outside the repository. The README only says "Nothing here is published".

Every workspace package stays `private: true`. That flag does one thing, refuse an `npm publish`,
and nothing is published before [[npm-launch]].

Why now: the operator wants the engine on a second machine for personal workflows, and each week
the author surface grows makes every renamed import cost more. The operator's existing workflows
are upgraded along with the rename.

## Where it stands

As of 2026-09-28, nothing is built.

- **Settled:**
  - the names: agents.wf, `agentswf`, `@agentswf/*`, `agentswf/workflow`, `awf`, `wf`, and the
    repository `agentswf/awf`;
  - the engine provides `agentswf/workflow` and `typebox`;
  - Bun only;
  - MIT;
  - no npm until the launch;
  - `claude.ts` is rewritten from scratch;
  - the README marks the project an early preview.
- **Next: the code changes, tasks 1 to 4, on `main`.** The operator decided on 2026-09-28 that
  this story is built on `main`, not in a worktree.
  - Each task lands as its own commits, pushed as it goes.
  - The rename is one commit with nothing else in it, because other sessions work on `main` too.
  - Nothing in tasks 1 to 4 waits for the repository to move. No manifest carries a `repository`
    field before [[npm-launch]], and the README's clone URL can name `agentswf/awf` ahead of the
    transfer, since GitHub redirects.
- **Before task 1:** the operator decides the two package names in Open questions 1, since the
  directories move once.
- **Alongside, by the operator:** create the GitHub org `agentswf` and transfer the repository.
  Task 5 needs it done, since the second machine clones from there.
- **Last:** task 6, reserving the npm scopes and the look-alike names.
- **Still open:** the package names (1), and the second machine's OS (4).

## How it works

```text
second machine                                        any folder
──────────────                                        ──────────
~/.agentswf  (clone at v0.0.1)                        ~/workflows/review.ts
  bun install                                           import { … } from "agentswf/workflow"
  packages/engine ── bun link ──► ~/.bun/bin/awf        import { Type } from "typebox"
                                       │                          │
                                       └── awf run ./review.ts ───┘
                                           serves both imports from its own copies
```

**Installing is a clone.** `bun add github:agentswf/awf` would install the repository's root
package, which is the private workspace, and Bun can't take one package out of a subdirectory of a
git repository. So the clone is the install, and `bun link` in `packages/engine` puts its `awf` on
PATH. This was tried earlier, in a scratch `BUN_INSTALL`. A private repository needs the machine's
SSH key on GitHub, and nothing else.

**The engine provides the author surface.** Before `awf run` imports a workflow, it registers
`agentswf/workflow`, `typebox` and `typebox/value` as Bun virtual modules whose exports are the
engine's own copies. pi does the same for its extensions, with jiti aliases under Node and
virtual modules in its Bun binary. This has three effects:

- a workflow in any folder runs, with no install and no link there;
- the surface it runs against is always the engine's version;
- the schemas a workflow writes with `typebox` are the ones the engine checks results with.

For types in an editor, a workflow folder links the clone's contract (`bun link` in
`packages/contract`, then `bun link @agentswf/contract`) and maps `agentswf/workflow` to it in its
`tsconfig.json` `paths`. At the launch, this becomes `bun add -d agentswf`.

What people will ask first:

- **Why not npm now?** An npm package is public the moment it is published, and a launch happens
  once. With the repository private, the npm page would link to a 404. The work is recorded in
  [[npm-launch]].
- **Why not a compiled binary?** It is possible. A `bun build --compile` binary loads a
  TypeScript workflow from disk and serves it the virtual module (tried 2026-09-28). But it needs
  three things, and a Bun user needs none of them:
  - `wf` built at pack time;
  - the docker files embedded;
  - a package per platform.
- **Why not Node?** See [[node-runtime]].

## Scope

In scope:

- **The naming rule.** Apply it to package names, directories, the README, `foundation.md`'s
  naming note and ADR 0005.
- **The author surface.** `awf run` provides `agentswf/workflow`, `typebox` and `typebox/value`
  to the workflows it loads.
- **`claude.ts` rewritten** from Claude Code's transcript format, not from the lifted file.
- **What an install elsewhere needs.**
  - `awf --version`.
  - A check at start that refuses too old a Bun.
- **The README.**
  - It marks agents.wf an early preview.
  - It says how to install from a clone, and gives a first workflow.
- **A LICENSE** (MIT).
- **v0.0.1.** A git tag, installed on the second machine, and one of the operator's workflows
  run there.

Out of scope:

- **Anything on npm:** manifests, packing, publishing, release automation. [[npm-launch]] holds
  the research from this story, and its work.
- **Docs written for strangers, and making the repository public:** [[scrub-private-references]],
  then [[npm-launch]].
- **Node.js** ([[node-runtime]]), and a compiled binary.
- **Renaming the command's own names.** `awf`, `wf`, `~/.awf/runs`, `AWF_*` variables and
  docker's `awf.*` labels all stay.

## Context and evidence

- **Fact: the decision is recorded.** [[0005-published-as-agentswf]]:
  - agents.wf is the project;
  - `agentswf` is the package;
  - authors import `agentswf/workflow`;
  - the commands stay `awf` and `wf`.

  It kept the workspace packages as private `@wf/*`, and one published package. Since then, the
  operator has decided on matching names, on publishing every package at the launch, and on no
  npm before it. Task 1 amends the ADR.
- **Fact: the names are free,** checked 2026-09-28:
  - on npm, `@agentswf`, `@agents-wf` and `@agentwf` answer "Scope not found", and `@awf` is held;
  - the unscoped `agentswf` is free;
  - so are the GitHub names `agentswf`, `agents-wf` and `agentwf`.
- **Fact: an npm organisation can be created empty; an unscoped name can't.** `agentswf` is held
  only by publishing it, so it stays open to anyone until the launch. [[npm-launch]] records the
  fallback.
- **Fact: `private: true` only blocks publishing.** npm and bun refuse to publish a package that
  sets it. It changes nothing about installing, linking or running.
- **Fact: the internal `@wf/` names are widespread.** 81 TypeScript files import them, across
  `packages`, `examples` and `scripts`. 9 examples import `@wf/contract/workflow`.
- **Fact: a workflow is loaded in the engine's process.** `loadWorkflowFile` in
  `packages/engine/src/workflow-loader.ts` does `await import(pathToFileURL(absolute).href)`.
- **Fact: the engine can serve the surface as a virtual module.** Tried with Bun 1.4.0,
  2026-09-28:
  - `plugin({ setup(b) { b.module("agentswf/workflow", () => ({ exports, loader: "object" })) } })`
    serves a workflow in a folder with no `node_modules`, under `bun` and in a compiled binary.
  - `onResolve` with the same filter does not reach a bare import from outside the project.
  - A workflow's own `import "typebox"` failed until the engine served it too.
- **Fact: `isExecutableWorkflow` compares `kind` as a string,** not by `instanceof`. So the
  virtual module is about one version, not about identity.
- **Fact: `claude.ts` was lifted.** `packages/harness/src/usage/claude.ts` (111 lines) says it was
  "lifted from" a file in the private workspace.
  - A search for "lifted from" and "ported from" in the packages' source finds no other file.
  - [[scrub-private-references]] names two tests with ported comments. Those are test data and
    comments, not code, and that todo owns them.
- **Fact: `awf` has no `--version`.** `operator-cli.ts` prints only its usage line.
- **Fact: the commands already refuse `.env`.** The shebang is
  `#!/usr/bin/env -S bun --no-env-file` (f8d6071).
- **Fact: pane agents need Herdr; host agents don't.** A host agent is a subprocess per turn
  (`operator-runtime.ts`). So a first workflow with host agents needs neither Herdr nor a sandbox.
- **Constraint: others work on `main` at the same time,** and this story is built there too, by
  the operator's decision of 2026-09-28, instead of in a worktree ([[story-worktrees]]).
  - Story 008's branch merged in e09cb69, and no other worktree or unmerged branch exists
    (checked 2026-09-28).
  - Each commit names only its own files, so another session's uncommitted work never rides
    along.
  - The rename lands as one mechanical commit, announced to whoever is working on `main`.
- **Assumption, unverified: `env -S` works on the second machine.** It is fine on macOS and on
  GNU coreutils 8.30 or later.

## Code map

### Names

- **Package names and directories:** `packages/*/package.json`, `examples/package.json` and
  `experiments/*/package.json` (`@wf/*`).
- **Imports:** every `@wf/` import in `packages`, `examples` and `scripts`.
- **Scripts:** `scripts/check-boundaries.ts` and its test name packages and directories.
  `scripts/eval.ts` may name them too.
- **Docs:** `README.md`, `AGENTS.md`, `docs/adr/0005-published-as-agentswf.md`, and in
  `docs/foundation.md` the naming note, §6's package list and §13 question 1. So does every
  package's `AGENTS.md`, if directories are renamed.
- **Checked, unchanged:** `experiments/_archive/`, which is frozen evidence. If it breaks under the
  rename, it keeps its own names, and that is noted here.

### Author surface

- **Change:** `packages/engine/src/workflow-loader.ts`. Register the virtual modules once, before
  the first `import`.
- **Tests:** next to it. A workflow in a temporary folder with no `node_modules` imports
  `agentswf/workflow` and `typebox`, and gets the engine's copies.

### `claude.ts`

- **Rewrite:** `packages/harness/src/usage/claude.ts`, and whatever `readClaudeUsage` and
  `claudeProjectsDirectory` callers need.
- **Unchanged:** the harness's usage records (`./records`). They are ours, and the rewrite has to
  produce them.
- **Tests:** `packages/harness/src/usage/usage.test.ts` checks the result. Its real home-directory
  path is [[scrub-private-references]]'s to replace.

### Install

- **`packages/engine/src/operator-cli.ts`:** `--version`, from the engine's `package.json`, plus the
  git commit when run from a clone. Also the Bun version check, against a minimum declared once.

### Docs

- **`README.md`:**
  - the tagline, and a line marking it an early preview: expect it to change, and nothing is on
    npm yet;
  - how the names relate;
  - prerequisites: bun, git, and an agent CLI logged in;
  - optional: Herdr for pane agents, srt (plus bubblewrap on Linux) or docker for sandboxes;
  - install from a clone, and update;
  - a first workflow, run from a folder outside the clone, with its `tsconfig.json` for editor
    types;
  - that `awf` loads no `.env`, and how Jev still finds `OPENROUTER_API_KEY`;
  - where the design docs are.

  It replaces the line "Nothing here is published".
- **`LICENSE`:** MIT, at the root.
- **`docs/status.md`:** a line when v0.0.1 runs on the second machine.

## Proposed design

**The naming rule, one sentence per name:**

- **agents.wf** is the project, in prose and on the README.
- **`agentswf`** is its GitHub organisation and, at the launch, its npm package.
- **The repository is `agentswf/awf`,** named for the command, as `earendil-works/pi` and
  `sst/opencode` are.
- **`@agentswf/*`** are the workspace packages. The directory name is the package name:
  `packages/harness` is `@agentswf/harness`.
- **`awf`** is the operator's command and everything it owns at run time: `~/.awf/runs`, `AWF_*`,
  `awf.*` docker labels, `awf-*` containers. Tools named after it (`awf-lab`) follow it.
- **`wf`** is the agent's command.

The README says the derivation once: `awf` is agents.wf's initials, and `wf`, short for workflow,
is what an agent types.

`@agentswf` over the others: it is free on npm and GitHub, it is the package's own name, `@awf` is
held, and `@agents-wf` would give readers two spellings to keep straight.

GitHub's Agentic Workflows Firewall (`github/gh-aw-firewall`) also installs a command named `awf`.
It clashes only on a machine that has both, and a GitHub search for "awf" shows neither project
(checked 2026-09-28).

**The author surface.** `awf run` registers Bun virtual modules before it imports a workflow:

- `agentswf/workflow`, whose exports are the engine's own `@agentswf/contract/workflow`;
- `typebox` and `typebox/value`, whose exports are the engine's own copy.

A workflow that imports any other package installs it in its own folder. Nothing else in the
engine becomes importable by that route. The list is part of the author surface: adding a name
later is cheap, removing one breaks workflows.

There is no alias for the old `@wf/contract/workflow`, because the operator's workflows are
upgraded with the rename.

**`claude.ts`, rewritten.** The implementer writes it from what Claude Code writes under
`~/.claude/projects`, observed in real transcripts. It must not start from the current file's
code.

- The subagent that writes it gets a description of the format and of the record it must
  produce. It does not get the old file or the private one.
- The existing tests then check the result.
- Where the old code's behaviour was deliberate, such as walking the subagent tree because
  reading only the session file undercounts a delegating agent, the description states the
  behaviour, not the code.

Alternatives rejected:

- **Keep `@wf/*` internally (ADR 0005 as written):** the operator wants one set of names.
- **Publish 0.0.1 quietly to npm:** a public package whose repository link is a 404. The operator
  chose no npm before the launch.
- **GitHub Packages as a private registry:** it takes only scoped names, so `agentswf` can't be
  there, and every machine needs a token. A clone is one step and needs nothing new.
- **Git dependencies (`bun add github:…`):** they install the repository's root package, not one
  from a subdirectory.
- **The workflow folder's own copy of the surface at run time:** it can disagree with the engine,
  and a folder without an install can't run.
- **A getting-started page beside the README:** an early preview needs the install and one
  workflow, and one page holds both.

## Tasks at a glance

- [ ] 1. The repository follows one naming rule
- [ ] 2. `awf run` provides `agentswf/workflow` and `typebox` to a workflow in any folder
- [ ] 3. `claude.ts` is rewritten from scratch, and `awf` reports its version and refuses an old Bun
- [ ] 4. The README marks an early preview and says how to install from a clone; MIT LICENSE
- [ ] 5. v0.0.1 is tagged and running on the operator's second machine
- [ ] 6. The npm scopes and the look-alike names are reserved

## Open questions

### 1. Names

- **Scope:** decided 2026-09-28, `@agentswf`.
- **Repository:** decided 2026-09-28, `agentswf/awf`. `romanlv/awf` is transferred to a new
  `agentswf` organisation. GitHub redirects the old URL, and the clone needs one
  `git remote set-url`.
- **Look-alike names:** decided 2026-09-28, the operator reserves them, last (task 6).
  - The empty npm organisations `@agentwf` and `@agents-wf`.
  - The GitHub organisations `agentwf` and `agents-wf`.
  - The unscoped `agentswf` can't be reserved without publishing. See [[npm-launch]].
- **Two package names,** decided in the rename, since the directories move once:
  - `cli-agent` is internal jargon for the package that is the `wf` command.
  - `autoresearch` ships a command called `awf-lab`, under a different name.
  - Recommended: `@agentswf/wf` in `packages/wf`, and `@agentswf/lab` in `packages/lab`. Keep
    `contract`, `harness`, `sandbox` and `engine`.

### 2. Author surface

- **Old import name:** decided 2026-09-28, no alias.
- **`typebox`:** decided 2026-09-28, the engine provides `typebox` and `typebox/value`.

### 3. `claude.ts`

- **Clean-room rewrite:** decided 2026-09-28, the file is rewritten from scratch. Nothing
  consumes this repository, so its behaviour is free to change where the rewrite finds better.

### 4. Second machine

- **What OS is it?** On Linux, check `env -S`, and srt's bubblewrap requirement.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. The repository follows one naming rule

Outcome: every workspace package, directory, import, doc and ADR follows the rule in Proposed
design, and nothing else changes behaviour.

Execution:

- [ ] Plan:
  - the two package names are settled (open questions 1);
  - list every file the rename touches.
- [ ] Implement:
  - the mechanical rename;
  - `foundation.md`'s naming note, §6 and §13 question 1;
  - ADR 0005 amended, for the names, for publishing every package at the launch, and for no npm
    before it;
  - `AGENTS.md`, and each package's `AGENTS.md`.
- [ ] Review: have two read-only subagents review this task's actual diff and test output. One
  reviews architecture and scope, the other correctness and proof.
- [ ] Resolve: fix or disposition every finding.
- [ ] Verify: satisfy every `Done when` item.

Work:

- Rename in one commit, with no other change in it, so later work rebases through it with one
  find-and-replace.

Done when:

- `bun install`, `bun test` and `bun run check` pass.
- `grep -r "@wf/"` finds nothing outside `experiments/_archive/` and git history.
- `foundation.md`, ADR 0005 and `AGENTS.md` state the same rule.

### 2. `awf run` provides `agentswf/workflow` and `typebox` to a workflow in any folder

Outcome: a workflow outside the repository runs under `awf`, with nothing installed or linked in
its folder.

Execution:

- [ ] Plan:
  - decide where the plugin is registered, once per process, before the first workflow import;
  - check that every `typebox` subpath the examples use is served.
- [ ] Implement: the virtual modules in `workflow-loader.ts`.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings.
- [ ] Verify: satisfy every `Done when` item.

Work:

- `examples/` keeps resolving through the workspace, so the repository's own typecheck is
  unchanged.

Done when:

- A test loads a workflow from a temporary folder with no `node_modules` that imports
  `agentswf/workflow` and `typebox`, and gets the engine's copies of both.
- `bun run awf run {folder}/x.ts` reaches opening the workflow's first agent.

### 3. `claude.ts` is rewritten from scratch, and `awf` reports its version and refuses an old Bun

Outcome:

- the code that reads Claude Code's usage is agents.wf's own;
- `awf --version` answers;
- an old Bun gets a message instead of a strange failure.

Execution:

- [ ] Plan:
  - write the description of Claude Code's transcript tree and of the record to produce, from
    real transcripts;
  - choose the minimum Bun.
- [ ] Implement:
  - `claude.ts`, by a subagent given only that description;
  - `--version` and the Bun check in `operator-cli.ts`.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews. Both reviewers
  compare the new `claude.ts` with the old one for copied code, not only for behaviour.
- [ ] Resolve: disposition findings.
- [ ] Verify: satisfy every `Done when` item.

Work:

- The `claude.ts` rewrite and the version work are separate commits.

Done when:

- The harness's usage tests pass against the new `claude.ts`, and no line or comment of the old
  one survives.
- On one of the operator's real sessions, a subagent-delegating one included, the new
  `readClaudeUsage` gives the same totals as the old one, or a difference explained in the story.
- `awf --version` prints the version and, from a clone, the commit.
- With a Bun below the minimum, `awf` exits non-zero with a message naming both versions.

### 4. The README marks an early preview and says how to install from a clone; MIT LICENSE

Outcome: on the second machine, the operator needs nothing but the README.

Execution:

- [ ] Plan: pick the first workflow. It uses host agents only, so neither Herdr nor a sandbox is
  needed.
- [ ] Implement: the README and `LICENSE`.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews.
- [ ] Resolve: disposition findings.
- [ ] Verify: satisfy every `Done when` item.

Work:

- The early-preview line is short and plain: the interfaces will change, and nothing is on npm
  yet. Docs for strangers come with [[npm-launch]].
- Herdr and the sandboxes come after the first workflow, each as a step of its own.

Done when:

- A subagent with no repository context follows the README, from a fresh clone into a scratch
  `BUN_INSTALL`, and reaches `awf run` of the first workflow from a folder outside the clone.
- The README no longer says nothing is published. It says the project is an early preview.

### 5. v0.0.1 is tagged and running on the operator's second machine

Outcome: the second machine runs the operator's workflows from a clone at `v0.0.1`.

Execution:

- [ ] Plan:
  - the repository has moved to `agentswf/awf`, and this clone's remote points there;
  - the second machine has git, Bun, an SSH key on GitHub, and an agent CLI logged in.
- [ ] Implement: set the engine's version to 0.0.1, tag `v0.0.1` and push the tag.
- [ ] Review: the tag's tree passes `bun run check` and `bun test`.
- [ ] Resolve: a fix is `v0.0.2`. A tag is never moved.
- [ ] Verify: satisfy every `Done when` item.

Work:

- None beyond the tag and the install.

Done when:

- On the second machine, `awf --version` shows 0.0.1, and one of the operator's workflows runs
  there with a live agent.
- What it needed that the README didn't say is back in the README.
- `docs/status.md` says v0.0.1 runs from a clone, and how to install it.

### 6. The npm scopes and the look-alike names are reserved

Outcome: no one else can publish under agents.wf's names, or under the ones a reader would
mistake for them.

Execution:

- [ ] Plan: check each name is still free, as in Context.
- [ ] Implement, by the operator:
  - the npm organisations `@agentswf`, `@agents-wf` and `@agentwf`, empty;
  - the GitHub organisations `agents-wf` and `agentwf`, empty, with a profile that points to
    `agentswf`.
- [ ] Review: each name answers as held (`registry.npmjs.org/-/org/{name}/package` returns `{}`,
  `api.github.com/users/{name}` returns an organisation).
- [ ] Resolve: a name taken in the meantime is recorded in [[npm-launch]], with what it means for
  the launch.
- [ ] Verify: satisfy every `Done when` item.

Work:

- Last, because nothing before it depends on these names. The GitHub org `agentswf` isn't here: it
  comes first, since the repository moves into it before task 1.
- The unscoped npm names `agentswf` and `agentwf` can only be held by publishing, so they wait for
  [[npm-launch]].

Done when:

- All five names answer as held, and `docs/status.md` lists them.

## Verification

Automated:

- [ ] The author-surface test: a workflow from a folder with no `node_modules` loads.
- [ ] The harness's usage tests, against the rewritten `claude.ts`.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] The new `readClaudeUsage` against real sessions (task 3).
- [ ] `bun run eval` after task 1: the rename changed nothing live.
- [ ] One live workflow on the second machine, from `v0.0.1` (task 5).

## Review record

Record reviews under the task they cover.

### Refinement, 2026-09-28

- **Compared with pi, opencode and codex; Bun 1.4.0's packing tried.**
  - `bundleDependencies` fails under `bun add`.
  - The engine should provide the author surface, as pi does.
  - A compiled binary is possible, not impossible.

  The packing findings are in [[npm-launch]].
- **The operator's decisions:**
  - no alias for `@wf/contract/workflow`;
  - the engine provides `typebox`;
  - the scope is `@agentswf`, and every package publishes at the launch;
  - `autoresearch` included;
  - Node goes to [[node-runtime]];
  - MIT;
  - the repository is `agentswf/awf`;
  - look-alike names are reserved.
- **Reviewed for developers, publicity and the brand.** Four things came out of it:
  - `awf --version`, a Bun check, and a first workflow without Herdr or a sandbox, all kept here;
  - package names, "charged", and the sandbox limits in the README, moved to [[npm-launch]];
  - code lifted from private work;
  - a public npm page linking to a private repository.
- **The operator decided, on that review:**
  - `claude.ts` is rewritten from scratch;
  - nothing goes to npm before the launch;
  - the second machine installs from a clone;
  - the README says "early preview" instead of full docs.

  The story went from "install from npm" to "run from GitHub", and the getting-started page was
  dropped. The npm work moved to [[npm-launch]] whole.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [ ] Expensive interface, record-format, and stage-gate decisions are settled. The two package
  names are not.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope. The second machine's OS.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
