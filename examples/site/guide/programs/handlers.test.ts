import { expect, test } from "bun:test";
import { fakeClient } from "agentswf/testing";
import {
  eventIdOf,
  onGithub,
  onThreadReply,
  relayPosts,
} from "./handlers.driver";

// #region test
test("a push is pr.pushed to the PR's run, named by the delivery, from github", async () => {
  const runs = fakeClient();
  const push = {
    kind: "push",
    delivery: "9f1c2e40-1d1a-11ef-8a2b-3c7d9e1f2a4b",
    pr: 7,
    sha: "abc123",
    branch: "fix-login",
  } as const;
  expect(await onGithub(runs, push)).toMatchObject({
    outcome: "accepted",
    did: "started",
  });
  expect(
    await onGithub(runs, {
      kind: "closed",
      delivery: "d-2",
      pr: 7,
      merged: true,
    }),
  ).toMatchObject({ did: "nudged" });
  expect(runs.calls).toEqual([
    {
      kind: "emit",
      workflow: "pr-review",
      ref: "pr-review/pr-7",
      name: "pr.pushed",
      data: { sha: "abc123", branch: "fix-login" },
      eventId: push.delivery,
      source: "github",
    },
    {
      kind: "emit",
      workflow: "pr-review",
      ref: "pr-review/pr-7",
      name: "pr.closed",
      data: { merged: true },
      eventId: "d-2",
      source: "github",
    },
  ]);
});
// #endregion test

test("a launch that failed is the result, not a throw; the run is kept, and a resent delivery launches it", async () => {
  let failed = 0;
  // The first launch fails; the script answers that once.
  const runs = fakeClient({
    emit: () =>
      failed++ === 0
        ? { did: "none", why: "launch-failed", error: "bun: not found" }
        : undefined,
  });
  const push = (delivery: string) =>
    onGithub(runs, {
      kind: "push",
      delivery,
      pr: 7,
      sha: "abc123",
      branch: "fix-login",
    });
  expect(await push("d-1")).toMatchObject({
    outcome: "accepted",
    why: "launch-failed",
  });
  // GitHub resends the delivery: a duplicate, never reviewed twice, which launches the run again.
  expect(await push("d-1")).toMatchObject({
    outcome: "duplicate",
    did: "started",
  });
  expect(await push("d-2")).toMatchObject({
    outcome: "accepted",
    did: "nudged",
  });
});

test("posts are relayed once, read on from the last cursor", async () => {
  const items = [
    {
      v: 2,
      ref: "pr-review/pr-7",
      at: "2026-11-05T09:00:00Z",
      cursor: "c1",
      kind: "post",
      participant: "thread",
      id: "1.p1",
      text: "Add a test.",
    },
    {
      v: 2,
      ref: "pr-review/pr-7",
      at: "2026-11-05T09:01:00Z",
      cursor: "c2",
      kind: "post",
      participant: "thread",
      id: "1.p2",
      text: "Looks right.",
    },
  ] as const;
  const runs = fakeClient({
    inbox: ({ after }) =>
      after === undefined ? [...items] : after === "c1" ? [items[1]] : [],
  });
  const posted: string[] = [];
  const cursor = await relayPosts(
    runs,
    undefined,
    async (_ref, text) => void posted.push(text),
  );
  expect(posted).toEqual(["Add a test.", "Looks right."]);
  expect(
    await relayPosts(
      runs,
      cursor,
      async (_ref, text) => void posted.push(text),
    ),
  ).toBe("c2");
  expect(posted).toHaveLength(2);
});

test("a reply goes to a run that is there; a Slack ts the grammar refuses is hashed", async () => {
  const runs = fakeClient();
  await expect(
    onThreadReply(runs, 7, "1730800000.000100", "on it", "sam"),
  ).rejects.toMatchObject({ code: "no-run" });
  expect(eventIdOf("1730800000.000100")).toBe("1730800000.000100");
  expect(eventIdOf("Ev0123ABC")).toMatch(/^h-[0-9a-f]{40}$/);
  expect(eventIdOf("Ev0123ABC")).toBe(eventIdOf("Ev0123ABC"));
});
