import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildAgentBundle, installSandboxedDoor } from "../packages/engine/src/agent-launcher";
import { startResultControlPlane } from "../packages/engine/src/control-plane";
import { Messaging } from "../packages/engine/src/messaging/messaging";
import { createResultSlotRegistry } from "../packages/engine/src/result-slots";
import { resolveSandbox } from "../packages/sandbox/src/resolve";
import { createSrtProvider, findSrt } from "../packages/sandbox/src/srt";
import { runCommand } from "../packages/sandbox/src/testing/conformance";

// A local test: real srt on this machine, `sh` for an agent, no model. Skipped without srt.
const home = realpathSync(homedir());
const harnessState = [join(home, ".claude"), join(home, ".codex"), join(home, ".pi", "agent")];
const found = await findSrt(process.env, harnessState);
const provider = found && createSrtProvider(found);

/** `wf`'s messaging commands from inside an srt sandbox, through the agent's door. */
describe.skipIf(!provider)("messaging through the srt door", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-door-")));
  const runRoot = join(root, "runs");
  const repo = join(root, "repo");
  const directory = join(runRoot, "run", "door");
  let close: () => Promise<void> = async () => undefined;
  let sh: (script: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  let launcher = "";

  beforeAll(async () => {
    await mkdir(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", repo]);
    const control = await startResultControlPlane({
      slots: createResultSlotRegistry({ runDir: join(root, "run") }),
    });
    const channel = await control.openChannel("reviewer");
    const door = await installSandboxedDoor(
      dirname(channel.endpoint),
      channel.endpoint,
      await buildAgentBundle(),
    );
    launcher = door.launcher;
    const messaging = new Messaging({
      agent: () => ({ state: "working" }),
      canAwait: () => true,
      launcher: () => door.launcher,
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
      { from: "reviewer", to: "implementer" },
      { purpose: "Ask about the design.", scope: messaging.attempt },
    );
    const { sandbox } = await resolveSandbox(
      { write: ["."] },
      {
        key: "door",
        cwd: repo,
        runRoot: await mkdir(runRoot, { recursive: true }).then(() => realpathSync(runRoot)),
        machineRoot: join(home, ".awf"),
        harnessState,
        providers: { installed: { srt: provider! }, default: "srt" },
      },
    );
    await mkdir(join(directory, "homes", "reviewer"), { recursive: true });
    const opened = await (provider as NonNullable<typeof provider>).open(sandbox as never, {
      runRoot,
      directory,
      deadline: { unixMilliseconds: Date.now() + 120_000 },
    });
    const occupant = await opened.admit({
      cwd: repo,
      home: join(directory, "homes", "reviewer"),
      door,
      harness: {
        env: {},
        seed: [],
        secrets: {},
        defaults: () => [],
        domains: [],
        command: "/bin/sh",
        executable: "/bin/sh",
        reads: [],
      },
    });
    sh = (script) =>
      runCommand(
        occupant.launch({ argv: ["/bin/sh", "-c", script], cwd: repo, timeoutMs: 30_000 }),
      );
    close = async () => {
      await opened.close();
      await control.close();
    };
  }, 60_000);

  afterAll(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  test("peers, a send with a heredoc, and a refusal all pass the door", async () => {
    const peers = await sh(`${launcher} peers --json`);
    expect(peers.exitCode).toBe(0);
    expect(JSON.parse(peers.stdout)).toMatchObject({
      peers: [{ peer: "implementer", can: "send", state: "working" }],
    });
    const sent = await sh(`${launcher} send implementer <<'EOF'\nWhich queue?\nEOF`);
    expect(sent).toMatchObject({ exitCode: 0 });
    expect(sent.stdout).toContain("wf: sent to implementer");
    const refused = await sh(`${launcher} reply implementer 'nothing owed'`);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("reply refused (none-owed)");
  });
});
