import { existsSync, lstatSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentReach } from "../format/settings";
import type { CaseWorkspace } from "./workspace";

// The "lab" box: one srt sandbox around a whole trial, `awf run --boxed` with env.ts, the
// workflow's code and its agents inside, so code an agent wrote reads no key. The workflow's own
// sandboxes are set aside inside it (srt does not nest), and its agents run in it as host agents.

/**
 * Each harness's model domains, as harness's `sandbox-needs.ts` gives them: the lab imports
 * contract only, so it keeps its own copy, and `tests/lab-box-domains.test.ts` fails on a drift.
 */
export const MODEL_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  claude: ["api.anthropic.com"],
  codex: ["chatgpt.com", "*.chatgpt.com", "auth.openai.com"],
  cursor: ["*.cursor.sh"],
  pi: [
    "chatgpt.com",
    "*.chatgpt.com",
    "auth.openai.com",
    "api.anthropic.com",
    "console.anthropic.com",
    "platform.claude.com",
    "api.openai.com",
  ],
};

/** Regions nothing in the box reads, before its own paths are allowed again inside them. */
const DENIED = [
  "/Users",
  "/home",
  "/Volumes",
  "/tmp",
  "/private/tmp",
  "/private/var/folders",
  "/private/var/tmp",
];

/** srt's settings file, as much of it as the box uses. */
export type BoxProfile = {
  enableWeakerNetworkIsolation: true;
  network: { allowedDomains: string[]; deniedDomains: string[]; allowUnixSockets: string[] };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
};

export type BoxPaths = {
  /** The code folder the trial runs: your checkout, or a folder `--against` names. */
  root: string;
  /** The built case folder and the scratch folder: read, and the scratch written. */
  caseDir: string;
  scratch: string;
  /** The trial's own run root and home, inside its folder: written. */
  runRoot: string;
  home: string;
  /** The trial's file, which `defineEnv` appends to. */
  trialFile: string;
  /** The engine's control root, `AWF_CONTROL_ROOT`: short, under `/tmp`, the trial's own. */
  control: string;
  /** What the toolchain needs read: bun, git, each harness's executable and install tree. */
  toolchain: readonly string[];
  /** Paths inside an allowed one that nothing in the box reads: keys, `.git`, records, the store. */
  hidden: readonly string[];
};

const unique = (xs: readonly string[]) => [...new Set(xs)];

/** The box's profile: reach the trial needs, and nothing of keys, the store or the home folder. */
export function boxProfile(paths: BoxPaths, network: readonly string[]): BoxProfile {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  return {
    enableWeakerNetworkIsolation: true,
    // The engine's own sockets, which its agents and `wfa` reach.
    network: {
      allowedDomains: unique(network),
      deniedDomains: [],
      allowUnixSockets: [real(paths.control)],
    },
    filesystem: {
      denyRead: unique([real(homedir()), ...DENIED, ...paths.hidden]),
      allowRead: unique([
        paths.root,
        paths.caseDir,
        paths.scratch,
        paths.runRoot,
        paths.home,
        dirname(paths.trialFile),
        real(paths.control),
        ...paths.toolchain,
      ]),
      allowWrite: unique([
        paths.scratch,
        paths.runRoot,
        paths.home,
        dirname(paths.trialFile),
        real(paths.control),
      ]),
      // srt applies a deny nested in an allowed path after the allow.
      denyWrite: unique([...paths.hidden, paths.root, paths.caseDir]),
    },
  };
}

/**
 * What the box hides inside the code folder it lets the trial read: `.git` (a committed key is in
 * its history), every dataset's keys, the records folder, `hide`'s paths and the store. The home
 * folder is denied whole by `boxProfile`.
 */
export function hiddenOf(root: string, workspace: CaseWorkspace): string[] {
  const hidden = [join(root, ".git"), workspace.store, workspace.labHome, ...ignoredOf(root)];
  for (const path of workspace.hide ?? []) hidden.push(join(root, path));
  if (workspace.records) hidden.push(workspace.records);
  const evals = join(root, workspace.evals.slice(workspace.root.length));
  if (existsSync(evals)) {
    for (const dataset of readdirSync(evals)) {
      const cases = join(evals, dataset, "cases");
      if (!existsSync(cases)) continue;
      for (const name of readdirSync(cases)) {
        hidden.push(join(cases, name, "key.md"), join(cases, name, "key"));
      }
    }
  }
  return hidden;
}

/**
 * What git ignores in the code folder, such as a `.env`, but `node_modules`: the box shows the
 * code as git would hold it, and an install. A folder outside git hides nothing this way.
 */
function ignoredOf(root: string): string[] {
  const listed = Bun.spawnSync(
    [
      "git",
      "-C",
      root,
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
    ],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  if (listed.exitCode !== 0) return [];
  return listed.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replace(/\/$/, ""))
    .filter((path) => !path.split("/").includes("node_modules"))
    .map((path) => join(root, path));
}

/** The realpath an installed package's link leads to, for each link in `node_modules`. */
function linkedPackages(root: string): string[] {
  const found: string[] = [];
  const modules = join(root, "node_modules");
  if (!existsSync(modules)) return found;
  const look = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const at = join(dir, name);
      if (name.startsWith("@")) {
        look(at);
        continue;
      }
      try {
        if (lstatSync(at).isSymbolicLink()) found.push(realpathSync(at));
      } catch {}
    }
  };
  look(modules);
  return found;
}

/** Where an executable on `PATH` lives, by realpath, and its install tree two levels up. */
function installOf(name: string, path: string): string[] {
  for (const dir of path.split(":").filter(Boolean)) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const real = realpathSync(file);
    return unique([dirname(real), dirname(dirname(real)), dirname(file)]);
  }
  return [];
}

/** What the box reads to run the trial: bun, git, the harnesses, and the code's linked packages. */
export function toolchainOf(root: string, path: string): string[] {
  const bun = realpathSync(process.execPath);
  return unique([
    dirname(dirname(bun)),
    ...["git", "claude", "codex", "cursor-agent", "pi"].flatMap((name) => installOf(name, path)),
    ...linkedPackages(root),
  ]);
}

/** The box's network: agents' reach, every harness's model domains, and the hosts code reaches. */
export function boxNetwork(reach: AgentReach, realHosts: readonly string[]): string[] {
  return unique([
    ...reach.network,
    ...Object.values(MODEL_DOMAINS).flat(),
    ...realHosts.filter((h) => h !== "localhost" && h !== "127.0.0.1"),
  ]);
}

/** Writes the profile and returns the command that runs a trial's `awf run` inside the box. */
export function boxCommand(profile: BoxProfile, file: string, srt = "srt"): string[] {
  writeFileSync(file, JSON.stringify(profile, null, 2), { mode: 0o600 });
  return [srt, "-s", file, "--"];
}

/**
 * What the box reads of the `awf` a trial runs: its package, and when it is a checkout of awf, the
 * packages and installs beside it, as the review lab mounts them. Never that checkout's root,
 * which holds `.env`.
 */
export function awfReads(awf: { bin: string; preload?: string }): string[] {
  const reads: string[] = [];
  for (const file of [awf.bin, awf.preload].filter((f): f is string => Boolean(f))) {
    if (!existsSync(file)) continue;
    let at = dirname(realpathSync(file));
    reads.push(at);
    for (; dirname(at) !== at; at = dirname(at)) {
      if (existsSync(join(at, "packages")) && existsSync(join(at, "package.json"))) {
        for (const entry of [
          "packages",
          "examples",
          "node_modules",
          "package.json",
          "tsconfig.json",
          "bunfig.toml",
        ]) {
          if (existsSync(join(at, entry))) reads.push(join(at, entry));
        }
        break;
      }
    }
  }
  return unique(reads);
}

/** The trial's reach under the box: the box itself, which every agent ran in. */
export function boxReach(profile: BoxProfile, agents: readonly string[]) {
  return {
    ok: true,
    problems: [],
    sockets: [],
    sandboxes: [
      {
        key: "lab",
        provider: "srt",
        network: profile.network.allowedDomains,
        webSearch: false,
        agents: [...agents],
      },
    ],
  };
}
