import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accepted,
  bumpLock,
  changelogSection,
  contentProblems,
  cutRelease,
  distTag,
  manifestProblems,
  PACKAGES,
} from "./release";

const names = new Set(["@agentswf/contract", "@agentswf/engine", "agentswf"]);

describe("release", () => {
  test("npm took a version when bun publish prints it, or refuses it as already there", () => {
    const took =
      "Tag: latest\nRegistry: https://registry.npmjs.org/\n\n + @agentswf/harness@0.1.0-beta.3\n";
    expect(accepted(took, "@agentswf/harness", "0.1.0-beta.3")).toBe(true);
    const again =
      "error: 403 Forbidden - You cannot publish over the previously published versions: 0.1.0-beta.3.";
    expect(accepted(again, "@agentswf/harness", "0.1.0-beta.3")).toBe(true);
  });

  test("a failed sign-in, or another package's line, is not taken", () => {
    const signIn = "404 Not Found: https://registry.npmjs.org/@agentswf%2fharness\n";
    expect(accepted(signIn, "@agentswf/harness", "0.1.0-beta.3")).toBe(false);
    expect(accepted(" + @agentswf/harness@0.1.0-beta.2", "@agentswf/harness", "0.1.0-beta.3")).toBe(
      false,
    );
    expect(accepted(" + @agentswf/engine@0.1.0-beta.3", "@agentswf/harness", "0.1.0-beta.3")).toBe(
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

  test("a prerelease goes under latest only until a stable version exists", () => {
    const betas = ["0.0.0-stage", "0.1.0-beta.0", "0.1.0-beta.5"];
    expect(distTag("0.1.0-beta.6", betas)).toBe("latest");
    expect(distTag("0.1.0", betas)).toBe("latest");
    const stable = [...betas, "0.1.0"];
    expect(distTag("0.2.0-beta.0", stable)).toBe("beta");
    expect(distTag("0.2.0-rc.1", stable)).toBe("rc");
    expect(distTag("1.0.0-0", stable)).toBe("next");
    expect(distTag("0.1.1", stable)).toBe("latest");
  });

  test("a tarball without its README or LICENSE, or with a test in it, stops it", () => {
    const fine = [
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
      "package/src/a.ts",
    ];
    expect(contentProblems("agentswf", fine)).toEqual([]);
    expect(
      contentProblems("agentswf", [
        "package/package.json",
        "package/src/a.test.ts",
        "package/src/a.typecheck.ts",
        "package/src/hold.fixture.ts",
        "package/src/fixtures/x.json",
      ]),
    ).toEqual([
      "agentswf lacks README.md",
      "agentswf lacks LICENSE",
      "agentswf ships src/a.test.ts",
      "agentswf ships src/a.typecheck.ts",
      "agentswf ships src/hold.fixture.ts",
      "agentswf ships src/fixtures/x.json",
    ]);
  });

  test("every package is released, each after the packages it depends on", () => {
    const manifest = (dir: string) =>
      JSON.parse(
        readFileSync(join(import.meta.dir, "..", "packages", dir, "package.json"), "utf8"),
      );
    // A directory without a manifest, such as one a rename left holding node_modules, is no package.
    const publishable = readdirSync(join(import.meta.dir, "..", "packages")).filter(
      (dir) =>
        existsSync(join(import.meta.dir, "..", "packages", dir, "package.json")) &&
        !manifest(dir).private,
    );
    expect([...PACKAGES].sort()).toEqual(publishable.sort());
    const byName = new Map(PACKAGES.map((dir) => [manifest(dir).name as string, dir]));
    for (const [index, dir] of PACKAGES.entries())
      for (const dep of Object.keys(manifest(dir).dependencies ?? {})) {
        const at = byName.get(dep);
        if (at) expect(PACKAGES.indexOf(at)).toBeLessThan(index);
      }
  });
  const changelog = [
    "# Changelog",
    "",
    "## Unreleased",
    "",
    "### Added",
    "",
    "- `awf open`.",
    "",
    "## 0.1.0 — 2026-11-06",
    "",
    "The first stable release.",
    "",
  ].join("\n");

  test("a version's notes are its section of the changelog, dated or not", () => {
    expect(changelogSection(changelog, "0.1.0")).toBe("The first stable release.");
    expect(changelogSection(changelog, "Unreleased")).toBe("### Added\n\n- `awf open`.");
    expect(changelogSection(changelog, "0.1")).toBeUndefined();
    expect(changelogSection(changelog, "0.2.0")).toBeUndefined();
  });

  test("preparing a version moves Unreleased's notes under it, dated, and empties Unreleased", () => {
    const cut = cutRelease(changelog, "0.2.0", "2026-12-01");
    expect(cut).toContain(
      "## Unreleased\n\n## 0.2.0 — 2026-12-01\n\n### Added\n\n- `awf open`.\n\n## 0.1.0",
    );
    expect(changelogSection(cut, "Unreleased")).toBe("");
    expect(changelogSection(cut, "0.2.0")).toBe("### Added\n\n- `awf open`.");
    expect(changelogSection(cut, "0.1.0")).toBe("The first stable release.");
  });

  test("a version without notes, or one already in the changelog, is not prepared", () => {
    const cut = cutRelease(changelog, "0.2.0", "2026-12-01");
    expect(() => cutRelease(cut, "0.3.0", "2026-12-02")).toThrow("Unreleased is empty");
    expect(() => cutRelease(changelog, "0.1.0", "2026-12-02")).toThrow("already has ## 0.1.0");
    expect(() => cutRelease("# Changelog\n", "0.2.0", "2026-12-02")).toThrow("no ## Unreleased");
  });

  test("bun.lock's workspace versions follow the manifests, which bun install leaves stale", () => {
    const lock = readFileSync(join(import.meta.dir, "..", "bun.lock"), "utf8");
    const names = PACKAGES.map(
      (dir) =>
        JSON.parse(
          readFileSync(join(import.meta.dir, "..", "packages", dir, "package.json"), "utf8"),
        ).name as string,
    );
    const bumped = bumpLock(lock, names, "9.9.9");
    for (const name of names)
      expect(bumped).toContain(`"name": "${name}",\n      "version": "9.9.9"`);
    expect(bumped.split("\n").length).toBe(lock.split("\n").length);
    expect(() => bumpLock(lock, ["@agentswf/missing"], "9.9.9")).toThrow("no workspace entry");
  });

  test("the changelog has notes for the version the manifests are at", () => {
    const { version } = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "packages", "agentswf", "package.json"), "utf8"),
    );
    const text = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8");
    expect(changelogSection(text, version)).toBeTruthy();
    expect(changelogSection(text, "Unreleased")).toBeDefined();
  });
});
