# Examples

Scenario workflows written against `@wf/contract/workflow`. The import boundary is enforced by
`bun run scripts/check-boundaries.ts`: workflows never reach into the engine or a harness.

## Run the review workflow

From this repository:

```sh
bun awf run examples/minimum-review/review-loop.ts
```

The default run deadline is thirty minutes. Set another deadline with a CLI flag before the workflow
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
precedence. A workflow that presents its own result prints that report on standard output;
otherwise, or with `--json`, the command prints the result as JSON. Either way the JSON is kept as
`output.json` beside the run's other artifacts, under `~/.awf/runs` unless `--run-root` says
otherwise, and a workflow that writes a Markdown report has it saved there as `report.md`. A run
that fails or is cancelled once it has started still writes `output.json`, with `outcome` saying
so, its `error`, and what its agents spent. A run directory without one is a run that never
started, or whose process was killed. A workflow file is trusted
executable code: loading it gives the file the same filesystem and process authority as the
operator.
Agent operations are cancelled on interruption. A custom trusted workflow remains responsible for
bounding or cancelling any external asynchronous work it starts outside the workflow engine.

## Smoke-test a harness

`quick-check/` asks one agent per runtime named (codex when none is) questions with known answers,
proving a harness, its result channel and the run's accounting for a few cents:

```sh
bun awf run examples/quick-check/workflow.ts -- codex pi
```

## Ask a decision model

`triage/` routes support tickets with Jev, a decision model: one call per ticket asks which team
owns it, whether it reports a bug, and how urgent it is, and gets a probability for every answer
back in a few hundred milliseconds. An answer below 0.9 is flagged `unsure` rather than taken. It
needs `OPENROUTER_API_KEY`, in the environment or in `.env`, which the engine holds and no agent is
given, and it costs about $0.00002 a ticket. It opens no agent, but `awf run` still checks the
Claude and Codex subscription logins at start, as for any workflow:

```sh
bun awf run examples/triage/workflow.ts
bun awf run examples/triage/workflow.ts -- "The invoice PDF shows last month's total"
```

With no tickets after `--` it triages four synthetic ones. `triageTicket` is the call as a plain
function, which is how a workflow shares a decision with others (story 006).

## See what a sandbox allows

`sandboxes/` shows two ways to sandbox agents, each agent running a few shell commands and
reporting what they printed, refusals included:

- **A team in one docker container, headed.** Three codex agents share a sandbox, all at once, each
  in a pane of the container's own Herdr. They write a file each into the working directory,
  print the container's hostname (the same for all three), and reach `registry.npmjs.org`.
- **pi under srt, headless.** A private sandbox, given inline on the agent, that reads the working
  directory but cannot write it, cannot read `~`, and reaches no domain beyond its model. It reads
  the team's files.

Point `--cwd` at a scratch directory, as the team writes into it:

```sh
bun awf run --cwd "$(mktemp -d)" examples/sandboxes/workflow.ts
```

The run's workspace in your Herdr shows the container's own Herdr, with the team's panes, while
they work. `awf run --no-watch` leaves it out; the run still prints the `docker exec -it … herdr`
command that shows them. It needs srt, docker and the default image, which the run names how to
build if it is missing. Four agents, under a minute.

## Other examples

Each example that spans more than one file has a folder of its own, with its workflow in
`workflow.ts`:

- `minimum-review/` is the reusable one-round, two-lens review definition, plus `review-loop.ts`
  that runs it and a `fixtures/` target with a known defect.
- `catalogue-review/` fans a diff out over catalogue lenses and verifies each finding.
  `defineCatalogueReview` turns a lens catalogue into an `awf run` entry point, which by default
  reviews `origin/main...HEAD` through every lens; `-- --lenses a,b` and `--range` narrow it.
  A lens with `paths` globs runs only when the diff touches a match, given the changed files by
  the entry point. It prints a line per finding to act on, and writes `report.md` with the
  evidence, the verifier's reasons and what was refuted, to hand back to the implementer.
- `feature-delivery/` is a typechecked design for planning, implementation, review, and revision.
- `quick-check/` is the smoke test above.
- `sandboxes/` is the sandbox tour above.
- `triage/` is the decision model example above.
- `sandbox-probe/` runs agents in a shared and a private sandbox, each running fixed shell
  commands and reporting what each printed. It is the apparatus of `tests/sandbox-*.eval.ts`,
  which plant the canaries and pass the plan as one JSON argument, not something to run by hand.
  Its claude runs headless and so needs `CLAUDE_CODE_OAUTH_TOKEN`.
- `output-schema/` is the TypeBox-to-output-schema helper the workflows share, with its type tests.

Only `minimum-review/review-loop.ts`, `quick-check/workflow.ts`, `sandboxes/workflow.ts`,
`sandbox-probe/workflow.ts` and `triage/workflow.ts` have the executable default export required by `awf run`.
A catalogue review's entry point lives beside the catalogue it reads, outside this package, because
reading one is I/O and a workflow here is pure.
