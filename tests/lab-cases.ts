import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrialRecord } from "../packages/lab/src/cases/format/records";
import { runCases } from "../packages/lab/src/cases/lab/cli";
import { readTrials } from "../packages/lab/src/cases/lab/store";

/**
 * A tool handler calling a mocked module, live (story 044): awf-lab runs one case of a project
 * whose workflow gives a real agent a `lookup` tool. Its handler calls `directory.find`, whose real
 * export throws; the case's `env.ts` mocks it to return {@link FAKE}. The agent must call the tool
 * and answer with what it got, so the handler ran in the trial's process, where the mocks are.
 */
const REPO = join(import.meta.dir, "..");
/** What the mocked `find` returns; the real one throws. */
export const FAKE = "room-7-violet";
export const MODEL = "claude-haiku-5-5";

// The project's sources, spelled so the boundary checker never reads them as this file's imports.
const from = (spec: string) => `from "${spec}"`;
const lazy = (spec: string) => `${"import"}("${spec}")`;

const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json" }),
  "app/directory.ts": [
    "/** Where a person sits; the real directory is never reached from a case. */",
    "export function find(name: string): string {",
    '  throw new Error("the real directory was reached for " + name);',
    "}",
    "",
  ].join("\n"),
  "app/workflow.ts": [
    `import Type ${from("typebox")};`,
    `import { defineWorkflow, tool } ${from("agentswf/workflow")};`,
    `import { find } ${from("./directory")};`,
    "",
    "const Answer = Type.Object({ room: Type.String() }, { additionalProperties: false });",
    "",
    "export default defineWorkflow<Record<string, never>, { room: string | null; outcome: string }>({",
    '  meta: { name: "lookup", description: "An agent looks up a room through a tool." },',
    "  prepare: () => ({}),",
    "  run: async (wf) => {",
    "    const agent = await wf.agents.open({",
    '      key: "asker",',
    `      runtime: { harness: "claude", model: "${MODEL}", placement: "headless", metered: true },`,
    "      sandbox: { srt: {}, write: [], network: [] },",
    "      tools: {",
    "        lookup: tool({",
    '          description: "The room where Ada sits.",',
    '          handler: () => find("Ada"),',
    "        }),",
    "      },",
    "    });",
    "    const { outcome } = await agent.run({",
    '      prompt: "Call your lookup tool once, then answer with the room it gave, word for word.",',
    "      schema: Answer,",
    '      timeout: "3m",',
    "    });",
    "    await agent.close();",
    "    return { room: outcome.answered ? outcome.value.room : null, outcome: outcome.kind };",
    "  },",
    "});",
    "",
  ].join("\n"),
  "evals/awf-lab.json": JSON.stringify({ kind: "awf.lab-workspace/0" }),
  "evals/lookup/dataset.json": JSON.stringify({
    kind: "awf.case-dataset/0",
    sandbox: "workflow",
    agentReach: { network: [] },
    timeout: "5m",
    setupTimeout: "1m",
  }),
  "evals/lookup/env.ts": [
    `import { defineEnv } ${from("@agentswf/lab/cases")};`,
    `import * as directory ${from("../../app/directory")};`,
    "",
    "export default defineEnv({",
    `  workflow: () => ${lazy("../../app/workflow")},`,
    "  setup(c) {",
    `    const spies = c.mock(directory, { find: () => "${FAKE}" });`,
    "    return {",
    "      observe: (result) => ({",
    "        room: result.room,",
    "        outcome: result.outcome,",
    "        calls: spies.find.mock.calls.length,",
    "      }),",
    "    };",
    "  },",
    "});",
    "",
  ].join("\n"),
  "evals/lookup/cases/ada/input.json": "{}",
  "evals/lookup/cases/ada/key.md": [
    "---",
    "kind: awf.case-key/0",
    "marker: harbor-violet-pepper-anvil",
    "expect:",
    `  room: "${FAKE}"`,
    '  outcome: "answered"',
    "  calls: 1",
    "---",
    "",
    "The agent calls the tool once and answers with the mocked room.",
    "",
  ].join("\n"),
};

export type Evidence = {
  exitCode: number;
  out: string;
  err: string;
  trial?: TrialRecord;
  /** The `expect` grader's verdict, from the trial's latest score. */
  verdict?: string;
  store?: string;
};

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

/**
 * Builds the project under `tests/`, so `tsconfig.base.json` and TypeScript resolve from this
 * checkout, links its `agentswf`, lab and `typebox` as `bun link` would, runs the case once and
 * removes the project. The lab's store is left in a temporary home, for the run's records.
 */
export async function gather(): Promise<Evidence> {
  const project = realpathSync(mkdtempSync(join(import.meta.dir, ".lab-cases-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "awf-lab-cases-")));
  try {
    for (const [path, text] of Object.entries(FILES)) {
      mkdirSync(join(project, path, ".."), { recursive: true });
      writeFileSync(join(project, path), text);
    }
    const modules = join(project, "node_modules");
    mkdirSync(join(modules, "@agentswf"), { recursive: true });
    symlinkSync(realpathSync(join(REPO, "packages/agentswf")), join(modules, "agentswf"));
    symlinkSync(realpathSync(join(REPO, "packages/lab")), join(modules, "@agentswf/lab"));
    symlinkSync(
      realpathSync(join(REPO, "packages/engine/node_modules/typebox")),
      join(modules, "typebox"),
    );
    git(project, "init", "-q", "-b", "main");
    git(project, "add", "-A");
    git(project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");

    const out: string[] = [];
    const err: string[] = [];
    const exitCode = await runCases(["run", "--trials", "1", "--yes"], {
      cwd: project,
      home,
      env: { ...process.env },
      stdout: (text) => out.push(text),
      stderr: (text) => {
        err.push(text);
        console.error(text);
      },
    });
    const lab = join(home, ".awf/lab");
    const name = readdirSync(lab).find((each) => each.startsWith(".lab-cases-"));
    const store = name ? join(lab, name) : undefined;
    const stored = store ? readTrials(store, 1)[0] : undefined;
    const trial = stored?.record;
    const verdict = stored?.scores
      .at(-1)
      ?.entries.find((each) => each.grader === "expect")?.verdict;
    return {
      exitCode,
      out: out.join("\n"),
      err: err.join("\n"),
      ...(trial ? { trial } : {}),
      ...(verdict ? { verdict } : {}),
      ...(store ? { store } : {}),
    };
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

/** What the run must show: the trial passed on the mocked room, with no call refused. */
export function problems(evidence: Evidence): string[] {
  const found: string[] = [];
  if (evidence.exitCode !== 0) found.push(`awf-lab exited ${evidence.exitCode}`);
  const { trial } = evidence;
  if (!trial) return [...found, "no trial record"];
  if (evidence.verdict !== "passed") found.push(`expect: ${evidence.verdict ?? "no verdict"}`);
  if (trial.facts?.room !== FAKE)
    found.push(`room ${JSON.stringify(trial.facts?.room)}, not the mocked ${FAKE}`);
  if (trial.facts?.calls !== 1) found.push(`find called ${trial.facts?.calls ?? "?"} times`);
  if (trial.refused.length > 0)
    found.push(`refused: ${trial.refused.map((each) => each.what).join(", ")}`);
  if (trial.workflowError) found.push(`workflow error: ${trial.workflowError}`);
  return found;
}
