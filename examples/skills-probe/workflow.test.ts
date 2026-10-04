import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import probe, { AGENTS, type AgentName, REPORT, type SkillsPlan } from "./workflow";

// Two probe skills on disk, as the host that runs the probe writes them.
const root = mkdtempSync(join(tmpdir(), "skills-probe-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const skill = (name: string) => {
  const path = join(root, name);
  mkdirSync(path);
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Makes a value.\n---\n`);
  return { path };
};
const names = Object.keys(AGENTS) as AgentName[];
const plan: SkillsPlan = {
  probes: { a: skill("probe-a"), b: skill("probe-b") },
  builds: Object.fromEntries(names.map((name) => [name, `build-${name}`])),
  agents: names,
};

/** Each agent makes the value its own probe makes, and sees only that probe. */
const found = answer(REPORT, (turn) => {
  const { probe: given } = AGENTS[turn.agent as AgentName];
  return {
    stamp: given === "a" ? `stamp-${turn.agent}` : "",
    seal: given === "b" ? `seal-${turn.agent}` : "",
    skills: [`probe-${given}`],
  };
});

describe("skills-probe", () => {
  test("each agent is given its own probe, on the host or in the one box", async () => {
    const run = await testWorkflow(probe, plan, { agents: { "*": found } });
    for (const name of names) {
      const agent = run.agentOf(name);
      expect(agent.skills).toEqual([`probe-${AGENTS[name].probe}`]);
      if (AGENTS[name].sandboxed) {
        expect(agent.sandbox).toMatchObject({ key: "box", provider: "srt" });
      } else {
        expect(agent.sandbox).toBeUndefined();
      }
      expect(agent.execution).toMatchObject(AGENTS[name].runtime);
      expect(run.turnsOf(name)[0]!.prompt).toStartWith(`Build build-${name} is ready.`);
    }
    // One agent pinned by hand, so a wrong entry in the table fails it too.
    expect(run.agentOf("box-pi")).toMatchObject({
      execution: { harness: "pi", placement: "headless" },
      skills: ["probe-a"],
      sandbox: { key: "box", provider: "srt" },
    });
    expect(run.value.reports.map((report) => report.agent)).toEqual(names);
    expect(run.value.reports[0]).toEqual({
      agent: "host-codex",
      outcome: "answered",
      stamp: "stamp-host-codex",
      seal: "",
      skills: ["probe-a"],
    });
  });

  test("an agent that doesn't answer is reported with why, and the others still are", async () => {
    const run = await testWorkflow(
      probe,
      { ...plan, agents: ["host-pi", "box-pi"] },
      { agents: { "host-pi": found, "box-pi": reply.failed("pi crashed") } },
    );
    expect(probe.present!({ kind: "completed", value: run.value, stages: [] })).toBe(
      ["host-pi: stamp -, seal seal-host-pi; probe-b", "box-pi: failed: pi crashed"].join("\n"),
    );
  });

  test("takes the plan as one JSON argument, naming only agents it knows, each with a build", () => {
    const prepare = (...argv: string[]) => probe.prepare({ argv, cwd: "." });
    expect(prepare(JSON.stringify(plan))).toEqual(plan);
    expect(() => prepare()).toThrow("pass the skills plan as one JSON argument");
    expect(() => prepare("{}")).toThrow("not a skills plan");
    expect(() => prepare(JSON.stringify({ ...plan, agents: ["host-rust"] }))).toThrow(
      "unknown agent host-rust",
    );
    expect(() => prepare(JSON.stringify({ ...plan, builds: {} }))).toThrow(
      "no build id for host-codex",
    );
  });
});
