# Archived experiments

The raw results of E1–E3 and E5, the evidence [`docs/findings/`](../../docs/findings/) is
written from, and the only copy of it. Do not edit them.

The scripts that produced them, their test harness and E6's shelved journal were removed on
2026-09-29. They drove agents through a session driver the engine had replaced, and kept it alive
in the harness. They are in git history: `git show xperiments/_archive/{file}`, or
`git worktree add {dir} fd34b33` to run them as they were.

`f-fork-cache/` is the evidence behind [`fork-cache.md`](../../docs/findings/fork-cache.md),
2026-10-01: its throwaway probes, kept as text since they import this checkout by absolute path,
what they wrote, the per-request rows read back from the harnesses' session files, and the console
output nothing else kept.
