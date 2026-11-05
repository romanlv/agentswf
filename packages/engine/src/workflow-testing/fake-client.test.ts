import { expect, test } from "bun:test";
import { ClientError } from "@agentswf/contract/client";
import { defineWorkflow, type OutputSchema, ParticipantReply } from "@agentswf/contract/workflow";
import { fakeClient } from "./index";

const Pushed = {
  type: "object",
  properties: { sha: { type: "string" } },
  required: ["sha"],
  additionalProperties: false,
} as OutputSchema<{ sha: string }>;

const review = defineWorkflow({
  meta: { name: "review", description: "Reviews a pull request." },
  file: "/flows/review.ts",
  events: { "pr.pushed": Pushed, "pr.closed": Pushed, "thread:reply": ParticipantReply },
  starts: ["pr.pushed"],
  run: async () => null,
});
const release = defineWorkflow({
  meta: { name: "release", description: "Releases." },
  file: "/flows/release.ts",
  prepare: ({ argv }) => ({ version: argv[0] ?? "" }),
  run: async () => "done",
});

/** A webhook handler, as a program writes it, taking its client. */
async function onPush(
  runs: ReturnType<typeof fakeClient>,
  pr: number,
  sha: string,
  delivery: string,
) {
  return runs.emit(
    review,
    `pr-${pr}`,
    "pr.pushed",
    { sha },
    { eventId: delivery, source: "github" },
  );
}

test("records emits and starts in order, with their typed data, and scripts a launch-failed and a rest", async () => {
  const runs = fakeClient({
    emit: (call) =>
      call.eventId === "d-2" ? { did: "none", why: "launch-failed", error: "no bun" } : undefined,
    rests: {
      "release/v1": [
        {
          state: "completed",
          final: true,
          ending: { kind: "completed", value: "done", stages: [] },
        },
      ],
    },
  });
  expect(await onPush(runs, 1, "a", "d-1")).toMatchObject({ outcome: "accepted", did: "started" });
  expect(await onPush(runs, 1, "b", "d-2")).toMatchObject({ did: "none", why: "launch-failed" });
  const started = await runs.start(release, { version: "1.0" }, { id: "v1" });
  expect(started.did).toBe("started");
  expect(await started.run.wait({ final: true })).toMatchObject({
    state: "completed",
    final: true,
  });
  expect(runs.calls).toEqual([
    {
      kind: "emit",
      workflow: "review",
      ref: "review/pr-1",
      name: "pr.pushed",
      data: { sha: "a" },
      eventId: "d-1",
      source: "github",
    },
    {
      kind: "emit",
      workflow: "review",
      ref: "review/pr-1",
      name: "pr.pushed",
      data: { sha: "b" },
      eventId: "d-2",
      source: "github",
    },
    { kind: "start", workflow: "release", ref: "release/v1", args: { version: "1.0" } },
  ]);
});

test("the ClientError the real client throws for a mixed-case event id", async () => {
  const runs = fakeClient();
  const sent = onPush(runs, 1, "a", "Delivery-1");
  await expect(sent).rejects.toBeInstanceOf(ClientError);
  await expect(sent).rejects.toMatchObject({ code: "id" });
});

test("unscripted: not-a-start, no-run for a reply to an unseen id, and a second start exists", async () => {
  const runs = fakeClient();
  expect(await runs.emit(review, "pr-1", "pr.closed", { sha: "a" })).toMatchObject({
    outcome: "refused",
    why: "not-a-start",
  });
  await expect(runs.emit(review, "pr-2", "thread:reply", { text: "hi" })).rejects.toMatchObject({
    code: "no-run",
  });
  expect((await runs.start(release, { version: "1" }, { id: "v" })).did).toBe("started");
  expect((await runs.start(release, { version: "1" }, { id: "v" })).did).toBe("exists");
  await expect(runs.start(release, { version: "2" }, { id: "v" })).rejects.toMatchObject({
    code: "other-args",
  });
  expect(await runs.emit(review, "pr-3", "pr.pushed", { sha: "a" })).toMatchObject({
    did: "started",
  });
  expect(await runs.emit(review, "pr-3", "thread:reply", { text: "ok" })).toMatchObject({
    did: "nudged",
  });
});

test("as the real rules: a retry after a launch that failed, a duplicate, a parked run continued, a returned one refused", async () => {
  let retried = 0;
  const runs = fakeClient({
    // The first launch fails; the script answers that once.
    emit: (call) =>
      call.eventId === "d-1" && retried++ === 0
        ? { did: "none", why: "launch-failed", error: "no bun" }
        : undefined,
    rests: {
      "review/pr-2": [{ state: "parked", final: false }],
      "review/pr-3": [{ state: "completed", final: true }],
    },
  });
  expect(await onPush(runs, 1, "a", "d-1")).toMatchObject({ did: "none", why: "launch-failed" });
  // The run is kept: the same delivery is a duplicate, which wakes it, launching it again.
  expect(await onPush(runs, 1, "a", "d-1")).toMatchObject({ outcome: "duplicate", did: "started" });
  expect(await onPush(runs, 1, "b", "d-2")).toMatchObject({ outcome: "accepted", did: "nudged" });
  expect(await runs.emit(review, "pr-1", "thread:reply", { text: "ok" })).toMatchObject({
    did: "nudged",
  });
  const parked = await runs.get(review, "pr-2");
  expect(await parked.wait()).toMatchObject({ state: "parked" });
  expect(await runs.emit(review, "pr-2", "pr.closed", { sha: "a" })).toMatchObject({
    did: "continued",
  });
  await (await runs.get(review, "pr-3")).wait({ final: true });
  expect(await runs.emit(review, "pr-3", "pr.closed", { sha: "a" })).toMatchObject({
    outcome: "refused",
    why: "returned",
  });
});

test("the real client's checks: a source, args, a run's id, a file, a cursor", async () => {
  const runs = fakeClient();
  await expect(onPushWith(runs, { source: "GitHub App" })).rejects.toMatchObject({ code: "event" });
  // biome-ignore lint/suspicious/noExplicitAny: args the types refuse, given anyway.
  await expect(runs.start(release, { version: new Date() } as any)).rejects.toMatchObject({
    code: "prepare",
  });
  await expect(runs.get(release, "Bad Id")).rejects.toMatchObject({ code: "id" });
  await expect(
    runs.start({ ...release, file: "flows/release.ts" }, { version: "1" }),
  ).rejects.toMatchObject({ code: "file" });
  await expect(runs.inbox(review, { after: "-h" })).rejects.toMatchObject({ code: "cursor" });
  // A start that failed its checks is still a call.
  expect(runs.calls.filter((call) => call.kind === "start")).toHaveLength(2);
});

test("generated ids are new; an id an event began is other-args to start; a wait with nothing scripted ends with its signal", async () => {
  const runs = fakeClient();
  await runs.start(release, { version: "1" }, { id: "fake-1" });
  const generated = await runs.start(release, { version: "2" });
  expect(generated.run.id).toBe("fake-2");
  await onPush(runs, 5, "a", "d-5");
  await expect(runs.start({ ...review, id: () => "pr-5" }, null)).rejects.toMatchObject({
    code: "other-args",
  });
  const controller = new AbortController();
  const waiting = generated.run.wait({ final: true, signal: controller.signal });
  controller.abort(new Error("gave up"));
  await expect(waiting).rejects.toThrow("gave up");
});

function onPushWith(runs: ReturnType<typeof fakeClient>, options: { source: string }) {
  return runs.emit(review, "pr-1", "pr.pushed", { sha: "a" }, options);
}

test("from re-review: a run stopped stays stopped, a prepare that refuses no argv, scripted answers the fake then knows", async () => {
  const runs = fakeClient({
    rests: { "review/pr-1": [{ state: "stopped", final: true }], "review/pr-9": [] },
    emit: (call) =>
      call.eventId === "refuse"
        ? { outcome: "refused", why: "not-a-start" }
        : call.eventId === "stuck"
          ? { why: "stuck" }
          : undefined,
  });
  await (await runs.get(review, "pr-1")).wait();
  expect(await runs.emit(review, "pr-1", "pr.closed", { sha: "a" })).toMatchObject({
    did: "none",
    why: "stopped",
  });
  expect(await (await runs.get(review, "pr-1")).status()).toMatchObject({ state: "stopped" });
  // Refused by the script: no run is left.
  expect(
    await runs.emit(review, "pr-2", "pr.pushed", { sha: "a" }, { eventId: "refuse" }),
  ).toMatchObject({ outcome: "refused", did: "none" });
  await expect(runs.get(review, "pr-2")).rejects.toMatchObject({ code: "no-run" });
  // why alone is did none; a stuck run launches nothing more.
  expect(
    await runs.emit(review, "pr-3", "pr.pushed", { sha: "a" }, { eventId: "stuck" }),
  ).toMatchObject({ did: "none", why: "stuck" });
  expect(await runs.emit(review, "pr-3", "pr.pushed", { sha: "b" })).toMatchObject({
    did: "none",
    why: "stuck",
  });
  // A run named only by rests that an emit reached first was begun by an event.
  await runs.emit(review, "pr-9", "pr.pushed", { sha: "a" });
  await expect(runs.start({ ...review, id: () => "pr-9" }, null)).rejects.toMatchObject({
    code: "other-args",
  });
  const needs = defineWorkflow({
    meta: { name: "needs", description: "Needs a ticket." },
    file: "/flows/needs.ts",
    events: { "pr.pushed": Pushed },
    prepare: ({ argv }) => {
      if (!argv[0]) throw new Error("a ticket");
      return { ticket: argv[0] };
    },
    run: async () => null,
  });
  await expect(runs.emit(needs, "n", "pr.pushed", { sha: "a" })).rejects.toMatchObject({
    code: "prepare",
  });
});
