# @agentswf/lab

Tools for evaluating workflows against cases with known answers, and later for improving them.
It holds review fixtures (story 005) and their scoring (story 008), in `src/review/` by purpose:
`format/` (the formats and their checks), `fixtures/` (reading, checking and sealing a set:
`seal.ts` writes `set.json`, each fixture pinned by a digest), `build/` (`collect`, code that
freezes a GitLab MR as a fixture; `draft-key`, where an agent drafts the answer key and code
checks it against the fixture; and `fixtures.workflow.ts`, which runs both and seals the set),
`judge/` (the panel scorer's workflow and the check every judgement passes), `metrics/` (pure
numbers from records), and `lab/` (`awf-lab`, the command line that runs a variant and a scorer
per case through `awf run` and keeps the trials and scores in the workspace's results). Story 008
has `awf-lab`'s terms and command line.

It is a consumer of the engine (ADR 0002): it may import `@agentswf/contract` and the engine's public
entry, never a harness; `awf-lab` starts workflows with the checkout's own `awf run` and reads the
record it prints. Every file in `src/review/` is pure except those the boundary checker names as
doing I/O (`fixtures/git.ts`, `verify.ts`, `seal.ts`; `build/gitlab.ts`, `collect.ts`,
`draft-key.ts`; `lab/cli.ts`, `execute.ts`, `identity.ts`, `load.ts`, `runner.ts`, `store.ts`,
`workspace.ts`; the workflows; the index). A folder imports only the folders below it: `format`
nothing of ours, `fixtures` `format`, `build`, `judge` and `metrics` those two, `lab` all but
`build`; the boundary checker keeps the order. Agents are used only where a step needs judgement:
drafting a key and its graders' votes, and judging a review. No person is in the loop.

Every file it writes in a format of its own has a TypeBox schema in `format/` and is checked
before it is written: the case formats in `format.ts`, the records `awf-lab` writes in
`records.ts`, its config in `workspace.ts`, and what each command prints with `--json` in
`output.ts`. A variant or scorer is identified by the version its file declares, nothing else:
an edit that changes what it measures bumps it, and the records keep only the commit and whether
its files were dirty, as provenance. The raw GitLab
responses under `key/evidence/gitlab/` are kept as GitLab sent them, unvalidated. After changing
a schema, regenerate `schema/` with `bun packages/lab/src/write-schemas.ts`.

GitLab is reached only through `glab api`, read-only. Fixtures and their data live outside this
repository, in the project's own autoresearch repository. It imports the package by name, linked
from a clone: `bun link` here, then `bun link @agentswf/lab` there. `@agentswf/lab/review` is the
entry; `@agentswf/lab/review/{dir}/{file}` reaches any other module, with no promise it stays.
