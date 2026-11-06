import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The live evals' consent to spend, which `bun run eval` gives. */
const LIVE_EVAL = "AWF_LIVE_EVAL";

/** Throws unless the runner gave that consent; `what` says what it is for. */
export function assertLiveOptIn(
  env: Readonly<Record<string, string | undefined>> = process.env,
  what = "start live agents",
): void {
  if (env[LIVE_EVAL] !== "1") throw new Error(`${LIVE_EVAL}=1 is required to ${what}`);
}

/** Aborts when the operator interrupts the eval. */
export function interruption(): AbortSignal {
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort("SIGINT"));
  process.on("SIGTERM", () => controller.abort("SIGTERM"));
  return controller.signal;
}

/**
 * Sets `name`, unless it is set, from the repository's git-ignored `.env`, which `bunfig.toml`
 * keeps Bun from loading whole.
 */
export async function loadFromDotEnv(name: string): Promise<void> {
  if (process.env[name]) return;
  const env = await readFile(join(import.meta.dir, "..", ".env"), "utf8").catch(() => "");
  const line = env.split("\n").find((entry) => entry.startsWith(`${name}=`));
  const value = line
    ?.slice(line.indexOf("=") + 1)
    .replace(/^["']|["']$/g, "")
    .trim();
  if (value) process.env[name] = value;
}
