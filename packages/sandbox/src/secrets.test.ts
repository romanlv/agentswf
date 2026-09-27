import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxContext } from "./seam";
import { removeSecrets, secretsDirectory, shellQuote, writeSecrets } from "./secrets";

const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-secrets-")));
afterAll(() => rm(root, { recursive: true, force: true }));

let sandboxes = 0;
function context(): SandboxContext {
  return {
    runRoot: root,
    directory: join(root, `s${++sandboxes}`),
    deadline: { unixMilliseconds: Date.now() + 60_000 },
  };
}

describe("a pane's secrets", () => {
  test("are a file of the operator's alone, beside the sandbox's directory, that a shell sources", async () => {
    const sandbox = context();
    const token = `a'b"c$d\`e`;
    const path = await writeSecrets(sandbox, "p1", { TOKEN: token });
    expect(path.startsWith(`${sandbox.directory}.secrets/`)).toBe(true);
    expect(secretsDirectory(sandbox)).toBe(`${sandbox.directory}.secrets`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(secretsDirectory(sandbox))).mode & 0o777).toBe(0o700);
    const sourced = Bun.spawnSync(["/bin/sh", "-c", `. ${shellQuote(path)}; printf %s "$TOKEN"`]);
    expect(sourced.stdout.toString()).toBe(token);
    await removeSecrets(sandbox);
    expect(await stat(secretsDirectory(sandbox)).catch(() => undefined)).toBeUndefined();
  });

  test("never follow or reuse what was planted at their path", async () => {
    const sandbox = context();
    const victim = join(root, "victim");
    await writeFile(victim, "operator's\n");
    await mkdir(secretsDirectory(sandbox), { mode: 0o700 });
    await symlink(victim, join(secretsDirectory(sandbox), "p1"));
    await expect(writeSecrets(sandbox, "p1", { TOKEN: "t" })).rejects.toThrow();
    expect(await readFile(victim, "utf8")).toBe("operator's\n");

    const linked = context();
    await symlink(root, secretsDirectory(linked));
    await expect(writeSecrets(linked, "p1", { TOKEN: "t" })).rejects.toThrow("not a private");

    const open = context();
    await mkdir(secretsDirectory(open));
    await chmod(secretsDirectory(open), 0o755);
    await expect(writeSecrets(open, "p1", { TOKEN: "t" })).rejects.toThrow("not a private");
  });

  test("refuse a name no shell would take as a variable", async () => {
    await expect(writeSecrets(context(), "p1", { "A;rm": "t" })).rejects.toThrow(
      "not an environment variable name",
    );
  });
});

describe("shellQuote", () => {
  test.each(["plain", "", "it's", "=cmd", "a b", "$HOME", "`x`", "-c", "%#"])(
    "passes %p to a shell as one word, unchanged",
    (value) => {
      const echoed = Bun.spawnSync(["/bin/zsh", "-fc", `printf '%s\\0' ${shellQuote(value)}`]);
      expect(echoed.stdout.toString()).toBe(`${value}\0`);
    },
  );
});
