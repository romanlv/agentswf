// Checked by `tsc --noEmit`, never run: what `agentswf/client` takes from a workflow's definition,
// and what it refuses.

import type { Client, Run } from "./client";
import { AgentEnded, defineWorkflow, type OutputSchema, ParticipantReply } from "./workflow";

declare const runs: Client;

const Pushed = { type: "object" } as OutputSchema<{ sha: string; branch: string }>;
const Closed = { type: "object" } as OutputSchema<{ by: string }>;

const review = defineWorkflow({
  meta: { name: "review", description: "Reviews a pull request as it changes." },
  file: import.meta.path,
  events: {
    "pr.pushed": Pushed,
    "pr.closed": Closed,
    "thread:reply": ParticipantReply,
    "fixer:ended": AgentEnded,
  },
  starts: ["pr.pushed"],
  run: async () => ({ verdict: "ok" }),
});

const release = defineWorkflow({
  meta: { name: "release", description: "Releases a version." },
  file: import.meta.path,
  prepare: ({ argv }) => ({ version: argv[0] ?? "", dryRun: argv.includes("--dry") }),
  run: async (_wf, { version }) => version.length,
});

const tidy = defineWorkflow({
  meta: { name: "tidy", description: "Takes no arguments." },
  file: import.meta.path,
  run: async () => "tidied",
});

type Handoff = { summary: string };
// With explicit type arguments, as `examples/feature-delivery` writes them, `file` is kept too.
const explicit = defineWorkflow<{ ticket: string }, Handoff>({
  meta: { name: "explicit", description: "Typed by hand." },
  file: import.meta.path,
  prepare: ({ argv }) => ({ ticket: argv[0] ?? "" }),
  run: async () => ({ summary: "done" }),
});

const unlocated = defineWorkflow({
  meta: { name: "unlocated", description: "Gives no file." },
  run: async () => null,
});

export async function emits(): Promise<void> {
  await runs.emit(review, "pr-1", "pr.pushed", { sha: "abc", branch: "main" });
  await runs.emit(
    review,
    "pr-1",
    "pr.pushed",
    { sha: "abc", branch: "main" },
    { source: "github", eventId: "d-1" },
  );
  await runs.emit(review, "pr-1", "thread:reply", { text: "looks good", author: "sam" });
  // @ts-expect-error A name the workflow doesn't declare.
  await runs.emit(review, "pr-1", "pr.opened", { sha: "abc" });
  // @ts-expect-error Data its schema refuses.
  await runs.emit(review, "pr-1", "pr.pushed", { sha: 1, branch: "main" });
  // @ts-expect-error `{key}:ended` is awf's alone to send.
  await runs.emit(review, "pr-1", "fixer:ended", {
    turn: "t",
    meta: null,
    outcome: { kind: "answered", answered: true, value: null },
  } as never);
  // @ts-expect-error A reply on a participant the workflow declares none for.
  await runs.emit(review, "pr-1", "other:reply", { text: "hi" });
  // @ts-expect-error A workflow without events takes none.
  await runs.emit(release, "r-1", "pr.pushed", { sha: "abc", branch: "main" });
}

export async function starts(): Promise<void> {
  const started = await runs.start(release, { version: "1.4.0", dryRun: false }, { id: "v1.4.0" });
  const length: number | undefined =
    (await started.run.wait({ final: true })).ending?.kind === "completed" ? 1 : undefined;
  void length;
  await runs.start(tidy, null);
  await runs.start(review, null, { id: "pr-1" });
  // @ts-expect-error Args its `prepare` doesn't return.
  await runs.start(release, { version: "1.4.0" });
  // @ts-expect-error A workflow that takes args isn't started with none.
  await runs.start(release, null);
  // @ts-expect-error A workflow of no args takes none.
  await runs.start(tidy, { version: "1.4.0" });
  // @ts-expect-error A workflow without `file` can't be found by a program.
  await runs.start(unlocated, null);
  // @ts-expect-error Nor its runs read.
  await runs.get(unlocated, "x");
}

export async function results(): Promise<void> {
  const plain: Run<number> = (await runs.start(release, { version: "1", dryRun: true })).run;
  const events: Run<{ verdict: string }> = await runs.get(review, "pr-1");
  const none: Run<string> = (await runs.start(tidy, null)).run;
  const typed: Run<Handoff> = await runs.get(explicit, "t-1");
  const ending = (await plain.status()).ending;
  if (ending?.kind === "completed") {
    const value: number = ending.value;
    void value;
  }
  // @ts-expect-error A run's result is the workflow's.
  const wrong: Run<string> = await runs.get(review, "pr-1");
  void [events, none, typed, wrong];
}
