// The Datadog watcher's triage tick, from its style-c sketch: it triages signals into cases and
// tells each changed case's run. Declared below: the case files' writer, and what the tick uses
// from beyond story 034 (`singleton`).
import { defineWorkflow, type JsonValue, type OutputSchema } from "agentswf/workflow";
import caseRun from "./dd-case";

type Change = {
  id: string;
  reopened: boolean;
  closed?: { status: "closed" | "noise"; why: string };
};
type Triaged = { decisions: JsonValue[]; sources: { ok: boolean }[] };
declare const Triage: OutputSchema<Triaged>;
declare const Changed: OutputSchema<Change[]>;
declare const Commits: OutputSchema<Record<string, string>>;
declare function openCases(root: string): {
  lastTick(): string;
  apply(decisions: JsonValue[], options: { maxNew: number }): Promise<Change[]>;
  commit(changed: Change[]): Promise<Record<string, string>>;
};
declare const DD_CASES: string;
declare const TRIAGE: { prompt: string };
declare function fill(template: string, values: Record<string, string>): string;

// Beyond story 034.
declare function singleton<W>(workflow: W): W;

type Tick = { changed: number; skipped?: string };

export default singleton(
  defineWorkflow({
    meta: { name: "dd-tick", description: "Triage Datadog signals into cases." },
    async run(wf): Promise<Tick> {
      // A window of some models' only, as `week (Fable)`, doesn't limit the triage's sonnet.
      const plan = await wf.allowance("claude");
      if (plan.read === "plan" && plan.windows.some((w) => !w.models && w.usedPercent >= 80))
        return { changed: 0, skipped: "claude's plan is over 80% used" };
      const cases = openCases(DD_CASES);
      const triage = await wf.agents.open({
        key: "triage",
        runtime: "claude",
        cwd: DD_CASES,
      });

      const { decisions, sources } = await wf.stage("triage", { result: Triage }, async () => {
        const { outcome } = await triage.run({
          prompt: fill(TRIAGE.prompt, { lastTick: cases.lastTick() }),
          schema: Triage,
        });
        if (!outcome.answered) throw new Error(`triage: ${outcome.kind}`);
        return outcome.value;
      });
      if (sources.some((s) => !s.ok)) return { changed: 0, skipped: "a pull failed" };

      const changed = await wf.stage("write", { result: Changed }, () =>
        cases.apply(decisions, { maxNew: 3 }),
      );
      const commits = await wf.stage("commit", { result: Commits }, () => cases.commit(changed));
      for (const c of changed) {
        const commit = commits[c.id] ?? c.id;
        await wf.emit(
          caseRun,
          c.id,
          "dd.changes",
          { case: c.id, reopened: c.reopened },
          { eventId: commit },
        );
        if (c.closed) {
          await wf.emit(
            caseRun,
            c.id,
            "dd.closed",
            { case: c.id, ...c.closed, by: "triage" },
            { eventId: `${commit}-closed` },
          );
        }
      }
      return { changed: changed.length };
    },
  }),
);
