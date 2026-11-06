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
 * A stable version goes up under `latest`, a prerelease under its id (`beta`, `rc`), so a beta
 * never becomes what a plain install gets. Before any stable version exists, a prerelease goes
 * under `latest`: it is the newest there is.
 *
 * The notes are CHANGELOG.md's section for the version. `prepare` sets every manifest and bun.lock
 * to the version and dates the Unreleased section as its own; a release without that section
 * stops before packing. Once npm has every package, the version is tagged and its notes go up as
 * the GitHub release, each skipped when it is already there.
 *
 *   bun run release prepare 0.2.0   # set the version, date the notes; then commit
 *   bun run release                 # publish what isn't on npm yet, tag, GitHub release
 *   bun run release --dry-run       # pack and check, publish nothing
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";

/** In dependency order: a package goes up only after the ones it depends on. */
export const PACKAGES = ["contract", "sandbox", "harness", "engine", "agentswf"];

const ROOT = resolve(import.meta.dir, "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
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

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The lines of CHANGELOG.md's `## {heading}` section, a date after it allowed: [start, end). */
const sectionAt = (lines: readonly string[], heading: string): [number, number] | undefined => {
  const start = lines.findIndex(
    (line) => line === `## ${heading}` || line.startsWith(`## ${heading} `),
  );
  if (start === -1) return undefined;
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return [start, next === -1 ? lines.length : next];
};

/** The notes under `## {heading}`, trimmed; undefined when there is no such section. */
export const changelogSection = (changelog: string, heading: string): string | undefined => {
  const lines = changelog.split("\n");
  const at = sectionAt(lines, heading);
  return (
    at &&
    lines
      .slice(at[0] + 1, at[1])
      .join("\n")
      .trim()
  );
};

/** The changelog with Unreleased's notes moved under `## {version} — {date}`, Unreleased left empty. */
export const cutRelease = (changelog: string, version: string, date: string): string => {
  const lines = changelog.split("\n");
  const at = sectionAt(lines, "Unreleased");
  if (!at) throw new Error("CHANGELOG.md has no ## Unreleased section");
  if (sectionAt(lines, version)) throw new Error(`CHANGELOG.md already has ## ${version}`);
  const notes = lines
    .slice(at[0] + 1, at[1])
    .join("\n")
    .trim();
  if (!notes) throw new Error("CHANGELOG.md's Unreleased is empty: write what changed first");
  const rest = lines.slice(at[1]).join("\n");
  return [
    ...lines.slice(0, at[0]),
    "## Unreleased",
    "",
    `## ${version} — ${date}`,
    "",
    notes,
    "",
    ...(rest ? [rest] : []),
  ].join("\n");
};

/** bun.lock with each workspace package in `names` at `version`; `bun install` leaves them stale. */
export const bumpLock = (lock: string, names: readonly string[], version: string): string =>
  names.reduce((text, name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const entry = new RegExp(`("name": "${escaped}",\\n\\s*"version": ")[^"]+"`);
    if (!entry.test(text)) throw new Error(`bun.lock has no workspace entry for ${name}`);
    return text.replace(entry, `$1${version}"`);
  }, lock);

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
const pack = async (
  dir: string,
  out: string,
): Promise<{ tarball: string; manifest: Manifest; paths: string[] }> => {
  const packed = await $`bun pm pack --destination ${out} --quiet`
    .cwd(join(ROOT, "packages", dir))
    .quiet()
    .nothrow();
  if (packed.exitCode !== 0) fail(`packing ${dir} failed: ${packed.stderr.toString().trim()}`);
  // --quiet prints the tarball alone, as a path in --destination.
  const tarball = resolve(out, packed.stdout.toString().trim().split("\n").at(-1)!.trim());
  const manifest = JSON.parse(await $`tar -xOf ${tarball} package/package.json`.text());
  const paths = (await $`tar -tzf ${tarball}`.text()).split("\n").filter(Boolean);
  return { tarball, manifest, paths };
};

/**
 * The dist-tag `version` goes up under, given the versions of agentswf npm has. A numeric
 * prerelease id, as `1.0.0-0` has, is no tag npm takes, so it goes under `next`.
 */
export const distTag = (version: string, published: Iterable<string>): string => {
  const id = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version)?.[1];
  if (id === undefined) return "latest";
  if (![...published].some((each) => /^\d+\.\d+\.\d+$/.test(each))) return "latest";
  return /^\d+$/.test(id) ? "next" : id;
};

/** Every tarball holds its README and LICENSE, and none of the tests, typechecks or fixtures. */
export const contentProblems = (name: string, paths: readonly string[]): string[] => {
  const problems: string[] = [];
  for (const required of ["package/README.md", "package/LICENSE"])
    if (!paths.includes(required))
      problems.push(`${name} lacks ${required.slice("package/".length)}`);
  for (const path of paths)
    if (/\.(test|eval|typecheck|fixture)\.ts$|\/fixtures\//.test(path))
      problems.push(`${name} ships ${path.slice("package/".length)}`);
  return problems;
};

/**
 * Whether bun publish's output says npm took the version: its `+ name@version` line, or npm
 * refusing it as already there, which a rerun meets for a version taken but not yet listed. Its
 * exit code isn't trusted: a sign-in that times out still exits 0.
 */
export const accepted = (output: string, name: string, version: string): boolean =>
  output.split("\n").some((line) => line.trim() === `+ ${name}@${version}`) ||
  /cannot publish over the previously published versions/i.test(output);

/**
 * Runs bun publish in the open, so its sign-in prompt is answerable, and returns what it printed.
 * From the package's directory: bun checks a tarball's bin paths against where it runs.
 */
const publish = async (dir: string, tarball: string, tag: string): Promise<string> => {
  const child = Bun.spawn(["bun", "publish", tarball, "--tag", tag], {
    cwd: join(ROOT, "packages", dir),
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

/** Sets every manifest and bun.lock to `version` and dates CHANGELOG.md's Unreleased notes as its. */
const prepare = async (version: string | undefined) => {
  if (!version || !VERSION.test(version)) fail("give the version: bun run release prepare 0.2.0");
  const date = new Date().toISOString().slice(0, 10);
  let changelog = "";
  try {
    changelog = cutRelease(readFileSync(CHANGELOG, "utf8"), version!, date);
  } catch (error) {
    fail((error as Error).message);
  }
  const names = PACKAGES.map((dir) => readManifest(dir).name);
  const lockPath = join(ROOT, "bun.lock");
  const lock = bumpLock(readFileSync(lockPath, "utf8"), names, version!);
  for (const dir of PACKAGES) {
    const path = join(ROOT, "packages", dir, "package.json");
    await Bun.write(
      path,
      readFileSync(path, "utf8").replace(/"version": "[^"]+"/, `"version": "${version}"`),
    );
  }
  await Bun.write(lockPath, lock);
  await Bun.write(CHANGELOG, changelog);
  console.log(
    `release: ${version} set in ${PACKAGES.length} manifests, bun.lock and CHANGELOG.md.\n` +
      `Read the notes, commit, then \`bun run release\`.`,
  );
};

/** Tags the version and puts its notes up as the GitHub release, each unless it is there already. */
const announce = async (version: string, notes: string, dryRun: boolean) => {
  const tag = `v${version}`;
  if (dryRun) return console.log(`release: would tag ${tag} and release it with:\n\n${notes}\n`);
  const tagged = await $`git rev-parse -q --verify refs/tags/${tag}`.cwd(ROOT).quiet().nothrow();
  if (tagged.exitCode !== 0) await $`git tag -a ${tag} -m ${tag}`.cwd(ROOT);
  const pushed = await $`git push origin ${tag}`.cwd(ROOT).quiet().nothrow();
  if (pushed.exitCode !== 0)
    fail(
      `npm has ${version}, but pushing ${tag} failed: ${pushed.stderr.toString().trim()}\nRun \`bun run release\` again to finish.`,
    );
  const released = await $`gh release view ${tag}`.cwd(ROOT).quiet().nothrow();
  if (released.exitCode === 0) return console.log(`release: ${tag} is tagged and released`);
  const notesFile = join(mkdtempSync(join(tmpdir(), "awf-notes-")), "notes.md");
  await Bun.write(notesFile, `${notes}\n`);
  const prerelease = version.includes("-") ? ["--prerelease"] : [];
  const created =
    await $`gh release create ${tag} --verify-tag --title ${tag} --notes-file ${notesFile} ${prerelease}`
      .cwd(ROOT)
      .quiet()
      .nothrow();
  rmSync(dirname(notesFile), { recursive: true, force: true });
  if (created.exitCode !== 0)
    fail(
      `npm has ${version} and ${tag} is pushed, but the GitHub release failed: ${created.stderr.toString().trim()}\nRun \`bun run release\` again to finish.`,
    );
  console.log(`release: ${tag} is tagged and released: ${created.stdout.toString().trim()}`);
};

const main = async () => {
  if (process.argv[2] === "prepare") return prepare(process.argv[3]);
  const dryRun = process.argv.includes("--dry-run");
  const manifests = PACKAGES.map(readManifest);
  const version = manifests[0]!.version;
  const odd = manifests.filter((manifest) => manifest.version !== version);
  if (odd.length > 0)
    fail(`versions differ: ${manifests.map((m) => `${m.name}@${m.version}`).join(", ")}`);
  const dirty = (
    await $`git status --porcelain -- packages bun.lock CHANGELOG.md`.cwd(ROOT).text()
  ).trim();
  if (dirty && !dryRun) fail(`commit these first, so the release is what git has:\n${dirty}`);
  const notes = changelogSection(readFileSync(CHANGELOG, "utf8"), version);
  if (!notes)
    fail(
      `CHANGELOG.md has no notes under ## ${version}: write them under Unreleased, then \`bun run release prepare ${version}\``,
    );

  const names = new Set(manifests.map((manifest) => manifest.name));
  const out = mkdtempSync(join(tmpdir(), "awf-release-"));
  try {
    // Everything is packed and checked before anything is published.
    const plan: { dir: string; name: string; tarball: string; published: boolean }[] = [];
    const problems: string[] = [];
    for (const dir of PACKAGES) {
      const { tarball, manifest, paths } = await pack(dir, out);
      problems.push(
        ...manifestProblems(manifest, version, names),
        ...contentProblems(manifest.name, paths),
      );
      const published = (await publishedVersions(manifest.name)).has(version);
      plan.push({ dir, name: manifest.name, tarball, published });
    }
    if (problems.length > 0) fail(`not publishing:\n  ${problems.join("\n  ")}`);
    const tag = distTag(version, await publishedVersions("agentswf"));

    for (const { name, published } of plan)
      console.log(`${published ? "on npm  " : "to go up"} ${name}@${version}`);
    const todo = plan.filter((entry) => !entry.published);
    if (todo.length === 0) {
      console.log(`release: ${version} is on npm whole`);
      return await announce(version, notes!, dryRun);
    }
    if (dryRun) {
      console.log(`release: dry run, ${todo.length} to publish under ${tag}`);
      return await announce(version, notes!, dryRun);
    }

    for (const { dir, name, tarball } of todo) {
      console.log(`\nrelease: publishing ${name}@${version}`);
      const output = await publish(dir, tarball, tag);
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
    console.log(`\nrelease: ${version} is on npm whole, under ${tag}`);
    await announce(version, notes!, dryRun);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};

if (import.meta.main) await main();
