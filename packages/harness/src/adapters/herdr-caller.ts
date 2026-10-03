import { randomUUID } from "node:crypto";
import type { AgentRunHostFactory } from "../adapter";
import { type RunProcess, runProcess, withholding } from "../command";
import { record, text } from "../json";
import { createSessionAdapter, localOutcome, type NativeTurnOutcome } from "../session-core";
import { createSingleSessionHostFactory } from "../single-session-host";
import { findHarness, HARNESS_NAMES, harnessSpec } from "../spec";
import type { Harness } from "../types";
import { createSessionAccounting } from "../usage/accounting";
import { createHerdrCommands, type HerdrConfig } from "./herdr";
import {
  abortableDelay,
  type HerdrCommand,
  type HerdrResult,
  hasHerdrErrorCode,
  herdrFailure,
  readable,
  readId,
  readPaneId,
  readSessionRef,
  reportedAgent,
  settleAgent,
  settledOutcome,
  submitPrompt,
} from "./herdr-protocol";

/**
 * The session `awf run --here` was started from (ADR 0010): the one agent pane whose screen showed
 * the run's code, the harness Herdr detected in it, and the directory it works in.
 */
export type CallerPane = { paneId: string; harness: Harness; cwd: string };

type CallerSearch = { kind: "found"; pane: CallerPane } | { kind: "refused"; reason: string };

const SEARCH_POLL_MS = 1_000;
/** Bounds the interrupt's calls, so a slow Herdr cannot outlast the engine's release grace. */
const INTERRUPT_MS = 2_000;
/** Lines of each pane read for the code: the agent's reply is the last thing on its screen. */
const SEARCH_LINES = 200;
/** Lines read after a turn: back to its prompt, when the turn printed less than this. */
const TURN_LINES = 400;

/**
 * Finds the one agent pane whose screen shows `code`, until `by`. Neither `$HERDR_PANE_ID` nor
 * Herdr's own session record finds it: under codex, every pane's tools run in one shared daemon
 * with whichever pane started it as their environment (E8). Two panes showing it is a refusal; so
 * is one whose harness the run cannot drive.
 */
export async function findCallerPane(
  herdr: HerdrCommand,
  code: string,
  options: { by: number; pollMs?: number; signal?: AbortSignal },
): Promise<CallerSearch> {
  const pollMs = options.pollMs ?? SEARCH_POLL_MS;
  const remaining = () => Math.max(1, options.by - Date.now());
  for (;;) {
    const listed = await herdr(["pane", "list"], remaining(), options.signal);
    if (!listed.ok) {
      return { kind: "refused", reason: `Herdr could not list its panes: ${listed.error}` };
    }
    const panes = (Array.isArray(listed.result.panes) ? listed.result.panes : [])
      .map((pane) => record(pane))
      .filter((pane): pane is Record<string, unknown> => !!pane && !!text(pane.agent));
    const showing = (
      await Promise.all(
        panes.map(async (pane) => {
          const paneId = text(pane.pane_id);
          if (!paneId) return undefined;
          const read = await herdr(
            [
              "pane",
              "read",
              paneId,
              "--source",
              "recent-unwrapped",
              "--lines",
              String(SEARCH_LINES),
            ],
            remaining(),
            options.signal,
          );
          return read.ok && read.stdout.includes(code) ? pane : undefined;
        }),
      )
    ).filter((pane): pane is Record<string, unknown> => pane !== undefined);
    if (showing.length > 1) {
      const ids = showing.map((pane) => text(pane.pane_id)).join(", ");
      return {
        kind: "refused",
        reason: `more than one pane shows ${code} (${ids}), so the calling session is not known`,
      };
    }
    const [pane] = showing;
    if (pane) {
      const paneId = text(pane.pane_id)!;
      const harness = text(pane.agent)!;
      if (!findHarness(harness)) {
        return {
          kind: "refused",
          reason: `the calling session in ${paneId} is ${harness}, and awf drives ${HARNESS_NAMES.join(", ")}`,
        };
      }
      const cwd = text(pane.cwd) ?? text(pane.foreground_cwd);
      if (!cwd) return { kind: "refused", reason: `Herdr reports no directory for ${paneId}` };
      return { kind: "found", pane: { paneId, harness: harness as Harness, cwd } };
    }
    if (Date.now() + pollMs >= options.by) {
      return {
        kind: "refused",
        reason: `no agent pane showed ${code} in its last ${SEARCH_LINES} lines; the calling session puts it there by replying with it`,
      };
    }
    if (!(await abortableDelay(pollMs, options.signal))) {
      return { kind: "refused", reason: "cancelled while looking for the calling session" };
    }
  }
}

/**
 * Whether the operator stopped the turn whose prompt carried `operationId`: a line after that
 * prompt starts with the harness's marker, past the glyph the harness puts before it. When the
 * prompt has scrolled out of what was read, all of it came after. A marker from an earlier turn is
 * before it; one quoted in the agent's own output does not start its line.
 */
export function interruptedAfter(screen: string, operationId: string, marker: string): boolean {
  const at = screen.lastIndexOf(operationId);
  return (at === -1 ? screen : screen.slice(at))
    .split("\n")
    .some((line) => line.replace(/^[^\p{L}\p{N}]+/u, "").startsWith(marker));
}

/**
 * The run host for the calling session: every turn prompted into its pane once it has settled, as a
 * pane agent's is (ADR 0008), and none of the pane's lifecycle. The pane is never opened, closed or
 * compacted here, and the run's cleanup leaves it as it is (ADR 0010).
 */
export function createCallerHostFactory(
  config: HerdrConfig,
  caller: CallerPane,
  run: RunProcess = runProcess,
): AgentRunHostFactory {
  const { herdr } = createHerdrCommands(config, run);
  const adapter = createSessionAdapter({
    harnesses: [caller.harness],
    placement: "pane",
    async activate(request) {
      if (!request.execution.caller) throw new Error("this host drives only the calling session");
      const spec = harnessSpec(caller.harness);
      const pane = caller.paneId;
      let closed = false;
      let activeController: AbortController | undefined;
      let activeCompletion: Promise<void> | undefined;
      /**
       * The prompt of the run's turn whose answer is still awaited, by number: the one turn the
       * host may interrupt. Cleared as that turn ends, or is answered and left finishing.
       */
      let outstanding: number | undefined;
      let prompts = 0;
      /** When this host first prompted the session: where the run's share of its spend begins. */
      let firstPrompt: number | undefined;

      const stopWaiting = async (): Promise<boolean> => {
        if (!activeController) return false;
        activeController.abort();
        await activeCompletion;
        return true;
      };
      /**
       * Stops the run's own turn, once, and only while the pane is working on it: a turn that ended
       * while its status was read may already have given the pane back to the operator.
       */
      const interrupt = async (): Promise<void> => {
        const mine = outstanding;
        if (mine === undefined) return;
        const got = await herdr(["agent", "get", pane], INTERRUPT_MS);
        const agent = got.ok ? reportedAgent(got.result) : undefined;
        if (outstanding !== mine || agent?.agent_status !== "working") return;
        outstanding = undefined;
        await herdr(["agent", "send-keys", pane, "esc"], INTERRUPT_MS);
      };
      return {
        identity: { sessionId: randomUUID(), cwd: caller.cwd },
        // The session is the operator's: an answered turn ends on its own, and the next is
        // prompted once it has. Whatever works on past its grace may be the operator's own turn,
        // so the host stops waiting on it and never interrupts it.
        finishesAnswered: true,
        stopFinishing: stopWaiting,
        leftFinishing() {
          outstanding = undefined;
        },
        promptedAt: () => firstPrompt,
        async execute(operation) {
          if (closed) throw new Error("the calling session's host is closed");
          if (operation.kind === "compact") {
            return localOutcome(
              "failed",
              "the calling session's context is the operator's, so a run does not compact it",
            );
          }
          const deadline = operation.deadline.unixMilliseconds;
          const controller = new AbortController();
          activeController = controller;
          let finish!: () => void;
          activeCompletion = new Promise<void>((resolve) => {
            finish = resolve;
          });
          try {
            // Herdr's prompt wait does not track turns, so the session settles first (E8): the
            // turn that replied with the code, the operator's own, or the last operation's.
            const busy = await settleAgent(herdr, pane, deadline, controller.signal);
            if (busy) return busy;
            const waitMs = deadline - Date.now();
            if (waitMs <= 0) return localOutcome("timed-out", "operation deadline exceeded");
            outstanding = ++prompts;
            firstPrompt ??= Date.now();
            const sent = await submitPrompt(
              herdr,
              pane,
              pane,
              operation.prompt,
              spec.pastesQuoted === true,
              waitMs,
              controller.signal,
            );
            if (!sent.ok) {
              if (sent.cancelled || controller.signal.aborted) {
                return localOutcome("cancelled", "pane operation cancelled");
              }
              if (hasHerdrErrorCode(sent.error, "agent_prompt_stalled")) {
                // Submitted, so the turn may be running: wait for its answer, not for a resend.
                if (
                  !(await abortableDelay(Math.max(0, deadline - Date.now()), controller.signal))
                ) {
                  return localOutcome("cancelled", "pane operation cancelled");
                }
                await interrupt();
                return localOutcome(
                  "timed-out",
                  "operation deadline exceeded after a stalled prompt observation",
                );
              }
              return herdrFailure(sent, deadline - Date.now());
            }
            outstanding = undefined;
            const read = await herdr(
              [
                "agent",
                "read",
                pane,
                "--source",
                "recent-unwrapped",
                "--lines",
                String(TURN_LINES),
              ],
              Math.max(1, deadline - Date.now()),
              controller.signal,
            );
            if (!read.ok && read.cancelled) {
              return localOutcome("cancelled", "pane operation cancelled");
            }
            return callerOutcome(caller.harness, spec.interrupted, sent, read, operation);
          } finally {
            outstanding = undefined;
            if (activeController === controller) activeController = undefined;
            finish();
          }
        },
        async cancel() {
          if (!activeController) return false;
          await interrupt();
          await stopWaiting();
          return true;
        },
        async close() {
          if (closed) return;
          await interrupt();
          await stopWaiting();
          closed = true;
        },
      };
    },
  });
  const host = createSingleSessionHostFactory(adapter);
  return {
    // The operator's session gets whatever its harness has; nothing was withheld from it.
    accounting: createSessionAccounting(withholding(run, config.emptyEnvironment ?? [])),
    caller: { harness: caller.harness, cwd: caller.cwd },
    openRun: (spec) => host.openRun(spec),
  };
}

function callerOutcome(
  harness: Harness,
  marker: string | undefined,
  sent: Extract<HerdrResult, { ok: true }>,
  read: HerdrResult,
  operation: { binding?: { operationId: string } },
): NativeTurnOutcome {
  const agent = reportedAgent(sent.result);
  const screen = read.ok ? readable(read.stdout) : "";
  const settled = settledOutcome(agent);
  const operationId = operation.binding?.operationId;
  const interrupted =
    settled.state === "completed" &&
    marker !== undefined &&
    operationId !== undefined &&
    interruptedAfter(screen, operationId, marker);
  // Herdr's codex integration reports from codex's shared daemon, so its session is another
  // pane's (E8); the launcher reports this one's own from `CODEX_SESSION_ID`.
  const session = harness === "codex" ? undefined : readSessionRef(agent);
  return {
    ...(interrupted ? { state: "cancelled", detail: "interrupted by the operator" } : settled),
    resultEvidence: screen.trim() ? { kind: "transcript", text: screen } : { kind: "unavailable" },
    ...(session ? { sessionRef: session } : {}),
    chargesUsd: [],
  };
}

/** How long a hand-back waits for the session to settle before it is sent anyway, queued. */
const HAND_BACK_SETTLE_MS = 10_000;

/**
 * The run's last message to the calling session: how it ended and where its record is. It is not an
 * operation, and nothing answers it; it is sent once the session settles, or queued after
 * `settleMs` (ADR 0010).
 */
export async function handBack(
  config: HerdrConfig,
  paneId: string,
  message: string,
  run: RunProcess = runProcess,
  settleMs = HAND_BACK_SETTLE_MS,
): Promise<string | undefined> {
  const { herdr } = createHerdrCommands(config, run);
  await herdr(["agent", "wait", paneId, "--timeout", String(settleMs)], settleMs + 5_000);
  const sent = await herdr(["agent", "prompt", paneId, message]);
  return sent.ok ? undefined : sent.error;
}

/** `findCallerPane` against the Herdr `config` names. */
export function searchCaller(
  config: HerdrConfig,
  code: string,
  options: { by: number; pollMs?: number; signal?: AbortSignal },
  run: RunProcess = runProcess,
): Promise<CallerSearch> {
  return findCallerPane(createHerdrCommands(config, run).herdr, code, options);
}

/**
 * Opens a tab in `workspace`, beside the operator's, and types `argv` into its login shell. The
 * command runs as a process Herdr started, not one of the calling session's, which is what keeps a
 * run out of that session's sandbox.
 */
export async function startInNewTab(
  config: HerdrConfig,
  tab: { workspace: string; cwd: string; label: string; argv: readonly string[] },
  run: RunProcess = runProcess,
): Promise<{ ok: true; tabId: string; paneId: string } | { ok: false; error: string }> {
  const commands = createHerdrCommands(config, run);
  const created = await commands.herdr([
    "tab",
    "create",
    "--workspace",
    tab.workspace,
    "--cwd",
    tab.cwd,
    "--label",
    tab.label,
    "--no-focus",
  ]);
  if (!created.ok) return { ok: false, error: created.error };
  const tabId = readId(created.result.tab, "tab_id");
  const paneId = readPaneId(created.result);
  if (!tabId || !paneId) {
    if (tabId) await commands.herdr(["tab", "close", tabId]);
    return { ok: false, error: "tab create returned no tab or pane" };
  }
  const typed = await commands.typeCommand(
    paneId,
    tab.argv,
    Date.now() + config.commandTimeoutMs,
    new AbortController().signal,
  );
  if (!typed?.ok) {
    await commands.herdr(["tab", "close", tabId]);
    return { ok: false, error: typed ? typed.error : "typing into the new tab was cancelled" };
  }
  return { ok: true, tabId, paneId };
}

/** Whether this process can drive Herdr: a sandboxed agent's shell may not reach its socket. */
export async function herdrReachable(
  config: HerdrConfig,
  run: RunProcess = runProcess,
): Promise<string | undefined> {
  const listed = await createHerdrCommands(config, run).herdr(["pane", "list"]);
  return listed.ok ? undefined : listed.error;
}

/** Brings `tabId` forward in the operator's Herdr; best effort. */
export async function focusTab(
  config: HerdrConfig,
  tabId: string,
  run: RunProcess = runProcess,
): Promise<void> {
  await createHerdrCommands(config, run).herdr(["tab", "focus", tabId]);
}
