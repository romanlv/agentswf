# Adding a harness

A harness is a terminal coding agent awf drives: claude, codex, pi, cursor. This page is what
adding one takes. The compiler holds most of it. The rest is measurement, which no type can
check, and every fact in a harness's file should trace back to one.

## What the compiler holds

Add the name to `Harness` in `packages/harness/src/types.ts`. Then `tsc` fails in each place below
until the harness takes a position there: given, or `{ absent: "why" }` with the reason a refusal
will quote.

| Where | What it holds |
| --- | --- |
| `harness/src/harnesses/{name}.ts`, then `HARNESSES` in `spec.ts` | the `HarnessSpec`: launches, resumes, output readers, usage readers, billing, compaction, fork, interrupt, pane quirks. Every optional field is given or named in `defineHarness`'s absences; a field given and named both fails too |
| `harness/src/state.ts`, `HOME_ENV` and `DEFAULT_STATE` | the variable that moves its state, and where the state is otherwise |
| `harness/src/adapters/herdr-startup.ts`, `STARTUP_BLOCKS` | the screens a pane shows before its first prompt, and the keys that answer each. Absent keeps it out of panes |
| `harness/src/sandbox-needs.ts`, `SANDBOXED` | what it needs in a sandbox: credential files or a token, model domains, config written fresh, the arguments that turn off what reaches past the sandbox, and whether an agent on the host may have a home of its own |
| `harness/src/capabilities/skills.ts`, `SKILLS` | where its skills go on the host, and the arguments and environment that hold it to them |
| `engine/src/operator-runtime.ts`, `LOGINS` | the subscription login checked before its first agent opens |

Fields of the spec the engine reads across every harness, so they are required rather than absent:
`callingSessionEnv` (withheld from every agent), `meteredCredentials` (withheld, and refuse a run),
`herdrSessionIsOwn`, `meteredHeadless`.

A capability added to `HarnessSpec` as optional fails to compile until every harness gives it or
says why not. A new per-harness table should be a `Record<Harness, X | Absent>` for the same
reason, never a list, a `Partial` or a `switch` with a default.

## What to measure first

Each of these is a live probe, recorded under `experiments/` and cited where it is used:

- **Launch and resume.** The headless command, its output format, where the session id is printed,
  and a resume that keeps the context. Whether it takes a session id we choose.
- **Its session in the agent's shell.** The variable it sets for commands it runs (`sessionEnv`),
  which `wf` reports back; and what else it sets (`callingSessionEnv`).
- **Usage.** Where it logs each request's tokens and cache reads, whether a resumed or forked
  session's log repeats its parent's, and whether its subagents log apart. A dollar figure, if it
  prints one, per turn (`readCharge`) or as a running total (`readCostTotal`). Then its models in
  `engine/src/accounting/prices.ts`.
- **Billing.** What says subscription or metered (`billing`), and whether headless turns are billed
  per token whatever the login (`meteredHeadless`).
- **Plan allowance.** The command that shows what is left of its plan without a model turn, headless
  (`readAllowance`) or only in its TUI (`allowancePane`); its output recorded for the parser, and
  whether a slash command sent headless goes to the model instead (story 022).
- **Fork and its cache.** A fork with no model call, and whether the fork reads its parent's cache:
  what keys the provider's cache (`docs/findings/fork-cache.md`).
- **Compaction.** Headless and in a pane, with a focus, and what shows it ran
  (`docs/findings/native-compaction.md`).
- **Effort and model.** Its levels (`effort`), the flag that launches at one, and whether it beats
  the harness's config and environment. Whether a headless resume runs at the model and effort it
  is given (`setHeadless`), and a pane relaunched on its session at them keeps the context
  (`setPane`). Where it logs what it ran at, and what it does with a level it lacks
  (`docs/findings/agent-effort.md`). Each launch plan passes `LaunchSettings`.
- **A pane.** Every startup screen, at a narrow and a wide pane, including the first run in a fresh
  home; what an interrupted turn shows (`interrupted`); whether Herdr names its session, and whether
  that is the pane's own.
- **A sandbox.** Under srt and docker: the domains its model needs, the files its login lives in or
  the token that stands in, what reads under `HOME` that its state variable does not move, the
  arguments that turn off web tools and plugins, and its own sandbox, which must be off inside ours.
  Every path it writes that ignores `TMPDIR` and its state variables, as cursor's `/tmp` paths do
  (story 019), and every socket it binds: a socket's path holds at most 104 bytes, and a sandbox's
  homes lie deep, which `shortDirectory` answers. Its first prompt in a sandboxed pane, which a
  slow start can lose (`paneReady`).
- **Skills.** Every root it reads skills from, on the host and in a fresh home, and how to point it
  at one directory and away from the operator's.
- **An expired login.** What it prints, headless and in a pane ([[expired-login]]).

## What else to change

- `packages/sandbox/docker/Dockerfile`: install it.
- `packages/sandbox/src/git.ts`, `HOST_RUN`: project files of its own that a sandboxed agent must
  not be able to rewrite for the operator's next session.
- `engine/src/operator-aliases.ts`, if `awf` should know it by a short name.
- The live evals: `tests/harnesses.eval.ts`, `fork.eval.ts`, `compaction.eval.ts`,
  `calling-session.eval.ts`, `skills.eval.ts` and the `sandbox-*` evals, with
  `examples/quick-check`, `examples/compaction` and `examples/fork`. Each lists its harnesses.
- `packages/lab` and `examples/single-agent-review` repeat `meteredHeadless` for claude, and
  `packages/lab/src/review/format/runtime.ts` every harness's effort levels, as they may not
  import the harness package.
- Docs: `status.md`, `workflow-api.md` (placements, compaction, effort), `foundation.md` §8 (usage),
  `design/permissions.md` (its permission column), `testing.md`, and a finding for each
  measurement.
