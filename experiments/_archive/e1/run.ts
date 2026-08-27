import { appendFileSync, mkdirSync } from "node:fs";
import { HARNESSES, type HarnessName } from "./harnesses";
import { runHeadless } from "./headless";
import { runPane } from "./pane";
import { bigPrompt, TRIVIAL } from "./prompts";

const RESULTS = `${import.meta.dir}/results`;
const REPS = 3;
const TIMEOUT_MS = 300_000;

const big = bigPrompt();

/**
 * The trivial prompt contains the word it asks for, so a bare search matches the terminal's own
 * echo. An answer is a later occurrence than the instruction that asked for it.
 */
function answeredTrivial(terminal: string): boolean {
  const cue = terminal.lastIndexOf("Reply with exactly the word:");
  const reply = terminal.lastIndexOf("pong");
  return cue !== -1 && reply > cue + "Reply with exactly the word: pong".length;
}

function answeredBig(terminal: string): boolean {
  return terminal.includes(big.expected);
}

const CASES = {
  trivial: { prompt: TRIVIAL, answered: answeredTrivial, contains: "pong" },
  big: { prompt: big.text, answered: answeredBig, contains: big.expected },
} as const;

type CaseName = keyof typeof CASES;

async function main(): Promise<void> {
  const [backend, harness, caseName] = Bun.argv.slice(2);
  if (backend !== "headless" && backend !== "pane") {
    throw new Error("usage: bun run.ts <headless|pane> <harness> <trivial|big>");
  }
  const name = harness as HarnessName;
  if (!HARNESSES[name]) throw new Error(`unknown harness ${harness}`);
  const probe = CASES[caseName as CaseName];
  if (!probe) throw new Error(`unknown case ${caseName}`);

  mkdirSync(RESULTS, { recursive: true });
  for (let rep = 1; rep <= REPS; rep += 1) {
    const row =
      backend === "headless"
        ? await runHeadless(name, probe.prompt, TIMEOUT_MS)
        : await runPane(name, probe.prompt, probe.answered, TIMEOUT_MS);
    const record = {
      at: new Date().toISOString(),
      backend,
      harness: name,
      case: caseName,
      rep,
      promptBytes: Buffer.byteLength(probe.prompt),
      ...row,
      // Only headless returns the reply itself; the pane's own check is `landedOnWaitAlone`.
      ...("reply" in row && { arrivedWhole: row.reply.includes(probe.contains) }),
    };
    appendFileSync(`${RESULTS}/e1.jsonl`, `${JSON.stringify(record)}\n`);
    console.log(JSON.stringify(record));
  }
}

await main();
