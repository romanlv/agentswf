import type { Fact } from "./index";

/** What a dataset's `capture.ts` default export carries, checked by the helper that loads it. */
export const CAPTURE_KIND = "awf.case-capture/0";

/** A real run of the workflow, as `capture` is given it: its record, read from its folder. */
export type CapturedRun = {
  id: string;
  /** The workflow's `meta.name`. */
  workflow: string;
  /** Its arguments, as given. */
  argv: string[];
  /** The args a program started it with, as JSON; absent for a run started from argv. */
  args?: unknown;
  /** How its last attempt ended: `completed`, `failed`, …, or `running` while it hasn't. */
  outcome: string;
  /** Its value when it completed; null otherwise. */
  result: unknown;
  /** The run's folder: its logs and records. */
  dir: string;
};

/** One case a run gives: its folder's name, its `input.json`, its `files/`, and what it did. */
export type CapturedCase = {
  name: string;
  input?: unknown;
  /** Paths inside the case's `files/`, each to its contents. */
  files?: Record<string, string>;
  /** What `observe` would have returned, read off this case's share of the result. */
  facts?: Record<string, Fact>;
};

export type Capture = {
  readonly kind: typeof CAPTURE_KIND;
  capture(input: { run: CapturedRun; root: string }): CapturedCase[] | Promise<CapturedCase[]>;
};

/**
 * The default export of a dataset's `capture.ts`: turns a real run of the workflow into cases,
 * one per thing it handled (a mail run that read five emails gives five). `awf-lab capture {run}`
 * calls it in your checkout and writes each case with a draft key.
 */
export function defineCapture(
  capture: (input: { run: CapturedRun; root: string }) => CapturedCase[] | Promise<CapturedCase[]>,
): Capture {
  return { kind: CAPTURE_KIND, capture };
}
