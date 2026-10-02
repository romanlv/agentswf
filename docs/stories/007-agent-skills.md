---
id: "007"
title: Give each agent the skills the workflow names
summary: A workflow names each agent's skills, as a path or a public skill in a git repository; the engine pins and copies them, and the agent sees exactly those, on the host or in a sandbox, under claude, codex and pi.
type: story
status: done
discovered_in: "ideas.md (unified skills; custom skills per agent), 2026-09-26"
depends_on: ["004"]
---

# Give each agent the skills the workflow names

## Outcome

A workflow decides which skills each agent has:

```ts
const planner = await workflow.agents.open({
  key: "planner",
  runtime: "planner",
  skills: [
    { path: new URL("./skills/ticket-doc", import.meta.url) },         // next to the workflow
    { repo: "vercel-labs/agent-skills", skill: "frontend-design", ref: "3f2a9c1" },
  ],
});

const reviewer = await workflow.agents.open({
  key: "reviewer",
  runtime: "reviewer",
  skills: [],                                                          // none of the operator's
  sandbox: box,
});
```

- **The agent sees exactly those skills**, plus what its harness will not give up: claude's bundled
  skills, and claude's and codex's working directory's own; pi keeps nothing else. The operator's
  personal skills are not among them. Two agents in one run, or in one
  sandbox, can have different sets.
- **It holds on the host and in a sandbox**, under claude, codex and pi. A harness that cannot hold
  the set refuses the agent at open; it never runs with more.
- **The run records what each agent had**: every skill's source, the commit a public one resolved
  to, and a digest of the files the agent got. Two runs with the same record gave their agents the
  same skills.

It matters now because autoresearch compares workflow variants, and skills are one of the
variables (foundation §8). Today an agent on the host has whatever the operator installed, which
differs between machines and changes during a run; an agent in a sandbox has none. Neither can be
varied, and neither is in the record. `AgentOpenSpec.skills` has been on the surface since Stage 1,
and the runner refuses it.

## How it works

```
 workflow: skills: [{path}, {repo, skill, ref}]
     │
     ▼
 1. resolve            path → real directory
     │                 repo → git fetch, cached by commit
     ▼
 2. check              SKILL.md name matches, no links,
     │                 under 10 MB
     ▼
 3. copy per agent     host:    {run}/agents/{agent}/skills
     │                 sandbox: {home}/skills
     ▼
 4. point harness      claude, codex, pi: each its own way
     │                 (see below)
     ▼
 5. record             source, commit, digest → output.json
```

Steps 1–3 and 5 are the engine's, on the host, and the same for every harness. Step 4 is the
harness adapter's.

**Resolve.** A `path` is a directory holding a `SKILL.md`, absolute or a `file:` URL: one beside
the workflow is `new URL("./skills/name", import.meta.url)`, which stays right when another
workflow calls it, where a relative path would not. A `repo` is a public skill as skills.sh names
it: `owner/repo` on GitHub or any git URL, the `skill` by the name in its `SKILL.md`, at `ref` or
the default branch. The engine fetches it with the host's git into a cache shared by runs and
keeps every commit it resolved there, so a run that pins one again needs no network.

**Check and copy.** Every agent gets a copy of its own, never a link to the source. A skill is code
the harness runs, so a link would let an agent change what the next agent runs, or what the
operator's own harness runs if the source is theirs. The copy refuses symbolic links: a link to
`~/.ssh` inside a skill would otherwise carry the key into a sandbox.

**Point the harness at it.** Each harness takes a different route (see
[`agent-skills`](../findings/agent-skills.md), K1–K12), and the harness package owns them:

- **pi** takes `--no-skills` and a `--skill` per directory, on the host or in a sandbox (K10).
  `--no-skills` also drops the working directory's own skills: pi keeps nothing else.
- **claude**, in a sandbox, finds them in its fresh home's `skills/` (K6). On the host it cannot
  have a home of its own, as its login is in the keychain. It gets `--add-dir` over a directory
  laid out as `.claude/skills/{name}` (K3), and `--setting-sources project,local` to leave the
  operator's out (K5). claude drops an `--add-dir` inside its working directory without a word,
  so a run root inside it refuses a claude agent given skills.
- **codex** can be pointed at a skill only through its home (K11). So a codex agent given skills
  always gets a home of its own, seeded as a sandboxed one's is, with `skills.bundled.enabled=false`.
  On the host, `HOME` stays the operator's so git and ssh work, and every skill in
  `~/.agents/skills` is turned off by its real path (K9). That home holds the credential and
  folder trust only: the operator's `config.toml` (providers, MCP servers, profiles) and
  `~/.codex/AGENTS.md` do not apply to it, and an operator logged in only by API key, with no
  `auth.json`, is refused.

**The case people ask about first: leaving `skills` out.** The agent keeps what it has today: the
operator's skills on the host, none in a sandbox. `skills: []` is how a workflow says "none of the
operator's". That keeps every existing workflow running unchanged, and the record says which case
each agent was in.

## Scope

In scope:

- `SkillRef` on the author surface, replacing `SkillName`: a `path` or a `repo` source.
- Resolving, checking, pinning and copying skills in the engine, with a cache for public ones.
- Each adapter's translation for claude, codex and pi, for headless turns, resumed turns and panes.
- Skills inside srt and docker sandboxes.
- The record in `output.json`.
- The docs this changes: `permissions.md` ("A skill is code"), foundation §7 and §10, and an ADR.

Out of scope:

- **Hooks.** See [[#Hooks later]]; this story leaves them room and builds none.
- **Tools and MCP servers.** Which built-in tools an agent may call stays the adapter's launch
  detail, and the harness-level `Grant` in `permissions.md` stays designed, not built.
- **Claude Code plugins and marketplaces** as a source. They are claude's alone and carry hooks and
  MCP servers with them.
- **A per-skill choice between invoking by name and loading by model decision.** Every harness
  lets the model pick; that stays.
- **cursor.** It has no skills route measured and is refused with any `skills`.
- **Operator ceilings**: an allowlist of repositories a workflow may fetch from. It returns with a
  stranger's workflow (`permissions.md`, open question 7).

## Context and evidence

- Fact: `AgentOpenSpec.skills?: readonly SkillName[]` exists, and `WorkflowContext.openAgent` in
  `packages/engine/src/workflow-runner.ts` throws on a non-empty list.
- Fact: `examples/feature-delivery/workflow.ts` passes `skills: ["ticket-doc"]` for its planner.
- Fact: every harness can be held to an exact set; the mechanism differs for each
  ([`agent-skills`](../findings/agent-skills.md) K3, K5, K6, K9, K10). codex reads the operator's
  `~/.agents/skills` through `HOME`, even with a home of its own (K7).
- Fact: claude ships 18 skills of its own, which go only if every skill goes (K4, K5). codex ships
  5, which a setting turns off (K8).
- Fact: on the host, an unsandboxed claude runs the operator's `SessionStart` hook and attaches
  their claude.ai connectors (K1). `--setting-sources project,local` removes the hook, not the
  connectors (K5).
- Fact: a sandboxed agent's home is under `{sandbox}/homes/`, which srt allows and docker mounts,
  and which the sandbox's agents can write (story 004). Under srt, `HOME` is the operator's and
  `~` is denied; under docker, `HOME` is the agent's home.
- Fact: skills.sh names a public skill by repository and name, and records the path and a folder
  hash in its lockfile (K12). Its CLI cannot install into a directory of our choosing.
- Constraint: foundation §7 puts request and report shapes in `contract`, resolution in `harness`,
  and fail-versus-downgrade in `engine`. §10's trigger for building it, "two adapters demonstrate
  what is actually portable", is met by three.
- Constraint: `permissions.md` says skills resolve by name from an operator-controlled root, and
  that a path from a workflow would be code injection. This story changes that; see
  [[#Proposed design]].
- Constraint: refuse, never downgrade (`permissions.md`, "Rules").
- Assumption: codex keeps reading `skills.config` from `-c` and `skills.bundled` in releases after
  0.157.1. The live eval catches a change.
- Assumption: a claude pane honours `--add-dir` skills and `--setting-sources` as `-p` does. Only
  `-p` was measured.

## Code map

### contract

- `packages/contract/src/workflow/agents.ts` — `SkillName`, `AgentOpenSpec.skills`: becomes
  `SkillRef`.
- `packages/contract/src/records.ts` — `OutputRecord`: gains the per-agent skill record.

### engine

- `packages/engine/src/workflow-runner.ts` — `openAgent`: drop the refusal; resolve skills before
  the channel opens, so a bad source fails the open; `assertCompatibleAgent` compares skills on
  reopen.
- `packages/engine/src/agent-launcher.ts`, `sandboxes.ts`, `sandbox-homes.ts` — where an agent's
  home and launch are prepared; the bundle is copied into the home here. `seedHome` also seeds an
  unsandboxed codex home.
- New `packages/engine/src/skills/` — resolve, check, fetch and cache, copy, digest. Pure checks
  apart from the files that do I/O, as `accounting` is.

### harness

- `packages/harness/src/spec.ts` — `interactive`, `headlessTurn`, `resumeTurn` and `TurnContext`:
  gain the skills arguments; `interactive(model)` has to take a context too.
- `packages/harness/src/sandbox-needs.ts`, `state.ts` — homes; codex's home becomes needed on the
  host as well.
- New `packages/harness/src/capabilities/` — the per-harness translation, where foundation §10
  put it.
- `packages/harness/src/adapters/herdr.ts`, `direct-process.ts` — pass the context through.

### sandbox

- Checked, no change expected: a home is already readable inside both providers. The conformance
  suite gains a case that a skill in a home is readable and not the source.

### examples and docs

- `examples/feature-delivery/workflow.ts` — `skills: ["ticket-doc"]` becomes a `path`.
- `docs/design/permissions.md`, `docs/design/README.md`, `docs/foundation.md` §7 and §10,
  `docs/status.md`, a new ADR.

## Proposed design

### The author surface

```ts
/** Where a skill comes from, as a record keeps it; its name is the one its SKILL.md gives. */
export type SkillSource =
  | { path: string }                                  // absolute
  | { repo: string; skill: string; ref?: string };    // owner/repo or a git URL

/** As a workflow names one: a path may also be a `file:` URL. */
export type SkillRef = SkillSource | { path: URL };

export interface AgentOpenSpec {
  /**
   * Exactly the skills this agent has, beside what its harness will not give up.
   * Absent, it has what it would have without awf: the operator's on the host, none in a sandbox.
   */
  skills?: readonly SkillRef[];
}
```

Objects, not a string grammar: foundation §7 says not to standardise one yet, and `owner/repo@name`
next to `./path` is a grammar. A bare string is refused with a message naming both forms, and so is
a relative path.

### The record

```ts
export type AgentSkillsRecord = {
  callPath: string[];
  agent: string;
  /** `operator` on the host when the workflow named none; in a sandbox, none named is `[]`. */
  skills: "operator" | SkillRecord[];
  /** The harness home of its own it ran with on the host: codex's. */
  home?: string;
};

export type SkillRecord = {
  name: string;
  source: SkillSource;
  /** The commit a `repo` source resolved to, an annotated tag peeled. */
  commit?: string;
  /** Where in the repository it was found. */
  within?: string;
  /** `sha256:` over the copied tree: each file's path, executable bit and bytes. */
  digest: string;
};

// OutputRecord gains:  skills?: AgentSkillsRecord[];
```

Beside `sandboxes`, not inside the accounting, for the same reason: an agent that failed before
its first turn still had them. An agent is recorded once it has a place for them; one refused
before that, by a source that would not resolve or a harness with no route, was given nothing.

### Rules

- **Resolved at open, before the channel.** An unreadable path, a repository that will not fetch,
  a `SKILL.md` without a `name` and a `description`, a name that does not match, a symbolic link, a
  tree over 10 MB, and two skills with one name each fail the open and name the cause.
- **Once per run.** A source resolves once per run, and a repository's ref once, so two agents,
  or two skills from one repository, cannot see two versions of `main`.
- **Every file, and only files.** A public skill is read from git's objects, not an archive, so
  `export-ignore` drops nothing; a link or a submodule refuses it before anything is written.
- **A copy per agent.** In a sandbox, the copy is in the agent's home. In one docker box, agents
  share a uid and can write each other's homes, so one could change another's skill: that is inside
  the trust boundary a shared sandbox already is.
- **Refuse, never downgrade.** A harness without a translation, today cursor, refuses an agent with
  `skills`.
- **Reopening compares.** Reopening an agent with a different `skills` rejects, as a different
  sandbox does.

### What changes in `permissions.md`

"A skill is code" stays; the conclusion changes. The workflow is code the operator runs with their
own authority, so a path it names is no more injection than its imports. What must not happen is an
agent writing code that runs later outside its reach. The copy per agent is what prevents it: no
agent ever writes the source, the operator's harness state, or another sandbox's copy. An operator
root to resolve bare names from is dropped; `{ path }` covers it. That decision goes in an ADR,
since it changes what foundation §7 and §10 say.

### Hooks later

Not built here. What would be needed, and why it fits:

- Hooks are not portable. claude's run on its own events and take `--settings` JSON, which applies
  whatever `--setting-sources` says; codex's live in its config; pi's are extensions loaded with
  `-e`. So hooks would be a separate field, per harness, not a kind of `SkillRef`.
- The pipeline carries them unchanged: a source, pinned, checked, copied per agent, recorded. The
  bundle directory and codex's own home this story adds are where they would go.
- A hook is code the harness runs. In a sandbox it runs inside it; on the host it runs with the
  operator's authority, as the workflow does.
- One thing this story already decides for hooks: a claude on the host given `skills` stops running
  the operator's hooks (K5). A workflow that wants those hooks leaves `skills` out.

Alternatives rejected:

- **Install with the skills CLI.** It writes into harness homes or the operator's, with no
  directory of our choosing (K12); on the host that is the operator's own state.
- **A symlink per skill instead of a copy.** Cheaper, and it hands the agent the source.
- **An operator-controlled root, names only**, as `permissions.md` designed. It cannot name a
  public skill, and a workflow could not ship its own.
- **claude plugins.** Namespaced names (K2), claude-only, and they bring hooks and MCP servers.
- **`HOME` pointed at the agent's home for codex on the host** (K9). It narrows skills, and also
  git's config, ssh and every CLI the agent calls.
- **Always an exact set, even with `skills` absent.** Cleaner, but it changes every existing
  workflow on the host. Open question 1.

## Tasks at a glance

- [x] 1. The surface, the record, and resolution in the engine
- [x] 2. Each harness holds the set on the host
- [x] 3. Each harness holds the set in a sandbox
- [x] 4. Live eval, docs and the ADR

## Open questions

Each was settled on its proposed default to build the story; the first was confirmed with the
story's approval.

### 1. The surface, the record, and resolution in the engine

- **Leaving `skills` out keeps the operator's skills on the host.** Built so: existing workflows
  run unchanged, `skills: []` opts out, and the record says `operator`. The alternative, always an
  exact set, is more reproducible and breaks agents that lean on an operator's skill without naming
  it. Confirmed by the approval of 2026-09-29.
- **Unpinned public skills are allowed**, resolved once per run per repository and ref, with the
  commit recorded. An autoresearch variant should pin; the variant runner can require it.
- **The cache** is `$XDG_CACHE_HOME/awf/skills`, else `~/.cache/awf/skills`: a bare repository per
  URL, every resolved commit kept under `refs/awf/commits/`.

### 2. Each harness holds the set on the host

- **claude's bundled skills stay**, as part of the harness like its built-in tools, unlisted in the
  record: they go only with every other skill (K4). A pane lists more of them than `-p` does.
- **`--setting-sources project,local` drops more than skills**: the operator's permissions, model
  settings, environment and hooks from `~/.claude/settings.json`. Accepted: a claude pane given
  skills started, used its skill and answered in the live eval.

### 3. Each harness holds the set in a sandbox

None.

### 4. Live eval, docs and the ADR

None.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. The surface, the record, and resolution in the engine

Outcome: a workflow can name skills; the engine resolves, checks, pins and copies them into a
bundle per agent and records them, and still refuses to launch an agent that has any, since no
adapter translates them yet.

Execution:

- [x] Plan: inspect the relevant code and tests, settle the cleanest module, interface, seam,
  invariants, failure behavior, and focused proof, and record material alternatives before coding.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: have two read-only subagents review this task's actual diff and test output—one for
  architecture and scope, one for correctness and proof.
- [x] Resolve: fix or explicitly disposition every material finding; request targeted re-review
  when a fix changes the selected architecture.
- [x] Verify: run this task's focused checks and satisfy every `Done when` item before checking the
  task in `Tasks at a glance` or starting the next task.

Work:

- `SkillRef` and the record types in `contract`; `feature-delivery` moved to `{ path }`.
- `engine/src/skills/`: resolve a path against the workflow file; fetch a repository into the cache
  by commit; find the skill by its `SKILL.md` name; check; copy; digest.
- `openAgent` resolves before the channel opens and compares skills on reopen.

Done when:

- Tests cover each refusal in [[#Rules]], a relative path, a `repo` source served from a local
  bare repository over `file://` (no network), one resolution per run for two agents, and a copy
  that does not change when its source does.
- `output.json` for a run with and without `skills` carries the record.

### 2. Each harness holds the set on the host

Outcome: an unsandboxed claude, codex or pi agent has exactly its skills, headless, resumed and in
a pane.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- `harness/src/capabilities/`: each harness's arguments, environment and home layout for a bundle.
- `TurnContext` and `interactive` carry them, on every turn and resume.
- codex's own home on the host, seeded and written back through `seedHome`; the operator's
  `~/.agents/skills` turned off by path, listed when each turn starts.
- cursor refused.

Done when:

- Unit tests fix each harness's argv and home layout, including the resumed turn and the pane.
- A live check per harness, on the host, reports `awf-probe` and none of a canary skill placed in
  the operator's root for the check.

### 3. Each harness holds the set in a sandbox

Outcome: the same agents inside srt and docker have exactly their skills, and two agents in one
sandbox can have different sets.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- The bundle is copied into the home before it moves into place, in `seedHome`'s staging.
- The sandbox conformance suite: a home's skill is readable inside, and writing it leaves the
  source unchanged.

Done when:

- Under srt and docker, two agents in one sandbox answer with their own probe word and not the
  other's.

### 4. Live eval, docs and the ADR

Outcome: the behaviour is checked by `bun run eval`, and the design documents say what was built.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- `skills.eval.ts`: each harness, on the host and in srt, with two skills and a canary, cheapest
  models; a claude turn costs about $0.02 (K3).
- ADR 0004; `permissions.md`, `design/README.md`, foundation §7 and §10, `testing.md`, `status.md`.

Done when:

- The eval passes and its cost is in `testing.md`.
- No document still says skills are refused or resolved from an operator root.

## Verification

Automated, on `agent-skills` at the review fixes:

- [x] `packages/engine/src/skills/*.test.ts`: sources, the copy and its refusals, the digest, a
  path's snapshot, public skills by branch, tag, annotated tag, full and short commit, behind a
  shallow cache, offline once kept, `export-ignore`, a path outside ASCII, one commit for two skills
  of one repository; and, through the runner with fake harnesses, two agents in one sandbox with
  different sets, a host codex's own home, a host pi, records for none named, refusals with no
  record, and a reopen conflict.
- [x] `packages/harness/src/capabilities/skills.test.ts`: layout and launch per harness, the
  shared root turned off by real path, TOML escaping, claude's run root inside its cwd refused.
- [x] Adapter argv: headless and resumed turns for claude, codex and pi; a claude pane's arguments
  last; a host codex tab's `CODEX_HOME`; an adapter without `givesSkills` refusing.
- [x] `bun test`: 734 pass, 10 skip, 0 fail.
- [x] `bun run check`: Biome, `tsc` and the boundaries clean.

Live, 2026-09-26, on subscriptions:

- [x] `skills`: passed, 5 agents in ~15 s, ~$0.06. codex and pi on the host and sharing one srt
  sandbox each reported only their own probe's word and listed only their own probe; the claude pane
  listed its probe and claude's bundled skills, none of the operator's. The first run failed on
  the claude pane only, which wrote its answer over its launcher (fixed since; see below).
- [x] `harnesses` ~$0.06 and `failed-run` under a cent: passed.
- [x] `minimum-review`: passed, ~$0.04. It first failed because this story's documents were being
  edited in the repository it fingerprints, then on its own preflight with a setup token exported.
- [x] `sandbox-srt`: passed, ~$0.29, with `CLAUDE_CODE_OAUTH_TOKEN` loaded from `.env`; it fails
  without it, as it should.
- [x] `sandbox-panes-srt`: passed, ~$0.28. One run before it failed: the sandboxed claude pane
  declined the probe as instructions in pasted content, which no argument of this story changes.
- [ ] `sandbox-docker` and `sandbox-panes-docker`: not run. Skills reach a box through the same
  staged home as srt's, which the engine fills before any provider sees it.

## Review record

Tasks 1–3 were reviewed together, as one diff (`0bb77a7`), by two read-only subagents; see
[[#Implementation notes]] for why.

### Tasks 1–3

- Architecture and scope: checked seam placement against foundation §7/§10, the published types
  and record, boundaries, scope, the `givesSkills` gate, the `launchArgs` rename and the host codex
  home. Findings, all fixed unless said:
  - The record said `operator` for a sandboxed agent named none, which had none: now `[]`.
  - A source's JSON shape was written three times: now one `SkillSource` in contract, which
    `SkillRef`, the record and the engine share.
  - The engine re-derived harness layout from paths (`dirname`, a fake `bundle: home`): now one
    `skillsLayout` returns the whole placement, `ownHome` included, and `skillsLaunch` reads no
    paths back.
  - `RunSandboxes` exposed its credential locks for the host path: the locks and environment are
    now the run's, passed to both.
  - A host codex home lived under `skills/`, unrecorded: now under `agents/{id}/home`, in the
    record's `home`, and engine `AGENTS.md` names `agents/` as written by harnesses.
  - `skills: []` on a host claude pointed `--add-dir` at a directory never made: now always made.
  - The pane's arguments bypassed `TurnContext`: `interactive` now takes the launch arguments, so
    `spec.ts` places them for every plan.
  - `run-skills.ts` mixed pure checks with git: split into `sources.ts` (no I/O), `fetch.ts`,
    `tree.ts` and `run-skills.ts`.
  - Harness `AGENTS.md` rows, the shared skills root moved to `state.ts`, and "(story 007)" tags
    in comments dropped.
  - Not changed: the `givesSkills` refusal of a host agent comes after its channel opens, as the
    sandbox gate's does; the cursor refusal, from `skillsLayout`, comes before it.
- Correctness and proof: checked resolution, the copy, the digest, the fetch and its cache under
  concurrency, path traversal, argv placement on every plan, refusals before the channel, the
  record, and the staged home. Findings, all fixed unless said:
  - A commit behind a shallow cache was never found: the fallback now fetches with `--unshallow`,
    and a commit already kept needs no fetch. Tested with an older short hash after a shallow fetch.
  - An annotated tag recorded the tag object: now peeled to the commit. Tested.
  - `git archive` dropped `export-ignore` files: public skills are now read from `ls-tree` and
    `cat-file --batch`, with links, submodules and paths outside the skill refused, and the caps
    checked, before anything is written. Tested.
  - `ls-tree` without `-z` missed a skill outside ASCII: now `-z`. Tested.
  - The published doc promised the repository's own skills for every harness: pi's `--no-skills`
    drops them and codex's bundled ones are off; the doc now says what each keeps.
  - A host claude silently drops an `--add-dir` inside its working directory: now refused, naming
    the fix. Tested.
  - The record was written before later refusals: now after the layout and the seat. Tested for
    a refused agent.
  - A host codex's trust key used the unresolved cwd: now its real path. Its missing
    `config.toml` and API-key logins are stated in [[#How it works]].
  - Each run re-fetched and could see two `main`s: commits are memoized per URL and ref, and kept.
  - git had no timeout and ssh could prompt: a five-minute timeout, and `BatchMode=yes` unless the
    operator set `GIT_SSH_COMMAND`. The lock retry is two minutes.
  - Relative run and cache roots broke extraction: made absolute. Temporary refs are deleted in
    one `update-ref --stdin`. DEL in a TOML path is escaped.
  - Not changed: a copy of the codex credential stays in the run directory after the run, as a
    sandboxed agent's does.

### Task 4

- Reviewed with tasks 1–3 where it touched code (`tests/skills.eval.ts`,
  `examples/skills-probe`); its documents were checked against the fixes above.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled: ADR 0004, and the
  record reviewed; open question 1 awaits the user's confirmation.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

Deviations from the proposal, and why:

- **A relative skill path is refused**, not resolved against the workflow file. A workflow called
  by another has no file the engine knows; `new URL("./skills/x", import.meta.url)` is right
  wherever it runs and needs no import. `LoadedWorkflow.file` is untouched.
- **Host homes and bundles live under `{run}/agents/{id}/`**, not `{run}/agents/{agent}/`: a key
  may hold any character. The record names each host home.
- **`SkillRecord.within`** records where in the repository a public skill was found.
- **pi keeps no repository skills** once given skills, and claude with skills refuses a run root
  inside its working directory; both are what the harnesses allow (see the review record).
- **No case was added to the sandbox package's conformance suite.** A skill in a home is the
  engine's copy, not a provider's behaviour: `skills.integration.test.ts` checks it through the
  fake provider, and the `skills` eval under srt.
- **Tasks 1–3 were built and reviewed as one diff**, not one task at a time: the surface, the
  harness translation and the sandbox copy are one mechanism that no task proves alone. One
  review round of two reviewers covered it; its findings are above, each fixed and tested.
- The `skills` eval's first run failed on the claude pane for a reason outside this story: Haiku
  wrote its answer over its own launcher with `cat >`. Since 2026-10-02 the launcher is written
  read-only, so that redirect fails; a `chmod` first still gets past it outside a sandbox.
- **The `skills` eval was made to test use, not sight**, at review. Its first form told the agent
  a skill held a word and took the agent's word for which skills it saw. Now the prompt never
  mentions skills: it asks for a build's release stamp and audit seal, and each probe's
  description claims one. Only a script inside the probe makes the value, from a secret no
  `SKILL.md` holds, keyed by a build id unique to the agent, and the script leaves a receipt
  beside itself. So a pass means the agent found its skill by description, ran its own copy
  (its host bundle, own codex home or sandbox home, never a source or a run's snapshot), with its
  executable bit, and could not make the other probe's value. The seal probe comes from a git
  repository, so the fetch runs live too. `tests/skills-eval.test.ts` checks the checks for free.
  First run: 5/5 in 38 s, ~$0.08.

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [x] Record the human's explicit approval or requested changes here.
- [x] If changes are requested, return to the affected task and repeat its review and verification.
- [x] Only after explicit approval, mark the story `done` and update `Stories at a glance`.

Approved on 2026-09-29: "007 and 008 can be closed". Marked `done`.
