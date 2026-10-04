import { readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord } from "../packages/contract/src/records";
import { herdrSession } from "../packages/engine/src/operator-runtime";
import { createHerdrCommands, type HerdrConfig } from "../packages/harness/src/adapters/herdr";
import { runProcess } from "../packages/harness/src/command";
import { harnessSpec } from "../packages/harness/src/spec";
import type { CallerSteps } from "./fixtures/caller-steps";
import { assertLiveOptIn, interruption } from "./live";

/**
 * `awf run --here` from claude, codex, pi and cursor sessions, live, on their cheapest models
 * (story 014). Each session is started in a Herdr tab and told to run the command, as an operator
 * would; the run it starts in a tab of its own drives it through three steps. The eval presses Esc
 * a few seconds into the second, a long essay, as an operator stopping it, and the third must
 * still recall the first's number.
 * Codex runs under its workspace-write sandbox with local sockets allowed, as an operator's would.
 * Must run inside Herdr. Four sessions at once, about three minutes and $0.10 at list prices.
 */
const STEPS = join(import.meta.dir, "fixtures/caller-steps.ts");
const CLI = join(import.meta.dir, "../packages/engine/src/operator-cli.ts");

const SESSIONS = {
  claude: harnessSpec("claude").interactive("claude-sonnet-5-5").argv.slice(1),
  codex: [
    "--sandbox",
    "workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--ask-for-approval",
    "never",
    "--model",
    "gpt-6-luna",
  ],
  pi: harnessSpec("pi").interactive("openai-codex/gpt-5.6-terra").argv.slice(1),
  cursor: [...harnessSpec("cursor").interactive("composer-2.5").argv.slice(1), "--trust"],
} as const;
type Harness = keyof typeof SESSIONS;

/** Where the operator's interrupt can be told apart, the step is `cancelled`; elsewhere unanswered. */
const INTERRUPTED: Record<Harness, string> = {
  claude: "cancelled",
  codex: "cancelled",
  pi: "cancelled",
  cursor: "unanswered",
};

export function problems(harness: Harness, record: OutputRecord | undefined): string[] {
  if (!record) return [`${harness}: no run record`];
  if (record.outcome !== "succeeded") {
    return [`${harness}: run ${record.outcome}: ${"error" in record ? record.error : ""}`];
  }
  const steps = record.value as CallerSteps;
  const found: string[] = [];
  if (steps.harness !== harness) found.push(`${harness}: the caller was ${steps.harness}`);
  if (steps.picked === undefined) found.push(`${harness}: no number picked`);
  if (steps.interrupted !== INTERRUPTED[harness]) {
    found.push(`${harness}: the interrupted step was ${steps.interrupted}`);
  }
  if (steps.recalled !== steps.picked) {
    found.push(`${harness}: recalled ${steps.recalled}, picked ${steps.picked}`);
  }
  // cursor prints no usage in a pane, the calling session's included.
  for (const agent of harness === "cursor" ? [] : record.accounting.byAgent) {
    if (agent.known !== agent.agents) found.push(`${harness}: usage unknown`);
  }
  return found;
}

if (import.meta.main) {
  assertLiveOptIn();
  if (process.env.HERDR_ENV !== "1") {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "not inside Herdr" }));
    process.exit(0);
  }
  const signal = interruption();
  const workDir = await mkdtemp(join(tmpdir(), "awf-calling-session-"));
  const session = await herdrSession(runProcess, process.env);
  const config: HerdrConfig = {
    session,
    workspaceLabel: "awf eval",
    commandTimeoutMs: 30_000,
    acceptWorkspaceTrust: true,
  };
  const { herdr, startAgent } = createHerdrCommands(config, runProcess);
  const created = await herdr([
    "workspace",
    "create",
    "--label",
    "awf eval calling-session",
    "--cwd",
    workDir,
    "--no-focus",
  ]);
  if (!created.ok) throw new Error(`workspace create failed: ${created.error}`);
  const workspace = (created.result.workspace as { workspace_id: string }).workspace_id;
  const startedAt = Date.now();

  const drive = async (harness: Harness): Promise<string[]> => {
    const cwd = join(workDir, harness);
    const runRoot = join(workDir, `runs-${harness}`);
    await mkdir(cwd, { recursive: true });
    await mkdir(runRoot, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", cwd]);
    const tab = await herdr([
      "tab",
      "create",
      "--workspace",
      workspace,
      "--cwd",
      cwd,
      "--label",
      harness,
      "--no-focus",
    ]);
    if (!tab.ok) return [`${harness}: tab create failed: ${tab.error}`];
    const pane = (tab.result.root_pane as { pane_id: string }).pane_id;
    const name = `here-${harness}`;
    const started = await startAgent(
      name,
      harness,
      pane,
      [...SESSIONS[harness]],
      Date.now() + 180_000,
      signal,
    );
    if (!started.ok) return [`${harness}: did not start: ${started.error}`];
    const command = [
      process.execPath,
      "--no-env-file",
      CLI,
      "run",
      "--here",
      "--run-root",
      runRoot,
      STEPS,
    ];
    const prompted = await herdr([
      "agent",
      "prompt",
      name,
      `Run this shell command and follow what it prints:\n\n${command.join(" ")}`,
    ]);
    if (!prompted.ok) return [`${harness}: prompt failed: ${prompted.error}`];
    // Esc once the long step has run a few seconds, as an operator stopping it would.
    let pressed = false;
    const by = Date.now() + 8 * 60_000;
    while (Date.now() < by && !signal.aborted) {
      const records = [...new Bun.Glob("*/*/output.json").scanSync({ cwd: runRoot })];
      if (records[0]) {
        return problems(harness, JSON.parse(readFileSync(join(runRoot, records[0]), "utf8")));
      }
      if (!pressed) {
        const screen = await herdr([
          "agent",
          "read",
          name,
          "--source",
          "recent-unwrapped",
          "--lines",
          "60",
        ]);
        const got = await herdr(["agent", "get", name]);
        const working = got.ok && JSON.stringify(got.result).includes('"agent_status":"working"');
        if (screen.ok && screen.stdout.includes("history of computer terminals") && working) {
          await Bun.sleep(4_000);
          await herdr(["agent", "send-keys", name, "esc"]);
          pressed = true;
        }
      }
      await Bun.sleep(1_000);
    }
    return [`${harness}: no run record within eight minutes`];
  };

  const found = (
    await Promise.all(
      (Object.keys(SESSIONS) as Harness[]).map((harness) =>
        drive(harness).catch((error: unknown) => [`${harness}: ${String(error)}`]),
      ),
    )
  ).flat();
  // Each run's own tab is in its caller's workspace, which under codex may be another one (E8).
  const workspaces = await herdr(["workspace", "list"]);
  for (const { workspace_id } of workspaces.ok
    ? (workspaces.result.workspaces as { workspace_id: string }[])
    : []) {
    const tabs = await herdr(["tab", "list", "--workspace", workspace_id]);
    for (const tab of tabs.ok ? (tabs.result.tabs as { tab_id: string; label?: string }[]) : []) {
      if (tab.label === "awf caller-steps.ts") await herdr(["tab", "close", tab.tab_id]);
    }
  }
  await herdr(["workspace", "close", workspace]);
  const estimates = (Object.keys(SESSIONS) as Harness[]).flatMap((harness) => {
    const runRoot = join(workDir, `runs-${harness}`);
    return [...new Bun.Glob("*/*/output.json").scanSync({ cwd: runRoot })].map(
      (file) =>
        (JSON.parse(readFileSync(join(runRoot, file), "utf8")) as OutputRecord).accounting.totals
          .estimate,
    );
  });
  console.log(
    JSON.stringify(
      {
        ok: found.length === 0,
        failed: found,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        estimateUsd: estimates.reduce<number>((sum, each) => sum + (each ?? 0), 0),
        artifacts: workDir,
      },
      null,
      2,
    ),
  );
  if (found.length > 0) process.exitCode = 1;
}
