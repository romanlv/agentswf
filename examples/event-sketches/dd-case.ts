// The Datadog watcher's case run, from agent/workflows/datadog-watcher/style-c-sketch.md: one run
// per case, keyed by the case id. A type-checked sketch: the case's files are declared below, and
// so is the emit to its own mailbox its tool's handler needs, which awf doesn't have yet.
import {
  defineEventWorkflow,
  isAnswered,
  type JsonValue,
  type TurnOutcome,
  tool,
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

// The emit to the run's own mailbox, which awf doesn't have yet; until it does, the port reads
// verdict.json when a turn ends.
declare function emitToSelf(
  name: "dd.closed",
  data: ClosedData,
  options?: { id?: string },
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
      const investigator = await workflow.agents.open({
        key: "investigator",
        runtime: "claude",
        cwd: AIR,
        instructions: INVESTIGATOR.standing,
        tools: {
          close_case: tool({
            description: "Close the case when the engineer says it's fixed or noise.",
            // Wrapped again: Type.Omit drops the static type outputSchema gave Closed.
            input: outputSchema(Type.Omit(Closed, ["case", "by"])),
            // No id: a call's id changes when a turn runs again after a crash, and the case's own
            // would drop a close after a reopen. A repeated close is the case's to absorb.
            handler: async (input) => {
              await emitToSelf("dd.closed", { ...input, case: workflow.key, by: "thread" });
              return `Closing the case as ${input.status}.`;
            },
          }),
        },
      });

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
