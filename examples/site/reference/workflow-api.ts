import {
  type AgentRef,
  choice,
  defineWorkflow,
  type JsonObject,
  type OutputSchema,
  score,
  tool,
  yesNo,
} from "agentswf/workflow";
import Type from "typebox";

// The workflow API page's samples: each region is a call as the page shows it, checked here.

declare const backlog: {
  close(id: string, status: "done" | "wontfix", why: string): void;
  open(): string;
};
declare function postToSlack(text: string): Promise<void>;

export const FINDINGS = Type.Object(
  { findings: Type.Array(Type.Object({ file: Type.String(), problem: Type.String() })) },
  { additionalProperties: false },
);
export type Findings = Type.Static<typeof FINDINGS>;
export const PLAN = Type.Object({ steps: Type.Array(Type.String()) });
export const PICKED = Type.Object({ number: Type.Number() });
export const VERDICT = Type.Object({ approved: Type.Boolean() });
const Doc = Type.Object({ path: Type.String() });
export const DOC: OutputSchema<Type.Static<typeof Doc>> = Doc;

export const agents = defineWorkflow({
  meta: { name: "workflow-api-agents", description: "The workflow API page's agent calls." },
  async run(wf): Promise<JsonObject> {
    // #region open
    const reviewer = await wf.agents.open({
      key: "review-security",
      runtime: { harness: "claude", model: "claude-sonnet-5-5" }, // placement defaults to "tui"
      instructions: "You review code for security problems. Report; don't fix.",
    });
    // #endregion open

    // #region run
    const { outcome } = await reviewer.run<Type.Static<typeof FINDINGS>>({
      prompt: "Review the diff on this branch against main.",
      schema: FINDINGS,
      timeoutMs: 15 * 60_000,
      label: "first pass",
    });
    // #endregion run

    // #region login
    if (outcome.kind === "failed" && outcome.login) wf.stop(outcome.reason);
    // #endregion login

    // #region isanswered
    if (!outcome.answered) return { error: `${outcome.kind}: ${outcome.reason}` };
    outcome.value.findings; // typed
    // #endregion isanswered

    const builder = await wf.agents.open({ key: "build", runtime: "claude" });
    // #region compact
    const compacted = await builder.compact({
      prompt: "Keep the plan's decisions, the branch and the worktree. Drop file contents.",
    });
    if (!compacted.answered) wf.log("compaction didn't finish", { reason: compacted.reason });
    // #endregion compact

    // #region set
    const critic = await wf.agents.open({
      key: "critic",
      runtime: { alias: "codex", effort: "high" },
    });
    await critic.run({ prompt: "Review the change.", schema: FINDINGS }); // high
    await critic.set({ effort: "low" });
    await critic.run({ prompt: "Summarise." }); // low, and every turn after
    // #endregion set

    // #region fork
    const worker = await wf.agents.open({ key: "worker", runtime: "claude" });
    await worker.run({ prompt: "Read the ticket and plan the change.", schema: PLAN });
    const [security, tests] = await Promise.all([
      worker.fork({ key: "security", instructions: "Review the plan for security." }),
      worker.fork({ key: "tests", runtime: { placement: "headless", metered: true } }),
    ]);
    // #endregion fork

    // #region layout
    const lead = await wf.agents.open({
      key: "lead",
      runtime: "claude",
      layout: { workspace: "origin", tab: "review" }, // a tab where `awf run` was typed
      keepPane: "on-failure",
    });
    await lead.run({ prompt: "Read the change and plan the review." });
    const lensA = await lead.fork({ key: "lens-a", layout: { beside: "lead", side: "right" } });
    const lensB = await lead.fork({ key: "lens-b", layout: { beside: "lens-a", side: "below" } });
    // #endregion layout

    // #region caller
    const author = await wf.agents.caller({ key: "author" });
    if (!author) throw new Error("start this workflow with awf run --here from an agent");
    const picked = await author.run({ prompt: "Pick a number and remember it.", schema: PICKED });
    // #endregion caller

    // #region forkcaller
    const fixer =
      (await wf.agents.forkCaller({ key: "fixer", layout: { workspace: "origin" } })) ??
      (await wf.agents.open({ key: "fixer", runtime: "claude" }));
    // #endregion forkcaller

    // #region tool
    const CloseItem = Type.Object({
      id: Type.String(),
      status: Type.Union([Type.Literal("done"), Type.Literal("wontfix")]),
      why: Type.String(),
    });

    const triager = await wf.agents.open({
      key: "triager",
      runtime: "codex",
      tools: {
        close_item: tool<Type.Static<typeof CloseItem>>({
          description: "Close an open item as done or won't fix, saying why.",
          input: CloseItem,
          handler: ({ id, status, why }) => {
            backlog.close(id, status, why);
            return `Closed ${id}.`;
          },
        }),
        list_open: tool({
          description: "The items still open, one per line.",
          handler: () => backlog.open(),
        }),
      },
    });
    // #endregion tool

    // #region close
    await triager.close(); // true once closed
    // #endregion close

    const opened = [security, tests, lensA, lensB, fixer, triager].map((agent) => agent.key);
    return { opened, picked: picked.outcome.kind };
  },
});

export const composing = defineWorkflow({
  meta: { name: "workflow-api-composing", description: "The workflow API page's other calls." },
  async run(wf) {
    // #region parallel
    const LENSES = ["security", "correctness", "tests"] as const;

    const reviews = await wf.parallel(
      LENSES,
      async (lens) => {
        const agent = await wf.agents.open({ key: `review-${lens}`, runtime: "codex" });
        const { outcome } = await agent.run<Findings>({
          prompt: `Review for ${lens}.`,
          schema: FINDINGS,
        });
        return outcome.answered ? outcome.value.findings : [];
      },
      { label: "review", concurrency: 2 },
    );
    // #endregion parallel

    // #region sandbox
    const box = await wf.sandboxes.open({
      key: "work",
      write: ["."], // the working directory is writable; everything else is read-only
      network: ["registry.npmjs.org"], // beyond each harness's own model API
      srt: {}, // the provider, required: srt, or docker: { image? }
    });

    const coder = await wf.agents.open({ key: "code", runtime: "claude", sandbox: box });
    const tester = await wf.agents.open({ key: "test", runtime: "codex", sandbox: box });
    const reader = await wf.agents.open({
      key: "read",
      runtime: "claude",
      sandbox: { read: ["/data"], srt: {} }, // an inline spec: a private sandbox for this agent only
    });
    // #endregion sandbox

    const title = "Checkout fails";
    const body = "Paying by card returns a 500.";
    // #region decide
    const { answers } = await wf.decisions.decide({
      key: "triage:42", // the part before ":" is its cost group, for a run without stages
      model: "jev",
      state: { title, body },
      questions: {
        team: choice("Which team owns this?", { payments: null, accounts: "logins, profiles" }),
        bug: yesNo("Is this a bug report rather than a feature request?"),
        urgency: score("How urgent is it?", ["whenever", "this sprint", "today"]),
      },
    });

    answers.team.choice; // "payments" | "accounts", typed from the options
    answers.team.probabilities; // { payments: 0.97, accounts: 0.03 }
    answers.bug.yes; // 0.91
    answers.urgency.expected; // 1.4, the probability-weighted level
    // #endregion decide

    // #region allow
    await wf.messages.allow({
      between: [tester, coder],
      purpose: "Revise the implementation until the tester approves it.",
      maxMessages: 6,
    });
    const verdict = await tester.run({
      prompt: "Test the change; ask the implementer for fixes.",
      schema: VERDICT,
    });
    // #endregion allow

    // #region connect
    const coordinator = await wf.participants.connect({
      key: "coordinator",
      labels: { audience: "operator" },
    });
    await wf.messages.allow({
      between: [reader, coordinator],
      purpose: "report findings that hold up; ask when the logs can't settle it",
      timeoutMs: 2 * 60 * 60_000,
    });
    // #endregion connect

    const ticket = "PROJ-1";
    // #region stage
    const doc = await wf.stage("doc-review", { result: DOC, summary: (d) => d.path }, async () => {
      const { outcome } = await reader.run({
        prompt: `Find the ticket doc for ${ticket}`,
        schema: DOC,
      });
      if (!outcome.answered) return wf.stop(outcome.reason); // inside: a continue redoes doc-review
      return outcome.value;
    });
    await wf.stage("notify", async () => {
      // no result: it only has to happen
      await postToSlack(`${ticket}: reviewed`);
    });
    // #endregion stage

    // #region log
    wf.log("reviewed", { findings: 12 }); // a line in awf's live progress and in `awf logs`
    wf.usage(); // this scope's finished operations: times and sessions
    // #endregion log

    return { reviews: reviews.flat().length, verdict: verdict.outcome.kind, doc: doc.path };
  },
});

declare type Kase = {
  unseen(): number;
  markGiven(given: string[]): void;
  close(data: { case: string }): Promise<void>;
  needsLook(): boolean;
  pending(): string[];
  view(): string;
};
declare function openCase(runId: string): Kase;
declare function promptFor(given: string[]): string;
declare function focusFor(view: string): string;

const Changes = Type.Object({ case: Type.String() }, { additionalProperties: false });
const Closed = Type.Object({ case: Type.String() }, { additionalProperties: false });
export const CHANGES: OutputSchema<Type.Static<typeof Changes>> = Changes;
export const CLOSED: OutputSchema<Type.Static<typeof Closed>> = Closed;

// #region events
export const ddCase = defineWorkflow({
  meta: { name: "dd-case", description: "Investigate one Datadog case." },
  file: import.meta.path, // where senders find it, and its runs live
  events: { "dd.changes": CHANGES, "dd.closed": CLOSED }, // a schema per name; no colon
  starts: ["dd.changes"], // the events that may start one; absent, any
  async run(wf) {
    const kase = openCase(wf.runId); // state lives in files, not variables
    const investigator = await wf.agents.open({ key: "investigator", runtime: "claude" });
    for (;;) {
      const events = await wf.receive({ label: `${kase.unseen()} unseen` });
      for (const e of events) {
        if (investigator.is<string[]>(e) && e.data.outcome.answered) kase.markGiven(e.data.meta);
        if (e.name === "dd.closed") await wf.stage(`close-${e.id}`, () => kase.close(e.data));
      }
      if (!investigator.turn && kase.needsLook()) {
        const given = kase.pending();
        await investigator.start({ prompt: promptFor(given), meta: given }); // returns at once
      }
    }
  },
});
// #endregion events

declare const REMINDER: string;
declare function isApproval(text: string): boolean;
declare function release(ticket: string): Promise<void>;
declare const ledger: { nextNudge(): Date | null; answered(): void };
declare function nudge(): Promise<void>;

export const waits = defineWorkflow({
  meta: { name: "workflow-api-waits", description: "The workflow API page's waits." },
  file: import.meta.path,
  events: { "dd.closed": CLOSED },
  async run(wf) {
    const kase = openCase(wf.runId);
    // #region keepalive
    const investigator = await wf.agents.open({
      key: "investigator",
      runtime: "claude",
      keepAlive: {
        onTimeout: async (agent: AgentRef) => {
          // Written when the window passes, from the case as it is then, while the cache is warm.
          await agent.compact({ prompt: focusFor(kase.view()) });
        },
      },
    });
    // #endregion keepalive

    // #region code-participant
    const approvals = await wf.participants.connect({ key: "approver", to: "code" });
    // #endregion code-participant

    // #region race
    // A reminder every two days, an approval, or an expiry at fourteen.
    const expiry = wf.timer("doc-expires", "14d");
    for (let round = 1; ; round++) {
      const next = await wf.race(
        `approval-${round}`,
        {
          reply: approvals, // a participant routed to the code
          remind: "2d", // a timer of the race's own
          expiry, // a timer the code made, shared by every round
        },
        { label: "awaiting approval" },
      );
      if (next.expiry) return "expired";
      if (next.reply && isApproval(next.reply.text)) break;
      if (next.remind) await wf.stage(`remind-${round}`, () => approvals.post(REMINDER));
    }
    // #endregion race

    // #region sleep
    await wf.stage("release", () => release(wf.runId));
    await wf.sleep("follow-up", "14d");
    // #endregion sleep

    // #region select
    for await (const next of wf.select({ reply: approvals, closed: wf.signal("dd.closed") })) {
      if (next.closed) return kase.close(next.closed.data).then(() => "closed");
      if (next.reply) await investigator.run({ prompt: next.reply.text });
    }
    // #endregion select

    // #region at
    for await (const next of wf.select({
      reply: approvals,
      nudge: wf.at(() => ledger.nextNudge()), // Date | null, from the ledger's file
    })) {
      if (next.nudge) await nudge(); // which puts ledger's nextNudge off, or clears it
      if (next.reply) ledger.answered(); // nextNudge = null: no more nudges
    }
    // #endregion at
    return "done";
  },
});
