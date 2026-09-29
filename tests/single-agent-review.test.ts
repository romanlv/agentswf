import { afterAll, describe, expect, test } from "bun:test";
import review from "../examples/single-agent-review/workflow";
import { runWorkflow } from "../packages/engine/src";
import { createTempRunDirs, future, submit } from "../packages/engine/src/testing";
import type { AgentSessionAdapter } from "../packages/harness/src/adapter";
import { createSingleSessionHostFactory } from "../packages/harness/src/single-session-host";
import { createFakeAdapter } from "../packages/harness/src/testing/fake";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

describe("examples/single-agent-review", () => {
  test("reads its arguments: a range, the request, a pinned public skill, a runtime", () => {
    const prepare = (argv: string[]) => review.prepare({ argv, cwd: "/work" });
    expect(prepare([])).toMatchObject({ range: "origin/main...HEAD" });
    expect(prepare([])).not.toHaveProperty("skill");
    expect(
      prepare([
        "--range",
        "abc...HEAD",
        "--request",
        "request.md",
        "--skill",
        "owner/repo/code-review@v1.2",
        "--runtime",
        "codex/gpt-6-luna",
      ]),
    ).toEqual({
      range: "abc...HEAD",
      request: "/work/request.md",
      skill: { repo: "owner/repo", skill: "code-review", ref: "v1.2" },
      runtime: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
    });
    expect(() => prepare(["--skill", "code-review"])).toThrow("--skill is owner/repo/skill@ref");
    expect(() => prepare(["--skill", "owner/repo/code-review"])).toThrow("pinned to a ref");
    expect(() => prepare(["--lenses", "a"])).toThrow("unknown flag --lenses");
  });

  test("one agent, the one skill named or none, one turn; its findings are the result", async () => {
    const answer = {
      findings: [
        { file: "src/a.ts", line: 3, severity: "must-fix" as const, claim: "c", evidence: "e" },
      ],
    };
    const adapter = createFakeAdapter({
      harnesses: ["claude", "codex"],
      script: (context) => ({ act: () => submit(context.binding!, answer).then(() => undefined) }),
    });
    // The fake gives no skills; this records what the agent was given and hands on the rest.
    const given: unknown[] = [];
    const recording: AgentSessionAdapter = {
      ...adapter,
      activate: (request) => {
        given.push(request.skills);
        const { skills: _, ...rest } = request;
        return adapter.activate(rest);
      },
    };
    const runtime = { aliases: {}, host: createSingleSessionHostFactory(recording) };
    const cwd = runDirs.tempRunDir();
    const bare = await runWorkflow(
      review.definition,
      review.prepare({ argv: ["--runtime", "codex/luna"], cwd }),
      { runRoot: runDirs.tempRunDir(), runtime, deadline: future(), cwd },
    );
    expect(bare.value).toEqual({ range: "origin/main...HEAD", skill: null, ...answer });
    expect(adapter.turns).toHaveLength(1);
    expect(adapter.turns[0]!.prompt).toContain("git diff origin/main...HEAD");
    expect(adapter.turns[0]!.prompt).not.toContain("title and description are in");
    // No skill named is none at all, not the operator's.
    expect(given).toHaveLength(1);
    expect(given[0]).toBeDefined();
  });
});
