import { createRequire } from "node:module";
import { access, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
  const binDir = await installAgentCommand();
  const host = createHerdrRunHostFactory(
    {
      session: environment.AWF_HERDR_SESSION || "default",
      workspaceLabel: "awf run",
      commandTimeoutMs: Math.min(timeoutMilliseconds, 150_000),
      settleTimeoutMs: timeoutMilliseconds,
      binDir,
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
    cleanup: () => rm(binDir, { recursive: true, force: true }),
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

async function installAgentCommand(): Promise<string> {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@wf/cli-agent/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relativeTarget =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.wf;
  if (!relativeTarget) throw new Error("@wf/cli-agent does not publish the wf command");
  const target = resolve(dirname(manifestPath), relativeTarget);
  await access(target, constants.X_OK);
  const binDir = await mkdtemp(join(tmpdir(), "awf-agent-bin-"));
  try {
    await symlink(target, join(binDir, "wf"));
    return binDir;
  } catch (error) {
    await rm(binDir, { recursive: true, force: true });
    throw error;
  }
}
