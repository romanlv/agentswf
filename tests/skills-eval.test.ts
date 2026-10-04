import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord } from "../packages/contract/src/records";
import { expected, makeProbe, problems, type Receipt } from "./skills.eval";

const root = await mkdtemp(join(tmpdir(), "awf-skills-eval-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const probes = {
  a: await makeProbe(join(root, "awf-stamp-x"), "awf-stamp-x", "stamp", "release stamp"),
  b: await makeProbe(join(root, "awf-seal-x"), "awf-seal-x", "seal", "audit seal"),
};
const PROBE_OF = {
  "host-codex": "a",
  "host-pi": "b",
  "host-claude": "a",
  "box-codex": "b",
  "box-pi": "a",
} as const;
const builds = Object.fromEntries(Object.keys(PROBE_OF).map((name) => [name, `B-${name}`]));

function honest() {
  const reports = Object.entries(PROBE_OF).map(([agent, probe]) => {
    const field = probe === "a" ? "stamp" : "seal";
    return {
      agent,
      outcome: "answered",
      stamp: "",
      seal: "",
      [field]: expected(probes[probe], field, builds[agent]!),
      skills: [probes[probe].name],
    };
  });
  const record = {
    outcome: "completed",
    value: { reports },
    skills: Object.entries(PROBE_OF).map(([agent, probe]) => ({
      callPath: [],
      agent,
      skills: [
        {
          name: probes[probe].name,
          source: { path: "/x" },
          digest: "sha256:x",
          ...(probe === "b" ? { commit: "c".repeat(40) } : {}),
        },
      ],
    })),
    sandboxes: [{ agents: [{ agent: "box-codex" }, { agent: "box-pi" }] }],
  } as unknown as OutputRecord;
  const receipts: Receipt[] = Object.entries(PROBE_OF).map(([agent, probe]) => ({
    path: `/r/agents/${agent}/skills/${probes[probe].name}/scripts/receipts`,
    builds: [builds[agent]!],
  }));
  return { record, receipts, reports };
}

describe("skills eval checks", () => {
  test("the probe's script makes what the host expects, and leaves a receipt beside itself", async () => {
    const script = join(probes.a.directory, "scripts", "make.sh");
    const child = Bun.spawn({ cmd: [script, "B1"], stdout: "pipe" });
    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe(
      expected(probes.a, "stamp", "B1"),
    );
    expect(await readFile(join(probes.a.directory, "scripts", "receipts"), "utf8")).toBe("B1\n");
    expect(await readFile(join(probes.a.directory, "SKILL.md"), "utf8")).not.toContain(
      probes.a.secret,
    );
  });

  test("honest agents pass", () => {
    const { record, receipts } = honest();
    expect(problems(0, record, probes, builds, receipts, [])).toEqual([]);
  });

  test("each way an agent could fall short or cheat is caught", () => {
    const cases: [string, (run: ReturnType<typeof honest>) => void, string][] = [
      [
        "a wrong value",
        (run) => {
          run.reports[0]!.stamp = "STAMP-0";
        },
        "host-codex: stamp",
      ],
      [
        "the other probe's value",
        (run) => {
          run.reports[0]!.seal = "SEAL-1";
        },
        "host-codex: made a seal",
      ],
      [
        "no receipt: the value was not made by its copy",
        (run) => void run.receipts.splice(1, 1),
        "host-pi: no receipt",
      ],
      [
        "a run's snapshot run instead",
        (run) => run.receipts.push({ path: "/r/skills/sources/u/scripts/receipts", builds: [] }),
        "snapshot",
      ],
      [
        "the other probe run",
        (run) =>
          run.receipts.push({
            path: `/r/skills/${probes.b.name}/scripts/receipts`,
            builds: [builds["host-codex"]!],
          }),
        `host-codex: ran ${probes.b.name}`,
      ],
      [
        "the other probe listed",
        (run) => run.reports[0]!.skills.push(probes.b.name),
        `host-codex: lists ${probes.b.name}`,
      ],
      [
        "an operator's skill listed",
        (run) => run.reports[0]!.skills.push("mine"),
        "operator's mine",
      ],
    ];
    for (const [, spoil, message] of cases) {
      const run = honest();
      spoil(run);
      const found = problems(0, run.record, probes, builds, run.receipts, ["mine"]);
      expect(found.join("\n")).toContain(message);
    }
  });
});
