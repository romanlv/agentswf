import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentOpenSpec,
  JsonValue,
  WorkflowContext,
  WorkflowDefinition,
} from "@wf/contract/workflow";
import { createHeadlessRunHostFactory } from "@wf/harness";
import type {
  AgentRunHostFactory,
  AgentRuntimeConfig,
  HarnessActivation,
} from "@wf/harness/adapter";
import type { SandboxProviders } from "@wf/sandbox";
import {
  createFakeSandboxProvider,
  FAKE_OCCUPANT_ENV,
  FAKE_SANDBOX_ENV,
  type FakeSandboxEvent,
  type FakeSandboxOptions,
} from "@wf/sandbox/testing";
import { installSandboxes } from "./operator-runtime";
import { RunSandboxes } from "./sandboxes";
import { createTempRunDirs, future } from "./testing";
import { runWorkflow, startWorkflow, WorkflowRunError } from "./workflow-runner";

// A codex that answers through the launcher its prompt names, as a real one would, and keeps what
// it was started with in its home. Asked to wait, it waits; asked to peek, it tries to read a file.
const FAKE_CODEX = `#!/bin/sh
prompt=$(cat)
{ printf 'argv:'; printf ' %s' "$@"; printf '\\n'; env; echo ---; } >> "$CODEX_HOME/turns.log"
case "$prompt" in *wait*) sleep 30 ;; esac
peek=$(printf '%s\n' "$prompt" | sed -n 's/^peek: //p')
[ -n "$peek" ] && { cat "$peek" >> "$CODEX_HOME/peeked.log" 2>&1 || echo denied >> "$CODEX_HOME/peeked.log"; }
case "$prompt" in *refresh*) printf '{"tokens":{"access_token":"refreshed"}}' > "$CODEX_HOME/auth.json" ;; esac
line=$(printf '%s\\n' "$prompt" | grep " result .* <<'WF_JSON'$" | head -1)
launcher=\${line%% result *}
rest=\${line#* result }
printf '"answered"' | "$launcher" result "\${rest%% *}" >/dev/null 2>&1
echo '{"type":"thread.started","thread_id":"thread-1"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
`;

const runDirs = createTempRunDirs();
const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-sandboxes-")));
const work = join(root, "work");
const saved = {
  PATH: process.env.PATH,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
};

beforeAll(async () => {
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "codex"), FAKE_CODEX);
  await chmod(join(root, "bin", "codex"), 0o755);
  await writeFile(join(root, "bin", "claude"), "#!/bin/sh\n");
  await chmod(join(root, "bin", "claude"), 0o755);
  await mkdir(join(root, "operator-codex"), { recursive: true });
  await writeFile(
    join(root, "operator-codex", "auth.json"),
    '{"tokens":{"access_token":"operator"}}',
  );
  await mkdir(join(work, "src"), { recursive: true });
  process.env.PATH = `${join(root, "bin")}:${saved.PATH}`;
  process.env.CODEX_HOME = join(root, "operator-codex");
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterAll(async () => {
  process.env.PATH = saved.PATH;
  for (const name of ["CODEX_HOME", "CLAUDE_CODE_OAUTH_TOKEN"] as const) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  runDirs.cleanup();
  await rm(root, { recursive: true, force: true });
});

const headless = { harness: "codex", model: "gpt-test", placement: "headless" } as const;

function setup(options: FakeSandboxOptions = {}, host?: AgentRunHostFactory) {
  const fake = createFakeSandboxProvider(options);
  const providers: SandboxProviders = { installed: { srt: fake.provider }, default: "srt" };
  const runtime: AgentRuntimeConfig = {
    aliases: {},
    host: host ?? createHeadlessRunHostFactory({ turnTimeoutMs: 20_000 }),
  };
  const logs: string[] = [];
  const run = <Result extends JsonValue>(body: (context: WorkflowContext) => Promise<Result>) =>
    runWorkflow(workflowOf(body), null, {
      runRoot: runDirs.tempRunDir(),
      runtime,
      deadline: future(),
      cwd: work,
      sandboxes: { providers },
      onLog: (message) => logs.push(message),
    });
  return { events: fake.events, run, providers, runtime, logs };
}

function workflowOf<Result extends JsonValue>(
  body: (context: WorkflowContext) => Promise<Result>,
): WorkflowDefinition<null, Result> {
  return { meta: { name: "sandboxes", description: "test" }, run: (context) => body(context) };
}

const kinds = (events: FakeSandboxEvent[], sandbox?: string) =>
  events.filter((event) => !sandbox || event.sandbox === sandbox).map((event) => event.kind);

async function turnsOf(home: string): Promise<{ argv: string; env: string[] }[]> {
  const log = await readFile(join(home, "turns.log"), "utf8");
  return log
    .split("---\n")
    .filter(Boolean)
    .map((turn) => {
      const [argv = "", ...env] = turn.trim().split("\n");
      return { argv, env };
    });
}

describe("sandboxed agents", () => {
  test("two share a sandbox and one has its own; every turn runs inside and is reaped", async () => {
    const { events, run } = setup();
    process.env.AWF_ENGINE_ONLY = "leaked";
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(async (context) => {
        const box = await context.sandboxes.open({ key: "shared", write: ["src"] });
        const coder = await context.agents.open({ key: "coder", runtime: headless, sandbox: box });
        const tester = await context.agents.open({
          key: "tester",
          runtime: headless,
          sandbox: box,
        });
        const reviewer = await context.agents.open({
          key: "reviewer",
          runtime: headless,
          sandbox: {},
        });
        const answers: JsonValue[] = [];
        for (const agent of [coder, tester, reviewer, coder]) {
          const { outcome } = await agent.run({ prompt: "go", nudge: false });
          answers.push(outcome.kind === "answered" ? outcome.value : outcome.kind);
        }
        return answers;
      });
    } finally {
      delete process.env.AWF_ENGINE_ONLY;
    }
    expect(result.value).toEqual(["answered", "answered", "answered", "answered"]);

    const [shared, own] = result.sandboxes!;
    // Taken first: bun's `toMatchObject` writes its matchers into the object it checks.
    const homes = [...shared!.agents, ...own!.agents].map((agent) => agent.home);
    const coderHome = homes[0]!;
    expect(shared).toMatchObject({
      callPath: [],
      key: "shared",
      provider: "srt",
      spec: { cwd: work, read: [], write: [join(work, "src")], network: [] },
      domains: ["*.chatgpt.com", "auth.openai.com", "chatgpt.com"],
      agents: [
        { callPath: [], agent: "coder", home: expect.stringContaining(shared!.directory) },
        { callPath: [], agent: "tester", home: expect.stringContaining(shared!.directory) },
      ],
    });
    expect(own).toMatchObject({ key: "agent:reviewer", agents: [{ agent: "reviewer" }] });

    // Each process carried its own agent's marker and home, and nothing else of the engine's.
    for (const [home, sandbox, count] of [
      [homes[0]!, "shared", 2],
      [homes[1]!, "shared", 1],
      [homes[2]!, "agent:reviewer", 1],
    ] as const) {
      const turns = await turnsOf(home);
      expect(turns).toHaveLength(count);
      for (const turn of turns) {
        expect(turn.env).toContain(`${FAKE_OCCUPANT_ENV}=${home}`);
        expect(turn.env).toContain(`${FAKE_SANDBOX_ENV}=${sandbox}`);
        expect(turn.env).toContain(`CODEX_HOME=${home}`);
        expect(turn.env.some((line) => line.startsWith("AWF_ENGINE_ONLY="))).toBe(false);
        expect(turn.argv).toContain('-c web_search="disabled"');
      }
    }
    expect((await turnsOf(coderHome))[1]!.argv).toContain("exec resume thread-1");
    // The home holds its copy of the credential, private to it.
    expect(await readFile(join(coderHome, "auth.json"), "utf8")).toBe(
      '{"tokens":{"access_token":"operator"}}',
    );

    // Every launch reaped; release after the sessions closed; sandboxes closed after their agents.
    expect(kinds(events).filter((kind) => kind === "launch")).toHaveLength(4);
    expect(kinds(events).filter((kind) => kind === "reap")).toHaveLength(4);
    for (const key of ["shared", "agent:reviewer"]) {
      const sequence = kinds(events, key);
      expect(sequence.at(-1)).toBe("close");
      expect(sequence.lastIndexOf("release")).toBeGreaterThan(sequence.lastIndexOf("reap"));
    }
  });

  test("a pane agent reaches its host with the sandbox's terminal", async () => {
    const opened: { occupant?: HarnessActivation["occupant"] }[] = [];
    const host: AgentRunHostFactory = {
      openRun: async () => ({
        openAgent: async (request) => {
          opened.push({ occupant: request.occupant });
          throw new Error("seen");
        },
        inspect: () => ({ state: "running", agents: [] }),
        close: async () => undefined,
      }),
    };
    const { run, logs } = setup(
      {
        panes: {
          prelude: "exec confined",
          ready: "box% ",
          herdr: {
            key: "box",
            run: () => ({ argv: [], timeoutMs: 1, group: true }),
            watch: ["watch-box"],
          },
        },
        record: { toolchain: ["/opt"] },
      },
      host,
    );
    await run(async (context) => {
      await open(context, { runtime: { harness: "codex", model: "m" }, sandbox: {} }).catch(
        () => undefined,
      );
      return null;
    });
    const terminal = await opened[0]?.occupant?.pane?.();
    expect(terminal).toMatchObject({ prelude: "exec confined", ready: "box% ", harness: "codex" });
    await opened[0]?.occupant?.pane?.();
    // Said to the operator at a sandbox's first pane.
    expect(logs.filter((line) => line.includes("watch its panes with watch-box"))).toHaveLength(1);
  });

  test("a run with no sandbox records none, and its agents run as before", async () => {
    const { run } = setup();
    const result = await run(async (context) => {
      const agent = await context.agents.open({ key: "plain", runtime: headless });
      return (await agent.run({ prompt: "go", nudge: false })).outcome.kind;
    });
    expect(result.value).toBe("answered");
    expect(result.sandboxes).toBeUndefined();
  });

  test.each<[string, (context: WorkflowContext) => Promise<unknown>, string]>([
    [
      "two environments",
      (c) => c.sandboxes.open({ key: "b", srt: {}, docker: {} } as never),
      "one environment",
    ],
    ["an unknown field", (c) => c.sandboxes.open({ key: "b", mounts: [] } as never), "unknown"],
    ["a bad domain", (c) => c.sandboxes.open({ key: "b", network: ["x.org:80"] }), "domain"],
    ["~ re-allowed", (c) => c.sandboxes.open({ key: "b", read: ["~"] }), "would expose ~"],
    ["the agent: namespace", (c) => c.sandboxes.open({ key: "agent:x" }), "agent: names"],
    ["an uninstalled provider", (c) => c.sandboxes.open({ key: "b", docker: {} }), "not installed"],
    [
      "a key already open",
      async (c) => {
        await c.sandboxes.open({ key: "b" });
        await c.sandboxes.open({ key: "b" });
      },
      "already open",
    ],
    [
      "a look-alike ref",
      (c) => open(c, { sandbox: { key: "b", provider: "srt" } as never }),
      "not a sandbox this run opened",
    ],
    [
      "an open spec inline",
      (c) => open(c, { sandbox: { key: "b" } as never }),
      "inline sandbox cannot name key",
    ],
    [
      "an agent outside the sandbox's reach",
      async (c) => open(c, { cwd: root, sandbox: await c.sandboxes.open({ key: "b", cwd: work }) }),
      "outside sandbox b's reach",
    ],
    [
      "a pane",
      (c) => open(c, { runtime: { harness: "codex", model: "m" }, sandbox: {} }),
      "hosts no panes",
    ],
    [
      "a gitdir the sandbox did not resolve when it opened",
      async (c) => {
        const late = join(root, "late-repo");
        await mkdir(late, { recursive: true });
        const box = await c.sandboxes.open({ key: "b", read: [late] });
        await mkdir(join(late, ".git"), { recursive: true });
        try {
          return await open(c, { cwd: late, sandbox: box });
        } finally {
          await rm(late, { recursive: true, force: true });
        }
      },
      "late-repo/.git is outside sandbox b's reach",
    ],
    [
      "a claude without its setup token",
      (c) =>
        open(c, {
          runtime: { harness: "claude", model: "m", placement: "headless", metered: true },
          sandbox: {},
        }),
      "a sandboxed claude needs CLAUDE_CODE_OAUTH_TOKEN",
    ],
    ["an empty path", (c) => open(c, { sandbox: { read: [""] } }), "non-empty path"],
    ["a missing path", (c) => open(c, { sandbox: { read: ["nowhere"] } }), "does not exist"],
    ["the run root", (c) => open(c, { sandbox: { read: [dirname(c.cwd)] } }), "would expose"],
    [
      "a harness no sandbox can run",
      (c) =>
        open(c, { runtime: { harness: "cursor", model: "m", placement: "headless" }, sandbox: {} }),
      "cursor cannot run in a sandbox",
    ],
  ])("refuses %s before anything opens for an agent", async (_name, body, reason) => {
    const { events, run } = setup();
    const failure = await run(body as never).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkflowRunError);
    expect(String((failure as Error).message)).toContain(reason);
    expect(kinds(events)).not.toContain("admit");
    expect(kinds(events)).not.toContain("launch");
  });

  test("an agent that fails to open has its private sandbox closed at once, and recorded", async () => {
    const refusing = setup({ refuseAdmit: () => "the image lacks codex" });
    const refusal = await refusing.run(async (context) => {
      const failed = await open(context, { sandbox: {} }).then(
        () => "opened",
        (error: Error) => error.message,
      );
      // Closed before the run ends, so nothing of it waits for the run's cleanup.
      return [failed, kinds(refusing.events, "agent:agent")];
    });
    expect(refusal.value).toEqual(["the image lacks codex", ["open", "close"]]);
    expect(refusal.sandboxes).toMatchObject([{ key: "agent:agent", agents: [] }]);

    // A host that refuses the agent after admission: released, then closed; its home recorded.
    const host: AgentRunHostFactory = {
      openRun: async () => ({
        openAgent: () => Promise.reject(new Error("host refused")),
        inspect: () => ({ state: "running", agents: [] }),
        close: async () => undefined,
      }),
    };
    const refused = setup({}, host);
    const result = await refused.run(async (context) => {
      const failed = await open(context, { sandbox: {} }).then(
        () => "opened",
        (error: Error) => error.message,
      );
      // Reopened the same way, it gives its own failure rather than a conflict.
      const again = await open(context, { sandbox: {} }).then(
        () => "opened",
        (error: Error) => error.message,
      );
      return [failed, again, kinds(refused.events, "agent:agent")];
    });
    expect(result.value).toEqual([
      "host refused",
      "host refused",
      ["open", "admit", "release", "close"],
    ]);
    expect(result.sandboxes).toMatchObject([{ key: "agent:agent", agents: [{ agent: "agent" }] }]);
  });

  test("a reap that fails is logged, and the turn's answer stands", async () => {
    const { run, logs } = setup({ failReap: "the box is gone" });
    const result = await run(async (context) => {
      const agent = await open(context, { sandbox: {} });
      return (await agent.run({ prompt: "go", nudge: false })).outcome.kind;
    });
    expect(result.value).toBe("answered");
    expect(logs).toContain(
      "sandbox agent:agent: agent: a turn's leftovers may still run: the box is gone",
    );
  });

  test("a refreshed credential is written back to the operator after the turn", async () => {
    const { run } = setup();
    await run(async (context) => {
      const agent = await open(context, { sandbox: {} });
      await agent.run({ prompt: "refresh and answer", nudge: false });
      return null;
    });
    expect(await readFile(join(root, "operator-codex", "auth.json"), "utf8")).toBe(
      '{"tokens":{"access_token":"refreshed"}}',
    );
    await writeFile(
      join(root, "operator-codex", "auth.json"),
      '{"tokens":{"access_token":"operator"}}',
    );
  });

  test("a cancelled run releases its agents and closes their sandboxes, leaving nothing", async () => {
    const { events, providers, runtime } = setup();
    const handle = await startWorkflow(
      workflowOf(async (context) => {
        const agent = await open(context, { sandbox: {} });
        await agent.run({ prompt: "wait for it", nudge: false });
        return null;
      }),
      null,
      {
        runRoot: runDirs.tempRunDir(),
        runtime,
        deadline: future(),
        cwd: work,
        sandboxes: { providers },
      },
    );
    for (let tries = 0; tries < 100 && !kinds(events).includes("launch"); tries++) {
      await Bun.sleep(50);
    }
    await handle.stop("operator stop");
    // The killed turn was reaped before its agent was released and its sandbox closed.
    expect(kinds(events, "agent:agent")).toEqual([
      "open",
      "admit",
      "launch",
      "reap",
      "release",
      "close",
    ]);
    const left = Bun.spawnSync(["pgrep", "-f", "sleep 30"]).stdout.toString().trim();
    // Nothing of this test's: a `sleep 30` elsewhere on the machine would not carry our home.
    for (const pid of left.split("\n").filter(Boolean)) {
      const environment = Bun.spawnSync([
        "ps",
        "-E",
        "-p",
        pid,
        "-o",
        "command=",
      ]).stdout.toString();
      expect(environment).not.toContain(FAKE_SANDBOX_ENV);
    }
  });

  test("a reopened agent keeps its sandbox, and naming another is a conflict", async () => {
    const { run } = setup();
    const result = await run(async (context) => {
      const box = await context.sandboxes.open({ key: "one" });
      const other = await context.sandboxes.open({ key: "two" });
      await open(context, { key: "shared", sandbox: box });
      await open(context, { key: "private", sandbox: { write: ["src"] } });
      const tries = [
        open(context, { key: "shared", sandbox: box }),
        open(context, { key: "shared" }),
        open(context, { key: "shared", sandbox: other }),
        open(context, { key: "shared", sandbox: {} }),
        open(context, { key: "private", sandbox: { write: ["src"] } }),
        open(context, { key: "private", sandbox: { write: ["."] } }),
        open(context, { key: "private", sandbox: box }),
      ];
      return (await Promise.allSettled(tries)).map((tried) =>
        tried.status === "fulfilled" ? "same" : (tried.reason as Error).message,
      );
    });
    const conflict = (key: string) => `agent ${key} is already open with different sandbox`;
    expect(result.value).toEqual([
      "same",
      "same",
      conflict("shared"),
      conflict("shared"),
      "same",
      conflict("private"),
      conflict("private"),
    ]);
  });

  test("an agent's door is a launcher and bundle of its own, by real paths", async () => {
    const { run, events } = setup();
    const result = await run(async (context) => {
      await open(context, { sandbox: {} });
      return null;
    });
    const home = result.sandboxes![0]!.agents[0]!.home;
    // The home is the agent's alone, and nothing but its seed and defaults are in it before a turn.
    expect((await readdir(home)).sort()).toEqual(["auth.json", "config.toml"]);
    const admitted = events.find((event) => event.kind === "admit");
    const door = admitted?.kind === "admit" ? admitted.door : undefined;
    expect(door).toBeDefined();
    // Under the control plane's root by its real path; the directory itself went with the run.
    for (const path of [door!.endpoint, door!.launcher, door!.bundle]) {
      expect(path.startsWith(`${realpathSync("/tmp")}/awf-`)).toBe(true);
    }
    expect(dirname(door!.bundle)).toBe(dirname(door!.launcher));
    expect(door!.reads).toEqual([realpathSync(process.execPath), door!.bundle]);
    expect(door!.boxScript).toBe(
      `#!/bin/sh\nexec 'bun' '${door!.bundle}' --at '${door!.endpoint}' --session "\${CODEX_SESSION_ID:-}" "$@"\n`,
    );
  });
});

function open(
  context: WorkflowContext,
  spec: Partial<AgentOpenSpec>,
): ReturnType<WorkflowContext["agents"]["open"]> {
  return context.agents.open({ key: "agent", runtime: headless, ...spec });
}

// The real provider, with nothing but a fake harness: the door crosses srt, and srt denies what it
// should. Skipped without srt. Installed at load, before `beforeAll` moves `CODEX_HOME`, so its
// pure check guards the operator's real harness state; the test's is under a denied temp anyway.
const installed = await installSandboxes(process.env);

describe.skipIf(!installed.installed.srt)("a sandboxed agent under srt", () => {
  test("answers through its door from inside, and cannot read ~", async () => {
    const canary = join(realpathSync(homedir()), `.awf-engine-canary-${crypto.randomUUID()}`);
    await writeFile(canary, "canary-in-home");
    try {
      const result = await runWorkflow(
        workflowOf(async (context) => {
          const agent = await open(context, { sandbox: { srt: {} } });
          const { outcome } = await agent.run({ prompt: `peek: ${canary}`, nudge: false });
          return outcome.kind === "answered" ? outcome.value : outcome.kind;
        }),
        null,
        {
          runRoot: runDirs.tempRunDir(),
          runtime: {
            aliases: {},
            host: createHeadlessRunHostFactory({ turnTimeoutMs: 60_000 }),
          },
          deadline: future(),
          cwd: work,
          sandboxes: { providers: installed },
        },
      );
      expect(result.value).toBe("answered");
      const [sandbox] = result.sandboxes!;
      expect(sandbox).toMatchObject({
        provider: "srt",
        provided: { toolchain: expect.any(Array) },
      });
      const home = sandbox!.agents[0]!.home;
      expect(await readFile(join(home, "peeked.log"), "utf8")).not.toContain("canary-in-home");
      const [turn] = await turnsOf(home);
      expect(turn!.env).toContain(`CODEX_HOME=${home}`);
      expect(turn!.env.some((line) => line.startsWith("HTTPS_PROXY="))).toBe(true);
    } finally {
      await rm(canary, { force: true });
    }
  }, 60_000);
});

describe("a run's sandboxes, opening as the run ends", () => {
  function gated() {
    const fake = createFakeSandboxProvider();
    let land: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      land = resolve;
    });
    const provider = {
      ...fake.provider,
      open: async (...args: Parameters<typeof fake.provider.open>) => {
        await gate;
        return fake.provider.open(...args);
      },
    };
    const sandboxes = new RunSandboxes({
      sandboxes: { providers: { installed: { srt: provider }, default: "srt" } },
      runDir: runDirs.tempRunDir(),
      runRoot: runDirs.tempRunDir(),
      cwd: work,
      deadline: future(),
      locks: new Map(),
      log: () => undefined,
    });
    return { sandboxes, events: fake.events, land };
  }

  test("close waits for a sandbox still opening, closes it and records it", async () => {
    const { sandboxes, events, land } = gated();
    const opening = sandboxes.open({ key: "slow" });
    const closing = sandboxes.close();
    land();
    await expect(opening).rejects.toThrow("the run's sandboxes are closed");
    expect(await closing).toEqual([]);
    expect(kinds(events)).toEqual(["open", "close"]);
    expect(sandboxes.records().map((record) => record.key)).toEqual(["slow"]);
  });

  test("a reopened agent is compared with its private sandbox while it still opens", async () => {
    const { sandboxes, land } = gated();
    const first = { write: ["."] };
    const seating = sandboxes.seat({ key: "a", sandbox: first, cwd: work, execution: headless });
    const same = sandboxes.same("a", first, {}, work);
    land();
    await seating;
    expect(await same).toBe(false);
    expect(await sandboxes.same("a", first, { write: ["."] }, work)).toBe(true);
    await sandboxes.close();
  });
});
