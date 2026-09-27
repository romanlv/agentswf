import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseSkillFile } from "./sources";
import { MAX_BYTES, MAX_FILES } from "./tree";

type Environment = Readonly<Record<string, string | undefined>>;
type GitResult = { ok: boolean; out: string; err: string };

/** Past this, a fetch is stuck, not slow: a skill is a few files. */
const GIT_TIMEOUT_MS = 5 * 60_000;
const HEX = /^[0-9a-f]{7,40}$/i;

/** A bare repository per URL in `cache`, shared by every run: git locks its own refs and objects. */
export async function cachedRepository(
  cache: string,
  url: string,
  environment: Environment,
): Promise<string> {
  const directory = join(
    cache,
    "repos",
    createHash("sha256").update(url).digest("hex").slice(0, 24),
  );
  if (!(await exists(join(directory, "HEAD")))) {
    await mkdir(join(cache, "repos"), { recursive: true });
    const staged = `${directory}.${randomUUID()}`;
    await git(["init", "--quiet", "--bare", staged], environment);
    // Two runs may create it at once; the one that lands second keeps the first's.
    await rename(staged, directory).catch(() => rm(staged, { recursive: true, force: true }));
  }
  return directory;
}

/**
 * The commit `ref` names, or the default branch's, in `repository`: fetched unless it is a commit
 * an earlier fetch kept. Every commit resolved is kept under `refs/awf/commits/`, so its objects
 * stay and a run that pins it again needs no network.
 */
export async function fetchCommit(
  repository: string,
  url: string,
  ref: string | undefined,
  environment: Environment,
): Promise<string> {
  const kept = ref && HEX.test(ref) ? await commitOf(repository, ref, environment) : undefined;
  if (kept) return kept;
  // A ref of our own per fetch: two agents or runs fetching at once never read each other's.
  const into = `refs/awf/fetch/${randomUUID()}`;
  try {
    const shallow = await unlocked(() =>
      git(
        ["-C", repository, "fetch", "--quiet", "--depth", "1", url, `+${ref ?? "HEAD"}:${into}`],
        environment,
        { allowFailure: true },
      ),
    );
    if (shallow.ok) return await keep(repository, into, environment);
    if (ref === undefined || !HEX.test(ref)) {
      throw new Error(`cannot fetch ${ref ?? "the default branch"} of ${url}: ${shallow.err}`);
    }
    // A commit, which a server need not serve alone, and a short one it cannot: every branch and
    // tag with their history, past any shallow boundary an earlier fetch left.
    const shallowed = await git(
      ["-C", repository, "rev-parse", "--is-shallow-repository"],
      environment,
    );
    const full = await unlocked(() =>
      git(
        [
          "-C",
          repository,
          "fetch",
          "--quiet",
          ...(shallowed.out === "true" ? ["--unshallow"] : []),
          url,
          `+refs/heads/*:${into}/heads/*`,
          `+refs/tags/*:${into}/tags/*`,
        ],
        environment,
        { allowFailure: true },
      ),
    );
    if (!full.ok) throw new Error(`cannot fetch ${url}: ${full.err}`);
    if (!(await commitOf(repository, ref, environment))) {
      throw new Error(`${url} has no commit ${ref}`);
    }
    return await keep(repository, ref, environment);
  } finally {
    const refs = await git(
      ["-C", repository, "for-each-ref", "--format=%(refname)", into, `${into}/`],
      environment,
      { allowFailure: true },
    );
    const names = refs.out.split("\n").filter(Boolean);
    if (names.length > 0) {
      await git(["-C", repository, "update-ref", "--stdin"], environment, {
        allowFailure: true,
        stdin: names.map((name) => `delete ${name}\n`).join(""),
      });
    }
  }
}

/** The commit `name` resolves to, an annotated tag peeled, or `undefined`. */
async function commitOf(
  repository: string,
  name: string,
  environment: Environment,
): Promise<string | undefined> {
  const found = await git(
    ["-C", repository, "rev-parse", "--verify", "--quiet", `${name}^{commit}`],
    environment,
    { allowFailure: true },
  );
  return found.ok ? found.out : undefined;
}

async function keep(repository: string, name: string, environment: Environment): Promise<string> {
  const commit = await commitOf(repository, name, environment);
  if (!commit) throw new Error(`${name} is not a commit`);
  await git(["-C", repository, "update-ref", `refs/awf/commits/${commit}`, commit], environment);
  return commit;
}

/**
 * `fetch`, again while another run's fetch into the shared cache holds one of git's locks: git
 * refuses rather than waits. Two minutes covers a large fetch by the other run.
 */
async function unlocked(fetch: () => Promise<GitResult>): Promise<GitResult> {
  for (let attempt = 0; ; attempt++) {
    const result = await fetch();
    if (result.ok || !/\.lock'?: File exists/.test(result.err) || attempt >= 480) return result;
    await Bun.sleep(250);
  }
}

/** The directory, relative to the repository's root, whose `SKILL.md` is named `skill`. */
export async function findSkill(
  repository: string,
  commit: string,
  skill: string,
  environment: Environment,
): Promise<string> {
  // `-z`, or a path outside ASCII comes back quoted and never matches.
  const listed = await git(
    ["-C", repository, "ls-tree", "-r", "-z", "--name-only", commit],
    environment,
  );
  const files = listed.out
    .split("\0")
    .filter(
      (path) =>
        (path === "SKILL.md" || path.endsWith("/SKILL.md")) && !path.includes("node_modules/"),
    );
  const matches: string[] = [];
  const names: string[] = [];
  for (const file of files) {
    const text = await git(["-C", repository, "show", `${commit}:${file}`], environment);
    let name: string | undefined;
    try {
      ({ name } = parseSkillFile(text.out, file));
    } catch {
      // Not a skill this can load; the one asked for may still be elsewhere.
    }
    if (name) names.push(name);
    if (name === skill) matches.push(file === "SKILL.md" ? "" : file.slice(0, -"/SKILL.md".length));
  }
  if (matches.length === 0) {
    const known = names.length > 0 ? `; it has ${names.slice(0, 10).join(", ")}` : "";
    throw new Error(`no skill named ${skill} at ${commit.slice(0, 12)}${known}`);
  }
  if (matches.length > 1) {
    throw new Error(`more than one skill is named ${skill}: ${matches.join(", ")}`);
  }
  return matches[0]!;
}

/**
 * `within` at `commit`, written under `into` from git's objects: every file, where an archive
 * would drop what `.gitattributes` marks `export-ignore`, and a link or a submodule refused, and
 * the caps checked, before anything is written.
 */
export async function extract(
  repository: string,
  commit: string,
  within: string,
  into: string,
  environment: Environment,
): Promise<void> {
  const tree = within === "" ? `${commit}^{tree}` : `${commit}:${within}`;
  const listed = await git(["-C", repository, "ls-tree", "-r", "-z", "-l", tree], environment);
  const entries: { mode: string; object: string; path: string }[] = [];
  let bytes = 0;
  for (const line of listed.out.split("\0").filter(Boolean)) {
    const match = /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t(.+)$/s.exec(line);
    if (!match) throw new Error(`cannot read git's listing of ${tree}: ${line}`);
    const [, mode, , object, size, path] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (mode === "120000") throw new Error(`skill at ${within || "the root"}: ${path} is a link`);
    if (mode !== "100644" && mode !== "100755") {
      throw new Error(`skill at ${within || "the root"}: ${path} is not a file`);
    }
    if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`skill at ${within || "the root"}: ${path} is not a path inside it`);
    }
    bytes += Number(size);
    entries.push({ mode, object, path });
  }
  if (bytes > MAX_BYTES || entries.length > MAX_FILES) {
    throw new Error(
      `skill at ${within || "the root"} is over ${MAX_FILES} files or ${MAX_BYTES} bytes`,
    );
  }
  const blobs = await readBlobs(
    repository,
    entries.map((entry) => entry.object),
    environment,
  );
  for (const [index, entry] of entries.entries()) {
    const path = join(into, entry.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
    await writeFile(path, blobs[index]!, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
  }
}

/** Each object's bytes, in order, from one `cat-file --batch`. */
async function readBlobs(
  repository: string,
  objects: readonly string[],
  environment: Environment,
): Promise<Buffer[]> {
  if (objects.length === 0) return [];
  const child = Bun.spawn({
    cmd: ["git", "-C", repository, "cat-file", "--batch"],
    env: gitEnvironment(environment),
    stdin: new TextEncoder().encode(`${objects.join("\n")}\n`),
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git cat-file failed: ${err.trim()}`);
  const buffer = Buffer.from(out);
  const blobs: Buffer[] = [];
  let at = 0;
  for (const object of objects) {
    const end = buffer.indexOf(10, at);
    const header = buffer.subarray(at, end).toString("utf8");
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== object) throw new Error(`git cat-file answered ${header}`);
    const size = Number(match[2]);
    blobs.push(buffer.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  return blobs;
}

/**
 * Never a prompt: a private repository fails instead of waiting for a password nobody types, and
 * ssh, which ignores git's variable, asks for no passphrase or host key.
 */
function gitEnvironment(environment: Environment): Record<string, string | undefined> {
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: environment.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
}

async function git(
  args: readonly string[],
  environment: Environment,
  options: { allowFailure?: boolean; stdin?: string } = {},
): Promise<GitResult> {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    env: gitEnvironment(environment),
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const result = { ok: code === 0, out: out.trim(), err: err.trim() || `exit ${code}` };
  if (!result.ok && !options.allowFailure) {
    throw new Error(`git ${args[0] === "-C" ? args[2] : args[0]} failed: ${result.err}`);
  }
  return result;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
