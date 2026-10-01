import { basename, join } from "node:path";

/**
 * Runs every live eval, `--jobs` at a time (4 by default), and totals what they cost. Running this
 * command is the consent to spend, so it sets `AWF_LIVE_EVAL=1` for them. Arguments narrow the set
 * by name: `bun run eval harnesses failed-run`. Each eval's output, its stderr progress included, is
 * printed in one block when it ends, all to stdout. Ctrl-C reaches the running evals too, which
 * stop their agents; the runner waits for them and starts no other.
 */
const ROOT = join(import.meta.dir, "..");

type Outcome = {
  name: string;
  ok: boolean;
  skipped: boolean;
  seconds: number;
  estimateUsd?: number;
};

const all = [...new Bun.Glob("tests/**/*.eval.ts").scanSync({ cwd: ROOT })].sort();
const args = process.argv.slice(2);
const jobsAt = args.indexOf("--jobs");
const jobs = jobsAt < 0 ? 4 : Number(args[jobsAt + 1]);
if (!Number.isInteger(jobs) || jobs < 1) {
  console.error("--jobs takes a whole number of evals to run at once");
  process.exit(2);
}
const filters =
  jobsAt < 0 ? args : args.filter((_, index) => index !== jobsAt && index !== jobsAt + 1);
const unmatched = filters.filter((filter) => !all.some((file) => nameOf(file) === filter));
if (unmatched.length > 0) {
  console.error(`no eval named ${unmatched.join(", ")}; expected ${all.map(nameOf).join(", ")}`);
  process.exit(2);
}
const files = all.filter((file) => filters.length === 0 || filters.includes(nameOf(file)));

let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    interrupted = true;
  });
}

const outcomes: Outcome[] = [];
const queue = [...files];
async function worker(): Promise<void> {
  for (let file = queue.shift(); file && !interrupted; file = queue.shift()) {
    outcomes.push(await runEval(file));
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
outcomes.sort((a, b) => a.name.localeCompare(b.name));

async function runEval(file: string): Promise<Outcome> {
  const name = nameOf(file);
  const started = Date.now();
  const child = Bun.spawn([process.execPath, file], {
    cwd: ROOT,
    env: { ...process.env, AWF_LIVE_EVAL: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const summary = lastJsonObject(stdout);
  const estimate = summary?.estimateUsd;
  const outcome: Outcome = {
    name,
    ok: exitCode === 0 && summary?.ok === true,
    // A pass that checked nothing is not shown as one.
    skipped: summary?.skipped === true,
    seconds: Math.round((Date.now() - started) / 1000),
    ...(typeof estimate === "number" ? { estimateUsd: estimate } : {}),
  };
  const block = [`\n── ${name}`, stderr.trimEnd()];
  if (exitCode !== 0) block.push(stdout.trim());
  else if (typeof summary?.artifacts === "string") block.push(`artifacts: ${summary.artifacts}`);
  console.log(block.filter(Boolean).join("\n"));
  return outcome;
}

console.log("");
for (const outcome of outcomes) {
  console.log(
    `${outcome.skipped ? "–" : outcome.ok ? "✓" : "✗"} ${outcome.name.padEnd(16)} ${`${outcome.seconds}s`.padStart(5)}  ${usd(outcome.estimateUsd)}`,
  );
}
const total = outcomes.reduce((sum, outcome) => sum + (outcome.estimateUsd ?? 0), 0);
const unknown = outcomes.filter((outcome) => outcome.estimateUsd === undefined).length;
const skipped = outcomes.filter((outcome) => outcome.skipped).length;
console.log(
  `${outcomes.filter((outcome) => outcome.ok && !outcome.skipped).length}/${outcomes.length} passed${skipped > 0 ? `, ${skipped} skipped` : ""} · ${usd(total)} at list prices${unknown > 0 ? `, ${unknown} unknown` : ""}`,
);
if (interrupted) console.log(`interrupted; ${files.length - outcomes.length} not run`);
if (interrupted || outcomes.some((outcome) => !outcome.ok)) process.exitCode = 1;

function nameOf(file: string): string {
  return basename(file, ".eval.ts");
}

function usd(amount: number | undefined): string {
  if (amount === undefined) return "cost unknown";
  return amount < 0.005 ? "<$0.01" : `~$${amount.toFixed(2)}`;
}

/** An eval prints its summary last; the minimum-review one prints only that object. */
function lastJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.lastIndexOf("\n{");
  for (const from of [start + 1, 0]) {
    try {
      const value: unknown = JSON.parse(text.slice(from));
      if (value && typeof value === "object") return value as Record<string, unknown>;
    } catch {}
  }
  return undefined;
}
