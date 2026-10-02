import { afterAll, describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { installAgentLauncher } from "./agent-launcher";
import { startResultControlPlane } from "./control-plane";
import { createResultSlotRegistry } from "./result-slots";
import { readAccepted } from "./run-dir";
import { COUNT_SCHEMA, createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const DEADLINE = { unixMilliseconds: Date.now() + 60_000 };

/**
 * The whole chain an agent actually walks: a path it was handed in a prompt, a shell script it
 * did not write, a socket it was never told the address of. Every other test in this package
 * speaks the wire directly, which is exactly the part a live run does not do — the run that
 * prompted this work failed at `command not found: wf`, with a green suite.
 */
async function twoAgents() {
  const runDir = runDirs.tempRunDir();
  const slots = createResultSlotRegistry({ runDir });
  const control = await startResultControlPlane({ slots });
  const alice = await control.openChannel("alice");
  const bob = await control.openChannel("bob");
  return {
    runDir,
    slots,
    control,
    alice: {
      channel: alice,
      wf: await installAgentLauncher(dirname(alice.endpoint), alice.endpoint),
    },
    bob: { channel: bob, wf: await installAgentLauncher(dirname(bob.endpoint), bob.endpoint) },
  };
}

/** No environment at all: a Codex pane runs its tool commands in a process we did not set up. */
async function run(wf: string, args: readonly string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([wf, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("the launcher an agent is told to run", () => {
  test("carries a result to the engine from a process with no environment", async () => {
    const fixture = await twoAgents();
    try {
      await fixture.slots.open({
        operationId: "op-1",
        agentId: "alice",
        question: "how many?",
        schema: COUNT_SCHEMA,
        deadline: DEADLINE,
      });

      const answered = await run(fixture.alice.wf, ["result", "op-1", '{"count":3,"even":false}']);

      expect(answered.exitCode).toBe(0);
      expect(await readAccepted(fixture.runDir, "op-1")).toEqual({
        value: { count: 3, even: false },
      });
    } finally {
      await fixture.control.close();
    }
  });

  test("takes the value from the heredoc the prompt shows, with nothing in it escaped", async () => {
    const fixture = await twoAgents();
    try {
      await fixture.slots.open({
        operationId: "op-1",
        agentId: "alice",
        question: "what went wrong?",
        schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
        deadline: DEADLINE,
      });
      // An apostrophe, a dollar sign and a backslash: each breaks a quoted argument one way or
      // another, and none of them is touched inside a quoted heredoc.
      const note = "it doesn't initialise $sum, so \\n is literal";
      const command = [
        `'${fixture.alice.wf}' result op-1 <<'WF_JSON'`,
        JSON.stringify({ note }),
        "WF_JSON",
      ].join("\n");
      const child = Bun.spawn(["sh", "-c", command], { env: {}, stdout: "pipe", stderr: "pipe" });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);

      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(await readAccepted(fixture.runDir, "op-1")).toEqual({ value: { note } });
    } finally {
      await fixture.control.close();
    }
  });

  test("refuses another agent's call, whoever names it", async () => {
    const fixture = await twoAgents();
    try {
      await fixture.slots.open({
        operationId: "op-1",
        agentId: "alice",
        question: "how many?",
        schema: COUNT_SCHEMA,
        deadline: DEADLINE,
      });

      const stolen = await run(fixture.bob.wf, ["result", "op-1", '{"count":3,"even":false}']);

      expect(stolen.exitCode).toBe(1);
      expect(stolen.stderr).toContain("another agent's call");
      expect(await readAccepted(fixture.runDir, "op-1")).toBeNull();
      // The refused value is not written into the owner's history: it came from somebody else.
      const attempts = Bun.file(`${fixture.runDir}/calls/op-1/attempts.jsonl`);
      expect(await attempts.exists()).toBe(false);
    } finally {
      await fixture.control.close();
    }
  });

  test("hands back the field-level reason, which is what the agent corrects from", async () => {
    const fixture = await twoAgents();
    try {
      await fixture.slots.open({
        operationId: "op-1",
        agentId: "alice",
        question: "how many?",
        schema: COUNT_SCHEMA,
        deadline: DEADLINE,
      });

      const wrong = await run(fixture.alice.wf, ["result", "op-1", '{"count":"3","even":false}']);

      expect(wrong.exitCode).toBe(1);
      expect(wrong.stderr).toContain("value.count: expected an integer");
      expect(wrong.stderr).toContain("run wf result again");
      expect(wrong.stderr).toContain("passed with < file");

      // The slot stays open, so the correction lands on the same call.
      const corrected = await run(fixture.alice.wf, ["result", "op-1", '{"count":3,"even":false}']);
      expect(corrected.exitCode).toBe(0);
    } finally {
      await fixture.control.close();
    }
  });

  test("names the call when the id is wrong, rather than declaring the turn over", async () => {
    const fixture = await twoAgents();
    try {
      const typo = await run(fixture.alice.wf, ["result", "op-7", "{}"]);

      expect(typo.exitCode).toBe(1);
      expect(typo.stderr).toContain("no call named op-7 is open");
      expect(typo.stderr).toContain("run wf result again");
    } finally {
      await fixture.control.close();
    }
  });

  test("is not replaced by an agent that redirects into it", async () => {
    const fixture = await twoAgents();
    try {
      const overwrite = Bun.spawn(["sh", "-c", 'echo answer > "$0"', fixture.alice.wf], {
        stderr: "pipe",
      });
      expect(await overwrite.exited).not.toBe(0);
      const answered = await run(fixture.alice.wf, ["result", "op-7", "{}"]);
      expect(answered.stderr).toContain("no call named op-7 is open");
    } finally {
      await fixture.control.close();
    }
  });

  test("does not let one agent read the directory its sibling's socket is in", async () => {
    const fixture = await twoAgents();
    try {
      const shared = dirname(dirname(fixture.alice.channel.endpoint));
      await expect(readdir(shared)).rejects.toMatchObject({ code: "EACCES" });
      expect((await stat(dirname(fixture.alice.channel.endpoint))).mode & 0o777).toBe(0o700);
    } finally {
      await fixture.control.close();
    }
  });

  test("reports the session the harness names in the agent's shell, even on a refused call", async () => {
    const runDir = runDirs.tempRunDir();
    const slots = createResultSlotRegistry({ runDir });
    const control = await startResultControlPlane({ slots });
    const seen: string[] = [];
    try {
      const channel = await control.openChannel("alice", (id) => seen.push(id));
      const wf = await installAgentLauncher(
        dirname(channel.endpoint),
        channel.endpoint,
        "CODEX_SESSION_ID",
      );
      await slots.open({
        operationId: "op-1",
        agentId: "alice",
        question: "how many?",
        schema: COUNT_SCHEMA,
        deadline: DEADLINE,
      });

      const refused = await run(wf, ["result", "op-7", "{}"], { CODEX_SESSION_ID: "s-1" });
      const unnamed = await run(wf, ["result", "op-1", '{"count":3,"even":false}']);
      const named = await run(wf, ["result", "op-1", '{"count":3,"even":false}'], {
        CODEX_SESSION_ID: "s-2",
      });

      expect([refused.exitCode, unnamed.exitCode, named.exitCode]).toEqual([1, 0, 1]);
      expect(seen).toEqual(["s-1", "s-2"]);
    } finally {
      await control.close();
    }
  });

  test("refuses a session variable that is not a name", async () => {
    const directory = runDirs.tempRunDir();
    await expect(
      installAgentLauncher(directory, `${directory}/s.sock`, "X; rm -rf /"),
    ).rejects.toThrow("not an environment variable name");
  });

  test("removes every socket, launcher and directory it made", async () => {
    const fixture = await twoAgents();
    const root = dirname(dirname(fixture.alice.channel.endpoint));
    await fixture.control.close();

    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
