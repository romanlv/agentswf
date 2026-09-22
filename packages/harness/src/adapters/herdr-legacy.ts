import { randomUUID } from "node:crypto";
import type { AgentSessionAdapter, HarnessActivation } from "../adapter";
import { runProcess, type RunProcess } from "../command";
import { createLegacyDriver } from "../legacy-driver";
import { createSessionAdapter, type ActivatedSessionBackend } from "../session-core";
import { harnessSpec } from "../spec";
import type { AgentSessionDriver, CallIdentity } from "../types";
import { createHerdrCommands, type HerdrConfig } from "./herdr";
import {
  emptyEnvironmentArgs,
  herdrFailure,
  knownHarness,
  readId,
  readPaneId,
  readSessionRef,
  record,
  safeAgentName,
  settledState,
  statusText,
  type HerdrCommand,
} from "./herdr-protocol";

/** A workspace per call, closed after. Every harness flag it passes through is in `spec.ts`. */
export function createHerdrAdapter(
  config: HerdrConfig,
  run: RunProcess = runProcess,
): AgentSessionDriver {
  return createLegacyDriver({
    kind: "pane",
    timeoutMs: config.settleTimeoutMs + config.commandTimeoutMs,
    adapter(call) {
      return createLegacyPaneAdapter(config, run, call);
    },
  });
}

function createLegacyPaneAdapter(
  config: HerdrConfig,
  run: RunProcess,
  call: CallIdentity,
): AgentSessionAdapter & {
  legacyTranscript(): Promise<string | null>;
  legacySessionRef(): string | undefined;
} {
  const { herdr, startAgent } = createHerdrCommands(config, run);
  let legacyTranscript: (() => Promise<string | null>) | undefined;
  let legacySessionRef: string | undefined;
  const adapter = createSessionAdapter({
    harnesses: ["claude", "codex", "pi", "cursor"],
    observeSessionRef: (sessionRef) => {
      legacySessionRef = sessionRef;
    },
    async activate(request) {
      const legacy = await activateLegacyPane(request, call, config, herdr, startAgent);
      legacyTranscript = legacy.readTranscript;
      return legacy.backend;
    },
  });
  return Object.assign(adapter, {
    async legacyTranscript() {
      return legacyTranscript?.() ?? null;
    },
    legacySessionRef: () => legacySessionRef,
  });
}

async function activateLegacyPane(
  request: HarnessActivation,
  call: CallIdentity,
  config: HerdrConfig,
  herdr: HerdrCommand,
  startAgent: ReturnType<typeof createHerdrCommands>["startAgent"],
): Promise<{
  backend: ActivatedSessionBackend;
  readTranscript(): Promise<string | null>;
}> {
  const harness = knownHarness(request.execution.harness);
  const spec = harnessSpec(harness);
  const emptyEnvironment = emptyEnvironmentArgs(config.emptyEnvironment);
  const name = safeAgentName(`wf-${call.callId}`);
  const created = await herdr([
    "workspace",
    "create",
    "--label",
    `${config.workspaceLabel} ${call.callId}`,
    ...emptyEnvironment,
    "--env",
    `WF_RUN=${call.runDir}`,
    "--env",
    `WF_CALL=${call.callId}`,
    ...(config.binDir ? ["--env", `PATH=${config.binDir}:${process.env.PATH ?? ""}`] : []),
    "--cwd",
    request.cwd,
    "--no-focus",
  ]);
  if (!created.ok) throw new Error(`workspace create failed: ${created.error}`);
  const paneId = readPaneId(created.result);
  const workspaceId = readId(created.result.workspace, "workspace_id");
  const closeWorkspace = async () => {
    if (!workspaceId) return;
    const closed = await herdr(["workspace", "close", workspaceId]);
    if (!closed.ok) throw new Error(`workspace close failed: ${closed.error}`);
  };
  if (!paneId || !workspaceId) {
    await closeWorkspace();
    throw new Error("workspace create returned incomplete identity");
  }
  const launch = spec.interactive(request.execution.model);
  const started = await startAgent(
    name,
    harness,
    paneId,
    launch.argv.slice(1),
    request.deadline.unixMilliseconds,
  );
  if (!started.ok) {
    await closeWorkspace();
    throw new Error(`agent start failed after ${started.attempts}: ${started.error}`);
  }
  let active: AbortController | undefined;
  let activeCompletion: Promise<void> | undefined;
  let isClosed = false;
  const backend: ActivatedSessionBackend = {
    identity: { sessionId: randomUUID(), cwd: request.cwd },
    async execute(operation) {
      if (isClosed) throw new Error("pane session is closed");
      const controller = new AbortController();
      active = controller;
      let finish!: () => void;
      activeCompletion = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        const remaining = Math.max(1, operation.deadline.unixMilliseconds - Date.now());
        const sent = await herdr(
          [
            "agent",
            "prompt",
            name,
            operation.prompt,
            "--wait",
            "--timeout",
            String(Math.min(config.settleTimeoutMs, remaining)),
          ],
          Math.min(config.settleTimeoutMs + 30_000, remaining),
          controller.signal,
        );
        if (!sent.ok) {
          return herdrFailure(sent, operation.deadline.unixMilliseconds - Date.now());
        }
        const read = await herdr(
          ["agent", "read", name, "--source", "detection"],
          Math.max(1, operation.deadline.unixMilliseconds - Date.now()),
          controller.signal,
        );
        const transcript = read.ok && read.stdout.trim() !== "" ? read.stdout : undefined;
        const agent = record(sent.result.agent) ?? sent.result;
        const sessionRef = readSessionRef(agent);
        const state = settledState(agent);
        return {
          state:
            state === "idle" || state === "done"
              ? "completed"
              : state === "blocked"
                ? "blocked"
                : "failed",
          ...(statusText(agent) ? { detail: statusText(agent) } : {}),
          resultEvidence: transcript
            ? { kind: "transcript" as const, text: transcript }
            : { kind: "unavailable" as const },
          ...(sessionRef ? { sessionRef } : {}),
          nativeUsage: [],
        };
      } finally {
        if (active === controller) active = undefined;
        finish();
      }
    },
    async cancel() {
      if (!active) return false;
      active.abort();
      await activeCompletion;
      return true;
    },
    async close() {
      active?.abort();
      await activeCompletion;
      await closeWorkspace();
      isClosed = true;
    },
  };
  return {
    backend,
    async readTranscript() {
      const read = await herdr(["agent", "read", name, "--source", "detection"]);
      return read.ok && read.stdout.trim() !== "" ? read.stdout : null;
    },
  };
}
