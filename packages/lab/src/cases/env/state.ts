import { appendFileSync } from "node:fs";
import { TRIAL_ENV, type TrialSettings } from "../format/trial-env";
import type { Phase, Refused, TrialLine } from "../format/trial-file";
import type { Route } from "./routes";

/** A request the lab's `fetch` saw: routed, real, refused or over a unix socket. */
export type HttpRequest = {
  method: string;
  url: string;
  body?: string;
  /** Bun's `unix` option, for a `fetch` over a socket. */
  unix?: string;
};

/**
 * What the `fetch` preload and `defineEnv` share. On a `globalThis` symbol rather than in a module,
 * so the preload's copy and the copy `env.ts` imports share it even when they resolve apart.
 */
export type Shared = {
  phase: Phase;
  refused: Refused[];
  routes: Route[];
  requests: HttpRequest[];
  /** `globalThis.fetch` as it was before the preload; undefined until it ran. */
  realFetch?: typeof fetch;
  /** The `writeLine`s after this are dropped: a timed-out trial's file ends at its line. */
  closed: boolean;
};

const KEY = Symbol.for("agentswf.lab.cases");
// A copy taken at load: a mock of `node:fs` that `spyOn` set up by hand doesn't reach the trial file.
const append = appendFileSync;

export function shared(): Shared {
  const holder = globalThis as { [KEY]?: Shared };
  holder[KEY] ??= { phase: "setup", refused: [], routes: [], requests: [], closed: false };
  return holder[KEY];
}

/** Appends a line to the trial file; nothing outside a trial. */
export function writeLine(line: TrialLine): void {
  const file = process.env[TRIAL_ENV.trial];
  if (!file || shared().closed) return;
  append(file, `${JSON.stringify(line)}\n`);
}

/**
 * Records a call the case doesn't fake, in the trial file and on the lab's side, and returns the
 * error to throw: the trial errors as the dataset's even when the workflow catches it.
 */
export function refuse(what: string, by: Refused["by"], message: string): Error {
  const state = shared();
  const refused: Refused = { what, by, phase: state.phase, message };
  state.refused.push(refused);
  writeLine({ refused });
  return new Error(message);
}

/** The trial's parameters, `{}` when the lab gave none. */
export function trialParams(): Record<string, string> {
  const text = process.env[TRIAL_ENV.params];
  return text ? (JSON.parse(text) as Record<string, string>) : {};
}

export function trialSettings(): TrialSettings | undefined {
  const text = process.env[TRIAL_ENV.settings];
  return text ? (JSON.parse(text) as TrialSettings) : undefined;
}
