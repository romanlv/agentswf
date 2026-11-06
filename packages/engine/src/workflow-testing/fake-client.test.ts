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
  expect(await onPush(runs, 1, "b", "d-2")).toMatchObject({
    ok: false,
    did: "none",
    why: "launch-failed",
  });
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

test("an id(args) is checked as the real client checks it, in its words", async () => {
  const runs = fakeClient();
  const named = (id: (args: { version: string }) => string) => defineWorkflow({ ...release, id });
  await expect(
    runs.start(
      named(() => "has space"),
      { version: "1" },
    ),
  ).rejects.toMatchObject({
    code: "id",
    message: expect.stringMatching(/^release's id\(args\): "has space"/),
  });
  const throwing = named(() => {
    throw new Error("no ticket");
  });
  await expect(runs.start(throwing, { version: "1" })).rejects.toMatchObject({
    code: "prepare",
    message: "release's id(args) failed: no ticket",
  });
  await expect(
    runs.emit(review, "pr-1", "pr.pushed", { sha: "a" }, { source: 1 as never }),
  ).rejects.toMatchObject({ code: "event", message: "source is a string" });
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

test("from the second review: a resent closing event, status after a failed launch, a relaunch continued", async () => {
  const done = { state: "completed", final: true } as const;
  const runs = fakeClient({
    rests: { "review/pr-1": [done], "review/pr-2": [{ state: "parked", final: false }] },
    emit: (call) =>
      call.eventId?.startsWith("bad") ? { did: "none", why: "launch-failed" } : undefined,
    start: (call) => (call.ref === "release/r1" ? { did: "launch-failed" } : undefined),
  });
  // A resent event to a completed run leaves it completed, as the real wake does.
  await runs.emit(review, "pr-1", "pr.pushed", { sha: "a" }, { eventId: "c-1" });
  const closed = await runs.get(review, "pr-1");
  expect(await closed.wait()).toEqual(done);
  expect(
    await runs.emit(review, "pr-1", "pr.pushed", { sha: "a" }, { eventId: "c-1" }),
  ).toMatchObject({ outcome: "duplicate", did: "none", why: "returned" });
  expect(await closed.status()).toEqual(done);

  // A plain run whose launch failed is interrupted, final; three failures make it stuck.
  const failed = await runs.start(release, { version: "1" }, { id: "r1" });
  expect(failed).toMatchObject({ ok: false, did: "launch-failed" });
  expect(await failed.run.wait({ final: true })).toEqual({ state: "interrupted", final: true });
  await runs.start(release, { version: "1" }, { id: "r1" });
  await runs.start(release, { version: "1" }, { id: "r1" });
  expect(await failed.run.status()).toEqual({ state: "stuck", final: true });
  expect(await runs.start(release, { version: "1" }, { id: "r1" })).toMatchObject({
    ok: false,
    did: "stuck",
  });

  // An event run whose first launch failed is interrupted, not final.
  await runs.emit(review, "pr-3", "pr.pushed", { sha: "a" }, { eventId: "bad-1" });
  expect(await (await runs.get(review, "pr-3")).status()).toEqual({
    state: "interrupted",
    final: false,
  });

  // A parked run whose continue failed stays parked, and is continued, not started, next.
  const parked = await runs.get(review, "pr-2");
  await parked.wait();
  await runs.emit(review, "pr-2", "pr.pushed", { sha: "b" }, { eventId: "bad-2" });
  expect(await parked.status()).toEqual({ state: "parked", final: false });
  expect(
    await runs.emit(review, "pr-2", "pr.pushed", { sha: "c" }, { eventId: "c-3" }),
  ).toMatchObject({ did: "continued" });

  // A reply to no run is no-run before its source is looked at, as the real client checks.
  await expect(
    runs.emit(review, "pr-9", "thread:reply", { text: "hi" }, { source: "Bad Source" }),
  ).rejects.toMatchObject({ code: "no-run" });
});

test("from the third review: prepare's result checked as JSON, rests for a generated id, final from the state", async () => {
  const loose = defineWorkflow({
    meta: { name: "loose", description: "Prepares what isn't JSON." },
    file: "/flows/loose.ts",
    events: { go: Pushed },
    // As a workflow that isn't type-checked writes it: undefined is no JSON.
    prepare: (({ argv }: { argv: readonly string[] }) => ({ base: argv[0] })) as never,
    run: async () => null,
  });
  await expect(
    fakeClient().emit(loose, "a", "go", { sha: "x" }, { eventId: "g-1" }),
  ).rejects.toMatchObject({ code: "prepare" });

  const runs = fakeClient({
    rests: {
      "release/fake-1": [{ state: "completed", final: true }],
      "review/pr-1": [{ state: "failed", final: true }],
    },
  });
  const started = await runs.start(release, { version: "1" });
  expect(started.run.ref).toBe("release/fake-1");
  expect(await started.run.wait()).toEqual({ state: "completed", final: true });
  // An event run that failed is continued by its next event: not final, whatever the script says.
  const failed = await runs.get(review, "pr-1");
  expect(await failed.wait()).toEqual({ state: "failed", final: false });
});

test("event data that isn't JSON is the ClientError event, as the real client throws", async () => {
  const data = { sha: "x", at: new Date() } as unknown as { sha: string };
  await expect(fakeClient().emit(review, "pr-1", "pr.pushed", data)).rejects.toMatchObject({
    code: "event",
  });
});

test("the first event to a run only rests names starts it, with its rests, or is not-a-start", async () => {
  const runs = fakeClient({ rests: { "review/pr-1": [{ state: "parked", final: false }] } });
  expect(await runs.emit(review, "pr-1", "pr.closed", { sha: "a" })).toMatchObject({
    outcome: "refused",
    why: "not-a-start",
  });
  await expect(runs.emit(review, "pr-1", "thread:reply", { text: "hi" })).rejects.toMatchObject({
    code: "no-run",
  });
  expect(await runs.emit(review, "pr-1", "pr.pushed", { sha: "a" })).toMatchObject({
    outcome: "accepted",
    did: "started",
  });
  const run = await runs.get(review, "pr-1");
  expect(await run.wait()).toEqual({ state: "parked", final: false });
  expect(await runs.emit(review, "pr-1", "pr.pushed", { sha: "b" })).toMatchObject({
    did: "continued",
  });
});

test("a handle get gave before a run's first event sees it; a start after a rest was taken is other-args", async () => {
  const runs = fakeClient({
    rests: {
      "review/pr-1": [{ state: "parked", final: false }],
      "release/v1": [{ state: "failed", final: true }],
    },
  });
  const early = await runs.get(review, "pr-1");
  await runs.emit(review, "pr-1", "pr.pushed", { sha: "a" });
  expect(await early.wait()).toEqual({ state: "parked", final: false });
  expect(await (await runs.get(review, "pr-1")).status()).toEqual({
    state: "parked",
    final: false,
  });
  expect(await runs.emit(review, "pr-1", "pr.pushed", { sha: "b" })).toMatchObject({
    did: "continued",
  });

  await (await runs.get(release, "v1")).wait();
  await expect(runs.start(release, { version: "1" }, { id: "v1" })).rejects.toMatchObject({
    code: "other-args",
  });
});
