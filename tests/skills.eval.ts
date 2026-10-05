import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTS,
  type AgentName,
  PROBE_FIELD,
  type SkillsPlan,
  type SkillsReport,
} from "../examples/skills-probe/workflow";
import type { OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { assertLiveOptIn, interruption } from "./live";

/**
 * Agents given skills, and using them, live (story 007): codex, pi and a claude pane on the host,
 * and codex and pi sharing one srt sandbox with different probes, cursor in one of its own. The prompt never mentions skills.
 * It asks each agent for a build's release stamp and audit seal; probe A's description claims the
 * stamp, probe B's the seal, and only the script inside each can make its value, from a secret no
 * `SKILL.md` holds, keyed by a build id unique to the agent. So an agent answers only by finding
 * its skill from the description and running the script it was given; the script leaves a receipt
 * beside itself, which must be in the agent's own copy and never in a source or a run's snapshot.
 * Probe A is given by path, probe B from a git repository, so the fetch is live too. About a
 * minute, on subscriptions; srt must be installed.
 */
const PROBE = join(import.meta.dir, "../examples/skills-probe/workflow.ts");

type Probe = { name: string; secret: string; directory: string };

/** What a probe's script prints for `build`: the host's own computation of it. */
export function expected(probe: Pick<Probe, "secret">, field: "stamp" | "seal", build: string) {
  const hash = createHash("sha256").update(`${probe.secret}:${build}`).digest("hex");
  return `${field.toUpperCase()}-${hash.slice(0, 16)}`;
}

/** A receipt under the run root: its path there, from a leading `/`, and the build ids in it. */
export type Receipt = { path: string; builds: string[] };

export function problems(
  exitCode: number,
  record: OutputRecord | undefined,
  probes: Record<"a" | "b", Probe>,
  builds: Record<string, string>,
  receipts: readonly Receipt[],
  operators: readonly string[],
): string[] {
  if (exitCode !== 0 || record?.outcome !== "completed") {
    return [`run did not succeed: exit ${exitCode}, outcome ${record?.outcome ?? "missing"}`];
  }
  const found: string[] = [];
  const snapshots = receipts.filter((receipt) => receipt.path.includes("/skills/sources/"));
  if (snapshots.length > 0) found.push(`a run's snapshot was run: ${snapshots[0]!.path}`);
  const { reports } = record.value as { reports: SkillsReport[] };
  for (const [name, given] of Object.entries(AGENTS) as [AgentName, (typeof AGENTS)[AgentName]][]) {
    const report = reports.find((candidate) => candidate.agent === name);
    if (!report?.skills) {
      found.push(`${name}: ${report?.outcome ?? "no report"} ${report?.reason ?? ""}`.trim());
      continue;
    }
    const build = builds[name]!;
    const mine = given.probe;
    const theirs = mine === "a" ? "b" : "a";
    const own = PROBE_FIELD[mine];
    const want = expected(probes[mine], own, build);
    if (report[own]?.trim() !== want) found.push(`${name}: ${own} ${report[own]}, not ${want}`);
    if (report[PROBE_FIELD[theirs]]?.trim()) {
      found.push(`${name}: made a ${PROBE_FIELD[theirs]} it has no skill for`);
    }
    const ran = receipts.filter((receipt) => receipt.builds.includes(build));
    if (ran.length === 0) found.push(`${name}: no receipt for build ${build}: its copy never ran`);
    if (ran.some((receipt) => !receipt.path.includes(`/${probes[mine].name}/`))) {
      found.push(`${name}: ran ${probes[theirs].name}`);
    }
    if (!report.skills.includes(probes[mine].name)) {
      found.push(`${name}: does not list ${probes[mine].name}`);
    }
    if (report.skills.includes(probes[theirs].name)) {
      found.push(`${name}: lists ${probes[theirs].name}`);
    }
    const leaked = report.skills.filter((skill) => operators.includes(skill));
    if (leaked.length > 0) found.push(`${name}: lists the operator's ${leaked.join(", ")}`);
    const recorded = record.skills?.find((entry) => entry.agent === name)?.skills;
    const entry = Array.isArray(recorded) ? recorded[0] : undefined;
    if (entry?.name !== probes[mine].name || !entry.digest) {
      found.push(`${name}: output.json does not record ${probes[mine].name}`);
    } else if (mine === "b" && !entry.commit) {
      found.push(`${name}: output.json records no commit for ${entry.name}`);
    }
  }
  const box = record.sandboxes?.find((sandbox) => sandbox.key === "box");
  const boxed = box?.agents.map((agent) => agent.agent).sort() ?? [];
  if (boxed.join() !== "box-codex,box-pi") found.push(`sandbox holds ${boxed.join() || "nobody"}`);
  return found;
}

/** Every skill the operator installed for any harness, which no agent given skills may see. */
async function operatorSkills(): Promise<string[]> {
  const roots = [".claude/skills", ".agents/skills", ".codex/skills", ".pi/agent/skills"];
  const names = await Promise.all(
    roots.map((root) => readdir(join(homedir(), root)).catch(() => [] as string[])),
  );
  return [...new Set(names.flat())].filter((name) => !name.startsWith("."));
}

/**
 * A skill whose `SKILL.md` says what it makes and how, and whose script holds the secret. The
 * script appends the build id to `receipts` beside itself, wherever the agent's copy is.
 */
export async function makeProbe(
  directory: string,
  name: string,
  field: "stamp" | "seal",
  what: string,
): Promise<Probe> {
  const secret = randomBytes(12).toString("hex");
  await mkdir(join(directory, "scripts"), { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Makes the ${what} of a build. Use whenever a ${what} is asked for; it cannot be made any other way.\n---\n\n# ${what}\n\nRun \`scripts/make.sh {build id}\` from this skill's directory. It prints the ${what}; give exactly what it prints.\n`,
  );
  const script = join(directory, "scripts", "make.sh");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      'set -eu; [ $# -eq 1 ] || { echo "usage: make.sh {build id}" >&2; exit 2; }',
      `hash=$(printf '%s' "${secret}:$1" | { shasum -a 256 2>/dev/null || sha256sum; } | cut -c1-16)`,
      `printf '%s\\n' "$1" >> "$(dirname "$0")/receipts" 2>/dev/null || true`,
      `echo "${field.toUpperCase()}-$hash"`,
      "",
    ].join("\n"),
  );
  await chmod(script, 0o755);
  return { name, secret, directory };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn({
    cmd: ["git", "-c", "user.name=awf", "-c", "user.email=awf@invalid", ...args],
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await child.exited) !== 0) {
    throw new Error(`git ${args[0]}: ${await new Response(child.stderr).text()}`);
  }
}

async function findReceipts(root: string): Promise<Receipt[]> {
  const found: Receipt[] = [];
  for (const path of await readdir(root, { recursive: true })) {
    if (!path.endsWith("/receipts")) continue;
    const text = await readFile(join(root, path), "utf8").catch(() => "");
    found.push({ path: `/${path}`, builds: text.split("\n").filter(Boolean) });
  }
  return found;
}

if (import.meta.main) {
  assertLiveOptIn();
  const workDir = await mkdtemp(join(tmpdir(), "awf-skills-"));
  const stampName = `awf-stamp-${randomBytes(3).toString("hex")}`;
  const sealName = `awf-seal-${randomBytes(3).toString("hex")}`;
  const sealRepo = join(workDir, "seal-repo");
  const probes = {
    a: await makeProbe(join(workDir, "skills", stampName), stampName, "stamp", "release stamp"),
    b: await makeProbe(join(sealRepo, "skills", sealName), sealName, "seal", "audit seal"),
  };
  await git(sealRepo, "init", "--quiet", "--initial-branch=main");
  await git(sealRepo, "add", ".");
  await git(sealRepo, "commit", "--quiet", "-m", "audit seal skill");
  const builds = Object.fromEntries(
    Object.keys(AGENTS).map((name) => [name, `B${randomBytes(4).toString("hex")}`]),
  );
  const plan: SkillsPlan = {
    probes: {
      a: { path: probes.a.directory },
      b: { repo: `file://${sealRepo}`, skill: sealName },
    },
    builds,
    agents: Object.keys(AGENTS),
  };
  const repo = join(workDir, "work");
  await mkdir(repo);
  const runs = join(workDir, "runs");
  const output: string[] = [];
  const exitCode = await runOperatorCli(
    ["run", "--run-root", runs, "--timeout", "10m", "--json", PROBE, "--", JSON.stringify(plan)],
    {
      cwd: repo,
      signal: interruption(),
      stdout: (text) => output.push(text),
      stderr: (text) => console.error(text),
    },
  );
  const record = output.length > 0 ? (JSON.parse(output.join("\n")) as OutputRecord) : undefined;
  const receipts = await findReceipts(runs).catch(() => []);
  const failed = problems(exitCode, record, probes, builds, receipts, await operatorSkills());
  // A source is never an agent's to run: every copy is made before any agent starts.
  for (const probe of Object.values(probes)) {
    const inSource = await readdir(join(probe.directory, "scripts"));
    if (inSource.includes("receipts")) failed.push(`${probe.name}'s source was run`);
  }
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        failed,
        reports: (record?.outcome === "completed" ? record.value : undefined) ?? null,
        receipts: receipts.map((receipt) => ({ ...receipt, path: receipt.path.slice(1) })),
        estimateUsd: record?.accounting.totals.estimate,
        artifacts: record?.artifacts,
      },
      null,
      2,
    ),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}
