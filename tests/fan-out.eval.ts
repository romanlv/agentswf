import { join } from "node:path";
import type { OutputRecord } from "../packages/contract/src/records";
import type { FanOutAnswer } from "./fixtures/fan-out";
import { assertLiveOptIn, recorded, report, runLive } from "./live";

/**
 * Twelve codex, six claude and four cursor TUI agents prompted at once, twice each (story concurrent-agents):
 * with twelve codex panes busy, Herdr missed half their turns and showed the rest's end past the
 * release. Every answer must be right, and the run end with no cleanup left unresolved.
 * `bun tests/fan-out.eval.ts codex=4` runs fewer. 22 agents, ~1 min, ~$0.65 at list prices.
 */
const FAN_OUT = join(import.meta.dir, "fixtures/fan-out.ts");

export function problems(exitCode: number, record: OutputRecord | undefined): string[] {
  if (exitCode !== 0 || record?.outcome !== "completed") {
    const reason = record && "reason" in record ? `: ${record.reason}` : "";
    return [
      `run did not succeed: exit ${exitCode}, outcome ${record?.outcome ?? "missing"}${reason}`,
    ];
  }
  const found: string[] = [];
  for (const agent of record.value as FanOutAnswer[]) {
    const right = agent.answers.filter((answer, at) => answer === agent.expected[at]).length;
    if (right !== agent.expected.length) {
      found.push(
        `${agent.agent}: ${right} of ${agent.expected.length} right (${agent.outcomes.join(", ")}${
          agent.reasons.length > 0 ? `: ${agent.reasons.join("; ")}` : ""
        })`,
      );
    }
  }
  return found;
}

if (import.meta.main) {
  assertLiveOptIn();
  const startedAt = Date.now();
  const { exitCode, record } = await runLive("fan-out", FAN_OUT, process.argv.slice(2), {
    timeout: "10m",
  });
  report(problems(exitCode, record), {
    seconds: Math.round((Date.now() - startedAt) / 1000),
    ...recorded(record),
  });
}
