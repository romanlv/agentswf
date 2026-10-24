---
id: "033"
title: "An agent learns awf from its help"
summary: "`awf -h` lists every command, grouped, with a line each; `awf help {command}` and `awf {command} -h` show its usage, `awf help reference` all of it at once, and a mistyped command names the closest one. One table of commands feeds the index, and a command can't be dispatched without being in it."
type: story
status: ready
priority: P2
epic: launch
discovered_in: "operator, 2026-10-23, after 032 added awf inbox, reply and send"
depends_on: []
---

# An agent learns awf from its help

## Outcome

A coding agent that has never seen awf types `awf -h` and finds every command, what each is for,
and how to read more. `awf {command} -h` and `awf help {command}` give one command's usage,
options and exit codes. `awf help reference` gives the whole tool in one read. A mistyped command
names the closest one.

Why now: [[032-run-coordinator|032]] added `awf inbox`, `awf reply` and `awf send`, and `awf -h`
doesn't mention them. Today `awf`, `awf -h` and `awf help` all print `awf: expected the run
command`, and then a usage list that is kept by hand in `run-command.ts`, apart from the dispatch.
`awf run -h` is worse: it tries to load `-h` as the workflow file. The commands' own help is good.
The problem is that nothing leads to it.

## How it works

```
operator-cli.ts runOperatorCli(argv)
  │
  ├─ (none) | -h | --help | help | help help → the index                   stdout, exit 0
  ├─ help {command}                          → that command's help text    stdout, exit 0
  ├─ help reference                          → every command's help        stdout, exit 0
  ├─ --version                               → as today
  ├─ {name} in COMMANDS                      → handlers[name]
  └─ anything else, help {unknown}           → one line on stderr, exit 2:
        awf: no command "inbx"; did you mean inbox? awf -h lists the commands
        awf: no command "review.ts"; did you mean: awf run review.ts

commands.ts      COMMANDS: { names, group, summary, help }[]   pure; index(), reference(), suggest()
operator-cli.ts  handlers satisfies Record<CommandName, Handler>
```

The index groups the commands the way an operator meets them:

```
awf runs workflows of coding agents.

usage: awf <command> [arguments]

Run a workflow
  run        Start a run of a workflow file, or continue one
  test       Run a workflow's tests
  init       Set up a directory for writing workflows

Look at runs
  runs       The runs here, or one run in depth
  logs       What a run did and is doing, merged by time

Coordinate a run from outside
  inbox      What agents said to a coordinator, and what it said back
  reply      Answer a question an agent asked
  send       Message an agent first

This machine
  allowance  What is left of each harness's plan

awf <command> -h      a command's usage, options and exit codes
awf help reference    every command's help in one document
awf --version
```

Each command keeps the help text it has. The table only points at it (`inboxUsage`, `logsUsage`
and the others), so `awf help logs` and `awf logs -h` print the same text. `reply` and `send`
share one entry, `names: ["reply", "send"]`, because they share one text.

A bare path doesn't run as `awf run`. If it did, `awf {word}` would mean two things, and a mistyped
command would fail with "workflow file must end in .ts". A path gets a suggestion instead.

## Scope

In scope:

- One table of the `awf` commands, read by the index, `awf help {command}`, `awf help reference` and
  the suggestion. The dispatch is keyed by the same names.
- `awf`, `awf -h`, `awf --help`, `awf help` and `awf help help` print the index.
- `awf help {command}`. `awf run -h` prints `run`'s usage.
- `awf help reference`: the index and each entry's help, in one Markdown document.
- An unknown command, or an unknown leading flag, names the closest command, or `awf run {path}`
  for a workflow file.
- A usage error in `awf run` shows only `run`'s usage, without the lines for other commands it
  shows now.
- The `awf-run` and `awf-coordinator` skills, and the README, point at `awf -h` where they would
  otherwise list commands.

Out of scope:

- `wf -h`, the in-session command. Its help says only that it "must be run through the launcher".
  It has its own readers and its own wire, so it goes to a todo.
- Help topics in the style of `gh help exit-codes` or `git help glossary`. Each command's help
  already gives its exit codes, and `run -h` explains runs and attempts.
- Listing the `--json` fields, as `gh pr list --json` does. awf's JSON is a fixed, versioned
  record, not a set of fields to pick from.
- Shell completion, man pages, rewording any command's own help, and how each command but `run`
  parses its own `-h`.

## Context and evidence

- Fact: today's top-level usage is `usage` in `packages/engine/src/run-command.ts`. It lists run,
  init, test, allowance, runs and logs, and is missing inbox, reply and send.
  `runOperatorCli(argv, environment)` in `operator-cli.ts` dispatches with a chain of
  `if (argv[0] === …)`. Anything unmatched goes to `parseCommand`, which fails with "expected the
  run command".
- Fact: `awf run -h` exits 2 with `awf: load: workflow file must end in .ts, .mts, .js, or .mjs`,
  because `-h` reaches the loader as the file. `awf run x.ts -h` exits 2 with "put -- before
  workflow arguments". Both were checked on 2026-10-23.
- Fact: each command checks for help in its own way, and this story leaves that alone:
  - inbox, logs and runs look for `-h` anywhere in argv;
  - init, test and allowance parse it as an option and return `"help"`;
  - reply and send check `argv[1]`.
- Fact: the handlers take different shapes:
  - `holderCommand` takes the whole argv, because it needs to know whether it is reply or send;
  - `parseCommand` expects `argv[0] === "run"`;
  - the others take `argv.slice(1)`;
  - some take `environment`, others a cwd and `{ stdout, stderr }`, and holder also needs stdin.
  Each handler in the map adapts its own shape, and none of them changes.
- Fact: surveyed by running each tool's own help on 2026-10-23:
  - `gh --help` groups its commands (core, Actions, additional, help topics) with one line each,
    and ends with a "learn more" block. `gh help reference` prints every command in one Markdown
    document. A typo gets "Did you mean this?".
  - git, uv and gh all treat `{tool} help {command}` as `{tool} {command} --help`. `git stauts`
    names `status`.
  - kubectl groups its commands by experience ("Basic Commands (Beginner)"), and its footer points
    at `kubectl {command} --help`.
  - codex and uv print one flat list, with a line for each command.
- Constraint: what `awf` prints follows the terminal-output style, each fact once. So a typo gets
  one line, not the line followed by the index.
- Constraint: help on stdout is never painted. On stderr, only the `awf:` line is red, through
  `stderrLines`, as today.
- Assumption: an agent that runs `awf help reference` reads all of it. At about 11 KB today it fits
  in one tool result.

## Code map

### packages/engine

- Each command but `run` becomes one file, `{name}-command.ts`, holding its usage, its parser and
  `{name}Command(argv, io): Promise<number>`, which parses, prints help or the usage error, and
  does the work. inbox, logs, runs and holder already have this shape. init, test and allowance
  keep their handlers in `operator-cli.ts` (`allowanceCommand`, `initCommand`, `testCommand`), and
  task 0 moves them into their files. What they read from `OperatorEnvironment` (`readAllowance`,
  `install`, `home`, `signal`, the output streams) is passed in. `run` stays split: `run-command.ts`
  parses it, and its attempt path stays in `operator-cli.ts`, the composition root that wires the
  providers.
- `src/operator-cli.ts` — in `runOperatorCli`, the `if` chain becomes
  `handlers satisfies Record<CommandName, Handler>`. Each handler adapts its command's argv and
  output shape, so a command in the table that has no handler fails to compile. The private paths
  for allowance, init, test and run stay where they are.
- New: `src/commands.ts` holds `COMMANDS`, `CommandName`, `index()`, `reference()` and `suggest()`.
  It is pure: it imports the usage strings and no handlers, so there is no import cycle back into
  `operator-cli.ts`.
- `src/run-command.ts` — `usage` shrinks to `awf run`'s own usage; the lines for other commands
  go, because the index replaces them. `parseCommand` now returns `RunCommand | "help"`, the shape
  init and test already use, and it returns `"help"` when `-h` or `--help` comes anywhere before
  `--`. Anything after `--` is still the workflow's.
- Read by the table, unchanged:
  - `inboxUsage` in `src/inbox-command.ts`;
  - `replyUsage` in `src/holder-command.ts`;
  - `logsUsage` in `src/logs-command.ts`;
  - `runsUsage` in `src/runs-command.ts`;
  - `initUsage` in `src/init-command.ts`;
  - `allowanceUsage` in `src/allowance-command.ts`;
  - `testUsage` in `src/test-command.ts`.
- `src/operator-cli.ts` `main()` takes no arguments and calls `runOperatorCli`. Checked: it needs
  no change.
- `skills/awf-run/SKILL.md` and `skills/awf-coordinator/SKILL.md` each get one line pointing at
  `awf -h`.

### tests

- `tests/operator-cli.test.ts` holds the CLI's tests, `awf test --help` among them (line 2714). The
  new tests go there. `packages/engine/src/operator-cli.test.ts` covers stderr color only.
- `tests/init-command.test.ts` checks the README's hello workflow. Task 5's README edit must keep
  that test passing.

### packages/agentswf

- `src/awf.ts` calls the engine's `main`. Checked: no change needed.

### docs

- `README.md` points at `awf -h` where it names commands. `docs/holder-cli.md` doesn't change,
  because nothing the holder can see changes.

## Proposed design

`COMMANDS` is an ordered array of `{ names, group, summary, help }`. `names` has more than one name
only for reply and send. `group` is a heading, and the index prints the groups in the order they
first appear. `CommandName` is the union of every name. The handlers map, keyed by `CommandName`,
lives in `operator-cli.ts`. A handler without a table entry, or an entry without a handler, is a
compile error.

- **The index** is built from the table plus the three fixed footer lines.
- **The reference** is `# awf`, then the index in a code block, then `## awf {name}` for each entry
  with its help in a code block. Reply and send come once, under `## awf reply, awf send`.
- **The suggestion** takes the commands that the word is the start of, or else those within edit
  distance 2. Of those, it keeps the ones at the smallest distance, and names all of them when
  there is a tie: `did you mean run or runs?`. When no command qualifies, it names none and keeps
  the pointer to `awf -h`. A word ending in
  `.ts`, `.mts`, `.js` or `.mjs` gets `did you mean: awf run {word}` instead, quoted as `shellLine`
  quotes.
- **`help`** takes no word, or one word. `help`, `help help` and `help -h` print the index. A
  command's name prints its help, and `reference` prints the reference. More than one word, or an
  unknown word, is the unknown-command refusal. `reference` is a reserved name, so no command can
  take it.
- **`--version`** with anything after it, and any other leading flag (`awf -x`), are the
  unknown-command refusal.

Invariants:

- `awf help {name}` and `awf {name} -h` print the same text.
- Help goes to stdout and exits 0. An unknown command or help word goes to stderr, as one line, and
  exits 2.

Alternatives rejected:

- **Generate help from an argument-parser library** such as commander, citty or yargs. It adds a
  dependency and rewrites every command's parsing, only to produce a list that a table gives. The
  hand-written help is the good part, and it stays.
- **The table holds the handlers.** Most handlers are private to `operator-cli.ts`, so `commands.ts`
  would have to import them back, which is a cycle, or the run path would have to move. A map keyed
  by the table's names gives the same guarantee, as a compile error.
- **Let a bare `awf {path}` run the workflow.** `awf {word}` would become ambiguous, and typos would
  hide. See How it works.
- **Add help topics now.** Nothing yet asks for one that a command's own help doesn't cover.

## Tasks at a glance

- [ ] 0. Every command but `run` is one file
- [ ] 1. One table of commands: the index, and `awf help {command}`
- [ ] 2. `awf run -h`, and `run`'s usage on its own
- [ ] 3. A mistyped command names the closest one
- [ ] 4. `awf help reference`
- [ ] 5. The skills and README point at `awf -h`

## Open questions

None. Settled by the operator on 2026-10-24:

- Q1. Bare `awf` prints the index and exits 0, as `gh` does.
- Q2. The group names and the one-line summaries in How it works stand.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 0. Every command but `run` is one file

Outcome: a reader who wants one command's details opens `{name}-command.ts` and finds its help,
its options and what it does, together. Nothing that awf prints changes.

Execution:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

Work:

- Move `allowanceCommand`, `initCommand` and `testCommand` out of `operator-cli.ts` into
  `allowance-command.ts`, `init-command.ts` and `test-command.ts`. Each takes argv and what it
  needs from the environment as arguments.

Done when:

- `operator-cli.ts` holds no command's parsing or help, except `run`'s.
- The existing tests pass unchanged, `tests/operator-cli.test.ts` among them.

### 1. One table of commands: the index, and `awf help {command}`

Outcome: `awf -h` lists every command, and `awf help inbox` prints the same as `awf inbox -h`.

Execution:

- [ ] Plan: inspect the relevant code and tests, settle the cleanest module, interface, seam,
  invariants, failure behavior, and focused proof, and record material alternatives before coding.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: have two read-only subagents review this task's actual diff and test output—one for
  architecture and scope, one for correctness and proof.
- [ ] Resolve: fix or explicitly disposition every material finding; request targeted re-review
  when a fix changes the selected architecture.
- [ ] Verify: run this task's focused checks and satisfy every `Done when` item before checking the
  task in `Tasks at a glance` or starting the next task.

Work:

- Add `src/commands.ts` with `COMMANDS`, `CommandName` and `index()`.
- In `runOperatorCli`, dispatch through `handlers`, and handle `help` and `help {command}`.

Done when:

- `awf`, `awf -h`, `awf --help`, `awf help` and `awf help help` each print the index and exit 0.
- Every name in `COMMANDS` appears in the index.
- For each name but `run`, `awf help {name}` prints the same as `awf {name} -h`. `run` waits for
  task 2.

### 2. `awf run -h`, and `run`'s usage on its own

Outcome: `awf run -h` prints `run`'s usage, and a run usage error shows only that.

Execution:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

Work:

- `parseCommand` returns help on `-h` or `--help` before `--`.
- `usage` keeps only `awf run`'s lines.

Done when:

- `awf run -h` and `awf run x.ts -h` exit 0 and print `run`'s usage.
- `awf run x.ts -- -h` passes `-h` to the workflow.
- `awf run --bogus` prints the error, then `run`'s usage, and no other command's line.
- `awf help run` prints the same as `awf run -h`.

### 3. A mistyped command names the closest one

Outcome: `awf inbx` says `did you mean inbox?`, and `awf review.ts` says
`did you mean: awf run review.ts`.

Execution:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

Work:

- Add `suggest()` in `commands.ts`, and the one-line refusal in `runOperatorCli`.

Done when:

- `awf inbx`, `awf help inbx` and `awf -x` each print one line on stderr and exit 2. The line names
  the closest command when there is one, and always points at `awf -h`.
- `awf review.ts` names `awf run review.ts`, and a path with a space in it comes back quoted.
- `awf ru` names both `run` and `runs`.
- `awf zzzz` names no command.
- `awf help inbox extra` gets the refusal.

### 4. `awf help reference`

Outcome: one read gives an agent every command's help.

Execution:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

Work:

- Add `reference()` in `commands.ts`, built from the table as Proposed design says.

Done when:

- The reference holds the index, and each entry's help text exactly once. Reply and send's shared
  text comes once, under both names.

### 5. The skills and README point at `awf -h`

Outcome: an agent that loads an awf skill, or reads the README, is told where the full list of
commands is.

Execution:

- [ ] Plan: find each place that lists commands for a reader.
- [ ] Implement: one line each. Don't restate the help.
- [ ] Review: obtain an architecture/scope subagent review of the diff.
- [ ] Resolve: disposition findings.
- [ ] Verify: satisfy every `Done when` item.

Work:

- Edit `skills/awf-run/SKILL.md`, `skills/awf-coordinator/SKILL.md` and `README.md`.

Done when:

- Each points at `awf -h` once, and `tests/init-command.test.ts` still passes.

## Verification

Automated:

- [ ] The tasks' tests in `tests/operator-cli.test.ts`, and `commands.ts`'s own unit tests.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`
- [ ] `bun run check`

Manual or live evaluation:

- [ ] Give a fresh codex session on a cheap model only this task: "find out how to answer the
  questions a running awf workflow asks, using the awf CLI". It should reach `awf inbox` and
  `awf reply` from `awf -h`. Record the commands from its transcript.

## Review record

### Story draft

- Architecture, correctness and writing, 2026-10-23, by one read-only subagent checking the draft
  against the code and the CLI's behaviour:
  - Four facts were wrong, and are fixed:
    - `awf run -h` exits 2, not 0;
    - the dispatch is in `runOperatorCli`, not `main`;
    - the CLI tests are in `tests/operator-cli.test.ts`;
    - the README check is `tests/init-command.test.ts`.
  - The table no longer holds the handlers, which avoids an import cycle. A `handlers` map keyed by
    the table's names takes their place.
  - The handlers' different shapes are recorded.
  - Run's `-h` now counts anywhere before `--`.
  - A typo is now one line, and no longer repeats the index.
  - Reply and send are one entry.
  - These cases were added: `help` with extra words, `help help`, a leading unknown flag, and
    `--version` with arguments.
  - The rule that help is never painted was added.
  - Task 1 is split into tasks 1 to 3.
  - The summary no longer overclaims.
- Re-review, the same subagent:
  - Task 1's checks no longer depend on tasks 2 and 3.
  - The scope now lets `parseCommand` change to `RunCommand | "help"`.
  - The suggestion has a tie rule.
- The operator, 2026-10-24: task 0 added, so that every command but `run` is one file.

### Task 0

- Architecture and scope:
- Correctness and proof:

### Task 1

- Architecture and scope:
- Correctness and proof:

### Task 2

- Architecture and scope:
- Correctness and proof:

### Task 3

- Architecture and scope:
- Correctness and proof:

### Task 4

- Architecture and scope:
- Correctness and proof:

### Task 5

- Architecture and scope:

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
