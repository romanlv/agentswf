import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunProcess } from "../command";
import { callingSession, findSession } from "./fork";

const saved = { ...process.env };
const made: string[] = [];
afterEach(async () => {
  for (const name of ["CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "awf-found-"));
  made.push(path);
  return path;
}

/** A pi session as pi writes it: its header, then an assistant message on `provider`'s model. */
async function piSession(id: string, cwd: string): Promise<string> {
  const home = await temporary();
  process.env.PI_CODING_AGENT_DIR = home;
  const directory = join(home, "sessions", "--work--");
  await mkdir(directory, { recursive: true });
  const rows = [
    { type: "session", id, cwd, timestamp: "2026-10-06T12:00:00.000Z" },
    {
      type: "message",
      id: "m1",
      timestamp: "2026-10-06T12:01:00.000Z",
      message: {
        role: "assistant",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
        usage: { input: 1, output: 1 },
      },
    },
  ];
  await writeFile(
    join(directory, `2026-10-06T12-00-00_${id}.jsonl`),
    rows.map((row) => JSON.stringify(row)).join("\n"),
  );
  return home;
}

const neverRun: RunProcess = () => {
  throw new Error("nothing is run");
};

describe("findSession", () => {
  test("finds a session by its id, with the directory its file records and when it was written", async () => {
    await piSession("p1", "/work/pi");
    const found = await findSession("pi", "p1", "/somewhere/else");
    expect(found?.cwd).toBe("/work/pi");
    expect(Date.now() - found!.writtenAt).toBeLessThan(60_000);
  });

  test("a claude session's directory is its rows', not where awf run was typed", async () => {
    const home = await temporary();
    process.env.CLAUDE_CONFIG_DIR = home;
    const directory = join(home, "projects", "-work-app");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "c1.jsonl"),
      [
        { type: "user", cwd: "/work/app", sessionId: "c1" },
        { type: "assistant", cwd: "/work/app/sub", sessionId: "c1" },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    expect((await findSession("claude", "c1", "/elsewhere"))?.cwd).toBe("/work/app/sub");
  });

  test("a session that is not in the operator's home is not found", async () => {
    await piSession("p1", "/work/pi");
    expect(await findSession("pi", "p2", "/work/pi")).toBeUndefined();
  });
});

describe("callingSession", () => {
  test("a fork runs on pi's last model with its provider, and is copied into another home", async () => {
    await piSession("p1", "/work/pi");
    const into = await temporary();
    const calling = callingSession({ harness: "pi", session: "p1", cwd: "/work/pi" }, neverRun);
    const fork = await calling.fork({ unixMilliseconds: Date.now() + 10_000 }, { directory: into });
    expect(fork).toEqual({
      harness: "pi",
      sessionRef: "p1",
      copied: true,
      model: "openai-codex/gpt-5.6-terra",
    });
    expect(await readdir(join(into, "sessions", "--work--"))).toEqual([
      "2026-10-06T12-00-00_p1.jsonl",
    ]);
  });

  test("a fork the run stopped is cancelled before it copies anything", async () => {
    await piSession("p1", "/work/pi");
    const into = await temporary();
    const calling = callingSession({ harness: "pi", session: "p1", cwd: "/work/pi" }, neverRun);
    await expect(
      calling.fork(
        { unixMilliseconds: Date.now() + 10_000 },
        { directory: join(into, "copy") },
        AbortSignal.abort(),
      ),
    ).rejects.toThrow("the fork was cancelled");
    expect(await readdir(into)).toEqual([]);
  });

  test("waits for the session to settle first where it is given a wait", async () => {
    await piSession("p1", "/work/pi");
    const into = await temporary();
    const calling = callingSession(
      { harness: "pi", session: "p1", cwd: "/work/pi" },
      neverRun,
      async () => {
        throw new Error("the calling session did not settle before its fork: busy");
      },
    );
    await expect(
      calling.fork({ unixMilliseconds: Date.now() + 10_000 }, { directory: into }),
    ).rejects.toThrow("did not settle");
  });
});
