// M1 of story 032: does a headless claude and codex session resume after hours, what does the
// resume cost once the prompt cache has expired, and does it still remember the investigation?
//   bun run.ts start    investigate, then one warm resume as the baseline; writes results/state.json
//   bun run.ts resume   the cold resume, hours later; writes results/{runtime}.json
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const results = join(here, "results");
const work = join(here, "work");
const CLAUDE_MODEL = "claude-sonnet-5-5";
const CODEX_MODEL = "gpt-6-luna";

const INVESTIGATE = `You are investigating checkout-api for an on-call coordinator. The logs are in ./logs.
Read them and find when the 5xx errors began, what changed just before, and the likely cause.
Then ask the coordinator one question: this looks like the 2026-10-14 incident on payments-api;
merge the two incidents or keep two? End your answer with that question.`;

const RESUME = `The coordinator answers: "Keep two, and link them."
Without reading any file again, from your investigation: the time the 5xx began, the deploy id,
what it changed, and your conclusion. Then say in one line what you will do next.`;

type Usage = {
  input: number;
  cachedRead: number;
  cacheWrite: number;
  output: number;
  costUsd?: number;
};
type Turn = { at: string; text: string; usage: Usage; ms: number; turns?: number };

function writeLogs(): void {
  mkdirSync(join(work, "logs"), { recursive: true });
  const lines: string[] = [];
  for (let minute = 0; minute < 120; minute++) {
    const t = `2026-10-22T08:${String(minute % 60).padStart(2, "0")}`;
    const hour = minute < 60 ? "08" : "09";
    const stamp = `2026-10-22T${hour}:${String(minute % 60).padStart(2, "0")}`;
    const failing = hour === "09" && minute % 60 >= 12;
    for (let i = 0; i < 6; i++) {
      const status = failing && i % 2 === 0 ? 503 : 200;
      const latency = failing ? 2400 + i * 37 : 80 + i * 3;
      lines.push(
        `${stamp}:${String(i * 9).padStart(2, "0")}Z checkout-api req=${minute}-${i} POST /checkout status=${status} latency_ms=${latency}${failing && i % 2 === 0 ? ' err="db pool exhausted: 10/10 in use"' : ""}`,
      );
    }
    void t;
  }
  writeFileSync(join(work, "logs", "checkout-api.log"), `${lines.join("\n")}\n`);
  writeFileSync(
    join(work, "logs", "deploys.log"),
    [
      "2026-10-21T16:40:00Z deploy 1a2b checkout-api: bump logging library",
      "2026-10-22T07:55:00Z deploy 77d0 search-api: reindex job schedule",
      "2026-10-22T09:10:00Z deploy 8f3c checkout-api: config: db.pool_size 50 -> 10 (cost reduction)",
      "2026-10-22T09:30:00Z deploy 91aa payments-api: retry budget tweak",
    ]
      .join("\n")
      .concat("\n"),
  );
}

async function exec(cmd: string[]): Promise<{ out: string; ms: number }> {
  const started = Date.now();
  const proc = Bun.spawn(cmd, { cwd: work, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) throw new Error(`${cmd[0]} failed: ${err.slice(-2000)}`);
  return { out, ms: Date.now() - started };
}

async function claude(prompt: string, session?: string): Promise<Turn & { session: string }> {
  const { out, ms } = await exec([
    "claude",
    "-p",
    "--model",
    CLAUDE_MODEL,
    "--output-format",
    "json",
    "--allowedTools=Read,Grep,Glob,Bash(ls:*),Bash(grep:*),Bash(cat:*)",
    ...(session ? ["--resume", session] : []),
    prompt,
  ]);
  const json = JSON.parse(out);
  const u = json.usage ?? {};
  return {
    at: new Date().toISOString(),
    session: json.session_id,
    text: json.result,
    ms,
    turns: json.num_turns,
    usage: {
      input: u.input_tokens ?? 0,
      cachedRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      costUsd: json.total_cost_usd,
    },
  };
}

async function codex(prompt: string, session?: string): Promise<Turn & { session: string }> {
  const { out, ms } = await exec(
    session
      ? ["codex", "exec", "resume", session, "--json", "--skip-git-repo-check", prompt]
      : [
          "codex",
          "exec",
          "--json",
          "-m",
          CODEX_MODEL,
          "--skip-git-repo-check",
          "-s",
          "read-only",
          prompt,
        ],
  );
  let id = session ?? "";
  let text = "";
  const usage: Usage = { input: 0, cachedRead: 0, cacheWrite: 0, output: 0 };
  let turns = 0;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "thread.started") id = event.thread_id;
    if (event.type === "item.completed" && event.item?.type === "agent_message")
      text = event.item.text;
    if (event.type === "item.completed" && event.item?.type === "command_execution") turns++;
    if (event.type === "turn.completed") {
      usage.input += event.usage?.input_tokens ?? 0;
      usage.cachedRead += event.usage?.cached_input_tokens ?? 0;
      usage.output += event.usage?.output_tokens ?? 0;
    }
  }
  return { at: new Date().toISOString(), session: id, text, ms, turns, usage };
}

const runners = { claude, codex };

if (process.argv[2] === "start") {
  mkdirSync(results, { recursive: true });
  writeLogs();
  const state: Record<string, { session: string; investigate: Turn; warm: Turn }> = {};
  for (const [name, run] of Object.entries(runners)) {
    const investigate = await run(INVESTIGATE);
    const warm = await run(
      "Before the coordinator answers: in one line, which deploy do you suspect?",
      investigate.session,
    );
    state[name] = { session: investigate.session, investigate, warm };
    console.log(name, investigate.session, JSON.stringify(warm.usage));
  }
  writeFileSync(join(results, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
} else if (process.argv[2] === "resume") {
  const state = JSON.parse(readFileSync(join(results, "state.json"), "utf8"));
  for (const [name, run] of Object.entries(runners)) {
    const cold = await run(RESUME, state[name].session);
    const remembered = {
      time: /09:1[0-2]/.test(cold.text),
      deploy: /8f3c/.test(cold.text),
      change: /50\D{1,12}10/.test(cold.text),
    };
    const hours = (Date.parse(cold.at) - Date.parse(state[name].warm.at)) / 3_600_000;
    writeFileSync(
      join(results, `${name}.json`),
      `${JSON.stringify({ ...state[name], cold, hours, remembered }, null, 2)}\n`,
    );
    console.log(
      name,
      hours.toFixed(2),
      "h",
      JSON.stringify(cold.usage),
      JSON.stringify(remembered),
    );
  }
} else {
  console.error("bun run.ts start | resume");
  process.exit(2);
}
