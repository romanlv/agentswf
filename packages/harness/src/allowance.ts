import type { HarnessAllowance } from "@agentswf/contract/records";
import type { HerdrConfig } from "./adapters/herdr";
import { readPaneAllowance } from "./adapters/herdr-allowance";
import type { RunProcess } from "./command";
import { absence, harnessSpec } from "./spec";
import type { Harness } from "./types";

export type AllowanceOptions = {
  /** How the harness is run, so it reads the login its agents get. */
  run: RunProcess;
  now: () => number;
  /** The Herdr a usage screen opens in, asked for only when a harness has nothing else. */
  herdr: () => Promise<HerdrConfig>;
  /** Stops a usage screen's read; its pane is closed all the same. */
  signal?: AbortSignal;
};

/**
 * What is left of `harness`'s plan: by a command of its own where it has one, else its TUI's usage
 * screen in a pane, else why it can't be read. Never throws: a failed read is `none`, with why.
 */
export async function readAllowance(
  harness: Harness,
  options: AllowanceOptions,
): Promise<HarnessAllowance> {
  const spec = harnessSpec(harness);
  try {
    if (spec.readAllowance) {
      return { harness, ...(await spec.readAllowance({ run: options.run, now: options.now() })) };
    }
    if (spec.allowancePane) {
      const config = await options.herdr();
      return {
        harness,
        ...(await readPaneAllowance(harness, config, {
          run: options.run,
          now: options.now,
          ...(options.signal ? { signal: options.signal } : {}),
        })),
      };
    }
  } catch (error) {
    return {
      harness,
      read: "none",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return { harness, read: "none", reason: absence(harness, "readAllowance") };
}
