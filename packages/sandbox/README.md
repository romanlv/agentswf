# @agentswf/sandbox

The sandboxes a workflow can open for its agents, and their providers: docker and srt.

This package is internal to [agents.wf](https://agents.wf). It is published so that
[`agentswf`](https://www.npmjs.com/package/agentswf) can depend on it, and its exports change
without notice between versions. Install `agentswf` instead:

```sh
bun add -g agentswf
```

A workflow imports `agentswf/workflow`, its tests `agentswf/testing`, and a program that drives
runs `agentswf/client`. The [guide](https://agents.wf/guide/) starts there.

MIT licensed. Source: [github.com/romanlv/agentswf](https://github.com/romanlv/agentswf/tree/main/packages/sandbox).
