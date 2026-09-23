import { describe, expect, test } from "bun:test";
import { createHerdrRunHostFactory } from "./herdr";
import { createFakeHerdr } from "../testing/herdr-cli";
import type { HerdrConfig } from "./herdr";

/**
 * The run host against a Herdr that behaves like 0.8.2 rather than one that answers whatever it is
 * asked. Each of these reached a live run through a green suite, and each fails here if its fix is
 * reverted; decisions the host makes from an answer belong in `herdr.test.ts` instead.
 */
const CONFIG: HerdrConfig = {
  session: "wf-lab",
  workspaceLabel: "contract",
  commandTimeoutMs: 5_000,
  settleTimeoutMs: 5_000,
  binDir: "/wf/bin",
  emptyEnvironment: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  acceptWorkspaceTrust: true,
  startRetryMs: 0,
  trustSettleMs: 0,
};

const deadline = () => ({ unixMilliseconds: Date.now() + 60_000 });

async function reviewOnce(
  herdr: ReturnType<typeof createFakeHerdr>,
  config: Partial<HerdrConfig> = {},
  harness: "claude" | "codex" = "claude",
) {
  const host = await createHerdrRunHostFactory({ ...CONFIG, ...config }, herdr.run).openRun({
    runId: "run-1",
    cwd: "/repo",
    deadline: deadline(),
  });
  const session = await host.openAgent({
    key: "reviewer",
    cwd: "/repo",
    deadline: deadline(),
    execution: { harness, model: "sonnet" },
  });
  const turn = await session.start(
    { id: "one", prompt: "review the target", deadline: deadline() },
    { endpoint: "/private/engine.sock", operationId: "op-1" },
  );
  const outcome = await turn.settled;
  await host.close();
  return { agent: [...herdr.agents.values()][0]!, outcome };
}

describe("the run host against a Herdr that behaves like 0.8.2", () => {
  test.each(["claude", "codex"] as const)(
    "answers a startup trust block that the pane's width has wrapped (%s)",
    async (harness) => {
      // In a narrow terminal the block's sentences break mid-phrase. Matching the raw screen misses
      // it and the agent never starts.
      const { agent, outcome } = await reviewOnce(createFakeHerdr({ rootColumns: 60 }), {}, harness);

      expect(outcome).toMatchObject({ state: "completed" });
      expect(agent.delivered).toHaveLength(1);
    },
  );

  test("empties the metered credentials in the agent's own pane, not just the workspace", async () => {
    // A tab launches its own process, so an environment set only on the workspace never reaches
    // the agent. This is the one thing the pane's environment is still used for.
    const { agent, outcome } = await reviewOnce(createFakeHerdr());

    expect(outcome).toMatchObject({ state: "completed" });
    expect(agent.emptied.sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  });

  test("answers a startup block the agent's own TUI has styled", async () => {
    // Both TUIs bold the option the cursor sits on, and the escape sequences land in the middle
    // of the phrases being matched. Matching the raw bytes leaves the agent blocked forever.
    const { agent, outcome } = await reviewOnce(createFakeHerdr(), {}, "codex");

    expect(outcome).toMatchObject({ state: "completed" });
    expect(agent.blocks).toEqual([]);
  });

  test("answers a startup block the terminal broke mid-word", async () => {
    // A terminal wrapping text it did not lay out breaks at the column, not at a space, so
    // `directory?` arrives as `direc\ntory?` and a single-spaced rendering never matches it.
    const herdr = createFakeHerdr({ rootColumns: 90, hardWrap: true });
    const { agent, outcome } = await reviewOnce(herdr, {}, "codex");

    expect(outcome).toMatchObject({ state: "completed" });
    expect(agent.blocks).toEqual([]);
  });

  test("answers the live block when an answered one is still on the screen", async () => {
    // The pane does not repaint the dismissed update notice away, so both Codex blocks match at
    // once. Table order would send `enter`, and on the update notice that runs `curl | sh`.
    const herdr = createFakeHerdr({ startupBlocks: ["update", "trust"] });
    const { agent, outcome } = await reviewOnce(herdr, {}, "codex");

    expect(outcome).toMatchObject({ state: "completed" });
    expect(agent.ranInstaller).toBe(false);
  });

  test("does not report an agent started while Herdr still calls it blocked", async () => {
    // `agent wait` answers for a blocked agent as readily as a ready one. Reporting that as
    // started puts the prompt into a pane still showing a question, where it is discarded.
    const herdr = createFakeHerdr({ startupBlocks: ["update"] });
    const { outcome } = await reviewOnce(herdr, {}, "codex");

    expect(outcome).toMatchObject({ state: "completed" });
    expect([...herdr.agents.values()][0]?.blocks).toEqual([]);
  });

  test("works through a startup queue rather than giving up after the first block", async () => {
    // Codex 0.155.1 put an update notice in front of the trust block. Both end "Press enter to
    // continue", and on the update notice enter selects the option that runs `curl | sh`.
    const herdr = createFakeHerdr({ startupBlocks: ["update", "trust"] });
    const { agent, outcome } = await reviewOnce(herdr, {}, "codex");

    expect(outcome).toMatchObject({ state: "completed" });
    expect(agent.blocks).toEqual([]);
    expect(agent.ranInstaller).toBe(false);
  });

  test("names the screen it could not answer", async () => {
    // Codex shipped a new block and the run failed saying only that a block was unrecognized,
    // which is the one thing already known. The screen is what identifies it.
    const herdr = createFakeHerdr({ startupBlocks: ["update"] });
    const { outcome } = await reviewOnce(herdr, {}, "claude");

    expect(outcome).toMatchObject({
      state: "failed",
      detail: expect.stringContaining("unknown block"),
    });
  });

  test("does not submit a prompt before the agent it just trusted accepts input", async () => {
    // Herdr reports the agent ready as soon as its block is answered; the UI is not there yet, and
    // a prompt submitted into that window is typed and discarded with no record.
    const { agent, outcome } = await reviewOnce(createFakeHerdr({ inputReadyAfterMs: 60 }), {
      trustSettleMs: 150,
    });

    expect(outcome).toMatchObject({ state: "completed" });
    expect(agent.discarded).toEqual([]);
    expect(agent.delivered).toHaveLength(1);
  });
});
