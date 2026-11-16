import type { Fact } from "./settings";
import type { Refused } from "./trial-file";

// What the lab hands a trial's process, and what `defineEnv` gives back: the one seam between the
// lab's side and `@agentswf/lab/cases`, which runs in the project's process.

/** The environment variables the lab sets for a trial's `awf run`. */
export const TRIAL_ENV = {
  /** The built case folder: the shared and the case's own files, and `input.json`. No key. */
  case: "AWF_LAB_CASE",
  /** The trial file `defineEnv` appends to. */
  trial: "AWF_LAB_TRIAL",
  /** The trial's empty scratch folder, also the run's `--cwd`. */
  scratch: "AWF_LAB_SCRATCH",
  /** The code folder: your checkout, or a folder `--against` names. */
  root: "AWF_LAB_ROOT",
  /** `TrialSettings` as JSON. */
  settings: "AWF_LAB_SETTINGS",
} as const;

/** From `dataset.json`, resolved by the lab. */
export type TrialSettings = {
  dataset: string;
  /** The dataset's folder, whose files are never the workflow's source. */
  datasetDir?: string;
  /** The body's limit, in ms. */
  timeoutMs: number;
  /** `setup`'s limit, and again `observe` with teardown, in ms. */
  setupTimeoutMs: number;
  /** Hosts the workflow's code may reach for real: `realHosts` and the engine's own. */
  realHosts: string[];
};

/** The run's value: `awf run --json`'s `value` for a trial that completed. */
export type EnvValue = {
  workflow: { name: string; version?: string };
  /** `null` under `until`. */
  result: unknown;
  facts: Record<string, Fact>;
  stages: Record<string, unknown>;
  given: string[];
  unused: string[];
  refused: Refused[];
};
