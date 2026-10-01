import { describe, expect, test } from "bun:test";
import type { SandboxedCommand } from "@agentswf/sandbox";
import { type ProcessInput, runProcess, withholding } from "./command";

test("withholding unsets the named variables and leaves everything else alone", async () => {
  const seen: ProcessInput[] = [];
  const run = withholding(
    async (input) => {
      seen.push(input);
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
    ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
  );
  await run({
    argv: ["codex", "exec"],
    timeoutMs: 1_000,
    env: { OPENAI_API_KEY: "metered", TERM: "xterm-256color" },
  });
  expect(seen[0]?.env).toEqual({
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    TERM: "xterm-256color",
  });
});

describe("a sandboxed command", () => {
  // A short sleep, so a leak ends on its own within the hour; its fraction tells it apart.
  const marker = () => `3600.${Math.floor(10_000 + Math.random() * 89_999)}`;
  const running = (seconds: string) =>
    Bun.spawnSync(["pgrep", "-f", `sleep ${seconds}`])
      .stdout.toString()
      .trim();
  const sandboxed = (script: string, extra: Partial<SandboxedCommand> = {}): SandboxedCommand => ({
    argv: ["/bin/sh", "-c", script],
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 5_000,
    group: true,
    ...extra,
  });

  test("ends with everything it started, on timeout, abort and exit alike", async () => {
    const [timeout, aborted, exited] = [marker(), marker(), marker()];
    const timedOut = await runProcess(sandboxed(`sleep ${timeout} & wait`, { timeoutMs: 300 }));
    expect(timedOut.timedOut).toBe(true);

    const controller = new AbortController();
    const cancelling = runProcess(
      sandboxed(`sleep ${aborted} & wait`, { signal: controller.signal }),
    );
    await Bun.sleep(200);
    controller.abort();
    expect((await cancelling).cancelled).toBe(true);

    // The leader exits at once; the sleep it left would hold stdout open until the timeout.
    const started = Date.now();
    const finished = await runProcess(sandboxed(`sleep ${exited} & echo started`));
    expect(finished).toMatchObject({ stdout: "started\n", exitCode: 0, timedOut: false });
    expect(Date.now() - started).toBeLessThan(2_000);

    await Bun.sleep(100);
    expect([running(timeout), running(aborted), running(exited)]).toEqual(["", "", ""]);
  });

  test("an unsandboxed process runs as before, leaving what it started", async () => {
    const seconds = marker();
    const result = await runProcess({
      argv: ["/bin/sh", "-c", `sleep ${seconds} >/dev/null 2>&1 & echo started`],
      timeoutMs: 5_000,
    });
    expect(result.stdout).toBe("started\n");
    try {
      expect(running(seconds)).not.toBe("");
    } finally {
      Bun.spawnSync(["pkill", "-f", `sleep ${seconds}`]);
    }
  });

  test("gets exactly its env, and none of this process's", async () => {
    process.env.AWF_COMMAND_TEST_LEAK = "leaked";
    try {
      const result = await runProcess(
        sandboxed("", { argv: ["/usr/bin/env"], env: { PATH: "/usr/bin:/bin", ONLY: "this" } }),
      );
      expect(result.stdout.trim().split("\n").sort()).toEqual(["ONLY=this", "PATH=/usr/bin:/bin"]);
    } finally {
      delete process.env.AWF_COMMAND_TEST_LEAK;
    }
  });

  test("reaps after its group is killed, and a failed reap leaves the result alone", async () => {
    const seconds = marker();
    let leftAtReap: string | undefined;
    const result = await runProcess(
      sandboxed(`sleep ${seconds} & echo out; exit 3`, {
        async reap() {
          leftAtReap = running(seconds);
          throw new Error("box is gone");
        },
      }),
    );
    expect(leftAtReap).toBe("");
    expect(result).toEqual({
      stdout: "out\n",
      stderr: "",
      exitCode: 3,
      timedOut: false,
    });
  });

  test("returns and reaps even when a process left the group holding its output", async () => {
    const tag = marker();
    let reaped = false;
    const started = Date.now();
    try {
      const result = await runProcess(
        sandboxed(
          `perl -MPOSIX -e 'fork and exit; POSIX::setsid(); sleep 20' ${tag} & sleep 0.5; echo started`,
          {
            async reap() {
              reaped = true;
            },
          },
        ),
      );
      expect(result.stdout).toBe("started\n");
      expect(reaped).toBe(true);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      Bun.spawnSync(["pkill", "-f", `perl.*${tag}`]);
    }
  });

  test("withholding removes the named variables from its exact env", async () => {
    const seen: (ProcessInput | SandboxedCommand)[] = [];
    const run = withholding(
      async (input) => {
        seen.push(input);
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      },
      ["OPENAI_API_KEY"],
    );
    let reaped = false;
    const reaper = {
      done: false,
      async reap(this: { done: boolean }) {
        this.done = true;
      },
    };
    await run(
      sandboxed("true", {
        env: { OPENAI_API_KEY: "metered", HOME: "/h" },
        reap: () => reaper.reap(),
      }),
    );
    expect(seen[0]?.env).toEqual({ HOME: "/h" });
    expect(seen[0]).toMatchObject({ group: true });
    await (seen[0] as SandboxedCommand).reap?.();
    reaped = reaper.done;
    expect(reaped).toBe(true);
  });
});

describe("a child held on stdin", () => {
  // Answers each line it reads, and exits only when stdin closes, as codex's app-server does.
  const server = ["/bin/sh", "-c", 'while read -r line; do echo "got $line"; done; echo bye'];

  test("is fed its stdin, held open until a line answers, then let exit", async () => {
    const result = await runProcess({
      argv: server,
      stdin: "first\nsecond\n",
      timeoutMs: 5_000,
      holdStdinUntil: (line) => line === "got second",
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toBe("got first\ngot second\nbye\n");
  });

  test("still ends at its timeout when no line answers", async () => {
    const result = await runProcess({
      argv: server,
      stdin: "first\n",
      timeoutMs: 300,
      holdStdinUntil: (line) => line === "never",
    });
    expect(result).toMatchObject({ timedOut: true });
    expect(result.stdout).toBe("got first\n");
  });
  test("one that answers and will not exit is stopped, and still counts as answered", async () => {
    const started = Date.now();
    const result = await runProcess({
      argv: ["/bin/sh", "-c", "read -r line; echo done; sleep 30"],
      stdin: "go\n",
      timeoutMs: 20_000,
      holdStdinUntil: (line) => line === "done",
    });
    expect(result).toMatchObject({ answered: true, timedOut: false, stdout: "done\n" });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});
