import { join } from "node:path";
import type { Billing } from "@agentswf/contract/records";
import type { RunProcess } from "../command";
import { parseRow, record, text } from "../json";
import { harnessState } from "../state";

export const STATUS_TIMEOUT_MS = 10_000;

/**
 * `claude auth status --json`. `oauth_token` is a plan's token from `claude setup-token`; the key
 * and third-party methods are metered. A Bedrock or Vertex provider reports `third_party` even over
 * a stored claude.ai login, so `apiProvider` adds nothing. Anything else says nothing about who pays.
 */
export function claudeBilling(stdout: string): Billing {
  const status = parseRow(stdout);
  if (status?.loggedIn !== true) return "unknown";
  switch (status.authMethod) {
    case "claude.ai":
    case "oauth_token":
      return "subscription";
    case "api_key":
    case "api_key_helper":
    case "third_party":
      return "metered";
    default:
      return "unknown";
  }
}

/** `codex login status` prints "Logged in using ChatGPT" or "Logged in using an API key". */
export function codexBilling(output: string): Billing {
  if (/logged in using chatgpt/i.test(output)) return "subscription";
  if (/logged in using an? api key/i.test(output)) return "metered";
  return "unknown";
}

/**
 * pi keeps one credential per provider: an `oauth` entry is a plan it signed in to, an `api_key`
 * entry is metered. The provider is the one pi logged, else the model's prefix, else pi's default.
 */
export function piBilling(
  auth: string,
  settings: string,
  model: string | undefined,
  provider: string | undefined,
): Billing {
  const chosen =
    provider ??
    (model?.includes("/")
      ? model.slice(0, model.indexOf("/"))
      : text(parseRow(settings)?.defaultProvider));
  if (!chosen) return "unknown";
  const type = record(parseRow(auth)?.[chosen])?.type;
  if (type === "oauth") return "subscription";
  if (type === "api_key") return "metered";
  return "unknown";
}

/** `run` is how the agents are launched, so the status reflects the credentials they get. */
export async function readClaudeBilling(run: RunProcess): Promise<Billing> {
  const result = await run({
    argv: ["claude", "auth", "status", "--json"],
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  return result.exitCode === 0 ? claudeBilling(result.stdout) : "unknown";
}

export async function readCodexBilling(run: RunProcess): Promise<Billing> {
  const result = await run({ argv: ["codex", "login", "status"], timeoutMs: STATUS_TIMEOUT_MS });
  // It prints the status on stderr.
  return result.exitCode === 0 ? codexBilling(`${result.stdout}\n${result.stderr}`) : "unknown";
}

/**
 * Whether cursor is logged in, by `cursor-agent status --format json`. It says nothing of the plan
 * or of an API key's billing.
 */
export async function readCursorLogin(run: RunProcess): Promise<boolean> {
  const result = await run({
    argv: ["cursor-agent", "status", "--format", "json"],
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  return result.exitCode === 0 && parseRow(result.stdout)?.isAuthenticated === true;
}

export async function readPiBilling(
  model: string | undefined,
  provider: string | undefined,
  agentDirectory = harnessState().pi,
): Promise<Billing> {
  const [auth, settings] = await Promise.all([
    readText(join(agentDirectory, "auth.json")),
    readText(join(agentDirectory, "settings.json")),
  ]);
  return piBilling(auth, settings, model, provider);
}

async function readText(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}
