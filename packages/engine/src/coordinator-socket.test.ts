import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WIRE_VERSION } from "@agentswf/contract/wire";
import {
  coordinatorSocket,
  coordinatorSocketPath,
  liveCoordinatorSocket,
  prepareCoordinatorDir,
} from "./coordinator-socket";
import type { HolderRequest } from "./messaging/messaging";
import type { RunStatus } from "./run-state";
import { createTempRunDirs, exchange } from "./testing";

const runDirs = createTempRunDirs();
const folders: string[] = [];
afterAll(async () => {
  runDirs.cleanup();
  await Promise.all(folders.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A coordinator folder short enough for `sun_path`, as `~/.awf/coordinator` is. */
async function folder(): Promise<string> {
  const dir = join(
    "/tmp",
    `awf-coord-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
  );
  folders.push(dir);
  await prepareCoordinatorDir(dir, runDirs.tempRunDir());
  return dir;
}

describe("the coordinator socket", () => {
  test("a run directory past sun_path's 104 bytes still gets a socket, which answers a holder", async () => {
    const dir = await folder();
    const runDir = join(runDirs.tempRunDir(), "a".repeat(80), "b".repeat(80), "investigate", "r1");
    const path = coordinatorSocketPath(dir, runDir);
    expect(Buffer.byteLength(path)).toBeLessThan(104);
    const asked: HolderRequest[] = [];
    const socket = coordinatorSocket({ dir, runDir, attempt: 2, failed: () => undefined });
    socket.attach({
      reply: async (request) => {
        asked.push(request);
        return request.to === 4
          ? { code: "delivered", message: 4 }
          : { code: "expired", error: "not open" };
      },
      send: async () => ({ code: "delivered", message: 9 }),
      open: () => [],
    });
    socket.recorded({ kind: "participant-connected", participant: "coordinator" });
    await Bun.sleep(50);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const request = (body: object) =>
      exchange(path, `${JSON.stringify({ version: WIRE_VERSION, ...body })}\n`).then(
        (line) => JSON.parse(line) as unknown,
      );
    expect(
      await request({ command: "reply", agent: "investigator", to: "2.4", text: "Keep two." }),
    ).toEqual({ v: 2, code: "delivered", id: "2.4" });
    // Another attempt's question ended with it: refused here, never asked of this one.
    expect(
      await request({ command: "reply", agent: "investigator", to: "1.4", text: "Keep two." }),
    ).toEqual({
      v: 2,
      code: "expired",
      error: "1.4 is a question of attempt 1, which has ended; the run is on attempt 2.",
    });
    expect(await request({ command: "send", agent: "investigator", text: "Also…" })).toEqual({
      v: 2,
      code: "delivered",
      id: "2.9",
    });
    expect(asked.map((each) => [each.to, each.via])).toEqual([[4, "command"]]);
    // An awf of another wire version is told both, which an older awf send prints as it is.
    expect(
      await exchange(
        path,
        `${JSON.stringify({ version: 5, command: "send", agent: "investigator", text: "Hi" })}\n`,
      ).then((line) => JSON.parse(line) as unknown),
    ).toEqual({
      v: 2,
      code: "unsupported-version",
      error: `this awf speaks wire version 5 and the run's engine ${WIRE_VERSION}: awf was installed anew while the run was live. Reach it with the awf it started with, or let it end and continue it under this one.`,
    });
    expect(asked).toHaveLength(1);
    await socket.close();
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("a stale socket is replaced when the run opens, and never trusted once the run is gone", async () => {
    const dir = await folder();
    const runDir = runDirs.tempRunDir();
    const path = coordinatorSocketPath(dir, runDir);
    await writeFile(path, "left by a killed run");
    const status = (state: RunStatus["state"]) =>
      ({ state, run: { dir: runDir } }) as Pick<RunStatus, "state" | "run">;
    expect(await liveCoordinatorSocket(dir, status("interrupted"))).toBeUndefined();
    const socket = coordinatorSocket({ dir, runDir, attempt: 1, failed: () => undefined });
    socket.recorded({ kind: "participant-connected", participant: "coordinator" });
    await Bun.sleep(50);
    expect(await liveCoordinatorSocket(dir, status("running"))).toBe(path);
    await socket.close();
    expect(await liveCoordinatorSocket(dir, status("running"))).toBeUndefined();
  });

  test("the folder is the operator's alone, and refused inside the workflow's directory", async () => {
    const workflow = runDirs.tempRunDir();
    await mkdir(join(workflow, "..cache"), { recursive: true });
    for (const dir of [join(workflow, ".coord"), workflow, join(workflow, "..cache", "coord")])
      await expect(prepareCoordinatorDir(dir, workflow)).rejects.toThrow(
        "inside the workflow's directory",
      );
    const through = join(runDirs.tempRunDir(), "via");
    await symlink(workflow, through);
    await expect(prepareCoordinatorDir(join(through, "coord"), workflow)).rejects.toThrow(
      "inside the workflow's directory",
    );
    await expect(prepareCoordinatorDir("relative/coord", workflow)).rejects.toThrow(
      "not an absolute path",
    );
    const outside = join(runDirs.tempRunDir(), "coordinator");
    await prepareCoordinatorDir(outside, workflow);
    expect((await stat(outside)).mode & 0o777).toBe(0o700);
  });
});
