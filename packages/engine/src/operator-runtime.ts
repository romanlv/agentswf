import type { AgentRuntimeConfig } from "@wf/harness/adapter";
import {
  createHerdrRunHostFactory,
  runProcess,
  type ProcessInput,
  type RunProcess,
} from "@wf/harness";

export type OperatorRuntimeInstallation = {
  config: AgentRuntimeConfig;
  cleanup(): Promise<void>;
};

export async function installOperatorRuntime(
  timeoutMilliseconds: number,
  run: RunProcess = runProcess,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<OperatorRuntimeInstallation> {
  await assertSubscriptionAuthentication(timeoutMilliseconds, run, environment);
  const host = createHerdrRunHostFactory(
    {
      session: environment.AWF_HERDR_SESSION || "default",
      workspaceLabel: "awf run",
      commandTimeoutMs: Math.min(timeoutMilliseconds, 150_000),
      settleTimeoutMs: timeoutMilliseconds,
      emptyEnvironment: METERED_CREDENTIAL_ENVIRONMENT,
      acceptWorkspaceTrust: true,
    },
    run,
  );
  return {
    config: {
      aliases: {
        claude: {
          harness: "claude",
          model: "sonnet",
        },
        codex: {
          harness: "codex",
          model: "gpt-5.6-sol",
        },
      },
      host,
    },
    // Nothing to undo: the agent's `wf` is a launcher the control plane installs beside its own
    // socket, and the control plane removes both when the run closes.
    cleanup: async () => undefined,
  };
}

export function withoutMeteredCredentials(input: ProcessInput): ProcessInput {
  const cleared = Object.fromEntries(
    METERED_CREDENTIAL_ENVIRONMENT.map((name) => [name, undefined]),
  );
  return {
    ...input,
    env: {
      ...input.env,
      ...cleared,
    },
  };
}

const METERED_CREDENTIAL_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
] as const;

async function assertSubscriptionAuthentication(
  timeoutMilliseconds: number,
  run: RunProcess,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const configured = METERED_CREDENTIAL_ENVIRONMENT.filter(
    (name) => environment[name]?.trim(),
  );
  if (configured.length > 0) {
    throw new Error(
      `subscription runtime refused metered credential environment: ${configured.join(", ")}`,
    );
  }
  const timeoutMs = Math.max(1, Math.min(timeoutMilliseconds, 15_000));
  const claude = await run(
    withoutMeteredCredentials({ argv: ["claude", "auth", "status"], timeoutMs }),
  );
  let claudeStatus: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(claude.stdout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      claudeStatus = parsed as Record<string, unknown>;
    }
  } catch {
    // The assertion below provides one stable operator-facing failure.
  }
  if (
    claude.exitCode !== 0 ||
    claudeStatus?.loggedIn !== true ||
    claudeStatus.authMethod !== "claude.ai" ||
    claudeStatus.apiProvider !== "firstParty"
  ) {
    throw new Error("Claude subscription authentication is required (claude.ai first-party)");
  }

  const codex = await run(
    withoutMeteredCredentials({ argv: ["codex", "login", "status"], timeoutMs }),
  );
  if (
    codex.exitCode !== 0 ||
    !/logged in using chatgpt/i.test(`${codex.stdout}\n${codex.stderr}`)
  ) {
    throw new Error("Codex subscription authentication is required (ChatGPT login)");
  }
}
