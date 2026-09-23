# awf

An engine for **workflows made of coding agents**. A workflow is ordinary TypeScript: it opens
agents, gives them work, waits for structured answers, and composes the results. The agents are
real terminal coding agents — claude, codex, pi, cursor — driven through one run host the operator
chooses. Herdr is the current host; it is not part of the workflow interface.

The distinguishing constraint is that the workers are non-deterministic processes that bill
money and sometimes fail to answer. That is not a normal task queue, and it drives the design.

Start with **[`docs/foundation.md`](docs/foundation.md)** for the vision and the argument, and
**[`docs/status.md`](docs/status.md)** for what runs today and what comes next.

```sh
bun install
bun test
```

| Where | What |
| --- | --- |
| [`docs/foundation.md`](docs/foundation.md) | the vision, the shape of this repository, and the argument for it |
| [`docs/status.md`](docs/status.md) | what runs today, open stages and stories, what is next |
| [`docs/stories/`](docs/stories/) | deliverables, each planned and reviewed task by task |
| [`docs/adr/`](docs/adr/) | decisions taken against the foundation since |
| [`docs/reference.md`](docs/reference.md) | the projects surveyed, and what is still unmined in them |
| [`docs/findings/`](docs/findings/) | what seven experiments settled, and what is still live |
| [`docs/design/`](docs/design/) | the interface design notes: messaging, composition, permissions |
| `packages/` | `contract`, `harness`, `engine`, `cli-agent` |
| `examples/` | scenario workflows against the author surface |
| `experiments/` | the archived experiments, and the one open measurement |

Nothing here is published. Everything is `private: true` until there is a reason otherwise.
