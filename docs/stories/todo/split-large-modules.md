---
title: Split the large modules, and keep them split
type: story
status: todo
priority: P2
discovered_in: "codebase review, 2026-10-01"
depends_on: []
---

# Split the large modules, and keep them split

Four source files have grown past 900 lines along seams a review found, and nothing stops the next
one; plan the splits, then add a check and an AGENTS.md rule that hold the line.

Why it matters: an agent reading `workflow-runner.ts` to change one turn helper loads 2,000 lines of
unrelated code, and two sessions editing the same big file on a shared main collide. The seams below
are clear, but a split is a move of half a package: done ad hoc, mid-story, it fights every
concurrent branch and blurs what a module owns. So it needs a plan first, and a check after, or the
files grow back.

Notes:

- Non-test source over 900 lines on 2026-10-01, with the seams the review found:
  - `packages/engine/src/workflow-runner.ts` (1,983): `LogicalAgent` and its turn helpers
    (`HeldTurn`, `TurnAttempt`, `observe*`, `releaseTurn`, `reconcile`, `operationPrompt`) →
    `logical-agent.ts`; `ExecutionScope`, `runParallel`, `executeParallel` → `parallel.ts`;
    `resolveExecution`, `storedPlacement`, `constrainExistingExecution`, `resolveAlias`,
    `assertCompatibleAgent` → `runtime-selection.ts`. `scopes` and `CLEANUP_GRACE_MILLISECONDS`
    become shared; `startWorkflow` and `WorkflowOwner` stay, about 1,000 lines. `LogicalAgent.run`
    and `compact` repeat about 40 lines of admission (closed and scope checks, idempotent replay,
    queueing, progress, tracking) that one helper could hold.
  - `packages/lab/src/review/lab/cli.ts` (1,687): argument parsing and usage; resolving subjects
    and selections; then one file per command (run and score, run against a baseline, loop, report,
    show, check, list), `list`'s rendering beside `renderCheck` and `renderShow`.
  - `packages/harness/src/adapters/herdr.ts` (1,141): `createHerdrCommands` with `startAgent`,
    `adoptAgent`, `typeInto` → `herdr-commands.ts`; `openTopology` → `herdr-topology.ts`;
    `compactInPane` and `paneOutcome` beside them. `createPaneAdapter`, about 150 lines, is used
    only by tests: move it under `testing/` or point the conformance test at the run host.
  - `packages/engine/src/operator-cli.ts` (901): the `--here`/`--session` code (`startHere`,
    `claimCaller`, `findCaller`, `showOwnTab`, `SESSION_CODE`) → `caller-session.ts`;
    `parseCommand`, `usage`, `readSandboxSpec` → `run-command.ts`, as `test-command.ts` is.
  - Near the line: lab's `execute.ts` (906), sandbox's `docker/index.ts` (845: the protected-path
    guard, `boxHerdr` and the relay, `dockerClient`).
- Related duplication to settle in the same pass, not separately: the active-operation pattern
  (`activeController`, `activeCompletion`, `finish`) written four times across `herdr.ts`,
  `herdr-caller.ts` and `direct-process.ts`; "spawn in its own group, time out, kill the group,
  drain" written four times (`harness/command.ts`, docker's client, the conformance helper, the srt
  probe).
- Plan before moving: what each new module owns and exports, in the terms of
  [[foundation]]; whether a seam is a new boundary for `scripts/check-boundaries.ts` or only a file;
  and an order that lands one file per commit, on a quiet main, with `bun test` green between.
- The check, once split: a file-size limit in `bun run check`. Biome has no per-file line rule, so
  it is a few lines in `scripts/check-boundaries.ts` or a script beside it: non-test source over
  {n} lines fails, with a short allowlist that says why each entry is there. Tests and evals are
  exempt, or have their own, higher limit.
- The rule, for AGENTS.md "Working here": a module owns one thing; when a change takes a file past
  the limit, split along its seam in its own commit before the change, not after.
- Decide {n}: 800 catches today's six without touching the 600-line tables (`spec.ts`,
  `output.ts`) that read fine as one.
