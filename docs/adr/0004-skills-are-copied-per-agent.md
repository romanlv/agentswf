# 0004 — Skills are sources a workflow names, copied to each agent

**Decided:** 2026-09-26. **Replaces:** `permissions.md`'s "skills resolve by name from an
operator-controlled root, mounted read-only; a path from a workflow would be code injection", and
the `foundation.md` §7 and §10 rows that left skill resolution unbuilt until two adapters showed
what was portable.

## What was decided

`AgentOpenSpec.skills` takes sources, not names: `{ path }`, a directory or a `file:` URL, and
`{ repo, skill, ref? }`, a public skill in a git repository as skills.sh names one. The engine
resolves each once per run, fetches a public one into a cache by commit, checks it (a `SKILL.md`
with a name and a description, no links, under a size cap), and copies it to every agent that
names it. The agent then has exactly those skills, beside what its harness will not give up:
claude's bundled skills, and claude's and codex's working directory's own. The operator's are
out. Leaving `skills` out keeps what the agent would have without
awf. `output.json` records each agent's skills: source, commit, digest.

Each harness is held to the set its own way, in `harness/src/capabilities/skills.ts`, and a harness
with no way is refused.

## Why

Three adapters showed what is portable ([`agent-skills`](../findings/agent-skills.md)): every
harness loads a directory with a `SKILL.md`, and each can be held to an exact set, by different
flags, and codex only through its home. That is §10's trigger. What is portable is the source and
the copy, not a `skill:name` grammar, so the surface names sources and leaves the grammar
unstandardised.

A name resolved from an operator root could not name a public skill or one a workflow ships with.
The injection argument was about who writes the code, not who names it: the workflow already runs
with the operator's authority. The risk is an agent writing a skill that runs later outside its
reach, and a copy per agent, never the source and never the operator's harness state, closes it.

## What would change it

A stranger's workflow. Then the operator needs a ceiling on which repositories and paths a
workflow may name (`permissions.md`, open question 7).
