---
title: srt is found however Node is switched
type: story
status: todo
priority: P2
epic: sandbox
discovered_in: "autoresearch Opus run, 2026-11-26"
depends_on: []
---

# srt is found however Node is switched

awf finds or brings its own `srt`. When it can't, the refusal names the command that installs it.

Why it matters: on 2026-11-26, mise moved the default Node from 22.20.0 to 24.22.3. `srt` was
installed globally only under the old Node, so every boxed lab trial stopped with "not installed"
before it started. Finding the cause took a while, and the fix was `npm i -g
@anthropic-ai/sandbox-runtime` under the new Node.

Notes: no awf package depends on `@anthropic-ai/sandbox-runtime`. It is found on `PATH`
(`packages/sandbox/src/srt/index.ts`). Options: depend on it and resolve its `cli.js` from awf's
own install; or keep `PATH`, and have the refusal name the install command and the Node it looked
under. Pin a version either way: the runs used 0.0.80. Related: [[node-runtime]], [[npm-launch]].
