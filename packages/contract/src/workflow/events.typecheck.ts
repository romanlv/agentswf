import {
  defineWorkflow,
  isAnswered,
  type OutputSchema,
  type Workflow,
  type WorkflowContext,
  type WorkflowInvocation,
} from "./index";

declare const Changes: OutputSchema<{ case: string; occurrences: number }>;
declare const Closed: OutputSchema<{ case: string; by: "triage" | "thread" }>;
declare const context: WorkflowContext;

type Given = { occurrences: number };

const caseRun = defineWorkflow({
  meta: { name: "dd-case", description: "One case." },
  file: import.meta.path,
  events: { "dd.changes": Changes, "dd.closed": Closed },
  starts: ["dd.changes"],
  async run(workflow) {
    const thread = await workflow.participants.connect({ key: "thread", to: "code" });
    const investigator = await workflow.agents.open({ key: "investigator", runtime: "claude" });
    const triage = await workflow.agents.open({
      key: "triage",
      runtime: "claude",
      keepAlive: {
        timeoutMs: 60 * 60_000,
        onTimeout: async (agent) => {
          void agent.turn;
          await agent.compact({ prompt: "Keep the findings." });
        },
      },
    });
    for (;;) {
      const events = await workflow.receive({ label: workflow.runId, until: Date.now() });
      for (const e of events) {
        if (investigator.ended<Given>(e)) {
          const given: Given = e.data.meta;
          if (isAnswered(e.data.outcome)) void given.occurrences;
        }
        if (thread.replied(e)) void e.data.text.length;
        // A second agent's end is still possible after the first's guard said no.
        if (triage.ended<{ seen: number }>(e)) void e.data.meta.seen.toFixed();
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
});

const typed: Workflow<null, never, { "dd.changes": typeof Changes; "dd.closed": typeof Closed }> =
  caseRun;

async function sender(): Promise<void> {
  const outcome: "accepted" | "duplicate" | "refused" = await context.emit(
    caseRun,
    "kombo",
    "dd.changes",
    { case: "kombo", occurrences: 3 },
    { eventId: "83d34d7" },
  );
  void outcome;
  // @ts-expect-error A name the target doesn't declare.
  await context.emit(caseRun, "kombo", "dd.opened", { case: "kombo" });
  // @ts-expect-error Data its schema refuses.
  await context.emit(caseRun, "kombo", "dd.closed", { case: "kombo", by: "someone" });
  // @ts-expect-error awf's own events are not sent.
  await context.emit(caseRun, "kombo", "agent:ended", { case: "kombo" });
}

defineWorkflow({
  meta: { name: "colon", description: "A name with a colon is awf's." },
  file: import.meta.path,
  // @ts-expect-error An event of the workflow's own has no colon in its name.
  events: { "dd:changes": Changes },
  run: async () => null,
});

// @ts-expect-error A workflow with events gives its file.
defineWorkflow({
  meta: { name: "no-file", description: "No file." },
  events: { "dd.changes": Changes },
  run: async () => null,
});

defineWorkflow({
  meta: { name: "starts", description: "Starts from its own events." },
  file: import.meta.path,
  events: { "dd.changes": Changes },
  // @ts-expect-error An event the workflow doesn't declare starts nothing.
  starts: ["dd.opened"],
  run: async () => null,
});

// A workflow with events takes args as any other; prepare infers them, and run its result.
defineWorkflow({
  meta: { name: "by-hand", description: "Started by hand or by an event." },
  file: import.meta.path,
  events: { "dd.changes": Changes },
  prepare: ({ argv }) => ({ occurrences: argv.length }),
  async run(workflow, args) {
    await workflow.receive();
    return args.occurrences;
  },
}) satisfies Workflow<{ occurrences: number }, number, { "dd.changes": typeof Changes }>;

// A workflow without events has no wait, no turn started without awaiting it, and no
// code-routed participant, wrapped in a generic helper too.
function plainHelper<Args extends null>(prepare: (invocation: WorkflowInvocation) => Args) {
  return defineWorkflow({
    meta: { name: "plain-helper", description: "Generic over its args." },
    prepare,
    async run(workflow) {
      // @ts-expect-error Only a workflow with events waits.
      await workflow.receive();
      return null;
    },
  });
}

const plain: Workflow<null, null> = defineWorkflow({
  meta: { name: "plain", description: "No events." },
  async run(workflow) {
    // @ts-expect-error Only a workflow with events waits.
    await workflow.receive();
    // @ts-expect-error A participant routed to the code needs a mailbox.
    const routed = await workflow.participants.connect({ key: "thread", to: "code" });
    void routed;
    const agent = await workflow.agents.open({ key: "a", runtime: "claude" });
    // @ts-expect-error Its end would have no wait to arrive at.
    await agent.start({ prompt: "Look" });
    return null;
  },
});

async function noEvents(): Promise<void> {
  // @ts-expect-error A workflow without events takes none.
  await context.emit(plain, "kombo", "dd.changes", { case: "kombo", occurrences: 3 });
}

void [typed, sender, plain, plainHelper, noEvents];

defineWorkflow({
  meta: { name: "plain", description: "No events: its runs never park." },
  async run(workflow) {
    // @ts-expect-error keepAlive is for a workflow with events.
    await workflow.agents.open({ key: "a", runtime: "claude", keepAlive: {} });
    return null;
  },
});
