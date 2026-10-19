import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { distTag, manifestProblems, PACKAGES } from "./release";

const names = new Set(["@agentswf/contract", "@agentswf/engine", "agentswf"]);

describe("release", () => {
  test("a prerelease goes up under its id, a release under latest", () => {
    expect(distTag("0.1.0-beta.2")).toBe("beta");
    expect(distTag("1.0.0-rc.1")).toBe("rc");
    expect(distTag("1.0.0")).toBe("latest");
  });

  test("a manifest whose siblings are at its own version is fine", () => {
    const manifest = {
      name: "agentswf",
      version: "0.1.0-beta.2",
      dependencies: { "@agentswf/engine": "0.1.0-beta.2", typebox: "^1.3.34" },
    };
    expect(manifestProblems(manifest, "0.1.0-beta.2", names)).toEqual([]);
  });

  test("a sibling at another version, as beta.1 had from a stale bun.lock, stops it", () => {
    const manifest = {
      name: "agentswf",
      version: "0.1.0-beta.1",
      dependencies: { "@agentswf/engine": "0.1.0-beta.0", "@agentswf/contract": "0.1.0-beta.0" },
    };
    expect(manifestProblems(manifest, "0.1.0-beta.1", names)).toEqual([
      "agentswf depends on @agentswf/engine@0.1.0-beta.0, not 0.1.0-beta.1 (is bun.lock's workspace version stale?)",
      "agentswf depends on @agentswf/contract@0.1.0-beta.0, not 0.1.0-beta.1 (is bun.lock's workspace version stale?)",
    ]);
  });

  test("a workspace: range left in, or a manifest at another version, stops it", () => {
    const manifest = {
      name: "@agentswf/engine",
      version: "0.1.0-beta.1",
      dependencies: { "@agentswf/contract": "workspace:*" },
    };
    expect(manifestProblems(manifest, "0.1.0-beta.2", names)).toEqual([
      "@agentswf/engine is 0.1.0-beta.1, not 0.1.0-beta.2",
      "@agentswf/engine has @agentswf/contract at workspace:*, unfilled",
    ]);
  });

  test("every package is released, each after the packages it depends on", () => {
    const manifest = (dir: string) =>
      JSON.parse(
        readFileSync(join(import.meta.dir, "..", "packages", dir, "package.json"), "utf8"),
      );
    const publishable = readdirSync(join(import.meta.dir, "..", "packages")).filter(
      (dir) => !manifest(dir).private,
    );
    expect([...PACKAGES].sort()).toEqual(publishable.sort());
    const byName = new Map(PACKAGES.map((dir) => [manifest(dir).name as string, dir]));
    for (const [index, dir] of PACKAGES.entries())
      for (const dep of Object.keys(manifest(dir).dependencies ?? {})) {
        const at = byName.get(dep);
        if (at) expect(PACKAGES.indexOf(at)).toBeLessThan(index);
      }
  });
});
