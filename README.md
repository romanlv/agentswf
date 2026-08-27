# awf

An engine for **workflows made of coding agents**. A workflow is ordinary TypeScript: it opens
agents, gives them work, waits for structured answers, and composes the results. The agents are
real terminal coding agents — claude, codex, pi, cursor — driven either as a Herdr pane or as a
headless process.

The distinguishing constraint is that the workers are non-deterministic processes that bill
money and sometimes fail to answer. That is not a normal task queue, and it drives the design.

Start with **[`docs/foundation.md`](docs/foundation.md)**.

```sh
bun install
bun test
```

| Where | What |
| --- | --- |
| [`docs/foundation.md`](docs/foundation.md) | the shape of this repository and the argument for it |
| [`docs/reference.md`](docs/reference.md) | the projects surveyed, and what is still unmined in them |
| [`docs/findings/`](docs/findings/) | seven experiments, raw numbers, what they settled |
| [`docs/design/`](docs/design/) | the interface design notes: messaging, composition, feedback |
| `packages/` | `contract`, `harness`, `engine` |
| `examples/` | scenario workflows against the author surface |
| `experiments/` | the archived experiments, and the one open measurement |

Nothing here is published. Everything is `private: true` until there is a reason otherwise.
