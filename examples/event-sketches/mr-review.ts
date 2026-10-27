// The MR review loop's run, from agent/loops/review-loop/style-c-sketch.md: one run per MR, keyed
// by its iid. The reviewer judges and the code publishes. A type-checked sketch: the ledger and
// GitLab are declared below.
import {
  defineWorkflow,
  isAnswered,
  type OutputSchema,
  type WorkflowContext,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

export const Changes = outputSchema(
  Type.Object({
    iid: Type.Number(),
    head: Type.String(),
    authorized: Type.Boolean(),
    threads: Type.Array(Type.Object({ id: Type.String(), resolved: Type.Boolean() })),
  }),
);
export const Closed = outputSchema(Type.Object({ iid: Type.Number(), merged: Type.Boolean() }));
const Rereview = outputSchema(Type.Object({ iid: Type.Number() }));

export type Finding = {
  id: string;
  severity: "blocker" | "major" | "minor" | "observation";
  verdict: "open" | "fixed" | "withdrawn" | "accepted";
  thread?: string;
  lastNote?: string;
};
export type Pass = {
  findings: Finding[];
  replies: { finding: string; text: string }[];
  verdict: string;
};
export const Pass: OutputSchema<Pass> = {
  type: "object",
  required: ["findings", "replies", "verdict"],
};
export type Ask =
  | { kind: "first"; head: string }
  | { kind: "followup"; from: string; to: string }
  | { kind: "again"; head: string }
  | { kind: "answer"; threads: string[] };
export type Thread = { id: string; resolved: boolean; noteIds: number[] };

export interface Ledger {
  readonly mr: { head: string; authorized: boolean };
  readonly head: string | null;
  readonly archived: boolean;
  readonly retryAt: number | undefined;
  readonly passes: number;
  readonly summaryChanges: number;
  saw(changes: Type.Static<typeof Changes>): void;
  askAgain(): void;
  apply(ask: Ask, pass: Pass): Promise<void>;
  failed(eventId: string): void;
  retrying(): boolean;
  posted(finding: string, note: { noteId: number }): void;
  resolved(finding: string, at: { at: string }): void;
  summarised(note: { noteId: number }): void;
}
declare const Posted: OutputSchema<{ noteId: number }>;
declare const Resolved: OutputSchema<{ at: string }>;
declare const SummaryNote: OutputSchema<{ noteId: number }>;
declare function openLedger(root: string, iid: number): Ledger;
declare const REVIEWS: string;
declare const REVIEWER: { standing: string; compact: { prompt: string } } & Record<
  Ask["kind"],
  string
>;
declare function worktreeOf(iid: number): string;
declare function checkout(iid: number, head: string): Promise<void>;
declare function archive(iid: number, closed: Type.Static<typeof Closed>): Promise<void>;
declare function fill(template: string, values: object): string;
declare function short(commit: string): string;
declare function nextAsk(ledger: Ledger, threads: Thread[]): Ask | null;
declare function postingPlan(
  ledger: Ledger,
  threads: Thread[],
): { post: Finding[]; resolve: Finding[]; summary: "post" | "update" | "cut" | "none" };
declare const gitlab: {
  threads(iid: number): Promise<Thread[]>;
  post(iid: number, finding: Finding, marker: string): Promise<{ noteId: number }>;
  resolve(iid: number, thread: string): Promise<{ at: string }>;
  summary(iid: number, how: string): Promise<{ noteId: number }>;
};

const mrReview = defineWorkflow({
  meta: { name: "mr-review", description: "Review one MR and keep its GitLab threads current." },
  file: import.meta.path,
  events: { "mr.changes": Changes, "mr.closed": Closed, "mr.rereview": Rereview },
  starts: ["mr.changes"],
  async run(workflow) {
    const iid = Number(workflow.runId);
    const ledger = openLedger(REVIEWS, iid);
    const reviewer = await workflow.agents.open({
      key: "reviewer",
      runtime: "claude",
      cwd: worktreeOf(iid),
      instructions: REVIEWER.standing,
    });

    for (;;) {
      const events = await workflow.receive({
        label: `${reviewer.turn ? "reviewing" : "idle"} at ${short(ledger.mr.head)}`,
        until: reviewer.turn || ledger.archived ? undefined : ledger.retryAt,
      });
      for (const e of events) {
        if (e.name === "mr.changes") ledger.saw(e.data);
        if (e.name === "mr.rereview") ledger.askAgain();
        if (reviewer.ended<Ask, Pass>(e)) {
          if (isAnswered(e.data.outcome)) {
            const pass = e.data.outcome.value;
            await workflow.stage(`apply-${e.id}`, () => ledger.apply(e.data.meta, pass));
          } else if (e.data.outcome.kind !== "cancelled") {
            ledger.failed(e.id);
            workflow.log("review pass failed; retried in 15 minutes", {
              outcome: e.data.outcome.kind,
            });
          }
        }
        if (e.name === "mr.closed") {
          await reviewer.turn?.cancel();
          await workflow.stage(`archive-${e.id}`, () => archive(iid, e.data));
          if (e.data.merged) return { merged: true };
        }
      }
      if (reviewer.turn || ledger.retrying() || ledger.archived) continue;

      const threads = await gitlab.threads(iid);
      const ask = nextAsk(ledger, threads);
      if (ask) {
        await checkout(iid, ledger.mr.head);
        await reviewer.start({ prompt: fill(REVIEWER[ask.kind], ask), schema: Pass, meta: ask });
      } else if (ledger.mr.authorized) {
        await publish(workflow, ledger, threads, iid);
        if (ledger.passes > 0)
          await workflow.stage(`compact-after-${ledger.passes}`, async () => {
            await reviewer.compact(REVIEWER.compact);
          });
      }
    }
  },
});
export default mrReview;

async function publish(workflow: WorkflowContext, ledger: Ledger, threads: Thread[], iid: number) {
  const plan = postingPlan(ledger, threads);
  const at = short(ledger.head ?? ledger.mr.head);
  for (const f of plan.post) {
    ledger.posted(
      f.id,
      await workflow.stage(`post-${f.id}@${at}`, { result: Posted }, () =>
        gitlab.post(iid, f, `${iid}@${at}/${f.id}`),
      ),
    );
  }
  for (const f of plan.resolve) {
    const thread = f.thread;
    if (!thread) continue;
    ledger.resolved(
      f.id,
      await workflow.stage(`resolve-${f.id}-${f.lastNote}`, { result: Resolved }, () =>
        gitlab.resolve(iid, thread),
      ),
    );
  }
  if (plan.summary !== "none") {
    const how = plan.summary;
    ledger.summarised(
      await workflow.stage(`summary-${ledger.summaryChanges + 1}`, { result: SummaryNote }, () =>
        gitlab.summary(iid, how),
      ),
    );
  }
}
