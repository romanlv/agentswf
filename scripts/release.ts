/**
 * Publishes every package at the version their manifests share, so that a release either goes up
 * whole or says what is missing.
 *
 * `bun publish` exits 0 when npm's sign-in times out, and fills `workspace:*` from `bun.lock`'s
 * workspace versions, which `bun install` doesn't update; 0.1.0-beta.1 went up depending on beta.0,
 * and 0.1.0-beta.2 without engine and wf. So every tarball is packed and read before anything is
 * published, a package goes on only when bun publish's output says npm took it, every one is
 * looked for on the registry at the end, since npm can take minutes to list a version, and a
 * package already there is skipped: running it again finishes a release that stopped.
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
/** npm can take minutes to list a version it has accepted. */
const APPEAR_MS = 600_000;

type Manifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};

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

/**
 * Whether bun publish's output says npm took the version: its `+ name@version` line, or npm
 * refusing it as already there, which a rerun meets for a version taken but not yet listed. Its
 * exit code isn't trusted: a sign-in that times out still exits 0.
 */
export const accepted = (output: string, name: string, version: string): boolean =>
  output.split("\n").some((line) => line.trim() === `+ ${name}@${version}`) ||
  /cannot publish over the previously published versions/i.test(output);

/** Runs bun publish in the open, so its sign-in prompt is answerable, and returns what it printed. */
const publish = async (tarball: string): Promise<string> => {
  const child = Bun.spawn(["bun", "publish", tarball, "--tag", "latest"], {
    cwd: ROOT,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const tee = async (stream: ReadableStream<Uint8Array>, to: NodeJS.WriteStream) => {
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      to.write(chunk);
      text += decoder.decode(chunk, { stream: true });
    }
    return text;
  };
  const [out, err] = await Promise.all([
    tee(child.stdout, process.stdout),
    tee(child.stderr, process.stderr),
  ]);
  await child.exited;
  return `${out}\n${err}`;
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
    if (dryRun) return console.log(`release: dry run, ${todo.length} to publish`);

    for (const { name, tarball } of todo) {
      console.log(`\nrelease: publishing ${name}@${version}`);
      // Under latest even as a prerelease: until a stable release, a plain install gets the newest.
      // TODO: once out of beta, publish a prerelease under its id (beta, rc) and only a stable under latest.
      const output = await publish(tarball);
      if (!accepted(output, name, version))
        fail(
          `npm did not take ${name}@${version}, so the release stopped here.\n` +
            `Fix what bun publish said above (\`npm whoami\` to check the sign-in), then run \`bun run release\` again.`,
        );
    }

    // npm takes a version before it lists it, sometimes minutes before; nothing above waited on that.
    console.log(`\nrelease: waiting for npm to list ${version} of each`);
    const until = Date.now() + APPEAR_MS;
    for (const { name } of todo)
      while (!(await publishedVersions(name)).has(version)) {
        if (Date.now() > until)
          fail(
            `npm took ${name}@${version} but hasn't listed it yet.\n` +
              `Run \`bun run release\` later: it reports what is listed and publishes nothing twice.`,
          );
        await Bun.sleep(5_000);
      }
    console.log(`\nrelease: ${version} is on npm whole, under latest`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};

if (import.meta.main) await main();
