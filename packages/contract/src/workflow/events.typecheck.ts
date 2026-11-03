import {
  defineWorkflow,
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
  async run(wf) {
    const thread = await wf.participants.connect({ key: "thread", to: "code" });
    const investigator = await wf.agents.open({ key: "investigator", runtime: "claude" });
    const triage = await wf.agents.open({
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
      const events = await wf.receive({ label: wf.runId });
      for (const e of events) {
        if (investigator.is<Given>(e)) {
          const given: Given = e.data.meta;
          if (e.data.outcome.answered) void given.occurrences;
        }
        if (thread.is(e)) void e.data.text.length;
        // A second agent's end is still possible after the first's guard said no.
        if (triage.is<{ seen: number }>(e)) void e.data.meta.seen.toFixed();
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
  async run(wf, args) {
    await wf.receive();
    return args.occurrences;
  },
}) satisfies Workflow<{ occurrences: number }, number, { "dd.changes": typeof Changes }>;

// A workflow without events has no wait, no turn started without awaiting it, and no
// code-routed participant, wrapped in a generic helper too.
function plainHelper<Args extends null>(prepare: (invocation: WorkflowInvocation) => Args) {
  return defineWorkflow({
    meta: { name: "plain-helper", description: "Generic over its args." },
    prepare,
    async run(wf) {
      // @ts-expect-error Only a workflow with events waits.
      await wf.receive();
      return null;
    },
  });
}

const plain: Workflow<null, null> = defineWorkflow({
  meta: { name: "plain", description: "No events." },
  async run(wf) {
    // @ts-expect-error Only a workflow with events waits.
    await wf.receive();
    // @ts-expect-error A participant routed to the code needs a mailbox.
    const routed = await wf.participants.connect({ key: "thread", to: "code" });
    void routed;
    const agent = await wf.agents.open({ key: "a", runtime: "claude" });
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
  async run(wf) {
    // @ts-expect-error keepAlive is for a workflow with events.
    await wf.agents.open({ key: "a", runtime: "claude", keepAlive: {} });
    return null;
  },
});

declare const Approved: OutputSchema<{ by: string }>;
declare function isApproval(text: string): boolean;

// The cases of story 037: timers, a race, a select and a sleep.
defineWorkflow({
  meta: { name: "approval", description: "Reminders and an expiry." },
  file: import.meta.path,
  events: { "doc.approved": Approved, "dd.closed": Closed },
  async run(wf) {
    const approvals = await wf.participants.connect({ key: "approvals", to: "code" });
    const expiry = wf.timer("doc-expires", "14d");
    for (let round = 1; ; round++) {
      const next = await wf.race(
        `approval-${round}`,
        { reply: approvals, remind: "2d", expiry, closed: wf.signal("dd.closed") },
        { label: "awaiting approval" },
      );
      if (next.expiry) {
        const key: "expiry" = next.key;
        return `${key} ${next.expiry.id} ${next.expiry.at}`;
      }
      // @ts-expect-error The expiry has returned: the key is another branch's.
      const notExpiry: "expiry" = next.key;
      void notExpiry;
      if (next.closed) return next.closed.data.by;
      if (next.reply && isApproval(next.reply.text)) return next.reply.id;
      if (next.remind) await approvals.post(`reminder ${next.remind.name}`);
      switch (next.key) {
        case "reply":
          void next.reply.author;
          break;
        case "remind":
          // @ts-expect-error A branch that didn't win is undefined.
          void next.reply.text;
          break;
      }
    }
  },
});

defineWorkflow({
  meta: { name: "approval-loop", description: "The same, as a select." },
  file: import.meta.path,
  events: { "doc.approved": Approved },
  async run(wf) {
    const approvals = await wf.participants.connect({ key: "approvals", to: "code" });
    const investigator = await wf.agents.open({ key: "investigator", runtime: "claude" });
    const expiry = wf.timer("doc-expires", new Date("2026-11-12T09:00:00Z"));
    const remind = wf.timer("remind", "2d");
    for await (const next of wf.select(
      { reply: approvals, expiry, remind, ended: investigator },
      { label: () => `${wf.now().toISOString()}` },
    )) {
      if (next.expiry) return null;
      if (next.remind) void next.remind.name;
      if (next.ended?.outcome.answered) void next.ended.meta;
    }
    // @ts-expect-error A branch named key would hide the answer's key.
    await wf.race("k", { key: approvals, other: "1h" });
    // @ts-expect-error A race of nothing never returns.
    await wf.race("empty", {});
    // @ts-expect-error A select takes no duration: it has no name to give a timer.
    wf.select({ remind: "2d" });
    return null;
  },
});

defineWorkflow({
  meta: { name: "turn", description: "A turn a close cuts short." },
  file: import.meta.path,
  events: { "dd.closed": Closed },
  async run(wf) {
    const investigator = await wf.agents.open({ key: "investigator", runtime: "claude" });
    const turn = await investigator.start({ prompt: "Look" });
    const next = await wf.race(`turn-${turn.id}`, {
      done: turn,
      closed: wf.signal("dd.closed"),
    });
    if (next.closed) await turn.cancel();
    // @ts-expect-error A turn that may not be running isn't a source.
    await wf.race("maybe", { done: investigator.turn });
    // @ts-expect-error A promise isn't a source.
    await wf.race("promise", { done: investigator.run({ prompt: "Look" }) });
    // @ts-expect-error Only a declared event is a signal.
    wf.signal("dd.opened");
    // @ts-expect-error A duration is days, hours or minutes.
    wf.timer("typo", "2 days");
    // @ts-expect-error Nor seconds.
    await wf.sleep("short", "30s");
    for (const e of await wf.receive()) {
      const retry = wf.timer("retry-1", "10m");
      if (retry.is(e)) void [e.at, e.data.name];
      const closed = wf.signal("dd.closed");
      if (closed.is(e)) void e.data.by;
      else if (e.name === "dd.closed") void e;
      if (turn.is<{ n: number }>(e)) void e.data.meta.n;
      else if (investigator.is(e)) void e.data.outcome;
      if (investigator.is<{ n: number }>(e)) void e.data.meta.n;
      if (e.name === "timer:due") void e.data.name;
    }
    void wf.started?.data;
    return null;
  },
});

defineWorkflow({
  meta: { name: "follow-up", description: "A sleep in a workflow without events." },
  async run(wf) {
    await wf.sleep("follow-up", "14d");
    void wf.now().getTime();
    // @ts-expect-error A race takes events, which a workflow without them has none of.
    await wf.race("x", { rested: "1h" });
    return null;
  },
});

defineWorkflow({
  meta: { name: "nudges", description: "A time read from state, moved by the loop." },
  file: import.meta.path,
  events: { "doc.approved": Approved },
  async run(wf) {
    const engineer = await wf.participants.connect({ key: "engineer", to: "code" });
    const ledger = { nextNudge: wf.after("4h") as Date | null };
    for await (const next of wf.select({
      reply: engineer,
      nudge: wf.at(() => ledger.nextNudge),
    })) {
      if (next.nudge) {
        const due: string = next.nudge.at;
        void due;
        ledger.nextNudge = wf.after("1d");
      }
      if (next.reply) ledger.nextNudge = null;
    }
    // @ts-expect-error A race answers once: it takes a timer, not a time read from state.
    await wf.race("r", { reply: engineer, nudge: wf.at(() => null) });
    // @ts-expect-error A time read from state is a Date or null, not a duration.
    wf.at(() => "4h");
    // @ts-expect-error after takes a duration.
    wf.after(new Date());
    return null;
  },
});
