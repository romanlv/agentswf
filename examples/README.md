# Examples

Scenario workflows written against `@wf/contract/workflow`. The import boundary is enforced by
`bun run scripts/check-boundaries.ts`: workflows never reach into the engine or a harness.

## Run the review workflow

From this repository:

```sh
bun awf run examples/minimum-review/review-loop.ts
```

The default run deadline is ten minutes. Set another deadline with a CLI flag before the workflow
file:

```sh
bun awf run --timeout 20m examples/minimum-review/review-loop.ts
```

The run deadline bounds agent activation, turns, nudges, and result collection. After it expires,
the engine cancels active work and allows at most five additional seconds for resource cleanup; a
broken adapter cannot keep the command open indefinitely. A future configuration file may provide
the same setting, but configuration is not part of the current interface.

`agent.run()` makes one standard missing-answer recovery attempt by default. Workflows only mention
nudging when they customize it or deliberately disable it with `nudge: false`.

By default the review target is the current directory. To review one file or directory relative to
the current working directory, put its path after `--`:

```sh
bun awf run examples/minimum-review/review-loop.ts -- packages/engine/src
```

When the `@wf/engine` package bin is installed, the shorter equivalent is:

```sh
awf run examples/minimum-review/review-loop.ts -- packages/engine/src
```

The command uses Herdr session `default` unless `AWF_HERDR_SESSION` selects another session. The
runtime selects subscription-authenticated Claude and Codex models without exposing terminal
placement in workflow aliases. Metered API-key variables are removed so they cannot silently take
precedence. The command prints structured JSON on standard output and reports retained run
artifacts. A workflow file is trusted executable code: loading it gives the file the same
filesystem and process authority as the operator.
Agent operations are cancelled on interruption. A custom trusted workflow remains responsible for
bounding or cancelling any external asynchronous work it starts outside the workflow engine.

## Other examples

Each example that spans more than one file has a folder of its own, with its workflow in
`workflow.ts`:

- `minimum-review/` is the reusable one-round, two-lens review definition, plus `review-loop.ts`
  that runs it and a `fixtures/` target with a known defect.
- `catalogue-review/` is a typechecked design for fan-out and per-finding verification.
- `feature-delivery/` is a typechecked design for planning, implementation, review, and revision.
- `output-schema/` is the TypeBox-to-output-schema helper the workflows share, with its type tests.

Only `minimum-review/review-loop.ts` currently has the executable default export required by
`awf run`.
