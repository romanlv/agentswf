import {
  defineEventWorkflow,
  defineExecutableWorkflow,
  type ExecutableEventWorkflow,
  type ExecutableWorkflow,
  isAnswered,
  type OutputSchema,
  type WorkflowContext,
} from "./index";

declare const Changes: OutputSchema<{ case: string; occurrences: number }>;
declare const Closed: OutputSchema<{ case: string; by: "triage" | "thread" }>;
declare const context: WorkflowContext;

type Given = { occurrences: number };

const caseRun = defineEventWorkflow({
  definition: {
    meta: { name: "dd-case", description: "One case." },
    file: import.meta.path,
    events: { "dd.changes": Changes, "dd.closed": Closed },
    key: (e) => e.data.case,
    starts: ["dd.changes"],
    async run(workflow) {
      const thread = await workflow.participants.connect({ key: "thread", to: "code" });
      const investigator = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      for (;;) {
        const events = await workflow.receive({ label: workflow.key, until: Date.now() });
        for (const e of events) {
          if (investigator.ended<Given>(e)) {
            const given: Given = e.data.meta;
            if (isAnswered(e.data.outcome)) void given.occurrences;
          }
          if (thread.replied(e)) void e.data.text.length;
          if (e.name === "dd.closed") {
            const by: "triage" | "thread" = e.data.by;
            void by;
            await investigator.turn?.cancel();
          }
          if (e.name === "dd.changes") void e.data.occurrences.toFixed();
          // @ts-expect-error A name the workflow doesn't declare never arrives.
          if (e.name === "dd.opened") void e;
          // @ts-expect-error Nor does a misspelling of awf's own.
          if (e.name === "agent:ende") void e;
          if (e.name === "agent:ended") {
            // @ts-expect-error An end has no text.
            void e.data.text;
          }
          if (e.name === "participant:reply") {
            // @ts-expect-error A reply has no meta.
            void e.data.meta;
          }
        }
        if (!investigator.turn)
          await investigator.start({ prompt: "Look", meta: { occurrences: 1 } });
        await thread.post("noted");
      }
    },
  },
});

const typed: ExecutableEventWorkflow<
  { "dd.changes": typeof Changes; "dd.closed": typeof Closed },
  never
> = caseRun;

async function sender(): Promise<void> {
  const outcome: "accepted" | "duplicate" | "refused" = await context.emit(
    caseRun,
    "dd.changes",
    { case: "kombo", occurrences: 3 },
    { id: "83d34d7" },
  );
  void outcome;
  // @ts-expect-error A name the target doesn't declare.
  await context.emit(caseRun, "dd.opened", { case: "kombo" });
  // @ts-expect-error Data its schema refuses.
  await context.emit(caseRun, "dd.closed", { case: "kombo", by: "someone" });
  // @ts-expect-error awf's own events are not sent.
  await context.emit(caseRun, "agent:ended", { case: "kombo" });
}

defineEventWorkflow({
  definition: {
    meta: { name: "colon", description: "A name with a colon is awf's." },
    file: import.meta.path,
    // @ts-expect-error An event of the workflow's own has no colon in its name.
    events: { "dd:changes": Changes },
    key: () => "k",
    starts: [],
    run: async () => null,
  },
});

// A workflow without events has no wait, no key, no turn started without awaiting it, and no
// code-routed participant.
const plain: ExecutableWorkflow<null, null> = defineExecutableWorkflow({
  definition: {
    meta: { name: "plain", description: "No events." },
    async run(workflow) {
      // @ts-expect-error Only a workflow with events waits.
      await workflow.receive();
      // @ts-expect-error Only a workflow with events has a key.
      void workflow.key;
      // @ts-expect-error A participant routed to the code needs a mailbox.
      const routed = await workflow.participants.connect({ key: "thread", to: "code" });
      void routed;
      const agent = await workflow.agents.open({ key: "a", runtime: "claude" });
      // @ts-expect-error Its end would have no wait to arrive at.
      await agent.start({ prompt: "Look" });
      return null;
    },
  },
  prepare: () => null,
});

void [typed, sender, plain];
