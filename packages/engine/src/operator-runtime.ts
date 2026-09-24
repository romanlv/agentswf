import {
  createHeadlessRunHostFactory,
  createHerdrRunHostFactory,
  createPlacementHostFactory,
  type RunProcess,
  readClaudeBilling,
  readCodexBilling,
  runProcess,
  withholding,
} from "@wf/harness";
import type { AgentRuntimeConfig } from "@wf/harness/adapter";

export type OperatorRuntimeInstallation = {
  config: AgentRuntimeConfig;
  cleanup(): Promise<void>;
};

export type OperatorRuntimeOptions = {
  run?: RunProcess;
  environment?: Readonly<Record<string, string | undefined>>;
};

/**
 * One run host for every agent: a Herdr tab for a pane agent, a subprocess per turn for a
 * headless one. Metered credentials are cleared from both.
 */
export async function installOperatorRuntime(
  timeoutMilliseconds: number,
  options: OperatorRuntimeOptions = {},
): Promise<OperatorRuntimeInstallation> {
  const { run = runProcess, environment = process.env } = options;
  const unmetered = withholding(run, METERED_CREDENTIAL_ENVIRONMENT);
  await assertSubscriptionAuthentication(unmetered, environment);
  const panes = (session: string) =>
    createHerdrRunHostFactory(
      {
        session,
        workspaceLabel: "awf run",
        commandTimeoutMs: Math.min(timeoutMilliseconds, 150_000),
        settleTimeoutMs: timeoutMilliseconds,
        emptyEnvironment: METERED_CREDENTIAL_ENVIRONMENT,
        acceptWorkspaceTrust: true,
      },
      run,
    );
  const { accounting } = panes("default");
  const host = createPlacementHostFactory({
    // The session is looked up when the first pane agent opens, so an all-headless run never
    // calls Herdr.
    pane: {
      ...(accounting ? { accounting } : {}),
      openRun: async (spec) => panes(await herdrSession(run, environment)).openRun(spec),
    },
    headless: createHeadlessRunHostFactory({ turnTimeoutMs: timeoutMilliseconds }, unmetered),
  });
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

/**
 * `AWF_HERDR_SESSION` when set; otherwise the session of the pane awf runs in, so its agents open
 * beside it; `default` outside Herdr.
 */
export async function herdrSession(
  run: RunProcess,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  if (environment.AWF_HERDR_SESSION) return environment.AWF_HERDR_SESSION;
  const socket = environment.HERDR_SOCKET_PATH;
  if (!socket) return "default";
  const listed = await run({ argv: ["herdr", "session", "list", "--json"], timeoutMs: 10_000 });
  let sessions: { name?: unknown; socket_path?: unknown }[] = [];
  if (listed.exitCode === 0) {
    try {
      sessions = JSON.parse(listed.stdout).sessions ?? [];
    } catch {}
  }
  const name = sessions.find((session) => session.socket_path === socket)?.name;
  // Falling back to `default` would put the agents in a session nobody is looking at.
  if (typeof name !== "string") {
    throw new Error(
      `no Herdr session owns ${socket} (\`herdr session list --json\`); set AWF_HERDR_SESSION`,
    );
  }
  return name;
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
  run: RunProcess,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const configured = METERED_CREDENTIAL_ENVIRONMENT.filter((name) => environment[name]?.trim());
  if (configured.length > 0) {
    throw new Error(
      `subscription runtime refused metered credential environment: ${configured.join(", ")}`,
    );
  }
  const [claude, codex] = await Promise.all([readClaudeBilling(run), readCodexBilling(run)]);
  if (claude !== "subscription") {
    throw new Error(
      `Claude subscription authentication is required (claude.ai login or \`claude setup-token\`); \`claude auth status\` reads as ${claude}`,
    );
  }
  if (codex !== "subscription") {
    throw new Error(
      `Codex subscription authentication is required (ChatGPT login); \`codex login status\` reads as ${codex}`,
    );
  }
}
