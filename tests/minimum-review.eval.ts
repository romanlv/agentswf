import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRunHostFactory,
  AgentRuntimeConfig,
  HarnessOperationBinding,
  HarnessReleaseDisposition,
  HarnessSession,
  HarnessTurn,
} from "../packages/harness/src/adapter";
import type {
  AgentStructuredTurnSpec,
  AgentTextTurnSpec,
  JsonValue,
} from "../packages/contract/src/workflow";
import { createHerdrRunHostFactory } from "../packages/harness/src/adapters/herdr";
import { runProcess, type RunProcess } from "../packages/harness/src/command";
import { runWorkflow } from "../packages/engine/src";
import { createMinimumReview, type ReviewOutcome } from "../examples/minimum-review/workflow";

export const LIVE_EVALUATION_BOUNDS = {
  workflowMilliseconds: 10 * 60_000,
  initialTurnMilliseconds: 5 * 60_000,
  maximumNudgesPerReviewer: 1,
  reviewers: [
    { lens: "correctness", harness: "claude", model: "sonnet" },
    { lens: "maintainability", harness: "codex", model: "gpt-5.6-sol" },
  ],
  meteredFallback: false,
  agentVersionPolicy: "record-only",
  workspaceTrust: "evaluator-created-disposable",
} as const;

const minimumReview = createMinimumReview(
  {
    correctness: "correctness",
    maintainability: "maintainability",
  },
  LIVE_EVALUATION_BOUNDS.initialTurnMilliseconds,
);

type Check = {
  name: string;
  ok: boolean;
  detail: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type EvaluationPreflight = {
  ok: boolean;
  checks: Check[];
};

export type NativeOutcomeEvidence = {
  agent: string;
  harness: string;
  operation: "turn" | "nudge";
  settlement: "native" | "released" | "quarantined";
  state: "completed" | "blocked" | "timed-out" | "failed" | "cancelled" | "quarantined";
  detail?: string;
  usageSamples: number;
};

const ROOT = join(import.meta.dir, "..");
const CLI_SOURCE = join(ROOT, "packages/cli-agent/src/cli.ts");
const FIXTURE_SOURCE = join(ROOT, "examples/minimum-review/fixtures/review-target.ts");
const HERDR_SESSION = "default";
const EXPECTED_HERDR_VERSION = "herdr 0.8.2";
const METERED_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
] as const;

export function liveRuntime(
  nativeOutcomes: NativeOutcomeEvidence[] = [],
  run: RunProcess = runProcess,
): AgentRuntimeConfig {
  const host = createHerdrRunHostFactory(
    {
      session: HERDR_SESSION,
      workspaceLabel: "awf minimum review live evaluation",
      commandTimeoutMs: 150_000,
      settleTimeoutMs: LIVE_EVALUATION_BOUNDS.initialTurnMilliseconds,
      emptyEnvironment: METERED_CREDENTIAL_ENV,
      acceptWorkspaceTrust: true,
    },
    run,
  );
  return {
    aliases: {
      correctness: {
        harness: "claude",
        model: "sonnet",
      },
      maintainability: {
        harness: "codex",
        model: "gpt-5.6-sol",
      },
    },
    host: observeNativeOutcomes(host, nativeOutcomes),
  };
}

export async function evaluationPreflight(): Promise<EvaluationPreflight> {
  const checks: Check[] = [];
  checks.push({
    name: "herdr-environment",
    ok: process.env.HERDR_ENV === "1",
    detail: process.env.HERDR_ENV === "1" ? "managed pane" : "HERDR_ENV is not 1",
  });
  checks.push(await executable("workflow-cli", CLI_SOURCE));
  checks.push(await executable("review-fixture", FIXTURE_SOURCE, false));

  const credentialOverrides = METERED_CREDENTIAL_ENV.filter((name) => process.env[name]);
  checks.push({
    name: "no-metered-credential-environment",
    ok: credentialOverrides.length === 0,
    detail:
      credentialOverrides.length === 0
        ? "no API-key or provider override environment is present"
        : `remove credential overrides: ${credentialOverrides.join(", ")}`,
  });

  const herdrVersion = await command(["herdr", "--version"]);
  checks.push(herdrVersionCheck(herdrVersion));
  checks.push(
    herdrBehaviourCheck(
      await command(["herdr", "agent", "prompt", "--help"]),
      await command(["herdr", "tab", "create", "--help"]),
    ),
  );

  for (const [name, argv] of [
    ["claude", ["claude", "--version"]],
    ["codex", ["codex", "--version"]],
  ] as const) {
    const version = await command([...argv]);
    checks.push(agentVersionEvidence(name, version));
  }

  const herdr = await command(["herdr", "--session", HERDR_SESSION, "workspace", "list"]);
  checks.push({
    name: "herdr-session",
    ok: herdr.exitCode === 0,
    detail: herdr.exitCode === 0 ? `session ${HERDR_SESSION} reachable` : safeDetail(herdr),
  });

  const claude = await command(["claude", "auth", "status"]);
  const claudeStatus = parseRecord(claude.stdout);
  const claudeSubscription =
    claude.exitCode === 0 &&
    claudeStatus?.loggedIn === true &&
    claudeStatus.authMethod === "claude.ai" &&
    claudeStatus.apiProvider === "firstParty";
  checks.push({
    name: "claude-subscription-auth",
    ok: claudeSubscription,
    detail:
      claudeSubscription
        ? "authenticated via claude.ai first-party subscription"
        : "Claude Code is not authenticated through a claude.ai subscription",
  });

  const codex = await command(["codex", "login", "status"]);
  const codexStatus = `${codex.stdout}\n${codex.stderr}`;
  checks.push({
    name: "codex-subscription-auth",
    ok: codex.exitCode === 0 && /logged in using chatgpt/i.test(codexStatus),
    detail:
      codex.exitCode === 0 && /logged in using chatgpt/i.test(codexStatus)
        ? "authenticated via ChatGPT"
        : safeDetail(codex),
  });

  checks.push(await smokeWorkflowCli());
  return { ok: checks.every((check) => check.ok), checks };
}

export async function runLiveEvaluation() {
  assertLiveOptIn(process.env.WF_LIVE_EVAL);
  const preflight = await evaluationPreflight();
  if (!preflight.ok) {
    throw new Error(
      `live evaluation prerequisites failed: ${preflight.checks
        .filter((check) => !check.ok)
        .map((check) => `${check.name}: ${check.detail}`)
        .join("; ")}`,
    );
  }

  const repositoryBefore = await repositoryFingerprint();
  const prepared = await prepareEvaluationDirectory();
  const startedAt = Date.now();
  const nativeOutcomes: NativeOutcomeEvidence[] = [];
  let observedResult: unknown;
  try {
    const result = await runWorkflow(
      minimumReview,
      { target: "review-target.ts" },
      {
        runRoot: prepared.runRoot,
        runtime: liveRuntime(nativeOutcomes),
        deadline: {
          unixMilliseconds: startedAt + LIVE_EVALUATION_BOUNDS.workflowMilliseconds,
        },
        cwd: prepared.workDir,
      },
    );
    observedResult = result;
    assertCompletedReviews(result.value.reviews);
    assertNativeEvidence(nativeOutcomes);
    if ((await repositoryFingerprint()) !== repositoryBefore) {
      throw new Error("repository changed during the disposable live evaluation");
    }
    const output = {
      bounds: LIVE_EVALUATION_BOUNDS,
      elapsedMilliseconds: Date.now() - startedAt,
      nativeOutcomes,
      result,
    };
    await retainEvaluationEvidence(prepared.root, startedAt, nativeOutcomes, observedResult);
    await access(join(prepared.root, "evaluation.json"), constants.R_OK);
    return { ...output, artifacts: prepared.root };
  } catch (error) {
    await retainEvaluationEvidence(prepared.root, startedAt, nativeOutcomes, observedResult);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`live evaluation failed; artifacts retained at ${prepared.root}: ${reason}`, {
      cause: error,
    });
  }
}

export function assertLiveOptIn(value: string | undefined): void {
  if (value !== "1") throw new Error("WF_LIVE_EVAL=1 is required to start live agents");
}

export function assertCompletedReviews(reviews: ReviewOutcome[]): void {
  const [correctness, maintainability] = reviews;
  if (
    reviews.length !== 2 ||
    correctness?.kind !== "completed" ||
    correctness.lens !== "correctness" ||
    maintainability?.kind !== "completed" ||
    maintainability.lens !== "maintainability"
  ) {
    const observed = reviews
      .map((review) =>
        review.kind === "completed"
          ? `${review.lens}:completed`
          : `${review.lens}:incomplete:${review.outcome}:${review.reason}`,
      )
      .join(", ");
    throw new Error(`live evaluation requires completed reviews in lens order; observed ${observed}`);
  }
}

export async function retainEvaluationEvidence(
  root: string,
  startedAt: number,
  nativeOutcomes: NativeOutcomeEvidence[],
  result: unknown,
): Promise<void> {
  let evidenceDirectory: string | undefined;
  try {
    evidenceDirectory = await mkdtemp(join(root, ".evaluation-evidence-"));
    const temporary = join(evidenceDirectory, "evaluation.json");
    await writeFile(
      temporary,
      `${JSON.stringify(
        {
          bounds: LIVE_EVALUATION_BOUNDS,
          elapsedMilliseconds: Date.now() - startedAt,
          nativeOutcomes,
          ...(result === undefined ? {} : { result }),
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporary, join(root, "evaluation.json"));
  } catch {
    // Preserve the original evaluation failure when diagnostic persistence is also unavailable.
  } finally {
    if (evidenceDirectory) {
      try {
        await rm(evidenceDirectory, { recursive: true, force: true });
      } catch {
        // Diagnostic cleanup cannot replace the evaluation failure either.
      }
    }
  }
}

export function assertNativeEvidence(outcomes: NativeOutcomeEvidence[]): void {
  if (
    outcomes.some(
      (outcome) =>
        outcome.state !== "completed" &&
        !(outcome.state === "cancelled" && outcome.settlement === "released"),
    )
  ) {
    const observed = outcomes
      .map(
        (outcome) =>
          `${outcome.agent}:${outcome.operation}:${outcome.settlement}:${outcome.state}`,
      )
      .join(", ");
    throw new Error(
      `live evaluation requires native completion or confirmed release; observed ${observed}`,
    );
  }
  const completed = new Map(
    outcomes.map((outcome) => [outcome.agent, outcome]),
  );
  if (
    completed.get("reviewer:correctness")?.harness !== "claude" ||
    completed.get("reviewer:maintainability")?.harness !== "codex"
  ) {
    const observed = outcomes
      .map((outcome) => `${outcome.agent}:${outcome.harness}:${outcome.state}`)
      .join(", ");
    throw new Error(`live evaluation requires native completion from both harnesses; observed ${observed}`);
  }
}

function observeNativeOutcomes(
  factory: AgentRunHostFactory,
  evidence: NativeOutcomeEvidence[],
): AgentRunHostFactory {
  return {
    async openRun(request) {
      const host = await factory.openRun(request);
      return {
        inspect: () => host.inspect(),
        close: (reason) => host.close(reason),
        async openAgent(activation) {
          const session = await host.openAgent(activation);
          return observeSession(
            session,
            activation.key,
            activation.execution.harness,
            evidence,
          );
        },
      };
    },
  };
}

function observeSession(
  session: HarnessSession,
  agent: string,
  harness: string,
  evidence: NativeOutcomeEvidence[],
): HarnessSession {
  return {
    ...session,
    start: (async (
      turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
      binding: HarnessOperationBinding,
    ) => {
      const native = turn.schema
        ? await session.start(turn as AgentStructuredTurnSpec<JsonValue>, binding)
        : await session.start(turn as AgentTextTurnSpec, binding);
      return observeTurn(native, "turn", agent, harness, evidence);
    }) as HarnessSession["start"],
  };
}

export function observeTurn(
  turn: HarnessTurn,
  operation: "turn" | "nudge",
  agent: string,
  harness: string,
  evidence: NativeOutcomeEvidence[],
): HarnessTurn {
  let releasePending = false;
  let recorded = false;
  const record = (
    outcome: Awaited<HarnessTurn["settled"]>,
    settlement: NativeOutcomeEvidence["settlement"],
  ) => {
    if (recorded) return;
    recorded = true;
    evidence.push({
      agent,
      harness,
      operation,
      settlement,
      state: outcome.state,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      usageSamples: outcome.nativeUsage.length,
    });
  };
  void turn.settled
    .then((outcome) => {
      if (!releasePending) record(outcome, "native");
    })
    .catch(() => undefined);
  return {
    ...turn,
    async nudge(spec) {
      return observeTurn(await turn.nudge(spec), "nudge", agent, harness, evidence);
    },
    async release(reason, deadline): Promise<HarnessReleaseDisposition> {
      releasePending = true;
      try {
        const disposition = await turn.release(reason, deadline);
        if (disposition.kind === "released") {
          record(disposition.outcome, "released");
        } else if (!recorded) {
          recorded = true;
          evidence.push({
            agent,
            harness,
            operation,
            settlement: "quarantined",
            state: "quarantined",
            detail: disposition.reason,
            usageSamples: 0,
          });
        }
        return disposition;
      } catch (error) {
        if (!recorded) {
          recorded = true;
          evidence.push({
            agent,
            harness,
            operation,
            settlement: "quarantined",
            state: "quarantined",
            detail: "native release rejected",
            usageSamples: 0,
          });
        }
        throw error;
      }
    },
  };
}

async function prepareEvaluationDirectory(): Promise<{
  root: string;
  workDir: string;
  runRoot: string;
  binDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "awf-minimum-review-"));
  const workDir = join(root, "work");
  const runRoot = join(root, "runs");
  const binDir = join(root, "bin");
  await Promise.all([mkdir(workDir), mkdir(runRoot), mkdir(binDir)]);
  await copyFile(FIXTURE_SOURCE, join(workDir, "review-target.ts"));
  const built = await command([
    "bun",
    "build",
    CLI_SOURCE,
    "--compile",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--outfile",
    join(binDir, "wf"),
  ]);
  if (built.exitCode !== 0) throw new Error(`failed to compile evaluation wf CLI: ${safeDetail(built)}`);
  return { root, workDir, runRoot, binDir };
}

async function repositoryFingerprint(): Promise<string> {
  const listed = await command(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (listed.exitCode !== 0) throw new Error(`could not fingerprint repository: ${safeDetail(listed)}`);
  const paths = listed.stdout.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    try {
      hash.update(await readFile(join(ROOT, path)));
    } catch (error) {
      hash.update(error instanceof Error ? error.name : "unreadable");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function smokeWorkflowCli(): Promise<Check> {
  const prepared = await prepareEvaluationDirectory();
  try {
    // Run bare, the way nothing is meant to: the refusal proves the executable built and its
    // contract imports resolved. The live path reaches it through the engine's own launcher.
    const result = await command([join(prepared.binDir, "wf")]);
    const ok = result.exitCode === 2 && result.stderr.includes("must be run through the launcher");
    return {
      name: "workflow-cli-smoke",
      ok,
      detail: ok ? "wf executable and contract imports resolve" : safeDetail(result),
    };
  } finally {
    await rm(prepared.root, { recursive: true, force: true });
  }
}

async function executable(name: string, path: string, requireExecute = true): Promise<Check> {
  try {
    await access(path, requireExecute ? constants.R_OK | constants.X_OK : constants.R_OK);
    return { name, ok: true, detail: path };
  } catch {
    return { name, ok: false, detail: `${path} is unavailable` };
  }
}

export function agentVersionEvidence(
  name: "claude" | "codex",
  result: CommandResult,
): Check {
  return { name: `${name}-version`, ok: true, detail: safeDetail(result) };
}

/**
 * The adapter's fake Herdr (`packages/harness/src/testing/herdr-cli.ts`) encodes these, so a suite
 * built on it stays green when Herdr stops behaving this way. Reading them back from the installed
 * CLI costs nothing and fails the dry run instead of a live one.
 */
export function herdrBehaviourCheck(prompt: CommandResult, tab: CommandResult): Check {
  const promptHelp = `${prompt.stdout}\n${prompt.stderr}`;
  const tabHelp = `${tab.stdout}\n${tab.stderr}`;
  const missing = [
    ...(promptHelp.includes("agent_prompt_stalled")
      ? []
      : ["`agent prompt` no longer documents agent_prompt_stalled"]),
    ...(/does not track turns/i.test(promptHelp)
      ? []
      : ["`agent prompt --wait` no longer disclaims turn tracking"]),
    ...(/--env <KEY=VALUE>/.test(tabHelp)
      ? []
      : ["`tab create` no longer takes --env, so an agent's tab cannot be given one"]),
  ];
  return {
    name: "herdr-documented-behaviour",
    ok: missing.length === 0,
    detail: missing.length === 0 ? "prompt settlement and tab environment unchanged" : missing.join("; "),
  };
}

export function herdrVersionCheck(result: CommandResult): Check {
  const observed = (result.stdout || result.stderr).trim();
  const ok = result.exitCode === 0 && observed === EXPECTED_HERDR_VERSION;
  return {
    name: "herdr-version",
    ok,
    detail: ok
      ? EXPECTED_HERDR_VERSION
      : `expected ${EXPECTED_HERDR_VERSION}; ${safeDetail(result)}`,
  };
}

async function command(argv: string[]): Promise<CommandResult> {
  try {
    const child = Bun.spawn({ cmd: argv, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 127,
    };
  }
}

function parseRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function safeDetail(result: { stdout: string; stderr: string; exitCode: number }): string {
  const detail = (result.stderr || result.stdout || `exit ${result.exitCode}`).trim();
  return detail.slice(0, 200);
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  try {
    if (dryRun) {
      const output = await evaluationPreflight();
      console.log(JSON.stringify(output, null, 2));
      if (!output.ok) process.exitCode = 1;
    } else {
      console.log(JSON.stringify(await runLiveEvaluation(), null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
