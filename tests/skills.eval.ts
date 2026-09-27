import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTS,
  type AgentName,
  type SkillsPlan,
  type SkillsReport,
} from "../examples/skills-probe/workflow";
import type { OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";

/**
 * Agents given skills, live (story 007): codex, pi and a claude pane on the host, and codex and pi
 * sharing one srt sandbox with different skills. Each must report its own probe's word and list its
 * own probe, not the other agents', and none of the operator's skills. About a minute, on
 * subscriptions; srt must be installed.
 */
const PROBE = join(import.meta.dir, "../examples/skills-probe/workflow.ts");

type Probe = { name: string; word: string; path: string };

export function problems(
  exitCode: number,
  record: OutputRecord | undefined,
  probes: Record<"a" | "b", Probe>,
  operators: readonly string[],
): string[] {
  if (exitCode !== 0 || record?.outcome !== "succeeded") {
    return [`run did not succeed: exit ${exitCode}, outcome ${record?.outcome ?? "missing"}`];
  }
  const found: string[] = [];
  const { reports } = record.value as { reports: SkillsReport[] };
  for (const [name, given] of Object.entries(AGENTS) as [AgentName, (typeof AGENTS)[AgentName]][]) {
    const report = reports.find((candidate) => candidate.agent === name);
    if (!report?.skills) {
      found.push(`${name}: ${report?.outcome ?? "no report"} ${report?.reason ?? ""}`.trim());
      continue;
    }
    const own = probes[given.probe];
    const other = probes[given.probe === "a" ? "b" : "a"];
    if (report.word?.trim() !== own.word)
      found.push(`${name}: word ${report.word}, not ${own.word}`);
    if (!report.skills.includes(own.name)) found.push(`${name}: does not list ${own.name}`);
    if (report.skills.includes(other.name)) found.push(`${name}: lists ${other.name}`);
    const leaked = report.skills.filter((skill) => operators.includes(skill));
    if (leaked.length > 0) found.push(`${name}: lists the operator's ${leaked.join(", ")}`);
    const recorded = record.skills?.find((entry) => entry.agent === name)?.skills;
    if (!Array.isArray(recorded) || recorded[0]?.name !== own.name || !recorded[0].digest) {
      found.push(`${name}: output.json does not record ${own.name}`);
    }
  }
  const boxed = record.sandboxes?.[0]?.agents.map((agent) => agent.agent).sort() ?? [];
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

async function makeProbe(root: string, letter: "a" | "b"): Promise<Probe> {
  const name = `awf-probe-${letter}`;
  const word = `${letter.toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
  const path = join(root, "skills", name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: Gives the probe word. Use when asked for the probe word.\n---\n\nThe probe word is ${word}. Report exactly that.\n`,
  );
  return { name, word, path };
}

if (import.meta.main) {
  if (process.env.WF_LIVE_EVAL !== "1") {
    console.error("WF_LIVE_EVAL=1 is required to start live agents");
    process.exit(1);
  }
  const workDir = await mkdtemp(join(tmpdir(), "awf-skills-"));
  const probes = { a: await makeProbe(workDir, "a"), b: await makeProbe(workDir, "b") };
  const plan: SkillsPlan = {
    probes: { a: probes.a.path, b: probes.b.path },
    agents: Object.keys(AGENTS),
  };
  const repo = join(workDir, "repo");
  await mkdir(repo);
  const output: string[] = [];
  const exitCode = await runOperatorCli(
    [
      "run",
      "--run-root",
      join(workDir, "runs"),
      "--timeout",
      "10m",
      "--json",
      PROBE,
      "--",
      JSON.stringify(plan),
    ],
    {
      cwd: repo,
      signal: interruption(),
      stdout: (text) => output.push(text),
      stderr: (text) => console.error(text),
    },
  );
  const record = output.length > 0 ? (JSON.parse(output.join("\n")) as OutputRecord) : undefined;
  const failed = problems(exitCode, record, probes, await operatorSkills());
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        failed,
        reports: (record?.outcome === "succeeded" ? record.value : undefined) ?? null,
        estimateUsd: record?.accounting.totals.estimate,
        artifacts: record?.artifacts,
      },
      null,
      2,
    ),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

function interruption(): AbortSignal {
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort("SIGINT"));
  process.on("SIGTERM", () => controller.abort("SIGTERM"));
  return controller.signal;
}
