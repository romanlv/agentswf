/** The live evals' consent to spend, which `bun run eval` gives. */
export const LIVE_EVAL = "AWF_LIVE_EVAL";

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
