import { HARNESSES, type HarnessName } from "./harnesses";
import { herdr } from "./herdr";
import { CWD } from "./headless";
import { TRIVIAL } from "./prompts";

/**
 * Whether a mid-turn pane is distinguishable from a settled one. `review-loop` reads claude's
 * title glyph for this; the other three write no status into their title, so `agent_status` is
 * the only signal a cross-harness engine can use.
 */
async function probe(name: HarnessName): Promise<void> {
  const created = await herdr(["workspace", "create", "--cwd", CWD, "--label", `e1 states ${name}`]);
  const pane = rec(created.result?.root_pane)?.pane_id;
  const workspace = rec(created.result?.workspace)?.workspace_id;
  const agent = `e1-states-${name}`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const start = await herdr([
      "agent",
      "start",
      agent,
      "--kind",
      HARNESSES[name].kind,
      "--pane",
      String(pane),
      "--timeout",
      "120000",
    ]);
    if (start.ok) break;
    await Bun.sleep(2_000);
  }

  const idleBefore = await herdr(["agent", "get", agent]);
  const working = await herdr([
    "agent",
    "prompt",
    agent,
    TRIVIAL,
    "--wait",
    "--until",
    "working",
    "--timeout",
    "15000",
  ]);
  const settled = await herdr(["agent", "wait", agent, "--timeout", "120000"]);

  console.log(
    JSON.stringify({
      harness: name,
      beforeStatus: field(idleBefore.result, "agent_status"),
      beforeTitle: field(idleBefore.result, "terminal_title"),
      workingMatched: working.ok,
      workingStatus: field(working.result, "agent_status"),
      workingTitle: field(working.result, "terminal_title"),
      workingError: working.error,
      settledStatus: field(settled.result, "agent_status"),
      settledTitle: field(settled.result, "terminal_title"),
    }),
  );

  if (workspace) await herdr(["workspace", "close", String(workspace)]);
}

function field(result: Record<string, unknown> | undefined, key: string): unknown {
  return rec(result?.agent)?.[key];
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

for (const name of ["claude", "codex", "pi", "cursor"] as HarnessName[]) {
  await probe(name);
}
