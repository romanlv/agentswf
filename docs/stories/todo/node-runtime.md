---
title: Run the packages on Node.js
type: story
status: todo
priority: P3
epic: launch
discovered_in: "story 009 review, 2026-09-28"
depends_on: ["009"]
---

# Run the packages on Node.js

What it takes for the published packages to run under Node as well as Bun, measured 2026-09-28,
cheapest part first.

Why it matters: [[009-publish-agentswf]] publishes TypeScript source for Bun. Someone who wants
to build on a package from a Node program can't import it at all, whether to read run records,
drive a harness or embed the engine. The operator's own use needs none of this.

Measured on 2026-09-28, with Node 22.20 and Bun 1.4.0:

- **Node won't run TypeScript from `node_modules`.** It strips types from a file it is handed,
  so a user's `.ts` workflow runs. Under `node_modules` it refuses with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. So each package has to publish JavaScript and
  `.d.ts`, from `tsc` or `bun build` per entry, as pi, opencode's SDK and codex's SDK do.
- **`bun build --target=node` doesn't translate Bun's API.** It leaves `Bun.spawn` as is, and
  the output fails under Node. The code has to use `node:` modules itself. Bun runs those too, so
  there would still be one codebase.
- **The Bun calls in what ships,** about 37 in 17 files:

  | File | Calls |
  | --- | --- |
  | `engine/src/control-plane.ts` | `Bun.listen` on a unix socket, `Bun.Socket` |
  | `engine/src/agent-launcher.ts` | `Bun.spawn` |
  | `engine/src/skills/fetch.ts` | `Bun.spawn`, `Bun.sleep` |
  | `engine/src/skills/sources.ts` | `Bun.YAML` |
  | `engine/src/runs.ts` | `Bun.spawnSync` |
  | `harness/src/command.ts` | `Bun.spawn`, `Bun.Subprocess`, `Bun.sleep` |
  | `harness/src/usage/*.ts`, `harness/src/sandbox-needs.ts` | `Bun.file` |
  | `sandbox/src/docker/index.ts` | `Bun.spawn`, `Bun.which`, `Bun.sleep` |
  | `sandbox/src/srt/index.ts`, `sandbox/src/groups.ts` | `Bun.spawn`, `Bun.spawnSync` |
  | `wf/src/cli.ts` | `Bun.stdin` |

  `testing/` files use `bun:test` and more of the same; they would publish as Bun-only or move.

Notes:

- **The cheapest step is `@agentswf/contract`.** It is pure, uses no Bun API (boundary 1), and
  only needs a build. That alone lets any Node tool read run records and type-check workflows.
- **The engine has three things of its own to replace:**
  - The `bun build` of `wf` at run time would be built at pack time instead.
  - The Bun virtual modules that serve `agentswf/workflow` and `typebox` would become
    `node:module` resolve hooks. pi uses jiti aliases for the same job.
  - The shebang `bun --no-env-file` would become `node`. Node loads no `.env` unless asked.
- **The risky part is `harness/src/command.ts`.** Its process handling (liveness, streams, exit)
  is the most tested code there, and `node:child_process` differs from `Bun.spawn` exactly there.
- **One option is to guard it.** A boundary rule could keep Bun's API behind one module per
  package, so the port stays possible without doing it now.
- **Revisit when:**
  - someone asks to use a package from Node; or
  - `contract` gets a consumer outside this repository.
