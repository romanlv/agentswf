import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accepted, manifestProblems, PACKAGES } from "./release";

const names = new Set(["@agentswf/contract", "@agentswf/engine", "agentswf"]);

describe("release", () => {
  test("npm took a version when bun publish prints it, or refuses it as already there", () => {
    const took =
      "Tag: latest\nRegistry: https://registry.npmjs.org/\n\n + @agentswf/wf@0.1.0-beta.3\n";
    expect(accepted(took, "@agentswf/wf", "0.1.0-beta.3")).toBe(true);
    const again =
      "error: 403 Forbidden - You cannot publish over the previously published versions: 0.1.0-beta.3.";
    expect(accepted(again, "@agentswf/wf", "0.1.0-beta.3")).toBe(true);
  });

  test("a failed sign-in, or another package's line, is not taken", () => {
    const signIn = "404 Not Found: https://registry.npmjs.org/@agentswf%2fwf\n";
    expect(accepted(signIn, "@agentswf/wf", "0.1.0-beta.3")).toBe(false);
    expect(accepted(" + @agentswf/wf@0.1.0-beta.2", "@agentswf/wf", "0.1.0-beta.3")).toBe(false);
    expect(accepted(" + @agentswf/engine@0.1.0-beta.3", "@agentswf/wf", "0.1.0-beta.3")).toBe(
      false,
    );
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
