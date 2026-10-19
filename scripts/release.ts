/**
 * Publishes every package at the version their manifests share, so that a release either goes up
 * whole or says what is missing.
 *
 * `bun publish` exits 0 when npm's sign-in times out, and fills `workspace:*` from `bun.lock`'s
 * workspace versions, which `bun install` doesn't update; 0.1.0-beta.1 went up depending on beta.0,
 * and 0.1.0-beta.2 without engine and wf. So every tarball is packed and read before anything is
 * published, each one published is looked for on the registry afterwards, and a package already
 * there is skipped: running it again finishes a release that stopped.
 *
 *   bun run release             # publish what isn't on npm yet
 *   bun run release --dry-run   # pack and check, publish nothing
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

/** In dependency order: a package goes up only after the ones it depends on. */
export const PACKAGES = ["contract", "sandbox", "harness", "wf", "engine", "agentswf"];

const ROOT = resolve(import.meta.dir, "..");
const REGISTRY = "https://registry.npmjs.org";
const APPEAR_MS = 120_000;

type Manifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};

/** The dist-tag a version goes up under: its prerelease id (`beta` for 0.1.0-beta.2), else latest. */
export const distTag = (version: string): string =>
  /^\d+\.\d+\.\d+-([a-z]+)/i.exec(version)?.[1] ?? "latest";

/**
 * What is wrong with a packed manifest: a `workspace:` left in, or a sibling at another version.
 * Siblings are the names in `names`; every one must be exactly `version`.
 */
export const manifestProblems = (
  manifest: Manifest,
  version: string,
  names: ReadonlySet<string>,
): string[] => {
  const problems: string[] = [];
  if (manifest.version !== version) problems.push(`is ${manifest.version}, not ${version}`);
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (range.startsWith("workspace:")) problems.push(`has ${dep} at ${range}, unfilled`);
    else if (names.has(dep) && range !== version)
      problems.push(
        `depends on ${dep}@${range}, not ${version} (is bun.lock's workspace version stale?)`,
      );
  }
  return problems.map((problem) => `${manifest.name} ${problem}`);
};

const fail = (message: string): never => {
  console.error(`release: ${message}`);
  process.exit(1);
};

const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"));

/** The versions npm has of a package; none for a package it has never seen. */
const publishedVersions = async (name: string): Promise<Set<string>> => {
  const response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, {
    headers: { "cache-control": "no-cache" },
  });
  if (response.status === 404) return new Set();
  if (!response.ok) return fail(`the registry answered ${response.status} for ${name}`);
  const body = (await response.json()) as { versions?: Record<string, unknown> };
  return new Set(Object.keys(body.versions ?? {}));
};

/** Packs a package into `out` and returns the tarball's path and the manifest inside it. */
const pack = async (dir: string, out: string): Promise<{ tarball: string; manifest: Manifest }> => {
  const packed = await $`bun pm pack --destination ${out} --quiet`
    .cwd(join(ROOT, "packages", dir))
    .quiet()
    .nothrow();
  if (packed.exitCode !== 0) fail(`packing ${dir} failed: ${packed.stderr.toString().trim()}`);
  // --quiet prints the tarball alone, as a path in --destination.
  const tarball = resolve(out, packed.stdout.toString().trim().split("\n").at(-1)!.trim());
  const manifest = JSON.parse(await $`tar -xOf ${tarball} package/package.json`.text());
  return { tarball, manifest };
};

const main = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const manifests = PACKAGES.map(readManifest);
  const version = manifests[0]!.version;
  const odd = manifests.filter((manifest) => manifest.version !== version);
  if (odd.length > 0)
    fail(`versions differ: ${manifests.map((m) => `${m.name}@${m.version}`).join(", ")}`);
  const dirty = (await $`git status --porcelain -- packages bun.lock`.cwd(ROOT).text()).trim();
  if (dirty && !dryRun) fail(`commit these first, so the release is what git has:\n${dirty}`);

  const names = new Set(manifests.map((manifest) => manifest.name));
  const tag = distTag(version);
  const out = mkdtempSync(join(tmpdir(), "awf-release-"));
  try {
    // Everything is packed and checked before anything is published.
    const plan: { name: string; tarball: string; published: boolean }[] = [];
    const problems: string[] = [];
    for (const dir of PACKAGES) {
      const { tarball, manifest } = await pack(dir, out);
      problems.push(...manifestProblems(manifest, version, names));
      const published = (await publishedVersions(manifest.name)).has(version);
      plan.push({ name: manifest.name, tarball, published });
    }
    if (problems.length > 0) fail(`not publishing:\n  ${problems.join("\n  ")}`);

    for (const { name, published } of plan)
      console.log(`${published ? "on npm  " : "to go up"} ${name}@${version}`);
    const todo = plan.filter((entry) => !entry.published);
    if (todo.length === 0) return console.log(`release: ${version} is on npm whole`);
    if (dryRun) return console.log(`release: dry run, ${todo.length} to publish under ${tag}`);

    for (const { name, tarball } of todo) {
      console.log(`\nrelease: publishing ${name}@${version} under ${tag}`);
      // Its exit code isn't trusted: a sign-in that times out still exits 0. The registry is.
      await $`bun publish ${tarball} --tag ${tag}`.cwd(ROOT).nothrow();
      const until = Date.now() + APPEAR_MS;
      while (!(await publishedVersions(name)).has(version)) {
        if (Date.now() > until)
          fail(
            `${name}@${version} is not on npm, so the release stopped here.\n` +
              `Run \`bun run release\` again to publish it and what's after it.`,
          );
        await Bun.sleep(3_000);
      }
    }
    console.log(`\nrelease: ${version} is on npm whole, under ${tag}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};

if (import.meta.main) await main();
