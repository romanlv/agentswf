import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessResult, RunProcess } from "@agentswf/harness";
import {
  ensureRunSession,
  type RunSessionDeps,
  runSessionName,
  serverEnvironment,
} from "./herdr-run-session";

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
 * A Herdr whose session `name` is running when `running` is true, or once `startsAfter` polls of
 * a started server; the starts and calls it saw.
 */
function fakeHerdr(options: {
  running?: boolean;
  startsAfter?: number;
  list?: ProcessResult;
  spawnFails?: boolean;
}) {
  const calls: string[] = [];
  const starts: { argv: readonly string[]; cwd: string; env: Record<string, string> }[] = [];
  let polls = 0;
  const run: RunProcess = async (input) => {
    calls.push(input.argv.join(" "));
    if (input.argv.join(" ") === "herdr session list --json") {
      return (
        options.list ??
        result(
          JSON.stringify({
            sessions: [
              { name: "default", running: true },
              {
                name: "awf",
                running: options.running === true,
                session_dir: "/h/sessions/awf",
              },
              { name: "journal", running: false },
            ],
          }),
        )
      );
    }
    polls += 1;
    const up =
      options.running === true || (starts.length > 0 && polls > (options.startsAfter ?? 0));
    return up ? result("{}") : result("", "server_not_running", 1);
  };
  return {
    run,
    calls,
    starts,
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
    expect(await ensureRunSession("awf", await deps(herdr))).toEqual({
      name: "awf",
      started: false,
    });
    expect(herdr.starts).toEqual([]);
    // Listed running may be another run's server still starting: it is asked once it answers.
    expect(herdr.calls).toEqual([
      "herdr session list --json",
      "herdr --session awf workspace list",
    ]);
  });

  test("down and awf's, it is started from the allowlist and the quiet config, and used once it answers", async () => {
    const herdr = fakeHerdr({ startsAfter: 2 });
    const d = await deps(herdr);
    expect(await ensureRunSession("awf-review", d)).toEqual({ name: "awf-review", started: true });
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

function result(stdout: string, stderr = "", exitCode = 0): ProcessResult {
  return { stdout, stderr, exitCode, timedOut: false };
}
