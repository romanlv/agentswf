// Scores results/*.json by runtime against story 029's M2 gate: in 18 of 20 trials the asker ends its
// turn without a blocking wait, and finishes with the answer; the rest is reported.
// bun score.ts [runtime]
// biome-ignore-all lint/suspicious/noExplicitAny: a throwaway reading untyped JSON results
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "results", process.env.RESULTS ?? "main");
const only = process.argv[2];
const runs = readdirSync(dir)
  .filter((file) => file.endsWith(".json") && (!only || file.startsWith(`${only}-`)))
  .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")));

const asks = (tool: string) => /\bsend\b/.test(tool) && /--await-reply/.test(tool);
const blocks = (tool: string) => /\bsleep\b|\bwf["']? waiting\b|\/wf waiting\b/.test(tool);
const peers = (tool: string) => /\/wf peers\b|\bwf peers\b/.test(tool);
// `wf send {peer} --await-reply`: the flag after the peer, which wf refuses.
const flagAfterPeer = (tool: string) => /\bsend\s+[^-\s]\S*\s+--/.test(tool);

const by = new Map<string, any[]>();
for (const run of runs) {
  const key = `${run.runtime} ${run.execution.model}`;
  by.set(key, [...(by.get(key) ?? []), ...run.trials.map((trial: any) => ({ ...trial, run }))]);
}
for (const [key, trials] of [...by].sort()) {
  const tally: Record<string, number> = {};
  const add = (name: string, ok: boolean) => {
    tally[name] = (tally[name] ?? 0) + (ok ? 1 : 0);
  };
  const notes: string[] = [];
  for (const trial of trials) {
    const asked = trial.sent.some((sent: any) => sent.awaits);
    // Every call, the asking one included: a command can wait after its heredoc. Inputs are the
    // summaries `awf logs` keeps, cut near 125 characters.
    const first = trial.tools.findIndex(asks);
    const after = first < 0 ? trial.tools : trial.tools.slice(first);
    const blocked = trial.tools.some(blocks);
    const answered = trial.result?.outcome === "answered" && trial.result.decision === "queue";
    const checkIns = trial.plannerPhases.filter((phase: string) => phase === "check-in-due").length;
    add("asked with --await-reply", asked);
    add("GATE: ended its turn with no blocking wait", asked && !blocked);
    add("GATE: finished with the answer", answered);
    add("GATE: both", asked && !blocked && answered);
    add(
      "turn ended before the reply came (awaiting-reply)",
      trial.plannerPhases.includes("awaiting-reply"),
    );
    add("needed a check-in", checkIns > 0);
    add("answer replied", trial.request.includes("replied"));
    add("architect reminded", trial.architectReminded);
    add(
      "architect answered by plain send, not reply",
      trial.architectSent.some((sent: any) => sent.replyTo === undefined),
    );
    add("peers checked more than twice after asking", after.filter(peers).length > 2);
    add("tried a flag after the peer", trial.tools.some(flagAfterPeer));
    add("a refusal", trial.refused.length > 0);
    if (!answered)
      notes.push(
        `#${trial.index} ${trial.result?.outcome ?? trial.run.outcome}: ${trial.run.reason ?? ""}`,
      );
    if (blocked)
      notes.push(`#${trial.index} blocked: ${after.filter(blocks).join(" | ").slice(0, 160)}`);
    for (const refusal of trial.refused) notes.push(`#${trial.index} refused ${refusal}`);
  }
  const delivered: Record<string, number> = {};
  for (const run of new Set(trials.map((trial) => trial.run))) {
    for (const [state, count] of Object.entries((run as any).deliveries ?? {})) {
      delivered[state] = (delivered[state] ?? 0) + (count as number);
    }
  }
  const cost = new Set(trials.map((trial) => trial.run)).values();
  const usd = [...cost].reduce((sum, run: any) => sum + (run.estimateUsd ?? 0), 0);
  console.log(`\n${key}: ${trials.length} trials, ~$${usd.toFixed(2)} at list prices`);
  for (const [name, count] of Object.entries(tally))
    console.log(`  ${String(count).padStart(3)}/${trials.length}  ${name}`);
  console.log(`  deliveries: ${JSON.stringify(delivered)}`);
  for (const note of notes) console.log(`  - ${note}`);
}
