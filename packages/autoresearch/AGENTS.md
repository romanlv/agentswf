# @wf/autoresearch

Tools for evaluating workflows against cases with known answers, and later for improving them.
Today it holds review fixtures (story 005): the format, its checks, `collect` (code that freezes a
GitLab MR as a fixture), and `draft-key` (an agent drafts the answer key; code checks it against the
fixture). `fixtures.workflow.ts` runs both over a list of MRs, then seals the folder as a set
(`seal.ts`: `set.json`, each fixture pinned by a digest).

It is a consumer of the engine (ADR 0002): it may import `@wf/contract` and the engine's public
entry, never a harness. Every file in `src/review/` is pure except those the boundary checker names
as doing I/O (`git.ts`, `gitlab.ts`, `collect.ts`, `verify.ts`, `seal.ts`, `draft-key.ts`, the workflow,
the index). Agents are used only where a step needs judgement: drafting the key, and graders from
another model family voting on what code cannot check. No person is in the loop.

Every file it writes in a format of its own has a TypeBox schema in `format.ts` and is checked
before it is written. The raw GitLab responses under `key/evidence/gitlab/` are kept as GitLab
sent them, unvalidated. After changing `format.ts`, regenerate `schema/` with
`bun packages/autoresearch/src/write-schemas.ts`.

GitLab is reached only through `glab api`, read-only. Fixtures and their data live outside this
repository, in the project's own autoresearch repository.
