import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunProcess, runProcess } from "../command";
import { harnessSpec } from "../spec";
import type { Harness } from "../types";
import type { AllowanceRead } from "../usage/allowance";
import { createHerdrCommands, type HerdrConfig } from "./herdr";
import {
  emptyEnvironmentArgs,
  readable,
  readId,
  readPaneId,
  safeAgentName,
} from "./herdr-protocol";

/** Starting the harness and showing its usage took about ten seconds for cursor. */
const PANE_READ_MS = 90_000;

/**
 * A harness's plan as its TUI's usage screen shows it: its pane opens unfocused in a workspace of
 * its own, in an empty folder, is driven through the harness's `allowancePane` steps and read, and
 * is closed whatever happened. Nothing it does asks a model.
 */
export async function readPaneAllowance(
  harness: Harness,
  config: HerdrConfig,
  options: { run?: RunProcess; now?: () => number; signal?: AbortSignal } = {},
): Promise<AllowanceRead> {
  const spec = harnessSpec(harness);
  const pane = spec.allowancePane;
  if (!pane) return { read: "none", reason: spec.absent.allowancePane ?? "no usage screen" };
  const { run = runProcess, now = Date.now, signal } = options;
  const deadline = now() + PANE_READ_MS;
  const left = () => Math.max(1, deadline - now());
  const { herdr, startAgent } = createHerdrCommands({ ...config, acceptWorkspaceTrust: true }, run);
  const failed = (what: string, error: string): AllowanceRead => ({
    read: "none",
    reason: `${harness}'s usage screen: ${what}: ${error}`,
  });
  const cwd = mkdtempSync(join(tmpdir(), "awf-allowance-"));
  let workspaceId: string | undefined;
  try {
    const created = await herdr(
      [
        "workspace",
        "create",
        "--label",
        `awf allowance ${harness}`,
        ...emptyEnvironmentArgs(config.emptyEnvironment),
        "--cwd",
        cwd,
        "--no-focus",
      ],
      left(),
      signal,
    );
    if (!created.ok) return failed("opening its pane failed", created.error);
    workspaceId = readId(created.result.workspace, "workspace_id");
    const paneId = readPaneId(created.result);
    if (!paneId || !workspaceId) return failed("opening its pane failed", "no pane was named");
    const started = await startAgent(
      safeAgentName(`awf-allowance-${harness}`),
      harness,
      paneId,
      spec.interactive().argv.slice(1),
      deadline,
      signal,
    );
    if (!started.ok) return failed("starting it failed", started.error);
    const awaited = (text: string) =>
      herdr(
        ["pane", "wait-output", paneId, "--match", text, "--timeout", String(left())],
        left() + 5_000,
        signal,
      );
    const steps = [...(spec.paneReady ? [{ await: spec.paneReady }] : []), ...pane.steps];
    for (const step of steps) {
      const done =
        "type" in step
          ? await herdr(["pane", "send-text", paneId, step.type], left(), signal)
          : "key" in step
            ? await herdr(["pane", "send-keys", paneId, step.key], left(), signal)
            : await awaited(step.await);
      if (!done.ok) {
        const screen = await herdr(["pane", "read", paneId], config.commandTimeoutMs);
        const shown = screen.ok ? readable(screen.stdout).trim().split("\n").at(-1) : undefined;
        return failed(
          "await" in step ? `\`${step.await}\` never showed` : "typing into it failed",
          shown ? `${done.error}; it shows ${shown.trim()}` : done.error,
        );
      }
    }
    const screen = await herdr(["pane", "read", paneId], left(), signal);
    if (!screen.ok) return failed("reading it failed", screen.error);
    return pane.read(readable(screen.stdout), now());
  } finally {
    if (workspaceId) await herdr(["workspace", "close", workspaceId]).catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
}
