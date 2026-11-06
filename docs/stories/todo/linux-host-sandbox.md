---
title: A sandbox on the host on Linux
type: story
status: todo
priority: P2
epic: sandbox
discovered_in: "Linux support, 2026-11-06: srt's local tests run on Linux for the first time (X24)"
depends_on: []
---

# A sandbox on the host on Linux

On Linux, agents run sandboxed on the host with the operator's toolchain, as srt gives them on
macOS; today awf refuses srt there and a Linux sandbox is docker's.

Why it matters: docker gives agents an image, not the operator's toolchain, so a workflow that
works under srt on a Mac can fail on Linux, and a Linux operator without docker has no sandbox.

Notes:

- **Which provider is open.** srt is the obvious one, but another host sandbox may be ready by
  then (Landlock-based or otherwise); weigh them before building srt's workarounds. Whatever is
  picked must pass `sandboxConformance` and `srt.local.test.ts`'s checks, which never ran on Linux
  before X24.
- **What srt 0.0.81 gets wrong on Linux** (X24), and what awf could do meanwhile:
  1. A write nested in a read under a denied region is read-only: srt
     [#446](https://github.com/anthropics/sandbox-runtime/issues/446), fix in
     [PR #447](https://github.com/anthropics/sandbox-runtime/pull/447), unmerged. Listing the
     write in `denyRead` too makes srt mount it last; tested by hand, relies on srt's mount order.
  2. git fails: an absent protected file (`.git/commondir`) is `/dev/null` on a `nodev` mount,
     so reading it is `EACCES`. [PR #707](https://github.com/anthropics/sandbox-runtime/pull/707)
     makes it an empty file, which still breaks git for `commondir`: git takes only its absence.
     So on Linux an absent `commondir` cannot be both protected and readable; the alternative is
     a check before the host's git runs that none was created. A decision.
  3. No network with `/tmp` denied: srt's bridge sockets are in `os.tmpdir()`
     ([#176](https://github.com/anthropics/sandbox-runtime/issues/176)). Starting srt with
     `TMPDIR` in a short directory awf allows would carry them.
  4. Every Unix socket is refused, the door's among them: `allowUnixSockets` is ignored on Linux
     ([#343](https://github.com/anthropics/sandbox-runtime/issues/343)).
     `allowAllUnixSockets` works, since a denied directory still hides its sockets
     ([#808](https://github.com/anthropics/sandbox-runtime/issues/808)), but drops the whole
     seccomp helper: io_uring, namespace and vsock blocks, the nested PID namespace
     ([#796](https://github.com/anthropics/sandbox-runtime/issues/796)). A decision. Stock Ubuntu
     24.04 cannot run that helper anyway
     ([#428](https://github.com/anthropics/sandbox-runtime/issues/428),
     [#429](https://github.com/anthropics/sandbox-runtime/issues/429)).
  5. Ubuntu 24.04 needs `sysctl kernel.apparmor_restrict_unprivileged_userns=0`; srt's own CI
     does that on GitHub's runners, so a CI job can.
- **What awf needs besides.** A shell for agents and panes: zsh may be absent, and bash 5 writes
  heredocs in `TMPDIR`, which srt sets. A bash pane drops an inherited `PS1` behind srt's
  non-interactive bash, so its prompt comes from `PROMPT_COMMAND`, drawn from `\045` as `%`, not
  `$`, which bash expands. Built and tested in a terminal on 2026-11-06 (5b9f298), then removed
  with srt's refusal; git has it. Linux denied regions: `/home`, `/root`, `/mnt`, `/media`,
  `/tmp`, `/var/tmp`, `/run/user`. `curl` on the host, for srt's probe.
- **CI.** A job on ubuntu-latest that installs the provider and runs its local tests, so it stays
  working.
- Comment our reproductions on srt #446, #176 and #707.
