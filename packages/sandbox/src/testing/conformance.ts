import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSandbox } from "../resolve";
import {
  type AgentDoor,
  type HarnessSandboxNeeds,
  type Occupant,
  type OpenedSandbox,
  REAP_GRACE_MS,
  type SandboxedCommand,
  type SandboxProvider,
} from "../seam";

export type ConformanceSetup = {
  provider: SandboxProvider<unknown>;
  /** The environment every sandbox names, as a spec would: `{ key: "docker", settings: {} }`. */
  environment?: { key: "srt" | "docker"; settings: unknown };
  /** Whether it enforces reach. A fake does not, so the reach and boundary tests are skipped. */
  confines: boolean;
  /**
   * How many processes whose command line contains `pattern` still run where `occupant` runs
   * them. By default, on the host.
   */
  running?(pattern: string, occupant: Occupant): Promise<number>;
  /** What the suite's agents need beyond `sh`. */
  needs?: Partial<HarnessSandboxNeeds>;
};

/** A real provider starts a process per launch; srt's takes most of a second. */
const TEST_TIMEOUT_MS = 30_000;

type Agent = { occupant: Occupant; home: string; door: AgentDoor };

/**
 * The invariants every provider holds, run against `setup`'s provider with `sh` for an agent: the
 * same paths inside, exactly the environment it sets, a door per agent, and nothing left running
 * after a killed turn, `release` or `close`. With `confines`, also reach and the boundary between
 * sandboxes. `setup` is `undefined` where the provider is not installed, and the suite is skipped.
 */
export function sandboxConformance(name: string, setup: ConformanceSetup | undefined): void {
  const suite = setup ? describe : describe.skip;
  suite(`${name} sandbox conformance`, () => {
    if (!setup) return;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-conformance-")));
    const runRoot = join(root, "runs");
    const cwd = join(root, "work");
    const outside = join(root, "outside");
    const shared = join(root, "shared");
    // A project keeping its runs inside it, as `.awf/runs`: a sandbox writing it holds them.
    const project = join(root, "project");
    const projectRuns = join(project, ".awf", "runs");
    const servers: Server[] = [];
    const doors: string[] = [];
    const sandboxes: OpenedSandbox[] = [];
    const agents: Record<"a1" | "a2" | "a3" | "b1" | "p1", Agent> = {} as never;
    const running = (pattern: string, agent: Agent) =>
      setup.running ? setup.running(pattern, agent.occupant) : hostRunning(pattern);
    const sh = (agent: Agent, script: string, extra: { timeoutMs?: number; cwd?: string } = {}) =>
      runCommand(
        agent.occupant.launch({
          argv: ["/bin/sh", "-c", script],
          cwd: extra.cwd ?? cwd,
          env: { AWF_CONFORMANCE_OVERLAY: "overlay" },
          timeoutMs: extra.timeoutMs ?? 30_000,
        }),
      );

    beforeAll(async () => {
      await mkdir(join(cwd, "out"), { recursive: true });
      await writeFile(join(cwd, "in.txt"), "readable\n");
      await mkdir(outside, { recursive: true });
      await mkdir(shared, { recursive: true });
      await writeFile(join(shared, "notes.txt"), "shared notes\n");
      await writeFile(join(outside, "canary.txt"), "canary-outside\n");
      await mkdir(join(runRoot, "other-run"), { recursive: true });
      await writeFile(join(runRoot, "other-run", "canary.txt"), "canary-other-run\n");
      await mkdir(join(projectRuns, "other-run"), { recursive: true });
      await writeFile(join(projectRuns, "other-run", "canary.txt"), "canary-project-run\n");
      const open = async (
        key: string,
        reach: { cwd: string; runRoot: string; read: string[]; write: string[] } = {
          cwd,
          runRoot,
          read: [shared],
          write: ["out"],
        },
      ) => {
        const environment = setup.environment;
        const { sandbox } = await resolveSandbox(
          {
            read: reach.read,
            write: reach.write,
            ...(environment ? { [environment.key]: environment.settings } : {}),
          },
          {
            key,
            cwd: reach.cwd,
            runRoot: reach.runRoot,
            harnessState: [],
            providers: {
              installed: { [environment?.key ?? "srt"]: setup.provider },
              default: environment?.key ?? "srt",
            },
          },
        );
        // Outside every run root, as the engine keeps them under `~/.awf/sandboxes`.
        const directory = join(root, "sandboxes", key);
        await mkdir(join(directory, "homes"), { recursive: true });
        const opened = await setup.provider.open(sandbox, {
          runRoot: reach.runRoot,
          directory,
          deadline: { unixMilliseconds: Date.now() + 120_000 },
        });
        sandboxes.push(opened);
        return { opened, directory };
      };
      const admit = async (
        box: { opened: OpenedSandbox; directory: string },
        name: string,
        at = cwd,
      ): Promise<Agent> => {
        const home = join(box.directory, "homes", name);
        await mkdir(home, { recursive: true });
        const door = await openDoor(servers, doors);
        const occupant = await box.opened.admit({
          cwd: at,
          home,
          door,
          harness: {
            env: {},
            seed: [],
            secrets: {},
            defaults: () => [],
            domains: [],
            command: "/bin/sh",
            executable: "/bin/sh",
            reads: [],
            ...setup.needs,
          },
        });
        return { occupant, home, door };
      };
      const a = await open("a");
      const b = await open("b");
      agents.a1 = await admit(a, "a1");
      agents.a2 = await admit(a, "a2");
      agents.a3 = await admit(a, "a3");
      agents.b1 = await admit(b, "b1");
      const p = await open("p", { cwd: project, runRoot: projectRuns, read: [], write: ["."] });
      agents.p1 = await admit(p, "p1", project);
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
      await Promise.allSettled(sandboxes.map((sandbox) => sandbox.close()));
      for (const server of servers) server.close();
      await Promise.all([root, ...doors].map((path) => rm(path, { recursive: true, force: true })));
    });

    test(
      "runs at the same paths, with only the environment it sets",
      async () => {
        process.env.AWF_CONFORMANCE_LEAK = "leaked";
        const agent = agents.a1;
        try {
          const result = await sh(
            agent,
            `pwd; echo "leak=$AWF_CONFORMANCE_LEAK overlay=$AWF_CONFORMANCE_OVERLAY"; cat in.txt; ` +
              `cat "${shared}/notes.txt"; ` +
              `echo home > "${agent.home}/written" && echo out > out/written`,
          );
          expect(result.stdout.split("\n").slice(0, 4)).toEqual([
            cwd,
            "leak= overlay=overlay",
            "readable",
            "shared notes",
          ]);
          expect(result.exitCode).toBe(0);
        } finally {
          delete process.env.AWF_CONFORMANCE_LEAK;
        }
        expect(await readFile(join(agent.home, "written"), "utf8")).toBe("home\n");
        expect(await readFile(join(cwd, "out", "written"), "utf8")).toBe("out\n");
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "each agent's launcher reaches its own door",
      async () => {
        for (const agent of [agents.a1, agents.a2, agents.b1]) {
          const result = await sh(agent, `"${agent.door.launcher}" hello`);
          expect(result.stdout).toBe(`pong ${agent.door.endpoint} hello`);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a killed turn leaves nothing running",
      async () => {
        const seconds = marker();
        const result = await sh(agents.a1, `sleep ${seconds} & sleep ${seconds}`, {
          timeoutMs: 1_000,
        });
        expect(result.timedOut).toBe(true);
        expect(await running(`sleep ${seconds}`, agents.a1)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a cancelled turn leaves nothing running",
      async () => {
        const seconds = marker();
        const controller = new AbortController();
        const turn = runCommand(
          agents.a2.occupant.launch({
            argv: ["/bin/sh", "-c", `sleep ${seconds} & sleep ${seconds}`],
            cwd,
            timeoutMs: 30_000,
            signal: controller.signal,
          }),
        );
        await until(async () => (await running(`sleep ${seconds}`, agents.a2)) > 0);
        controller.abort();
        await turn;
        expect(await running(`sleep ${seconds}`, agents.a2)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "release ends the agent's processes",
      async () => {
        const seconds = marker();
        const turn = sh(agents.a3, `sleep ${seconds} & wait`);
        await until(async () => (await running(`sleep ${seconds}`, agents.a3)) > 0);
        await agents.a3.occupant.release();
        await turn;
        // Counted by a co-tenant: a released agent launches nothing.
        expect(await running(`sleep ${seconds}`, agents.a1)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    test.skipIf(!setup.confines)(
      "denies what lies outside reach",
      async () => {
        const result = await sh(
          agents.a1,
          `cat "${outside}/canary.txt" || echo denied-outside; ` +
            `cat "${runRoot}/other-run/canary.txt" || echo denied-run; ` +
            `echo x > in.txt || echo denied-write`,
        );
        expect(result.stdout).not.toContain("canary-outside");
        expect(result.stdout).not.toContain("canary-other-run");
        expect(result.stdout).toContain("denied-outside");
        expect(result.stdout).toContain("denied-run");
        expect(result.stdout).toContain("denied-write");
        expect(await readFile(join(cwd, "in.txt"), "utf8")).toBe("readable\n");
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "hides the run root a writable project holds",
      async () => {
        const result = await sh(
          agents.p1,
          `echo written > written; ` +
            `cat "${projectRuns}/other-run/canary.txt" || echo denied-read; ` +
            `echo forged > "${projectRuns}/other-run/canary.txt" || echo denied-write; ` +
            `echo planted > "${projectRuns}/planted" || echo denied-plant`,
          { cwd: project },
        );
        expect(await readFile(join(project, "written"), "utf8")).toBe("written\n");
        if (!setup.confines) return;
        expect(result.stdout).not.toContain("canary-project-run");
        expect(result.stdout).toContain("denied-read");
        // Inside, docker's empty tmpfs may take the plant; the host's run root never sees it.
        expect(await readFile(join(projectRuns, "other-run", "canary.txt"), "utf8")).toBe(
          "canary-project-run\n",
        );
        expect(await stat(join(projectRuns, "planted")).catch(() => undefined)).toBeUndefined();
      },
      TEST_TIMEOUT_MS,
    );

    test.skipIf(!setup.confines)(
      "trust stops at the sandbox's boundary",
      async () => {
        const { a1, a2, b1 } = agents;
        await writeFile(join(a1.home, "secret.txt"), "a1 only\n");
        // b1 runs its own bundle, which it may, at a1's socket, which it may not reach.
        const [bun, bundle] = b1.door.reads;
        const across = await sh(
          b1,
          `cat "${a1.home}/secret.txt" || echo denied-home; ` +
            `"${a1.door.launcher}" hello || echo denied-door; ` +
            `"${bun}" "${bundle}" --at "${a1.door.endpoint}" hello || echo denied-socket`,
        );
        expect(across.stdout).not.toContain("a1 only");
        expect(across.stdout).not.toContain("pong");
        expect(across.stdout).toContain("denied-home");
        expect(across.stdout).toContain("denied-door");
        expect(across.stdout).toContain("denied-socket");
        const own = await sh(a2, `echo forged > "${a2.door.launcher}" || echo denied-launcher`);
        expect(own.stdout).toContain("denied-launcher");
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "close ends everything and keeps the homes",
      async () => {
        const seconds = marker();
        const turn = sh(agents.a2, `sleep ${seconds} & wait`);
        await until(async () => (await running(`sleep ${seconds}`, agents.a2)) > 0);
        const pattern = `sleep ${seconds}`;
        await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()));
        await turn;
        // Only the host is left to ask: a provider's own place to look may have gone with it, so a
        // provider whose processes the host cannot see (docker's) proves this in its own tests.
        expect(await hostRunning(pattern)).toBe(0);
        expect((await stat(agents.a1.home)).isDirectory()).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );
  });
}

/** The door the engine would give an agent, answering `pong {endpoint} {args}`. */
async function openDoor(servers: Server[], directories: string[]): Promise<AgentDoor> {
  // Under `/tmp`, as the control plane's are, to stay inside a socket path's length.
  const directory = await realpath(await mkdtemp("/tmp/wf-door-"));
  directories.push(directory);
  const endpoint = join(directory, "s.sock");
  const bundle = join(directory, "door.js");
  const launcher = join(directory, "wf");
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let said = "";
    socket.on("data", (data) => {
      said += data;
    });
    socket.on("end", () => socket.end(`pong ${endpoint} ${said}`));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  servers.push(server);
  await writeFile(
    bundle,
    `const net = require("node:net");
const at = process.argv.indexOf("--at");
const client = net.createConnection(process.argv[at + 1], () => client.end(process.argv.slice(at + 2).join(" ")));
client.on("data", (data) => process.stdout.write(data));
client.on("error", (error) => { console.error(error.message); process.exit(2); });
`,
  );
  const bun = await realpath(process.execPath);
  await writeFile(launcher, `#!/bin/sh\nexec '${bun}' '${bundle}' --at '${endpoint}' "$@"\n`);
  await chmod(launcher, 0o500);
  return {
    endpoint,
    launcher,
    boxScript: `#!/bin/sh\nexec bun '${bundle}' --at '${endpoint}' "$@"\n`,
    bundle,
    reads: [bun, bundle],
  };
}

/**
 * `runProcess`'s contract for a sandboxed command, which the seam cannot import from harness: its
 * group killed however it ends, output drained for a moment after, and `reap` held to its grace.
 */
export async function runCommand(
  command: SandboxedCommand,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const child = Bun.spawn({
    cmd: [...command.argv],
    cwd: command.cwd,
    env: { ...command.env },
    detached: true,
    stdin: command.stdin === undefined ? "ignore" : new TextEncoder().encode(command.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, command.timeoutMs);
  command.signal?.addEventListener("abort", kill, { once: true });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  kill();
  clearTimeout(timer);
  const [stdout, stderr] = (await Promise.race([output, Bun.sleep(1_000)])) ?? ["", ""];
  if (command.reap) {
    const started = Date.now();
    await command.reap();
    const took = Date.now() - started;
    if (took > REAP_GRACE_MS)
      throw new Error(`reap took ${took}ms, past its ${REAP_GRACE_MS}ms grace`);
  }
  return { stdout, stderr, exitCode, timedOut };
}

async function hostRunning(pattern: string): Promise<number> {
  const listed = Bun.spawnSync(["pgrep", "-f", pattern]).stdout.toString().trim();
  return listed === "" ? 0 : listed.split("\n").length;
}

async function until(condition: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 300; tries++) {
    if (await condition()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition never held");
}

/** A sleep that ends on its own within the hour if a test leaks it; its fraction tells it apart. */
function marker(): string {
  return `3599.${Math.floor(10_000 + Math.random() * 89_999)}`;
}
