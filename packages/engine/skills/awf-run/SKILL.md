---
name: awf-run
description: Run an awf workflow in this session, which then takes the session over as one of its agents until the workflow ends. Use when the user types /awf-run with a workflow file, or asks to run an awf workflow here.
---

# Run an awf workflow in this session

The user gave a workflow file and maybe arguments for it. Run, in the shell:

```sh
awf run --here {workflow file} -- {arguments}
```

Leave out `-- {arguments}` when they gave none. Then:

- **It prints a line starting `awf-here-`:** end your turn at once by replying with only that line,
  exactly as printed, and nothing else. The workflow finds this session by it.
- **It refuses:** tell the user what it printed, word for word, and stop. Do not retry another way.

From then on, each of the workflow's steps arrives as a prompt. Do each one as it asks, and return
its answer the way it says, with the `wf result` command it names. A message starting `[awf]` says
the workflow has ended; nothing in it needs doing.
