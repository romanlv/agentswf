import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HolderResultJson, InboxItemJson } from "../packages/contract/src/records";
import { WIRE_VERSION } from "../packages/contract/src/wire";
import { coordinatorSocketPath } from "../packages/engine/src/coordinator-socket";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { claimAttempt, createRun } from "../packages/engine/src/runs";
import { createTempRunDirs, exchange, submit } from "../packages/engine/src/testing";
import type { AgentRuntimeConfig } from "../packages/harness/src/adapter";
import { createSingleSessionHostFactory } from "../packages/harness/src/single-session-host";
import { createFakeAdapter } from "../packages/harness/src/testing/fake";

const runDirs = createTempRunDirs();
// Short enough for `sun_path`, as `~/.awf/coordinator` is.
const coordinators = mkdtempSync("/tmp/awf-holders-");
afterAll(() => {
  runDirs.cleanup();
  rmSync(coordinators, { recursive: true, force: true });
});

/**
 * A project whose workflow connects `keys` and lets the investigator ask the first; it returns once
 * `release` resolves, with what the investigator's answer said.
 */
function project(keys = ["coordinator"]) {
  const cwd = runDirs.tempRunDir();
  const home = runDirs.tempRunDir();
  const module = `
    export default {
      kind: "awf.executable-workflow/v1",
      definition: {
        meta: { name: "investigate", description: "asks a coordinator" },
        async run(workflow) {
          const investigator = await workflow.agents.open({ key: "investigator", runtime: "claude" });
          const keys = ${JSON.stringify(keys)};
          const connected = [];
          for (const key of keys) connected.push(await workflow.participants.connect({ key }));
          for (const coordinator of connected)
            await workflow.messages.allow({ between: [investigator, coordinator], purpose: "Ask." });
          const { outcome } = await investigator.run({ prompt: "Ask." });
          return outcome.kind === "answered" ? outcome.value : outcome.kind;
        },
      },
      prepare() { return null; },
    };`;
  const adapter = createFakeAdapter({
    harnesses: ["claude"],
    script: () => ({
      act: async (turn) => {
        if (turn.kind === "turn") {
          await exchange(
            turn.binding!.endpoint,
            `${JSON.stringify({ version: WIRE_VERSION, command: "send", peer: keys[0], text: "Merge or keep two?", awaitReply: true })}\n`,
          );
        } else if (turn.kind === "deliver") {
          await submit(turn.binding!, turn.prompt.includes("Keep two.") ? "kept" : "other");
        }
      },
    }),
  });
  const runtime: AgentRuntimeConfig = {
    aliases: { claude: { harness: "claude", model: "sonnet" } },
    host: createSingleSessionHostFactory(adapter),
  };
  const environment = { ...process.env, AWF_COORDINATOR_DIR: coordinators };
  const awf = async (argv: string[], stdin = "") => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runOperatorCli(argv, {
      cwd,
      home,
      environment,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      stdin: async () => stdin,
      awaitReply: () => true,
      installRuntime: async () => ({ config: runtime, cleanup: async () => undefined }),
    });
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  };
  return { cwd, awf, write: (name: string) => Bun.write(join(cwd, name), module) };
}

async function openQuestion(awf: ReturnType<typeof project>["awf"]) {
  for (let tries = 0; tries < 200; tries += 1) {
    const read = await awf(["inbox", "--all", "--open", "--json"]);
    const [item] = read.stdout.split("\n").filter(Boolean);
    if (item) return JSON.parse(item) as InboxItemJson & { kind: "message" };
    await Bun.sleep(20);
  }
  throw new Error("no question was asked");
}

describe("awf reply and awf send", () => {
  test("two holders answer one question: the first is delivered, the other expired", async () => {
    const { awf, write } = project();
    await write("flow.js");
    const running = awf(["run", "--json", "flow.js"]);
    const question = await openQuestion(awf);
    const reply = (text: string) =>
      awf(["reply", question.ref, "investigator", "--to", question.id, text, "--json"]);
    const [first, second] = await Promise.all([reply("Keep two."), reply("Merge.")]);
    const results = [first, second].map((each) => JSON.parse(each.stdout) as HolderResultJson);
    expect(results.map((each) => each.code).sort()).toEqual(["delivered", "expired"]);
    expect(results.find((each) => each.code === "delivered")).toEqual({
      v: 1,
      code: "delivered",
      id: question.id,
    });
    const run = await running;
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).value).toBe(results[0]!.code === "delivered" ? "kept" : "other");
    const inbox = await awf(["inbox", question.ref, "--json"]);
    const answered = inbox.stdout
      .split("\n")
      .map((line) => JSON.parse(line) as InboxItemJson)
      .filter((item) => item.kind === "answered");
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ via: "command" });
    // The run has ended: both commands say so.
    expect(JSON.parse((await reply("Late.")).stdout)).toMatchObject({ code: "ended" });
  });

  test("refusals: no such run, an unknown agent, two coordinators and no --as, text from stdin", async () => {
    const { awf, write } = project(["coordinator", "pager"]);
    await write("flow.js");
    expect(await awf(["reply", "investigate/nope", "investigator", "x"])).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("refused (not-found)"),
    });
    const running = awf(["run", "--json", "flow.js"]);
    const question = await openQuestion(awf);
    const send = (...args: string[]) => awf(["send", question.ref, ...args, "--json"]);
    const result = async (pending: ReturnType<typeof send>) =>
      JSON.parse((await pending).stdout) as HolderResultJson;
    expect(await result(send("ghost", "Hi."))).toMatchObject({ code: "unknown-agent" });
    expect(await result(send("investigator", "Hi."))).toMatchObject({
      code: "ambiguous",
      choices: ["coordinator", "pager"],
    });
    expect(await result(send("investigator", "--as", "operator", "Hi."))).toMatchObject({
      code: "no-coordinator",
    });
    // To an agent awaiting this coordinator's answer: held, and the line says so.
    const held = await awf(["send", question.ref, "investigator", "--as", "coordinator", "FYI."]);
    expect(held.stdout).toMatch(
      /^delivered as 1\.\d+; investigator still awaits the reply to 1\.\d+$/,
    );
    // The answer, from stdin, speaks as the coordinator it was asked of.
    const answered = await awf(
      ["reply", question.ref, "investigator", "--to", question.id],
      "Keep two.\n",
    );
    expect(answered).toMatchObject({ code: 0, stdout: `answered ${question.id}` });
    await running;
  });

  test("a live run not connected yet, or a socket a killed attempt left, is no-coordinator", async () => {
    const { awf, cwd } = project();
    const run = await createRun(join(cwd, ".awf", "runs"), {
      workflow: "investigate",
      id: "r1",
      argv: [],
      cwd,
      sandbox: null,
    });
    const claimed = await claimAttempt(run, { file: "flow.js", flags: {} });
    if ("refused" in claimed) throw new Error("refused");
    const reply = () => awf(["reply", "investigate/r1", "investigator", "--json", "Keep two."]);
    expect(JSON.parse((await reply()).stdout)).toMatchObject({ code: "no-coordinator" });
    await Bun.write(coordinatorSocketPath(coordinators, run.dir), "left by a killed attempt");
    expect(JSON.parse((await reply()).stdout)).toMatchObject({ code: "no-coordinator" });
  });

  test("text after -- is the message's, whatever it says; blank text is a usage error", async () => {
    const { awf } = project();
    const flagLike = await awf([
      "send",
      "investigate/nope",
      "investigator",
      "--json",
      "--",
      "--help",
    ]);
    expect(flagLike.code).toBe(1);
    expect(JSON.parse(flagLike.stdout)).toMatchObject({ code: "not-found" });
    expect((await awf(["send", "investigate/nope", "investigator", " "])).code).toBe(2);
  });
});
