import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessResult, RunProcess } from "@agentswf/harness";
import {
  ensureRunSession,
  type RunSessionDeps,
  runSessionName,
  serverEnvironment,
} from "./herdr-run-session";
import { liveness, marksDir, markWorkspace } from "./herdr-workspace-marks";

/** A `herdr` on the operator's `PATH` that a system `PATH` would not find. */
const bin = mkdtempSync(join(tmpdir(), "awf-run-session-bin-"));
writeFileSync(join(bin, "herdr"), "#!/bin/sh\n", { mode: 0o755 });
const homes: string[] = [bin];
afterAll(() => Promise.all(homes.map((home) => rm(home, { recursive: true, force: true }))));

const OPERATOR = {
  HOME: "/Users/op",
  USER: "op",
  LOGNAME: "op",
  SHELL: "/bin/zsh",
  TERM: "xterm-256color",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TMPDIR: "/var/tmp/op",
  PATH: `${bin}:/repo/node_modules/.bin`,
  GH_TOKEN: "secret",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  HERDR_SOCKET_PATH: "/h/herdr.sock",
};

/**
 * A Herdr whose session `awf` is running when `running` is true, or once `startsAfter` polls of
 * a started server, holding `workspaces` and running a stale binary when `stale`; the starts and
 * calls it saw.
 */
function fakeHerdr(options: {
  running?: boolean;
  startsAfter?: number;
  list?: ProcessResult;
  spawnFails?: boolean;
  stale?: boolean;
  workspaces?: { workspace_id: string; label: string }[];
  unreadableWorkspaces?: boolean;
  closeFails?: boolean;
  stopFails?: boolean;
  /** Called on each workspace list, after the first: another run acting meanwhile. */
  onRelist?: () => Promise<void>;
}) {
  const calls: string[] = [];
  const starts: { argv: readonly string[]; cwd: string; env: Record<string, string> }[] = [];
  const workspaces = [...(options.workspaces ?? [])];
  let polls = 0;
  let stale = options.stale === true;
  let running = options.running === true;
  const run: RunProcess = async (input) => {
    const command = input.argv.join(" ");
    calls.push(command);
    if (command === "herdr session list --json") {
      return (
        options.list ??
        result(
          JSON.stringify({
            sessions: [
              { name: "default", running: true },
              { name: "awf", running, session_dir: "/h/sessions/awf" },
              { name: "journal", running: false },
            ],
          }),
        )
      );
    }
    if (command === "herdr session stop awf") {
      if (options.stopFails) return result("", "stop refused", 1);
      running = false;
      stale = false;
      return result("stopped session awf");
    }
    if (command === "herdr --version") return result("herdr 0.9.3\n");
    const [, , , ...args] = input.argv;
    if (args.join(" ") === "status server --json") {
      return result(
        JSON.stringify({ version: stale ? "0.9.1" : "0.9.3", server_binary_stale: stale }),
      );
    }
    if (args[0] === "workspace" && args[1] === "close") {
      if (options.closeFails) return result("", "close refused", 1);
      workspaces.splice(
        workspaces.findIndex((workspace) => workspace.workspace_id === args[2]),
        1,
      );
      return result("{}");
    }
    polls += 1;
    if (polls > 1 && running) await options.onRelist?.();
    if (starts.length > 0 && polls > (options.startsAfter ?? 0)) running = true;
    if (!running) return result("", "server_not_running", 1);
    return result(
      options.unreadableWorkspaces ? "not json" : JSON.stringify({ result: { workspaces } }),
    );
  };
  return {
    run,
    calls,
    starts,
    workspaces,
    start: async (argv: readonly string[], opts: { cwd: string; env: Record<string, string> }) => {
      if (options.spawnFails) throw new Error("spawn ENOENT");
      starts.push({ argv, ...opts });
    },
  };
}

async function deps(
  herdr: ReturnType<typeof fakeHerdr>,
  clock = { t: 0 },
): Promise<RunSessionDeps> {
  const home = await mkdtemp(join(tmpdir(), "awf-run-session-"));
  homes.push(home);
  return {
    run: herdr.run,
    environment: OPERATOR,
    home,
    start: herdr.start,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
  };
}

describe("the run session", () => {
  test("is awf unless AWF_HERDR_SESSION names another; a name Herdr can't use is refused", () => {
    expect(runSessionName({})).toBe("awf");
    expect(runSessionName({ AWF_HERDR_SESSION: "" })).toBe("awf");
    expect(runSessionName({ AWF_HERDR_SESSION: "awf-review" })).toBe("awf-review");
    for (const bad of ["-awf", "Awf", "awf/../x", "a b", "x".repeat(33)]) {
      expect(() => runSessionName({ AWF_HERDR_SESSION: bad })).toThrow("not a Herdr session name");
    }
  });

  test("running, it is used and nothing is started", async () => {
    const herdr = fakeHerdr({ running: true });
    expect(await ensureRunSession("awf", await deps(herdr))).toMatchObject({
      name: "awf",
      started: false,
    });
    expect(herdr.starts).toEqual([]);
    // Listed running may be another run's server still starting: it is asked once it answers.
    expect(herdr.calls).toEqual([
      "herdr session list --json",
      "herdr --session awf workspace list",
      "herdr --session awf status server --json",
    ]);
  });

  test("down and awf's, it is started from the allowlist and the quiet config, and used once it answers", async () => {
    const herdr = fakeHerdr({ startsAfter: 2 });
    const d = await deps(herdr);
    expect(await ensureRunSession("awf-review", d)).toMatchObject({
      name: "awf-review",
      started: true,
    });
    const config = join(d.home, ".awf", "herdr", "config.toml");
    expect(herdr.starts).toEqual([
      {
        argv: [join(bin, "herdr"), "--session", "awf-review", "server"],
        cwd: d.home,
        env: {
          HOME: "/Users/op",
          USER: "op",
          LOGNAME: "op",
          SHELL: "/bin/zsh",
          TERM: "xterm-256color",
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
          TMPDIR: "/var/tmp/op",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HERDR_CONFIG_PATH: config,
        },
      },
    ]);
    expect(await readFile(config, "utf8")).toContain('delivery = "off"');
    expect(await readFile(config, "utf8")).toContain("enabled = false");
    expect(herdr.calls.filter((call) => call.endsWith("workspace list"))).toHaveLength(3);
  });

  test("the quiet config, once there, is the operator's to edit", async () => {
    const herdr = fakeHerdr({});
    const d = await deps(herdr);
    const config = join(d.home, ".awf", "herdr", "config.toml");
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, "# mine\n");
    await ensureRunSession("awf", d);
    expect(await readFile(config, "utf8")).toBe("# mine\n");
  });

  test("down and not awf's, it is refused with the command that starts it", async () => {
    const herdr = fakeHerdr({});
    await expect(ensureRunSession("journal", await deps(herdr))).rejects.toThrow(
      "Herdr session journal is not running, and awf starts only sessions named awf or awf-…; start it with `herdr --session journal server`",
    );
    expect(herdr.starts).toEqual([]);
  });

  test("started but never answering, it fails within ten seconds, naming where to look", async () => {
    const herdr = fakeHerdr({ startsAfter: Number.POSITIVE_INFINITY });
    const clock = { t: 0 };
    await expect(ensureRunSession("awf", await deps(herdr, clock))).rejects.toThrow(
      "Herdr session awf did not answer within 10s; its log is under /h/sessions/awf, and `herdr session attach awf` shows it",
    );
    expect(clock.t).toBe(10_000);
  });

  test("a server that can't be started is said at once, not after the wait", async () => {
    const herdr = fakeHerdr({ spawnFails: true });
    const clock = { t: 0 };
    await expect(ensureRunSession("awf", await deps(herdr, clock))).rejects.toThrow(
      "could not start Herdr session awf: spawn ENOENT",
    );
    expect(clock.t).toBe(0);
  });

  test("herdr not on the operator's PATH starts nothing", async () => {
    const herdr = fakeHerdr({});
    const d = await deps(herdr);
    await expect(
      ensureRunSession("awf", { ...d, environment: { PATH: "/nowhere" } }),
    ).rejects.toThrow("herdr is not on PATH");
    expect(herdr.starts).toEqual([]);
  });

  test("a session list that fails is said, not read as every session down", async () => {
    const herdr = fakeHerdr({ list: result("", "permission denied", 1) });
    await expect(ensureRunSession("awf", await deps(herdr))).rejects.toThrow(
      "herdr session list failed: permission denied",
    );
    expect(herdr.starts).toEqual([]);
  });

  test("nothing of the starting shell's own crosses into the server", () => {
    const env = serverEnvironment(OPERATOR);
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(env).not.toHaveProperty("HERDR_SOCKET_PATH");
    expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    // What moves Herdr's own directory stays, or the server and awf's calls look in two places.
    expect(serverEnvironment({ HERDR_HOME: "/h", XDG_CONFIG_HOME: "/x" })).toMatchObject({
      HERDR_HOME: "/h",
      XDG_CONFIG_HOME: "/x",
    });
  });
});

describe("keeping the run session", () => {
  const LIVE = 101;
  const DEAD = 202;
  const REUSED = 303;
  const UNSEEN = 404;
  const STARTED = new Date(1_000_000).toISOString();
  /** `LIVE` is the process its mark says; `REUSED` is another holding its pid; `UNSEEN`, `ps` can't see. */
  const probe = (pid: number) =>
    pid === LIVE || pid === process.pid
      ? STARTED
      : pid === REUSED
        ? new Date(9_000_000).toISOString()
        : undefined;
  const exists = (pid: number) => pid !== DEAD;

  async function mark(home: string, label: string, pid: number, workspaceId?: string) {
    const file = join(marksDir(home, "awf"), `${pid}-${Math.random().toString(16).slice(2)}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ version: 1, label, pid, processStart: STARTED, workspaceId }),
    );
    return file;
  }

  async function kept(herdr: ReturnType<typeof fakeHerdr>) {
    return { ...(await deps(herdr)), probe, exists };
  }

  test("a run is dead only when its process is gone or another holds its pid", () => {
    const at = (pid: number) => liveness({ pid, processStart: STARTED }, probe, exists);
    expect([LIVE, DEAD, REUSED, UNSEEN].map(at)).toEqual(["live", "dead", "dead", "unknown"]);
  });

  test("stale and empty, awf's session is restarted", async () => {
    const herdr = fakeHerdr({ running: true, stale: true });
    const result = await ensureRunSession("awf", await kept(herdr));
    expect(result).toEqual({
      name: "awf",
      started: true,
      restartedFrom: "0.9.1",
      closed: [],
      unclaimed: [],
    });
    expect(herdr.calls).toContain("herdr session stop awf");
    expect(herdr.starts).toHaveLength(1);
  });

  test("stale with a workspace open, it is named once and used", async () => {
    const herdr = fakeHerdr({
      running: true,
      stale: true,
      workspaces: [{ workspace_id: "w1", label: "notes" }],
    });
    const result = await ensureRunSession("awf", await kept(herdr));
    expect(result).toMatchObject({
      started: false,
      stale: { server: "0.9.1", installed: "0.9.3" },
    });
    expect(herdr.calls).not.toContain("herdr session stop awf");
  });

  test("stale, but a run marks its workspace before the stop, so it is not restarted", async () => {
    let d: RunSessionDeps | undefined;
    const herdr = fakeHerdr({
      running: true,
      stale: true,
      onRelist: async () => {
        await mark(d!.home, "awf review r1 #1", LIVE);
      },
    });
    d = await kept(herdr);
    const result = await ensureRunSession("awf", d);
    expect(result.stale).toEqual({ server: "0.9.1", installed: "0.9.3" });
    expect(herdr.calls).not.toContain("herdr session stop awf");
  });

  test("a stop that fails leaves it named stale, not said restarted", async () => {
    const herdr = fakeHerdr({ running: true, stale: true, stopFails: true });
    const result = await ensureRunSession("awf", await kept(herdr));
    expect(result).toMatchObject({ started: false, stale: { server: "0.9.1" } });
    expect(result.restartedFrom).toBeUndefined();
    expect(herdr.starts).toEqual([]);
  });

  test("stale and not named awf, it is named and used, never restarted", async () => {
    const list = result(
      JSON.stringify({ sessions: [{ name: "mine", running: true, session_dir: "/h/mine" }] }),
    );
    const mine = fakeHerdr({ running: true, stale: true, list });
    const found = await ensureRunSession("mine", await kept(mine));
    expect(found.stale).toEqual({ server: "0.9.1", installed: "0.9.3" });
    expect(mine.calls.some((call) => call.startsWith("herdr session stop"))).toBe(false);
  });

  test("a workspace whose run ended is closed; a live, reused-pid-free or unseen run's is kept; one no run claims is named and kept", async () => {
    const herdr = fakeHerdr({
      running: true,
      workspaces: [
        { workspace_id: "w1", label: "awf review r1 #1" },
        { workspace_id: "w2", label: "awf review r2 #1" },
        { workspace_id: "w3", label: "awf review r3 #1" },
        { workspace_id: "w4", label: "notes" },
        { workspace_id: "w5", label: "awf review r5 #1" },
        { workspace_id: "w6", label: "awf review r6 #1" },
      ],
    });
    const d = await kept(herdr);
    const dead = await mark(d.home, "awf review r1 #1", DEAD, "w1");
    await mark(d.home, "awf review r2 #1", LIVE, "w2");
    const reused = await mark(d.home, "awf review r5 #1", REUSED, "w5");
    const unseen = await mark(d.home, "awf review r6 #1", UNSEEN, "w6");
    // A run that died after its workspace was closed by hand, and one that died before it made one.
    const gone = await mark(d.home, "awf review r9 #1", DEAD, "w9");
    const early = await mark(d.home, "awf review r8 #1", DEAD);
    const result = await ensureRunSession("awf", d);
    expect(result.closed).toEqual(["awf review r1 #1", "awf review r5 #1"]);
    expect(result.unclaimed).toEqual([{ id: "w3", label: "awf review r3 #1" }]);
    expect(herdr.workspaces.map((workspace) => workspace.workspace_id)).toEqual([
      "w2",
      "w3",
      "w4",
      "w6",
    ]);
    for (const file of [dead, gone, reused, early]) {
      expect(await Bun.file(file).exists()).toBe(false);
    }
    expect(await Bun.file(unseen).exists()).toBe(true);
  });

  test("two projects' runs with one label: only the dead run's own workspace is closed", async () => {
    const label = "awf review pr-12 #1";
    const herdr = fakeHerdr({
      running: true,
      workspaces: [
        { workspace_id: "w1", label },
        { workspace_id: "w2", label },
      ],
    });
    const d = await kept(herdr);
    await mark(d.home, label, DEAD, "w1");
    await mark(d.home, label, LIVE, "w2");
    expect((await ensureRunSession("awf", d)).closed).toEqual([label]);
    expect(herdr.workspaces.map((workspace) => workspace.workspace_id)).toEqual(["w2"]);
  });

  test("a dead run's mark with no workspace of its own closes nothing of another's with its label", async () => {
    const label = "awf review pr-12 #1";
    const herdr = fakeHerdr({ running: true, workspaces: [{ workspace_id: "w2", label }] });
    const d = await kept(herdr);
    // Killed before its first pane: marked, never given a workspace.
    const early = await mark(d.home, label, DEAD);
    // Another project's run, unmarked: its `ps` could not see itself.
    const result = await ensureRunSession("awf", d);
    expect(result.closed).toEqual([]);
    expect(herdr.workspaces).toHaveLength(1);
    expect(await Bun.file(early).exists()).toBe(false);
  });

  test("a live run between its mark and its workspace's id is not named as nobody's", async () => {
    const label = "awf review r1 #1";
    const herdr = fakeHerdr({ running: true, workspaces: [{ workspace_id: "w1", label }] });
    const d = await kept(herdr);
    await mark(d.home, label, LIVE);
    const result = await ensureRunSession("awf", d);
    expect(result).toMatchObject({ closed: [], unclaimed: [] });
  });

  test("a workspace that won't close keeps its mark, for the next run to try", async () => {
    const herdr = fakeHerdr({
      running: true,
      closeFails: true,
      workspaces: [{ workspace_id: "w1", label: "awf review r1 #1" }],
    });
    const d = await kept(herdr);
    const dead = await mark(d.home, "awf review r1 #1", DEAD, "w1");
    expect((await ensureRunSession("awf", d)).closed).toEqual([]);
    expect(await Bun.file(dead).exists()).toBe(true);
  });

  test("closing its orphans can leave a stale session empty, and then it is restarted", async () => {
    const herdr = fakeHerdr({
      running: true,
      stale: true,
      workspaces: [{ workspace_id: "w1", label: "awf review r1 #1" }],
    });
    const d = await kept(herdr);
    await mark(d.home, "awf review r1 #1", DEAD, "w1");
    const result = await ensureRunSession("awf", d);
    expect(result).toMatchObject({ started: true, closed: ["awf review r1 #1"] });
  });

  test("a workspace list it can't read closes nothing and restarts nothing", async () => {
    const herdr = fakeHerdr({ running: true, stale: true, unreadableWorkspaces: true });
    const result = await ensureRunSession("awf", await kept(herdr));
    expect(result).toMatchObject({ started: false, stale: { server: "0.9.1" } });
    expect(herdr.calls).not.toContain("herdr session stop awf");
  });

  test("a run's mark is there while its workspace is, and gone once released; one that can't be written fails nothing", async () => {
    const herdr = fakeHerdr({});
    const d = await deps(herdr);
    const held = await markWorkspace(d.home, "awf", "awf review r1 #1", probe);
    const read = async () => {
      const [file] = await readdir(marksDir(d.home, "awf"));
      return JSON.parse(await readFile(join(marksDir(d.home, "awf"), file!), "utf8"));
    };
    const mark = { version: 1, label: "awf review r1 #1", pid: process.pid, processStart: STARTED };
    expect(await read()).toEqual(mark);
    await held.bind("w7");
    expect(await read()).toEqual({ ...mark, workspaceId: "w7" });
    await held.release();
    expect(await readdir(marksDir(d.home, "awf"))).toEqual([]);
    // A home that is a file: nothing can be made under it.
    const blocked = join(d.home, "file-home");
    await writeFile(blocked, "");
    const unwritten = await markWorkspace(blocked, "awf", "awf review r2 #1", probe);
    await unwritten.bind("w8");
    await unwritten.release();
  });
});

function result(stdout: string, stderr = "", exitCode = 0): ProcessResult {
  return { stdout, stderr, exitCode, timedOut: false };
}
