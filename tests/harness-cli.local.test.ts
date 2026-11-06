import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord } from "../packages/contract/src/records";
import {
  resultCommand,
  type ScriptedModel,
  scriptedHomes,
  startScriptedModel,
} from "../packages/harness/src/testing/scripted-model";
import type { ScriptedAnswers } from "./fixtures/scripted-model.workflow";

// A local test: the installed harness CLIs, driven by a real `awf run`, with a scripted model in
// place of a provider. Free, and a second or two a harness. Each harness is skipped where its CLI
// is not installed, except in CI, which installs them all.
const AWF = join(import.meta.dir, "../packages/agentswf/src/awf.ts");
const WORKFLOW = join(import.meta.dir, "fixtures/scripted-model.workflow.ts");
const HARNESSES = { pi: "pi", codex: "codex", claude: "claude" } as const;
const required = Boolean(process.env.CI);

/**
 * Answers the first prompt's number, and the second turn that number plus 9, read from the
 * session's history: only a resumed session still holds it.
 */
function script(request: Parameters<Parameters<typeof startScriptedModel>[0]>[0]) {
  if (request.afterToolResult) return { text: "Reported." };
  const reported = /Report the number (\d+)/.exec(request.userTexts.join("\n"))?.[1];
  const added = /Add 9 to the number/.test(request.userTexts.at(-1) ?? "");
  const command =
    reported && resultCommand(request, { answer: Number(reported) + (added ? 9 : 0) });
  return command ? { shell: command } : { text: "No number to report." };
}

describe("the harness CLIs end to end, on a scripted model", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "awf-scripted-")));
  let model: ScriptedModel;
  let homes: Record<string, string>;

  beforeAll(async () => {
    model = startScriptedModel(script);
    homes = await scriptedHomes(join(root, "state"), model);
  });

  afterAll(async () => {
    await model.stop();
    await rm(root, { recursive: true, force: true });
  });

  for (const [runtime, command] of Object.entries(HARNESSES)) {
    const installed = Bun.which(command) !== null;
    test.skipIf(!installed && !required)(
      `${runtime} answers two turns of one session through wfa result`,
      async () => {
        expect(installed).toBe(true);
        const work = join(root, runtime);
        await mkdir(work, { recursive: true });
        const awf = Bun.spawn(
          [
            process.execPath,
            AWF,
            "run",
            "--json",
            "--run-root",
            join(work, "runs"),
            WORKFLOW,
            "--",
            runtime,
          ],
          {
            cwd: work,
            env: { ...process.env, ...homes },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(awf.stdout).text(),
          new Response(awf.stderr).text(),
          awf.exited,
        ]);
        const record = stdout.trim() ? (JSON.parse(stdout) as OutputRecord) : undefined;
        if (record?.outcome !== "completed") {
          throw new Error(`run did not complete: exit ${exitCode}\n${stderr}`);
        }
        expect(record.value as ScriptedAnswers).toEqual({
          outcomes: ["answered", "answered"],
          answers: [17, 26],
          reasons: [],
        });
        // The harness's own records were read: what the scripted model reported it used.
        const [agent] = record.accounting.byAgent;
        expect(agent?.known).toBe(agent?.agents);
        expect(record.accounting.totals.tokens.input).toBeGreaterThan(0);
      },
      60_000,
    );
  }
});
