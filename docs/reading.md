# Reading

Projects and essays not read yet, each with the question to read it against. When one is read
against its question, move it to [`reference.md`](reference.md) with what was taken, rejected and
left unmined, and delete it here.

## Before Stage 1 settles the harness seam

- **Agent Client Protocol (ACP)**: [site](https://agentclientprotocol.com),
  [spec repo](https://github.com/zed-industries/agent-client-protocol),
  [Claude Code adapter](https://github.com/zed-industries/claude-code-acp). JSON-RPC for driving
  coding agents, with sessions, streamed updates, permission requests and an explicit stop reason.
  Does it give the turn-completion signal that Herdr's ambiguous `idle` cannot, and is it a run host? %% so much easier to use native harness, and you can take over control or debug if needed, this is intentional, we can use any cli harness this way %%
- **Headless structured output**: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
  (`--output-schema`), [Codex SDK](https://developers.openai.com/codex/sdk)
  ([TypeScript](https://github.com/openai/codex/tree/main/sdk/typescript)),
  [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview)
  ([TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript)). Result channels E2 did
  not measure: do they replace `wf result` for headless agents, or only duplicate it?
%% already looked into, similar performance and restricted only for headless mode %%

## Before the usage record format hardens

- **OpenTelemetry GenAI semantic conventions**:
  [spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Standard names for token usage and
  agent spans. Should `SettledOperation` use them?
- **Harness OTel export**: [Claude Code monitoring](https://docs.claude.com/en/docs/claude-code/monitoring-usage),
  [Codex OTel config](https://developers.openai.com/codex/config-advanced). Can usage come from
  exported telemetry instead of session files? %% good idea, let's add it to TODO , we should standartize on OTel %%

## The run record and autoresearch

- **Inspect AI**: [docs](https://inspect.aisi.org.uk/), [repo](https://github.com/UKGovernmentBEIS/inspect_ai).
  Its eval-log format is a run record with outside readers. Its sandbox providers and its
  solver/scorer split bear on story 004 and story 008.
- **Harbor**: [repo](https://github.com/laude-institute/harbor), from
  [Terminal-Bench](https://www.tbench.ai). It drives Claude Code, Codex and others as installed
  agents in containers, with a trajectory format. It is the `harness` package, built by eval people.
- **τ-bench, pass^k**: [arXiv 2406.12045](https://arxiv.org/abs/2406.12045). The chance that all
  k runs succeed, not at least one. A candidate quality signal for open question 5.

## Before unshelving the journal

- **Restate**: [site](https://restate.dev), [TypeScript SDK](https://github.com/restatedev/sdk-typescript).
- **DBOS**: [docs](https://docs.dbos.dev), [TypeScript](https://github.com/dbos-inc/dbos-transact-ts).
  Durable execution as a library rather than a platform. What is their effect boundary?
- **Build Systems à la Carte** (Mokhov, Mitchell, Peyton Jones):
  [code and paper links](https://github.com/snowleopard/build). A resumable step is an incremental
  build. Which trace model covers the working tree that E6's journal key missed?
- **Bazel remote caching**: [docs](https://bazel.build/remote/caching). An action key that hashes
  every input, the git tree included.

## Deadlines and cancellation

- **Trio**: [Timeouts and cancellation for humans](https://vorpus.org/blog/timeouts-and-cancellation-for-humans/),
  [Notes on structured concurrency](https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful/).
  The canonical design for deadlines that nested scopes inherit.
- **Effect**: [site](https://effect.website). Scopes, interruption and retry schedules in
  TypeScript; opencode uses it.

## Sandboxes (story 004)

- **sandbox-runtime (srt)**: [repo](https://github.com/anthropic-experimental/sandbox-runtime).
- **container-use**: [repo](https://github.com/dagger/container-use). One agent per container and
  branch.
- **Codex sandbox modes**: [doc](https://github.com/openai/codex/blob/main/docs/sandbox.md). A
  policy vocabulary users already know.

## Checkpoints and humans

- **LangGraph interrupts**: [docs](https://docs.langchain.com/oss/javascript/langgraph/interrupts).
- **12-factor agents**: [repo](https://github.com/humanlayer/12-factor-agents). Compare both with
  the Temporal Update already chosen for checkpoints.

## Parallel coding-agent tools

For what users want (review, merging worktrees), not for architecture.

- [Conductor](https://conductor.build)
- [vibe-kanban](https://github.com/BloopAI/vibe-kanban)
- [Claude Squad](https://github.com/smtg-ai/claude-squad)
- [Sculptor](https://imbue.com/sculptor/)
- [Gas Town](https://github.com/steveyegge/gastown) and [Beads](https://github.com/steveyegge/beads)

## Essays

- **Cognition, [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents)**. The
  strongest case against this project's premise. Write the answer down.
- **Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)**.
  Token spend explained most of the performance difference; multi-agent used about 15× the tokens.
- **Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)**.
  Names for workflow patterns: orchestrator-workers, evaluator-optimizer.
- **Geoffrey Huntley, [Ralph](https://ghuntley.com/ralph/)**. The simplest loop, as a baseline for
  the variant matrix.
