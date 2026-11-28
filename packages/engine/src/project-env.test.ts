import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envEntries, loadProjectEnv } from "./project-env";

describe("the project's .env", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-env-")));
  const repo = join(root, "repo");
  const deep = join(repo, "evals", "set");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(deep, { recursive: true });

  test("the nearest up to the repository's root; what is already set wins", () => {
    writeFileSync(join(repo, ".env"), "TOKEN=from-file\nexport OTHER='quoted'\n# NOTE=skipped\n");
    const environment: Record<string, string | undefined> = { TOKEN: "from-shell" };
    expect(loadProjectEnv(deep, environment)).toBe(join(repo, ".env"));
    expect(environment).toEqual({ TOKEN: "from-shell", OTHER: "quoted" });
  });

  test("never above the repository's root", () => {
    writeFileSync(join(root, ".env"), "OUTSIDE=1\n");
    const inner = join(root, "other");
    mkdirSync(join(inner, ".git"), { recursive: true });
    const environment: Record<string, string | undefined> = {};
    expect(loadProjectEnv(inner, environment)).toBeUndefined();
    expect(environment).toEqual({});
  });

  test("lines", () => {
    expect(envEntries('A=1\n  export B = "two words"\nnot a line\nC=\n')).toEqual([
      ["A", "1"],
      ["B", "two words"],
      ["C", ""],
    ]);
  });
});
