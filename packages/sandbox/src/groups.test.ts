import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KILL_GROUPS, LaunchedGroups } from "./groups";

const root = mkdtempSync(join(tmpdir(), "wf-groups-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a group whose leader has exited is still killed", async () => {
  const groups = new LaunchedGroups(join(root, "orphaned"));
  const { argv, pidFile } = groups.wrap(["/bin/sh", "-c", "sleep 30 >/dev/null & echo $!"]);
  const leader = Bun.spawn(argv, { detached: true, stdout: "pipe" });
  const member = Number((await new Response(leader.stdout).text()).trim());
  await leader.exited;
  expect(alive(member)).toBe(true);
  await groups.kill(pidFile);
  await Bun.sleep(50);
  expect(alive(member)).toBe(false);
});

test("a pid a newer process has taken is left alone", async () => {
  const groups = new LaunchedGroups(join(root, "reused"));
  const other = Bun.spawn(["sleep", "30"], { detached: true });
  const pidFile = await groups.pidFile();
  await writeFile(pidFile, `${other.pid}\n`);
  const anHourAgo = new Date(Date.now() - 3_600_000);
  await utimes(pidFile, anHourAgo, anHourAgo);
  await groups.kill(pidFile);
  expect(alive(other.pid)).toBe(true);
  other.kill("SIGKILL");
});

test("the in-box kill script takes files and directories, and skips a pid that takes all", async () => {
  const pids = join(root, "pids ' $(x)");
  await mkdir(pids, { recursive: true });
  await writeFile(join(pids, "a"), "1\n");
  await writeFile(join(pids, "b"), "not a pid");
  const single = join(root, "single");
  await writeFile(single, "0\n");
  const ran = Bun.spawnSync(["sh", "-c", KILL_GROUPS, "sh", pids, single]);
  expect(ran.exitCode).toBe(0);
  expect(await readdir(pids)).toEqual([]);
  expect(await Bun.file(single).exists()).toBe(false);
});
