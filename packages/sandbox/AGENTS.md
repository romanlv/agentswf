# @wf/sandbox

Running agents inside sandboxes a workflow opens (story 004). The seam is here, and so is every
provider, so harness and engine hold no provider's code.

| Entry | Owns |
| --- | --- |
| `@wf/sandbox` | the seam's types (`seam.ts`), and a spec's check and path and gitdir resolution (`resolve.ts`) |
| `@wf/sandbox/srt` | `createSrtProvider` and `findSrt`: srt's profiles, the pure check, the first-open probe (`src/srt/`) |
| `@wf/sandbox/docker` | `createDockerProvider` and `findDocker`: a box, its proxy and network, the door's relay, the reaper, the box's Herdr (`src/docker/`); the default image, the proxy and the relay's box half (`docker/`) |
| `@wf/sandbox/testing` | the conformance suite every provider's test calls, and a fake provider for engine and adapter tests |

- **It imports contract only.** harness and engine import `@wf/sandbox`; only the engine's
  `operator-runtime.ts` imports a provider. `scripts/check-boundaries.ts` holds these.
- **A provider is a directory under `src/`** with an `index.ts`, and imports the seam by path,
  never another provider.
- **Every provider holds the seven invariants** in the story. The conformance suite checks what a
  provider can show with `sh`; each provider's own tests check the rest.
- **`git.ts`** lists what in a writable gitdir the host's git runs or follows, which every
  provider keeps from an agent.
- **`secrets.ts`** writes a pane's secret where its shell reads and deletes it, and holds the one
  `shellQuote` a prelude is built with.
- **A pane is typed, then adopted** (`PaneTerminal`): the prelude gives the pane's shell exactly
  its environment and a zsh whose prompt carries a nonce (`ready`), with job control off so
  `release` ends its jobs. srt's pane is in the run's Herdr; docker's in the box's own.
- **`groups.ts`** records the process group each launch leads, so a provider ends what an agent
  still runs at `release` and `close`.
- **`*.local.test.ts`** runs a real provider with `sh` for an agent, no model; each is skipped
  where its provider is not installed.
- **Resolution runs no process.** It reads `realpath`, `~`, and a `.git` file's `gitdir:` and
  `commondir`.
