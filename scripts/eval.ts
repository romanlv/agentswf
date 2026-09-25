import { basename, join } from "node:path";

/**
 * Runs every live eval, one after another, and totals what they cost. Running this command is the
 * consent to spend, so it sets `WF_LIVE_EVAL=1` for them. Arguments narrow the set by name:
 * `bun run eval harnesses failed-run`. Everything goes to stdout: an eval's progress is on its stderr,
 * which a terminal may paint as errors. Ctrl-C reaches the running eval too, which stops its agents;
 * the runner waits for that and starts no other.
 */
const ROOT = join(import.meta.dir, "..");

type Outcome = { name: string; ok: boolean; seconds: number; estimateUsd?: number };

const all = [...new Bun.Glob("tests/**/*.eval.ts").scanSync({ cwd: ROOT })].sort();
const filters = process.argv.slice(2);
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
for (const file of files) {
  if (interrupted) break;
  const name = nameOf(file);
  console.log(`\n── ${name}`);
  const started = Date.now();
  const child = Bun.spawn([process.execPath, file], {
    cwd: ROOT,
    env: { ...process.env, WF_LIVE_EVAL: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
    child.stderr.pipeTo(new WritableStream({ write: (chunk) => void process.stdout.write(chunk) })),
  ]);
  const summary = lastJsonObject(stdout);
  const estimate = summary?.estimateUsd;
  outcomes.push({
    name,
    ok: exitCode === 0 && summary?.ok === true,
    seconds: Math.round((Date.now() - started) / 1000),
    ...(typeof estimate === "number" ? { estimateUsd: estimate } : {}),
  });
  if (exitCode !== 0) console.log(stdout.trim());
  else if (typeof summary?.artifacts === "string") console.log(`artifacts: ${summary.artifacts}`);
}

console.log("");
for (const outcome of outcomes) {
  console.log(
    `${outcome.ok ? "✓" : "✗"} ${outcome.name.padEnd(16)} ${`${outcome.seconds}s`.padStart(5)}  ${usd(outcome.estimateUsd)}`,
  );
}
const total = outcomes.reduce((sum, outcome) => sum + (outcome.estimateUsd ?? 0), 0);
const unknown = outcomes.filter((outcome) => outcome.estimateUsd === undefined).length;
console.log(
  `${outcomes.filter((outcome) => outcome.ok).length}/${outcomes.length} passed · ${usd(total)} at list prices${unknown > 0 ? `, ${unknown} unknown` : ""}`,
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
