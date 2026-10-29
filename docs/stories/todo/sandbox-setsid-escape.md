---
title: End what leaves a sandbox's process group
type: story
status: todo
priority: P2
epic: sandbox
discovered_in: "cleanup audit, 2026-10-29"
depends_on: []
---

# End what leaves a sandbox's process group

A process an agent starts that calls `setsid` — a daemon, codex's app-server — is ended with the
agent's sandbox, as what stays in its group is.

Why it matters: srt's release and close kill the groups named in the sandbox's pid files
(`sandbox/src/groups.ts`), and srt does not deny `setsid`. The audit ran `fork and exit; setsid;
exec sleep` inside an srt sandbox; after `release()` and `close()` the `sleep` ran on under PID 1 in
a group of its own. Orphaned codex app-server daemons were found on the same machine. On docker the
escape lasts until close, since `rm -f` ends the box.

Notes: two ways, to choose between. Deny `setsid` in srt's profile, if srt can say so and agents
work without it. Or sweep by something a process cannot shed: a per-sandbox marker in its
environment, its argv, or the profile path srt runs it under, found with `ps` at release. The
conformance suite then gets a `setsid` and double-fork case, which every provider passes.
