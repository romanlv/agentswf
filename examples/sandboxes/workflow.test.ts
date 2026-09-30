import { describe, expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import sandboxes, { AUDITOR_COMMANDS, REPORT, TEAM, teamCommands } from "./workflow";

/** Each agent runs its commands, and every one succeeds with a line of output. */
const ran = answer(REPORT, (turn) => ({
  results: (turn.agent === "auditor" ? AUDITOR_COMMANDS : teamCommands(turn.agent)).map(
    (command) => ({ command, output: `ran ${command.split(" ")[0]}`, exitCode: 0 }),
  ),
}));

describe("sandboxes", () => {
  test("the team shares one container; the auditor has a sandbox of its own", async () => {
    const run = await testWorkflow(sandboxes, null, { agents: { "*": ran } });
    expect(run.value.reports.map(({ agent, where }) => [agent, where])).toEqual([
      ["ada", "docker, shared, headed"],
      ["grace", "docker, shared, headed"],
      ["linus", "docker, shared, headed"],
      ["auditor", "srt, private, headless"],
    ]);
    for (const name of TEAM) {
      expect(run.agentOf(name).sandbox).toMatchObject({ key: "team", provider: "docker" });
    }
    const team = run.agentOf("ada").sandbox!;
    expect(team.spec).toMatchObject({ write: [team.spec.cwd], network: ["registry.npmjs.org"] });
    expect(team.domains).toContain("registry.npmjs.org");
    const auditor = run.agentOf("auditor").sandbox!;
    expect(auditor).toMatchObject({ key: "agent:auditor", provider: "srt" });
    expect(auditor.spec).toMatchObject({ read: [], write: [], network: [] });
    expect(auditor.domains).not.toContain("registry.npmjs.org");
    expect(run.agentOf("auditor").execution.placement).toBe("headless");
    expect(run.turnsOf("grace")[0]!.prompt).toContain('1. echo "grace was here" > grace.txt');
  });

  test("the auditor runs only once the whole team has reported", async () => {
    // Each of the team takes a moment to report; the auditor checks they all have.
    const reported = new Set<string>();
    const run = await testWorkflow(sandboxes, null, {
      agents: {
        "*": answer(REPORT, async (turn) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          reported.add(turn.agent);
          return { results: [] };
        }),
        auditor: answer(REPORT, () => {
          if (reported.size < TEAM.length)
            throw new Error(`asked before ${[...reported]} of the team`);
          return { results: [] };
        }),
      },
    });
    expect(run.value.reports).toHaveLength(4);
  });

  test("an agent that ends without a report is reported as its failure, and the rest go on", async () => {
    const run = await testWorkflow(sandboxes, null, {
      agents: { "*": ran, grace: reply.blocked("waiting on a permission prompt") },
    });
    expect(run.value.reports[1]).toEqual({
      agent: "grace",
      where: "docker, shared, headed",
      failure: "blocked: waiting on a permission prompt",
    });
    expect(run.value.reports.filter((report) => report.results)).toHaveLength(3);
    expect(sandboxes.present!(run.value)).toContain(
      "grace (docker, shared, headed)\n  blocked: waiting on a permission prompt",
    );
  });

  test("prints each command with its output, and a failing one's exit code", () => {
    expect(
      sandboxes.present!({
        reports: [
          {
            agent: "auditor",
            where: "srt, private, headless",
            results: [
              { command: "cat *.txt", output: "ada was here\n", exitCode: 0 },
              { command: "touch auditor.txt", output: "Read-only file system", exitCode: 1 },
            ],
          },
        ],
      }),
    ).toBe(
      [
        "auditor (srt, private, headless)",
        "  $ cat *.txt",
        "    ada was here",
        "",
        "  $ touch auditor.txt",
        "    Read-only file system",
        "    [exit 1]",
        "",
      ].join("\n"),
    );
  });

  test("takes no arguments", () => {
    expect(sandboxes.prepare({ argv: [], cwd: "." })).toBeNull();
    expect(() => sandboxes.prepare({ argv: ["x"], cwd: "." })).toThrow("unexpected argument x");
  });
});
