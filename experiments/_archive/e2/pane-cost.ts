/**
 * What a pane turn cost. Herdr hands back no usage, so the numbers come from claude's own
 * session log, found by the `agent_session` id the pane backend recorded with the trial. Only
 * claude is read here: it is the pane harness whose log is addressable by that id alone.
 *
 * The cache split is the point. A pane keeps one process alive across both turns, so the nudge
 * reads the prompt cache the first turn built instead of rebuilding it; a headless resume is a
 * new process and pays for the cache again. That is the whole difference between a nudge that
 * is cheap and a nudge that costs as much as the work.
 *
 *   bun run e2/pane-cost.ts e2/results/nudge-cost.jsonl
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const path = process.argv[2] ?? `${import.meta.dir}/results/nudge-cost.jsonl`;
const projects = join(process.env.HOME ?? "", ".claude", "projects");

type Turn = { uncachedIn: number; cacheWrite: number; cacheRead: number; out: number };

const empty = (): Turn => ({ uncachedIn: 0, cacheWrite: 0, cacheRead: 0, out: 0 });

/** Assistant messages are attributed to the user message they follow: turn 1, then the nudge. */
async function turns(sessionId: string): Promise<Turn[] | null> {
  for (const project of await readdir(projects)) {
    const file = Bun.file(join(projects, project, `${sessionId}.jsonl`));
    if (!(await file.exists())) continue;
    const found: Turn[] = [];
    for (const line of (await file.text()).split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line) as {
        type?: string;
        isSidechain?: boolean;
        message?: { usage?: Record<string, number> };
      };
      if (row.type === "user" && !row.isSidechain) found.push(empty());
      if (row.type !== "assistant" || !row.message?.usage || found.length === 0) continue;
      const usage = row.message.usage;
      const turn = found.at(-1)!;
      turn.uncachedIn += usage.input_tokens ?? 0;
      turn.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      turn.cacheRead += usage.cache_read_input_tokens ?? 0;
      turn.out += usage.output_tokens ?? 0;
    }
    return found;
  }
  return null;
}

const records = (await Bun.file(path).text())
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as { harness: string; backend: string; sessionRef?: string })
  .filter((record) => record.harness === "claude" && record.backend === "pane" && record.sessionRef);

const totals = [empty(), empty()];
let counted = 0;
for (const record of records) {
  const found = await turns(record.sessionRef!);
  if (!found || found.length < 2) continue;
  counted += 1;
  for (const index of [0, 1]) {
    totals[index]!.uncachedIn += found[index]!.uncachedIn;
    totals[index]!.cacheWrite += found[index]!.cacheWrite;
    totals[index]!.cacheRead += found[index]!.cacheRead;
    totals[index]!.out += found[index]!.out;
  }
}

if (counted === 0) {
  console.log(`no claude pane trial in ${path} had a readable session log`);
} else {
  console.log(`claude pane, mean per turn over ${counted} trials`);
  for (const [index, label] of [[0, "first turn"], [1, "nudge turn"]] as const) {
    const turn = totals[index]!;
    const mean = (value: number) => String(Math.round(value / counted)).padStart(7);
    console.log(
      `  ${label}  uncached-in ${mean(turn.uncachedIn)}  cache-write ${mean(turn.cacheWrite)}  cache-read ${mean(turn.cacheRead)}  out ${mean(turn.out)}`,
    );
  }
}
