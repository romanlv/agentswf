// The Datadog watcher's case run, from agent/workflows/datadog-watcher/style-c-sketch.md: one run
// per case, keyed by the case id. A type-checked sketch: the case's files are declared below, and
// so is what it uses from beyond story 034 (tools, and the emit to its own mailbox they need).
import {
  type AgentOpenSpec,
  defineEventWorkflow,
  isAnswered,
  type JsonValue,
  type TurnOutcome,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

export const Changes = outputSchema(
  Type.Object({ case: Type.String(), reopened: Type.Optional(Type.Boolean()) }),
);
export const Closed = outputSchema(
  Type.Object({
    case: Type.String(),
    status: Type.Union([Type.Literal("closed"), Type.Literal("noise")]),
    why: Type.String(),
    by: Type.Union([Type.Literal("triage"), Type.Literal("thread")]),
  }),
);
type ClosedData = Type.Static<typeof Closed>;

/** What a turn is given, which its end carries back in `meta`. */
export type Batch = {
  occurrences: number;
  replies: string[];
  writeUp: "first" | "reopen" | "close" | null;
};

export const DAY = 24 * 60 * 60 * 1000;

// The case's files in dd-cases, owned by the watcher, not awf.
export interface Case {
  readonly title: string;
  unseen(): { newSignal: boolean; gapBefore?: number }[];
  pendingReplies(): string[];
  pending(): Batch;
  writeUpDue(): Batch["writeUp"];
  closed(): boolean;
  retrying(): boolean;
  retryAt(): number | undefined;
  failuresInARow(): number;
  markGiven(given: Batch): void;
  markFailed(eventId: string): void;
  addReply(eventId: string, reply: { text: string; author?: string }): void;
  close(closed: ClosedData, at: string): Promise<void>;
}
declare function openCase(root: string, key: string): Case;
declare const DD_CASES: string;
declare const AIR: string;
declare const INVESTIGATOR: { standing: string } & Record<
  "first" | "reopen" | "close" | "closedReply" | "update",
  string
>;
declare function fill(template: string, ...values: unknown[]): string;
declare function failedNote(outcome: TurnOutcome<JsonValue>): string;

// Beyond story 034: tools an agent calls (workflow-tools), and the emit to the run's own mailbox
// their handlers use. Until then the port reads verdict.json when a turn ends.
type Tool<Input> = {
  description: string;
  input: unknown;
  handler: (input: Input, call: { id: string }) => Promise<unknown>;
};
declare function withTools(
  spec: AgentOpenSpec,
  tools: Record<string, Tool<{ status: "closed" | "noise"; why: string }>>,
): AgentOpenSpec;
declare function emitToSelf(
  name: "dd.closed",
  data: ClosedData,
  options: { id: string },
): Promise<unknown>;

const caseRun = defineEventWorkflow({
  definition: {
    meta: {
      name: "dd-case",
      description: "Investigate one Datadog case in its own #dd-watch thread.",
    },
    file: import.meta.path,
    events: { "dd.changes": Changes, "dd.closed": Closed },
    key: (e) => e.data.case,
    starts: ["dd.changes"],
    async run(workflow) {
      const kase = openCase(DD_CASES, workflow.key);
      const thread = await workflow.participants.connect({
        key: "thread",
        to: "code",
        labels: { title: kase.title },
      });
      const investigator = await workflow.agents.open(
        withTools(
          { key: "investigator", runtime: "claude", cwd: AIR, instructions: INVESTIGATOR.standing },
          {
            close_case: {
              description: "Close the case when the engineer says it's fixed or noise.",
              input: Type.Omit(Closed, ["case", "by"]),
              handler: (input, call) =>
                emitToSelf(
                  "dd.closed",
                  { ...input, case: workflow.key, by: "thread" },
                  { id: call.id.toLowerCase() },
                ),
            },
          },
        ),
      );

      for (;;) {
        const events = await workflow.receive({
          label: investigator.turn ? "investigating" : `${kase.unseen().length} unseen`,
          until: !investigator.turn && needsTurn(kase) ? kase.retryAt() : undefined,
        });
        for (const e of events) {
          if (investigator.ended<Batch>(e)) {
            if (isAnswered(e.data.outcome)) kase.markGiven(e.data.meta);
            else if (e.data.outcome.kind !== "cancelled") {
              kase.markFailed(e.id);
              if (kase.failuresInARow() === 1)
                await workflow.stage(`failed-${e.id}`, () =>
                  thread.post(failedNote(e.data.outcome)),
                );
            }
          }
          if (thread.replied(e)) kase.addReply(e.id, e.data);
          if (e.name === "dd.closed") {
            if (e.data.by === "triage") await investigator.turn?.cancel();
            await workflow.stage(`close-${e.id}`, () => kase.close(e.data, e.at));
          }
        }
        if (!investigator.turn && !kase.retrying() && needsTurn(kase)) {
          const given = kase.pending();
          await investigator.start({ prompt: promptFor(kase, given), meta: given });
        }
      }
    },
  },
});
export default caseRun;

export function needsTurn(kase: Case): boolean {
  if (kase.writeUpDue() || kase.pendingReplies().length > 0) return true;
  if (kase.closed()) return false;
  const unseen = kase.unseen();
  return (
    unseen.some((o) => o.newSignal) || unseen.length >= 50 || (unseen[0]?.gapBefore ?? 0) >= 7 * DAY
  );
}

function promptFor(kase: Case, given: Batch): string {
  const due = kase.writeUpDue();
  if (due) return fill(INVESTIGATOR[due], kase, given);
  return kase.closed() ? fill(INVESTIGATOR.closedReply, given) : fill(INVESTIGATOR.update, given);
}
