import { createHash } from "node:crypto";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { type AnswerKey, type FixtureSet, SET_FORMAT } from "../format/format";
import { checkFixture, checkFixtureSet, describeProblems, type Problem } from "../format/validate";
import { canonicalJson, fixtureId, leftOut, mergeExcluded, SET_FILE } from "./set";
import { at, readJson, verifyFixture } from "./verify";

/** A problem only in the key: the fixture itself is sound, and redrafting the key can fix it. */
export function inKey(problem: Problem): boolean {
  return /^key\/(key\.json|evidence\/votes\.json)/.test(problem.path);
}

/** SHA-256 of a value as canonical JSON, as a fixture's, a key's and a score's digests are. */
export function digestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/**
 * The digest a set pins a fixture by, taken over all of `fixture.json` (the MR, its URL and state, and the
 * frozen head) and the request exactly as the reviewer reads it. The frozen code is covered by its
 * head, which pins the tree and its history and which the checker proves the bundle restores to,
 * so rebundling the same commits keeps the digest. The key is not covered: it grows, and a score
 * records its revision separately. This definition is part of `awf.fixture-set/1`; changing what
 * it covers needs a new set format.
 */
export async function digestFixture(dir: string): Promise<string> {
  const fixture = await Bun.file(join(dir, "fixture.json")).json();
  const request = await Bun.file(join(dir, "request.md")).text();
  return digestOf({ fixture, request });
}

type Entry = FixtureSet["fixtures"][number];
type Exclusion = FixtureSet["excluded"][number];
type Assessed =
  | { kind: "broken"; problems: Problem[] }
  | { kind: "in"; entry: Entry }
  | { kind: "out"; entry: Exclusion };

/**
 * Checks one fixture folder end to end and decides whether it belongs in a set. With a
 * `procedure`, a key drafted under other instructions is left out as stale.
 */
async function assess(dir: string, clone: string, procedure?: string): Promise<Assessed> {
  const unreadable: Problem[] = [];
  const fixture = checkFixture(await readJson(dir, "fixture.json", unreadable));
  if (unreadable.length > 0) return { kind: "broken", problems: unreadable };
  if (!fixture.ok) {
    return { kind: "broken", problems: fixture.problems.map((p) => at("fixture.json", p)) };
  }
  const { id, source } = fixture.value;
  const expected = fixtureId(source.project, source.number);
  if (id !== basename(dir) || id !== expected) {
    const message = `is ${id}, in folder ${basename(dir)}, for ${expected}`;
    return { kind: "broken", problems: [{ path: "fixture.json/id", message }] };
  }
  const out = (reason: string): Assessed => ({
    kind: "out",
    entry: { project: source.project, number: source.number, reason },
  });
  const problems = await verifyFixture(dir, { ...source, clone }).catch((error) => [
    { path: "", message: String(error) },
  ]);
  if (!problems.every(inKey)) return { kind: "broken", problems };
  if (problems.length > 0) return out("its key fails its checks");
  const keyFile = join(dir, "key", "key.json");
  const key: AnswerKey | undefined = existsSync(keyFile)
    ? await Bun.file(keyFile).json()
    : undefined;
  if (procedure && key && key.procedure !== procedure) {
    return out("its key was drafted under older instructions");
  }
  const reason = leftOut(fixture.value, key);
  if (reason) return out(reason);
  return {
    kind: "in",
    entry: { id, at: fixture.value.request.asOf, digest: await digestFixture(dir) },
  };
}

function fixtureFolders(setDir: string): string[] {
  if (!existsSync(setDir)) return [];
  return readdirSync(setDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.endsWith(".partial"))
    .map((e) => e.name)
    .sort();
}

/**
 * Writes `set.json` for the fixture folders in `setDir`: every folder that passes its checks and
 * the set's rules is in, pinned by its digest; the rest, and `excluded` (MRs that never became a
 * folder), are listed with why. Exclusions from an earlier `set.json` are kept for MRs with no
 * folder. Nothing is written while a fixture or the earlier `set.json` is broken, nor when nothing
 * changed.
 */
export async function sealSet(
  setDir: string,
  options: { clone: string; builder: string; procedure: string; excluded?: Exclusion[] },
): Promise<
  { status: "sealed" | "unchanged"; set: FixtureSet } | { status: "broken"; detail: string }
> {
  const file = join(setDir, SET_FILE);
  let previous: FixtureSet | undefined;
  if (existsSync(file)) {
    const problems: Problem[] = [];
    const checked = checkFixtureSet(await readJson(setDir, SET_FILE, problems));
    if (!checked.ok) problems.push(...checked.problems.map((p) => at(SET_FILE, p)));
    if (problems.length > 0) {
      return {
        status: "broken",
        detail: `${describeProblems(setDir, problems)}\nremove it to start over`,
      };
    }
    if (checked.ok) previous = checked.value;
  }
  const folders = fixtureFolders(setDir);
  const fixtures: Entry[] = [];
  const fromFolders: Exclusion[] = [];
  const broken: string[] = [];
  for (const folder of folders) {
    const dir = join(setDir, folder);
    const assessed = await assess(dir, options.clone, options.procedure);
    if (assessed.kind === "broken") broken.push(describeProblems(dir, assessed.problems));
    else if (assessed.kind === "in") fixtures.push(assessed.entry);
    else fromFolders.push(assessed.entry);
  }
  if (broken.length > 0) return { status: "broken", detail: broken.join("\n") };
  const noFolder = (e: Exclusion) => !folders.includes(fixtureId(e.project, e.number));
  const excluded = mergeExcluded(
    fromFolders,
    (options.excluded ?? []).filter(noFolder),
    (previous?.excluded ?? []).filter(noFolder),
  );
  const content = { name: basename(setDir), builder: options.builder, fixtures, excluded };
  if (
    previous &&
    canonicalJson(content) ===
      canonicalJson({
        name: previous.name,
        builder: previous.builder,
        fixtures: previous.fixtures,
        excluded: previous.excluded,
      })
  ) {
    return { status: "unchanged", set: previous };
  }
  const set: FixtureSet = { format: SET_FORMAT, builtAt: new Date().toISOString(), ...content };
  const checked = checkFixtureSet(set);
  if (!checked.ok) throw new Error(describeProblems(file, checked.problems));
  // Written aside and moved into place, so a killed seal never leaves half a set.json.
  await Bun.write(`${file}.partial`, `${JSON.stringify(set, null, 2)}\n`);
  renameSync(`${file}.partial`, file);
  return { status: "sealed", set };
}

/**
 * Checks a sealed set: `set.json` is valid, every fixture folder is either in it or excluded, and
 * every fixture in it still passes its checks and the set's rules, with the digest it was sealed
 * with. A reader checks this before scoring against the set.
 */
export async function verifySet(setDir: string, clone: string): Promise<Problem[]> {
  const problems: Problem[] = [];
  const set = checkFixtureSet(await readJson(setDir, SET_FILE, problems));
  if (problems.length > 0) return problems;
  if (!set.ok) return set.problems.map((p) => at(SET_FILE, p));
  const folders = fixtureFolders(setDir);
  const listed = new Set(set.value.fixtures.map((entry) => entry.id));
  const excluded = new Set(set.value.excluded.map((e) => fixtureId(e.project, e.number)));
  for (const folder of folders) {
    if (listed.has(folder) && excluded.has(folder)) {
      problems.push({ path: folder, message: "is both in the set and excluded from it" });
    } else if (!listed.has(folder) && !excluded.has(folder)) {
      problems.push({ path: folder, message: "is neither in set.json nor excluded; seal the set" });
    }
  }
  for (const entry of set.value.fixtures) {
    const dir = join(setDir, entry.id);
    if (!folders.includes(entry.id)) {
      problems.push({ path: entry.id, message: "is in set.json but has no folder" });
      continue;
    }
    const assessed = await assess(dir, clone);
    if (assessed.kind === "broken") {
      problems.push(...assessed.problems.map((p) => ({ ...p, path: join(entry.id, p.path) })));
    } else if (assessed.kind === "out") {
      problems.push({ path: entry.id, message: `is in the set, but ${assessed.entry.reason}` });
    } else if (canonicalJson(assessed.entry) !== canonicalJson(entry)) {
      problems.push({
        path: entry.id,
        message: `changed since the set was sealed: ${assessed.entry.digest}, sealed as ${entry.digest}`,
      });
    }
  }
  return problems;
}
