import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { HarnessSandboxNeeds } from "@wf/sandbox";

/** A seeded home's credentials, and a way to hand a refreshed one back to the operator. */
export type SeededHome = {
  /**
   * Replaces the operator's credential with the home's when a turn refreshed it: only if the copy
   * differs from what was seeded in the fields a refresh rewrites alone, so an account the file
   * names stays the operator's, and only if the operator's file is still what was copied, so a
   * login the operator made meanwhile is never overwritten. The written value becomes the new
   * baseline; a copy refused is said once, as a rejection.
   */
  writeBack(): Promise<void>;
};

/** One run's write-backs, serialized per operator file: two agents may share a credential. */
export type CredentialLocks = Map<string, Promise<void>>;

/**
 * Makes an agent's harness home, private to it, holding copies of its credentials and nothing
 * else of the operator's (story 004, "A fresh harness home"). It is built in `staging`, which no
 * agent writes, and moved into place whole: the directory `home` lands in is writable by the
 * sandbox's agents, which could plant a link there for the engine to write through.
 */
export async function seedHome(
  home: string,
  staging: string,
  needs: Pick<HarnessSandboxNeeds, "seed" | "defaults">,
  /** The agent's working directory, which a harness's first-run answers name. */
  cwd: string,
  locks: CredentialLocks,
  /** Fills the home, staged at the path it is given, before it moves into place: its skills. */
  populate?: (staged: string) => Promise<void>,
): Promise<SeededHome> {
  const staged = (path: string) => {
    const inside = relative(home, path);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`${path} is not in the agent's home ${home}`);
    }
    return join(staging, inside);
  };
  await mkdir(dirname(staging), { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  const seeds: {
    from: string;
    to: string;
    refreshes: string[][];
    baseline: Buffer;
    refused?: Buffer;
  }[] = [];
  try {
    for (const { from, to, refreshes } of needs.seed) {
      let bytes: Buffer;
      try {
        bytes = await readFile(from);
      } catch {
        throw new Error(`cannot seed ${to}: ${from} is missing; log the harness in first`);
      }
      await mkdir(dirname(staged(to)), { recursive: true, mode: 0o700 });
      await writeFile(staged(to), bytes, { mode: 0o600 });
      seeds.push({
        from,
        to,
        refreshes: refreshes.map((field) => field.split(".")),
        baseline: bytes,
      });
    }
    for (const { path, contents } of needs.defaults(cwd)) {
      await mkdir(dirname(staged(path)), { recursive: true, mode: 0o700 });
      await writeFile(staged(path), contents, { mode: 0o600 });
    }
    await populate?.(staging);
    await rename(staging, home);
  } catch (error) {
    // Its credentials go with it.
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    async writeBack() {
      // Every seed is tried: one refused leaves the others' refreshes to go back.
      const failures: unknown[] = [];
      for (const seed of seeds) {
        await serialized(locks, seed.from, async () => {
          const copied = await readOwnFile(seed.to);
          if (!copied || copied.equals(seed.baseline) || seed.refused?.equals(copied)) return;
          const beyond = beyondRefresh(parse(seed.baseline), parse(copied), seed.refreshes);
          if (beyond !== undefined) {
            // Said once for each such copy: if a refresh rotated the token, the operator's may
            // stop working, and this is why.
            seed.refused = copied;
            throw new Error(
              `${seed.to} changed at ${beyond || "its top"}, which no refresh does: not written back to ${seed.from}`,
            );
          }
          const operator = await readFile(seed.from).catch(() => undefined);
          if (!operator?.equals(seed.baseline)) return;
          // Atomic, so the operator's harness never reads half a credential.
          const temporary = join(dirname(seed.from), `.awf-${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, copied, { mode: 0o600 });
            await rename(temporary, seed.from);
          } catch (error) {
            await rm(temporary, { force: true });
            throw error;
          }
          seed.baseline = copied;
        }).catch((error: unknown) => failures.push(error));
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          failures
            .map((error) => (error instanceof Error ? error.message : String(error)))
            .join("; "),
        );
    },
  };
}

async function serialized(
  locks: CredentialLocks,
  key: string,
  work: () => Promise<void>,
): Promise<void> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => undefined);
  locks.set(key, settled);
  await next;
}

/**
 * A regular file's bytes, never a link's target: the agent owns its home, and a link there would
 * have the engine read what it points at. One handle, so nothing swaps the file between checks.
 */
async function readOwnFile(path: string): Promise<Buffer | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (!handle) return undefined;
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parse(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Where `after` differs from `before` beyond the fields a refresh rewrites, as a dotted path, or
 * undefined where it does not: at a path `refreshes` names, a scalar may change, appear or go;
 * everywhere else the two are equal. Undefined JSON differs at its top.
 */
function beyondRefresh(
  before: unknown,
  after: unknown,
  refreshes: readonly (readonly string[])[],
  at: readonly string[] = [],
): string | undefined {
  const here = at.join(".");
  if (before === undefined || after === undefined) return here;
  if (!isObject(before) || !isObject(after)) {
    return isDeepStrictEqual(before, after) ? undefined : here;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const path = [...at, key];
    const own = { before: Object.hasOwn(before, key), after: Object.hasOwn(after, key) };
    const refreshed = refreshes.some(
      (field) =>
        field.length === path.length &&
        field.every((part, index) => part === "*" || part === path[index]),
    );
    if (refreshed) {
      if (!isScalar(own.before ? before[key] : undefined)) return path.join(".");
      if (!isScalar(own.after ? after[key] : undefined)) return path.join(".");
      continue;
    }
    if (!own.before || !own.after) return path.join(".");
    const beyond = beyondRefresh(before[key], after[key], refreshes, path);
    if (beyond !== undefined) return beyond;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === undefined || value === null || ["string", "number"].includes(typeof value);
}
