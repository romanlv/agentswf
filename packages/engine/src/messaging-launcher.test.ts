import { afterAll, expect, test } from "bun:test";
import { dirname } from "node:path";
import { installAgentLauncher } from "./agent-launcher";
import { startResultControlPlane } from "./control-plane";
import { type AgentView, Messaging } from "./messaging/messaging";
import { createResultSlotRegistry } from "./result-slots";
import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

/**
 * The chain an agent walks for messaging: the launcher's path from its prompt, a heredoc typed in a
 * shell, the real control plane and the run's messaging behind it.
 */
test("wf peers, send and reply through the launcher an agent is told to run", async () => {
  const runDir = runDirs.tempRunDir();
  const control = await startResultControlPlane({
    slots: createResultSlotRegistry({ runDir }),
  });
  try {
    const channels = {
      reviewer: await control.openChannel("reviewer"),
      implementer: await control.openChannel("implementer"),
    };
    const launchers = {
      reviewer: await installAgentLauncher(
        dirname(channels.reviewer.endpoint),
        channels.reviewer.endpoint,
      ),
      implementer: await installAgentLauncher(
        dirname(channels.implementer.endpoint),
        channels.implementer.endpoint,
      ),
    };
    const states = new Map<string, AgentView>([
      ["reviewer", { state: "working" }],
      ["implementer", { state: "working" }],
    ]);
    const messaging = new Messaging({
      agent: (key) => states.get(key),
      canAwait: () => true,
      launcher: (key) => launchers[key as keyof typeof launchers],
      changed: () => undefined,
      schedule: () => () => undefined,
      now: () => Date.parse("2026-10-12T14:00:00Z"),
      record: async () => undefined,
    });
    control.attach(messaging);
    const deadline = Date.parse("2026-10-12T14:30:00Z");
    for (const agent of ["reviewer", "implementer"]) {
      messaging.opened({
        id: `op-${agent}`,
        agent,
        kind: "workflow",
        deadline,
        ceiling: deadline,
        scope: messaging.attempt,
      });
    }
    messaging.grant(
      { between: ["reviewer", "implementer"] },
      { purpose: "Review until both agree.", scope: messaging.attempt },
    );
    const sh = async (script: string) => {
      const child = Bun.spawn(["/bin/sh", "-c", script], {
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
    };
    const reviewer = launchers.reviewer;
    const implementer = launchers.implementer;

    expect(
      await sh(
        `${reviewer} send --await-reply implementer <<'EOF'\nHandle a cache miss; it's \`urgent\`.\nEOF`,
      ),
    ).toEqual({
      exitCode: 0,
      stdout: [
        "wf: sent to implementer. Its reply starts your next turn (deadline 14:30 UTC, in 30m).",
        "Go on with work that does not need the answer, then end your turn with one line saying what you await; do not poll or sleep.",
        `If you find the answer first, or decide not to wait, finish with ${reviewer} result op-reviewer; the wait is dropped.`,
      ].join("\n"),
      stderr: "",
    });
    // Shown to the implementer, as its operation's next turn would show it.
    const delivered = messaging.take("op-implementer", "continues");
    expect(delivered?.messages).toEqual([
      {
        kind: "message",
        from: "reviewer",
        text: "Handle a cache miss; it's `urgent`.",
        asks: true,
      },
    ]);

    const peers = await sh(`${implementer} peers`);
    expect(peers.exitCode).toBe(0);
    expect(peers.stdout.split("\n")).toEqual([
      "peer      you can  state         queued  purpose",
      "reviewer  both     awaiting you          “Review until both agree.”",
      "You owe reviewer a reply.",
    ]);
    expect(JSON.parse((await sh(`${implementer} peers --json`)).stdout)).toEqual({
      peers: [
        {
          peer: "reviewer",
          can: "both",
          state: "awaiting",
          awaits: "implementer",
          queued: 0,
          purpose: "Review until both agree.",
        },
      ],
      owes: ["reviewer"],
    });

    expect(await sh(`${implementer} result op-implementer '{}'`)).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("result refused (owes-reply): you owe reviewer a reply."),
    });
    expect(await sh(`echo 'A miss falls through.' | ${implementer} reply reviewer`)).toEqual({
      exitCode: 0,
      stdout: "wf: replied to reviewer.",
      stderr: "",
    });
    expect(await sh(`${implementer} reply reviewer 'Also this.'`)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `wf: reply refused (none-owed): you owe reviewer nothing. Send it with ${implementer} send reviewer.`,
    });
    expect(await sh(`${reviewer} send nobody hi`)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `wf: send refused (no-route): no route to nobody. Your routes: ${reviewer} peers`,
    });
    // Usage names the launcher by its full path, as the agent must type it.
    expect((await sh(`${reviewer} send`)).stderr).toContain(`${reviewer} reply [--await-reply`);
  } finally {
    await control.close();
  }
});

/** The design's lines no other test prints through a launcher, each with its exit code. */
test("the design's acknowledgements and refusals, as an agent's launcher prints them", async () => {
  const runDir = runDirs.tempRunDir();
  const control = await startResultControlPlane({ slots: createResultSlotRegistry({ runDir }) });
  try {
    const keys = ["asker", "peer", "solo", "late"] as const;
    const launchers = new Map<string, string>();
    for (const key of keys) {
      const channel = await control.openChannel(key);
      launchers.set(key, await installAgentLauncher(dirname(channel.endpoint), channel.endpoint));
    }
    const messaging = new Messaging({
      agent: () => ({ state: "working" }),
      canAwait: (key) => key !== "solo",
      launcher: (key) => launchers.get(key)!,
      changed: () => undefined,
      schedule: () => () => undefined,
      now: () => Date.parse("2026-10-12T14:00:00Z"),
      record: async () => undefined,
    });
    control.attach(messaging);
    const deadline = Date.parse("2026-10-12T14:30:00Z");
    const plan = messaging.scope("plan");
    for (const key of keys) {
      messaging.opened({
        id: `op-${key}`,
        agent: key,
        kind: "workflow",
        deadline,
        ceiling: deadline,
        scope: messaging.attempt,
      });
    }
    messaging.grant({ between: ["asker", "peer"] }, { purpose: "Talk.", scope: messaging.attempt });
    messaging.grant({ from: "solo", to: "peer" }, { purpose: "Notes.", scope: messaging.attempt });
    messaging.grant({ from: "late", to: "peer" }, { purpose: "Plan.", scope: plan });
    const wf = (key: (typeof keys)[number]) => launchers.get(key)!;
    const sh = async (script: string) => {
      const child = Bun.spawn(["/bin/sh", "-c", script], {
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, out: (stdout + stderr).trim() };
    };

    const rows: [string, number, string][] = [
      [
        `${wf("solo")} send peer 'A note.'`,
        0,
        "wf: sent to peer; it reads this when its current turn ends.",
      ],
      [
        `${wf("solo")} send --await-reply peer 'Why?'`,
        1,
        "wf: send refused (unsupported): this agent cannot await a reply here. Send without --await-reply and say where the answer should go, such as a file.",
      ],
      [
        `${wf("asker")} send --await-reply peer 'Q?'`,
        0,
        "wf: sent to peer. Its reply starts your next turn",
      ],
      [
        `${wf("asker")} waiting op-asker --reason 'peer is checking'`,
        0,
        `wf: you already await peer's reply, until 14:30 UTC, in 30m. End your turn, or finish with ${wf("asker")} result op-asker.`,
      ],
      [
        `${wf("asker")} peers`,
        0,
        "You await peer's reply, until 14:30 UTC, in 30m; checking again does not speed it.",
      ],
      [
        `${wf("asker")} send --await-reply peer 'Again?'`,
        1,
        "wf: send refused (awaiting): you already await peer. End your turn, or send without --await-reply.",
      ],
    ];
    for (const [script, exitCode, line] of rows) {
      const outcome = await sh(script);
      expect({ script, exitCode: outcome.exitCode }).toEqual({ script, exitCode });
      expect(outcome.out.split("\n")[0]).toStartWith(line);
    }
    messaging.finishing(plan);
    expect(await sh(`${wf("late")} send peer 'One more.'`)).toEqual({
      exitCode: 1,
      out: "wf: send refused (closed): stage plan is finishing; it takes no new messages. Say so in your result.",
    });
  } finally {
    await control.close();
  }
});
