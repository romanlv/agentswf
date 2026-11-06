import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panePrelude } from "./pane";

const root = realpathSync(mkdtempSync(join(tmpdir(), "awf-pane-")));
afterAll(() => rm(root, { recursive: true, force: true }));

// A pane's shell is zsh, which every Mac has; the docker image carries it too.
describe.skipIf(!existsSync("/bin/zsh"))("a pane's zsh", () => {
  test("shows its prompt only once zsh draws it, through a non-interactive bash", async () => {
    const pidFile = join(root, "pane", "pid");
    const secretsFile = join(root, "pane.secrets");
    await writeFile(secretsFile, "PANE_TOKEN='pane-secret'\n");
    // srt runs its command through `bash -c`, which drops an inherited `PS1`.
    const pane = panePrelude({
      environment: { PATH: "/usr/bin:/bin", HOME: root },
      pidFile,
      secretsFile,
      through: ["/bin/bash", "-c", 'exec "$@"', "bash"],
    });
    expect(pane.prelude).not.toContain(pane.ready.trimEnd());
    let shown = "";
    const process = Bun.spawn(["/bin/sh", "-c", pane.prelude], {
      cwd: root,
      terminal: {
        cols: 200,
        rows: 50,
        data: (_terminal, data) => {
          shown += new TextDecoder().decode(data);
        },
      },
    });
    const until = async (seen: () => boolean) => {
      for (let tries = 0; tries < 100 && !seen(); tries++) await Bun.sleep(50);
      return seen();
    };
    try {
      expect(await until(() => shown.includes(pane.ready))).toBe(true);
      expect(existsSync(secretsFile)).toBe(false);
      expect((await readFile(pidFile, "utf8")).trim()).toMatch(/^\d+$/);
      process.terminal!.write('echo "token=$PANE_TOKEN shell=$0"\n');
      expect(await until(() => shown.includes("token=pane-secret shell=/bin/zsh"))).toBe(true);
      process.terminal!.write("exit\n");
      expect(await process.exited).toBe(0);
    } finally {
      process.kill("SIGKILL");
      process.terminal?.close();
    }
  });
});
