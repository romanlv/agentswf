import type { Dataset } from "../format/settings";
import type { TrialSettings } from "../format/trial-env";

/**
 * The hosts the engine reaches itself from the trial's process: its decision provider,
 * `OPENROUTER_DECISIONS` in `engine/src/decisions/openrouter.ts`. One that falls behind refuses a
 * decision, which errors the trial as the dataset's and names the host.
 */
export const ENGINE_HOSTS = ["openrouter.ai"] as const;

const UNIT = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

/** `"30m"` in ms; the schema has already checked its shape. */
export function durationMs(text: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(text);
  if (!match) throw new Error(`not a duration: ${text}`);
  return Number(match[1]) * UNIT[match[2] as keyof typeof UNIT];
}

export function trialSettingsOf(name: string, dataset: Dataset, dir?: string): TrialSettings {
  return {
    dataset: name,
    ...(dir ? { datasetDir: dir } : {}),
    timeoutMs: durationMs(dataset.timeout ?? "30m"),
    setupTimeoutMs: durationMs(dataset.setupTimeout ?? "10m"),
    realHosts: [...new Set([...(dataset.realHosts ?? []), ...ENGINE_HOSTS])],
  };
}

/** `awf run --timeout`: a backstop the engine records as `timed-out`, past every phase's own. */
export function backstopOf(settings: TrialSettings): string {
  const ms = settings.timeoutMs + 2 * settings.setupTimeoutMs + 60_000;
  return `${Math.ceil(ms / 1000)}s`;
}
