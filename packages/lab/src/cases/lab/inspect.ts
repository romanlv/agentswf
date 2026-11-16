import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { OUTPUT_RECORD_VERSION } from "@agentswf/contract/records";
import { type AwfBin, probeRecordVersion } from "../../shared/runner";
import { ENV_FILE, STUB_LINE } from "./dataset";
import { Refusal } from "./refusal";
import { inside } from "./workspace";

/**
 * The oldest `agentswf` whose author surface this lab was written for: an older one is refused,
 * never adapted to. beta.2 has no `defineWorkflow` and no `--quiet`, and keeps other record files.
 */
export const MIN_AGENTSWF = "0.1.1";

/** This lab's own `@agentswf/lab/cases` and its preload, which a folder must resolve to. */
const OWN_ENTRIES: Readonly<Record<string, string>> = {
  "@agentswf/lab/cases": join(import.meta.dir, "../env/index.ts"),
  "@agentswf/lab/cases/fetch": join(import.meta.dir, "../env/fetch.ts"),
};

/** What a folder of code runs its trials with, once checked. */
export type FolderSetup = {
  root: string;
  awf: Required<AwfBin>;
  version: string;
  /** Its `node_modules/.bin`, first on a trial's `PATH`. */
  bin: string;
};

/** `env.ts` is there and filled in. */
export function checkEnvFile(datasetDir: string): string {
  const file = join(datasetDir, ENV_FILE);
  if (!existsSync(file)) {
    throw new Refusal(`${file} is missing: a dataset's env.ts sets up each case's world`);
  }
  if (readFileSync(file, "utf8").includes(STUB_LINE)) {
    throw new Refusal(
      `${file} is the stub awf-lab case new wrote: fill in its workflow and observe, then delete its first line`,
    );
  }
  return file;
}

/** The first `node_modules/{path}` at or above `dir`. */
function upward(dir: string, path: string): string | undefined {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const candidate = join(at, "node_modules", path);
    if (existsSync(candidate)) return candidate;
    if (dirname(at) === at) return undefined;
  }
}

/** `a.b.c` against `x.y.z`, a prerelease below its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    return { parts: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

/**
 * The checks on a folder before the first trial: its own `awf`, at least the `agentswf` this lab
 * reads; `@agentswf/lab/cases` and its `fetch` resolving there; and `env.ts` type-checked by the
 * folder's own `tsc`, only errors in `env.ts` and its dataset folder counting.
 */
export async function inspectFolder(root: string, envFile: string): Promise<FolderSetup> {
  const problems: string[] = [];
  const manifest = upward(root, "agentswf/package.json");
  let awf: Required<AwfBin> | undefined;
  let version = "";
  if (!manifest) {
    problems.push(`no agentswf installed in ${root}: bun add agentswf there`);
  } else {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      version: string;
      bin?: string | Record<string, string>;
    };
    version = pkg.version;
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.awf;
    if (compareVersions(version, MIN_AGENTSWF) < 0) {
      problems.push(
        `agentswf ${version} in ${root} is older than ${MIN_AGENTSWF}, the oldest this lab reads: upgrade agentswf there`,
      );
    } else if (!bin) {
      problems.push(`${manifest} names no awf bin`);
    } else {
      const preload = resolveFrom(root, "@agentswf/lab/cases/fetch");
      awf = { bin: join(dirname(manifest), bin), dir: root, preload: preload ?? "" };
      const probed = await probe(awf, root);
      if (probed) problems.push(probed);
    }
  }
  for (const [spec, own] of Object.entries(OWN_ENTRIES)) {
    const found = resolveFrom(root, spec);
    if (!found) {
      problems.push(`${spec} does not resolve from ${root}: bun link @agentswf/lab there`);
    } else if (realpathSync(found) !== realpathSync(own)) {
      problems.push(
        `${spec} resolves from ${root} to ${found}, not this lab's ${own}: bun link @agentswf/lab there`,
      );
    }
  }
  const tsc = upward(root, ".bin/tsc");
  if (!tsc) problems.push(`no tsc in ${root}: install typescript there, for the check of env.ts`);
  else problems.push(...(await typeCheck(root, tsc, envFile)));
  if (problems.length > 0 || !awf) {
    throw new Refusal(`${root} can't run trials:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }
  return { root, awf, version, bin: dirname(tsc ?? join(root, "node_modules/.bin/tsc")) };
}

/** The folder's `awf`, started once on a workflow that does nothing: the record version it prints. */
async function probe(awf: Required<AwfBin>, root: string): Promise<string | undefined> {
  const dir = mkdtempSync(join(root, ".awf-lab-probe-"));
  try {
    const workflow = join(dir, "probe.ts");
    writeFileSync(workflow, PROBE);
    const printed = await probeRecordVersion(awf, workflow, dir);
    if ("unread" in printed) return `${awf.bin} can't be read: ${printed.unread}`;
    if (printed.version !== OUTPUT_RECORD_VERSION) {
      return `${awf.bin} prints run records of version ${String(printed.version)}; this lab reads version ${OUTPUT_RECORD_VERSION}: upgrade agentswf there, or the lab`;
    }
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The engine serves its author surface to the workflows it loads; the lab never imports it. */
const SURFACE = "agentswf/workflow";
const PROBE = [
  `import { defineWorkflow } from ${JSON.stringify(SURFACE)};`,
  "",
  "export default defineWorkflow({",
  '  meta: { name: "awf-lab-probe", description: "Does nothing: awf-lab reads the record it prints." },',
  "  run: async () => null,",
  "});",
  "",
].join("\n");

function resolveFrom(root: string, spec: string): string | undefined {
  try {
    return Bun.resolveSync(spec, root);
  } catch {
    return undefined;
  }
}

/** `tsc --noEmit` on `env.ts` alone, through a tsconfig beside the folder's own, extending it. */
async function typeCheck(root: string, tsc: string, envFile: string): Promise<string[]> {
  const config = join(root, `tsconfig.awf-lab-${randomBytes(4).toString("hex")}.json`);
  const own = join(root, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      ...(existsSync(own) ? { extends: "./tsconfig.json" } : {}),
      compilerOptions: {
        noEmit: true,
        incremental: false,
        composite: false,
        ...(existsSync(own)
          ? {}
          : {
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "bundler",
              strict: true,
              skipLibCheck: true,
              allowImportingTsExtensions: true,
            }),
      },
      files: [relative(root, envFile)],
      include: [],
    }),
  );
  try {
    const child = Bun.spawn([process.execPath, tsc, "-p", config, "--pretty", "false"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: 300_000,
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return errorsIn(`${out}\n${err}`, root, dirname(envFile));
  } finally {
    rmSync(config, { force: true });
  }
}

/** tsc's errors in files under `dir`, each with its continuation lines. */
export function errorsIn(output: string, root: string, dir: string): string[] {
  const errors: { file: string; text: string }[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?)\(\d+,\d+\): error TS\d+:/.exec(line);
    if (match) errors.push({ file: resolve(root, match[1]!), text: line });
    else if (/^\s+\S/.test(line) && errors.length > 0) errors.at(-1)!.text += `\n${line}`;
  }
  return errors
    .filter((error) => inside(dir, error.file))
    .map((error) => `type error: ${error.text.replace(`${root}/`, "")}`);
}
