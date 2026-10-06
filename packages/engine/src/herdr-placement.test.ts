import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERDR_VERSION, type RunProcess } from "@agentswf/harness";
import { findOrigin, namedSession, workspaceLock } from "./herdr-placement";
import { machinePaths } from "./machine";

const DRIVEN = HERDR_VERSION.replace(/^herdr /, "");
const ok = (stdout: unknown) => ({
  stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
  stderr: "",
  exitCode: 0,
  timedOut: false,
});
const failed = { stdout: "", stderr: "no", exitCode: 1, timedOut: false };

/** A Herdr with sessions `default` (the operator's) and `awf`, and a process tree. */
function herdr(
  options: {
    version?: string;
    shellPid?: number;
    parents?: Record<number, number>;
    sessions?: { name: string; running: boolean; socket_path?: string }[];
  } = {},
) {
  const calls: string[][] = [];
  const parents = options.parents ?? { 500: 400, 400: 300, 300: 1 };
  const run: RunProcess = async ({ argv }) => {
    calls.push([...argv]);
    const command = argv.join(" ");
    if (argv[0] === "ps") return ok(String(parents[Number(argv.at(-1))] ?? ""));
    if (command === "herdr session list --json") {
      return ok({
        sessions: options.sessions ?? [
          { name: "default", running: true, socket_path: "/sock/default" },
          { name: "awf", running: true, socket_path: "/sock/awf" },
          { name: "work", running: false, socket_path: "/sock/work" },
        ],
      });
    }
    if (command.endsWith("status server --json")) {
      return ok({ version: options.version ?? DRIVEN });
    }
    if (argv.includes("process-info")) {
      return ok({ result: { process_info: { shell_pid: options.shellPid ?? 300 } } });
    }
    if (argv.includes("get")) {
      return ok({ result: { pane: { pane_id: argv.at(-1), workspace_id: "w7" } } });
    }
    return failed;
  };
  return { run, calls };
}

describe("namedSession", () => {
  const deps = (run: RunProcess) => ({ run, environment: {}, home: "/nowhere" });

  test("a session awf does not start is used only if running, on the driven Herdr", async () => {
    expect(await namedSession("default", deps(herdr().run))).toBeUndefined();
    expect(await namedSession("work", deps(herdr().run))).toBe(
      "it is not running, and awf starts only sessions named awf-…",
    );
    expect(await namedSession("default", deps(herdr({ version: "0.8.0" }).run))).toBe(
      `it runs Herdr 0.8.0, not ${DRIVEN}`,
    );
  });
});

describe("findOrigin", () => {
  const environment = { HERDR_SOCKET_PATH: "/sock/default", HERDR_PANE_ID: "w7:p2" };

  test("the pane `awf run` was typed in, believed by its shell being an ancestor", async () => {
    const { run, calls } = herdr();
    expect(await findOrigin({ run, environment, runSession: "awf", pid: 500 })).toEqual({
      session: "default",
      workspaceId: "w7",
    });
    expect(calls.some((call) => call.includes("w7:p2") && call.includes("get"))).toBe(true);
  });

  test("a HERDR_PANE_ID whose shell is not an ancestor, as a codex shell inherits, is refused", async () => {
    const { run } = herdr({ shellPid: 999 });
    expect(await findOrigin({ run, environment, runSession: "awf", pid: 500 })).toBe(
      "HERDR_PANE_ID names pane w7:p2, which awf run was not typed in",
    );
  });

  test("under --here the caller's pane is used, with no ancestor check", async () => {
    const { run, calls } = herdr({ shellPid: 999 });
    expect(
      await findOrigin({ run, environment, runSession: "awf", callerPane: "w7:p9", pid: 500 }),
    ).toEqual({ session: "default", workspaceId: "w7" });
    expect(calls.some((call) => call.includes("process-info"))).toBe(false);
  });

  test("refused: no Herdr, the run session itself, or another Herdr version", async () => {
    expect(await findOrigin({ run: herdr().run, environment: {}, runSession: "awf" })).toBe(
      "awf run was not started in a Herdr pane",
    );
    expect(
      await findOrigin({
        run: herdr().run,
        environment: { ...environment, HERDR_SOCKET_PATH: "/sock/awf" },
        runSession: "awf",
      }),
    ).toBe("it is the run session, awf, whose workspaces are runs'");
    expect(
      await findOrigin({ run: herdr({ version: "0.8.0" }).run, environment, runSession: "awf" }),
    ).toBe(`its session default: it runs Herdr 0.8.0, not ${DRIVEN}`);
  });
});

describe("workspaceLock", () => {
  test("two holders of one name take turns; another name does not wait", async () => {
    const home = mkdtempSync(join(tmpdir(), "awf-lock-"));
    try {
      const lock = workspaceLock(home);
      const order: string[] = [];
      const first = await lock("awf", "review");
      const second = lock("awf", "review").then((release) => {
        order.push("second");
        return release;
      });
      const other = await lock("awf", "other");
      order.push("other");
      await Bun.sleep(150);
      order.push("first released");
      await first();
      await (await second)();
      await other();
      expect(order).toEqual(["other", "first released", "second"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a lock left by a run that died expires", async () => {
    const home = mkdtempSync(join(tmpdir(), "awf-lock-"));
    try {
      const lock = workspaceLock(home);
      await lock("awf", "review");
      const dir = join(machinePaths(home).herdr, "locks", "awf");
      const [held] = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir, onlyFiles: false }));
      const old = (Date.now() - 60_000) / 1000;
      utimesSync(join(dir, held!), old, old);
      const started = Date.now();
      await (await lock("awf", "review"))();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
