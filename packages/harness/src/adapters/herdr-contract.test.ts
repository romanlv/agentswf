import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RunProcess } from "../command";
import { createFakeHerdr } from "../testing/herdr-cli";
import type { HerdrConfig } from "./herdr";
import { createHerdrRunHostFactory, HERDR_VERSION } from "./herdr";

/**
 * The run host against a Herdr that behaves like 0.8.2 rather than one that answers whatever it is
 * asked. Each of these reached a live run through a green suite, and each fails here if its fix is
 * reverted; decisions the host makes from an answer belong in `herdr.test.ts` instead.
 */
const CONFIG: HerdrConfig = {
  session: "wf-lab",
  workspaceLabel: "contract",
  commandTimeoutMs: 5_000,
  emptyEnvironment: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  acceptWorkspaceTrust: true,
  startRetryMs: 0,
  trustSettleMs: 0,
};

const deadline = () => ({ unixMilliseconds: Date.now() + 60_000 });

async function reviewOnce(
  herdr: ReturnType<typeof createFakeHerdr>,
  config: Partial<HerdrConfig> = {},
  harness: "claude" | "codex" | "pi" = "claude",
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
      const { agent, outcome } = await reviewOnce(
        createFakeHerdr({ rootColumns: 60 }),
        {},
        harness,
      );

      expect(outcome).toMatchObject({ state: "completed" });
      expect(agent.delivered).toHaveLength(1);
    },
  );

  test("starts pi, which raises no startup block, and prompts it once it is ready", async () => {
    const { agent, outcome } = await reviewOnce(createFakeHerdr({ startupBlocks: [] }), {}, "pi");

    expect(outcome).toMatchObject({ state: "completed" });
    expect(agent.kind).toBe("pi");
    expect(agent.delivered).toHaveLength(1);
  });

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

/** A prelude whose shell draws `awf-%-n1% `, as zsh draws the `PROMPT` it sets. */
const PRELUDE = "exec /usr/bin/env -i PATH=/box/bin PROMPT='awf-%%-n1%# ' /bin/sh -c 'srt'";

describe("a pane agent in a sandbox", () => {
  const occupant = (terminal: { prelude: string; harness: string }) => ({
    launch: () => {
      throw new Error("a pane launches nothing itself");
    },
    release: async () => undefined,
    pane: async () => ({ herdr: "run" as const, ready: "awf-%-n1% ", ...terminal }),
  });

  test.each(["claude", "codex"] as const)(
    "is typed into its pane after its prelude, adopted by name, and prompted once idle (%s)",
    async (harness) => {
      const herdr = createFakeHerdr({ startupBlocks: [], detectionPolls: 3 });
      const host = await createHerdrRunHostFactory(CONFIG, herdr.run).openRun({
        runId: "run-1",
        cwd: "/repo",
        deadline: deadline(),
      });
      const session = await host.openAgent({
        key: "lead",
        cwd: "/repo",
        deadline: deadline(),
        execution: { harness, model: "sonnet" },
        occupant: occupant({
          prelude: PRELUDE,
          harness,
        }),
      });
      const turn = await session.start(
        { id: "one", prompt: "lead the work", deadline: deadline() },
        { endpoint: "/private/engine.sock", operationId: "op-1" },
      );
      await turn.settled;
      const [pane] = [...herdr.panes.values()].filter((candidate) => candidate.typed.length > 0);
      expect(pane!.typed[0]).toBe(PRELUDE);
      // Its own arguments and the ones that turn off model-side search, each quoted.
      expect(pane!.typed[1]).toStartWith(`'${harness}' `);
      expect(pane!.typed[1]).toContain(
        harness === "claude"
          ? "'--disallowed-tools' 'WebSearch,WebFetch'"
          : "'-c' 'web_search=\"disabled\"'",
      );
      const [agent] = [...herdr.agents.values()];
      expect(agent!.kind).toBe(harness);
      expect(agent!.delivered).toHaveLength(1);
      // Adopted by rename, never started: `agent start` refuses a pane whose root is not a shell.
      const verbs = herdr.calls.map((call) => call.argv.slice(3, 5).join(" "));
      expect(verbs).not.toContain("agent start");
      expect(verbs.filter((verb) => verb === "agent rename")).toHaveLength(4);
      await host.close();
    },
  );

  test("a harness Herdr never detects fails the start and closes its tab", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [], detectionPolls: 1_000 });
    const host = await createHerdrRunHostFactory(CONFIG, herdr.run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "lead",
      cwd: "/repo",
      deadline: { unixMilliseconds: Date.now() + 1_500 },
      execution: { harness: "claude", model: "sonnet" },
      occupant: occupant({ prelude: PRELUDE, harness: "claude" }),
    });
    const turn = await session.start(
      { id: "one", prompt: "lead", deadline: { unixMilliseconds: Date.now() + 1_500 } },
      { endpoint: "/private/engine.sock", operationId: "op-1" },
    );
    expect(await turn.settled).toMatchObject({ state: "timed-out" });
    // The workspace's first pane is all that is left.
    expect(herdr.openPanes()).toEqual(["w1:p1"]);
    await host.close();
  });

  test("a prelude the login shell swallowed never gets the harness typed into that shell", async () => {
    const herdr = createFakeHerdr({ startupBlocks: [], swallowsPrelude: true });
    const host = await createHerdrRunHostFactory(CONFIG, herdr.run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await host.openAgent({
      key: "lead",
      cwd: "/repo",
      deadline: { unixMilliseconds: Date.now() + 1_500 },
      execution: { harness: "claude", model: "sonnet" },
      occupant: occupant({ prelude: PRELUDE, harness: "claude" }),
    });
    const turn = await session.start(
      { id: "one", prompt: "lead", deadline: { unixMilliseconds: Date.now() + 1_500 } },
      { endpoint: "/private/engine.sock", operationId: "op-1" },
    );
    expect(await turn.settled).toMatchObject({ state: "timed-out" });
    const typed = herdr.calls.filter((call) => call.argv.slice(3, 5).join(" ") === "pane run");
    expect(typed.map((call) => call.argv[6])).toEqual([PRELUDE]);
    // The workspace's first pane is all that is left.
    expect(herdr.openPanes()).toEqual(["w1:p1"]);
    await host.close();
  });
});

describe("a pane agent in a sandbox's own Herdr", () => {
  /** The host's Herdr and a box's, each a fake; the box's is reached through its commands. */
  const setup = (boxVersion = "0.9.1") => {
    const host = createFakeHerdr({ startupBlocks: [] });
    const box = createFakeHerdr({ startupBlocks: [], version: boxVersion });
    const state = { gone: false };
    const run: RunProcess = async (input) =>
      input.argv[0] === "box-herdr" && state.gone
        ? { stdout: "", stderr: "Error: No such container", exitCode: 125, timedOut: false }
        : input.argv[0] === "box-herdr"
          ? box.run({
              ...input,
              argv:
                input.argv[1] === "--version"
                  ? ["herdr", "--version"]
                  : ["herdr", "--session", "box", ...input.argv.slice(1)],
            })
          : host.run(input);
    const occupant = () => ({
      launch: () => {
        throw new Error("a pane launches nothing itself");
      },
      release: async () => undefined,
      pane: async () => ({
        herdr: {
          key: "box-1",
          run: (args: readonly string[], timeoutMs: number) => ({
            argv: ["box-herdr", ...args],
            env: {},
            timeoutMs,
            group: true as const,
            reap: async () => undefined,
          }),
          watch: ["docker", "exec", "-it", "box 1", "herdr"],
        },
        prelude: PRELUDE,
        ready: "awf-%-n1% ",
        harness: "claude",
      }),
    });
    return { host, box, run, occupant, state };
  };

  test("opens one workspace in the box for its agents, drives them there, and closes it", async () => {
    const { host, box, run, occupant } = setup();
    const runHost = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    // Both at once: the box's workspace is still one.
    await Promise.all(
      ["lead", "second"].map(async (key) => {
        const session = await runHost.openAgent({
          key,
          cwd: "/repo",
          deadline: deadline(),
          execution: { harness: "claude", model: "sonnet" },
          occupant: occupant(),
        });
        const turn = await session.start(
          { id: "one", prompt: `${key} the work`, deadline: deadline() },
          { endpoint: "/private/engine.sock", operationId: `op-${key}` },
        );
        expect(await turn.settled).toMatchObject({ state: "completed" });
      }),
    );
    const verbs = (calls: typeof box.calls) => calls.map((call) => call.argv.slice(3, 5).join(" "));
    // Nothing on the host: not an agent's tab, nor, unwatched, an empty workspace.
    expect(verbs(host.calls)).toEqual([]);
    expect(verbs(box.calls).filter((verb) => verb === "workspace create")).toHaveLength(1);
    expect(verbs(box.calls).filter((verb) => verb === "tab create")).toHaveLength(2);
    expect([...box.agents.values()].map((agent) => agent.delivered.length)).toEqual([1, 1]);
    // Every box command is the sandbox's, which the process runner reaps however it ended.
    expect(box.calls.every((call) => "group" in call && call.group === true)).toBe(true);
    // A turn's prompt carries its cancellation into the box, where the runner reaps it.
    const prompts = box.calls.filter(
      (call) => call.argv[3] === "agent" && call.argv[4] === "prompt",
    );
    expect(prompts).toHaveLength(2);
    expect(prompts.every((call) => call.signal instanceof AbortSignal)).toBe(true);
    await runHost.close();
    expect(box.openWorkspaces()).toEqual([]);
    expect(host.openWorkspaces()).toEqual([]);
  });

  test("watched, the run's workspace gets one tab attached to the box's Herdr", async () => {
    const { host, run, occupant } = setup();
    const runHost = await createHerdrRunHostFactory(
      { ...CONFIG, watchSandboxes: true },
      run,
    ).openRun({ runId: "run-1", cwd: "/repo", deadline: deadline() });
    for (const key of ["lead", "second"]) {
      const session = await runHost.openAgent({
        key,
        cwd: "/repo",
        deadline: deadline(),
        execution: { harness: "claude", model: "sonnet" },
        occupant: occupant(),
      });
      const turn = await session.start(
        { id: "one", prompt: key, deadline: deadline() },
        { endpoint: "/private/engine.sock", operationId: `op-${key}` },
      );
      await turn.settled;
    }
    await runHost.close();
    const verbsOf = (verb: string) =>
      host.calls.filter((call) => call.argv.slice(3, 5).join(" ") === verb);
    expect(verbsOf("workspace create")).toHaveLength(1);
    // In the workspace's own first pane, labelled for the box: no idle shell beside it.
    expect(verbsOf("tab create")).toHaveLength(0);
    expect(verbsOf("tab rename").map((call) => call.argv.slice(5))).toEqual([
      ["w1:t1", "sandbox box-1"],
    ]);
    expect(verbsOf("pane run").map((call) => call.argv.slice(5))).toEqual([
      ["w1:p1", "'docker' 'exec' '-it' 'box 1' 'herdr'"],
    ]);
    expect(host.openWorkspaces()).toEqual([]);
  });

  test("a box already removed leaves its agents' tabs and workspace closed with it", async () => {
    const { run, occupant, state, host } = setup();
    const runHost = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    const session = await runHost.openAgent({
      key: "lead",
      cwd: "/repo",
      deadline: deadline(),
      execution: { harness: "claude", model: "sonnet" },
      occupant: occupant(),
    });
    const turn = await session.start(
      { id: "one", prompt: "lead", deadline: deadline() },
      { endpoint: "/private/engine.sock", operationId: "op-1" },
    );
    await turn.settled;
    state.gone = true;
    await runHost.close();
    expect(host.openWorkspaces()).toEqual([]);
  });

  test("the default image pins the Herdr this adapter drives", async () => {
    const dockerfile = await Bun.file(
      join(import.meta.dir, "../../../sandbox/docker/Dockerfile"),
    ).text();
    expect(`herdr ${/^ENV HERDR_VERSION=(\S+)$/m.exec(dockerfile)?.[1]}`).toBe(HERDR_VERSION);
  });

  test("a box whose Herdr is another version is refused, naming both", async () => {
    const { run, occupant, box } = setup("0.8.2");
    const runHost = await createHerdrRunHostFactory(CONFIG, run).openRun({
      runId: "run-1",
      cwd: "/repo",
      deadline: deadline(),
    });
    await expect(
      runHost.openAgent({
        key: "lead",
        cwd: "/repo",
        deadline: deadline(),
        execution: { harness: "claude", model: "sonnet" },
        occupant: occupant(),
      }),
    ).rejects.toThrow("the sandbox's Herdr is herdr 0.8.2, and this adapter drives herdr 0.9.1");
    expect(box.openWorkspaces()).toEqual([]);
    await runHost.close();
  });
});
