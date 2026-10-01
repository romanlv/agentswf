import {
  ANSI_SEQUENCE,
  abortableDelay,
  HERDR_REPORT_GRACE_MS,
  type HerdrCommand,
  type HerdrResult,
  readable,
  reportedAgent,
  settledState,
} from "./herdr-protocol";

/**
 * An agent that has just dismissed a startup block reports ready before its terminal UI accepts
 * input again, and a prompt submitted into that window is discarded with no record: Herdr answers
 * `agent_prompt_stalled` and the pane sits idle for the rest of the operation. The same length
 * separates one block from the next, which is why it is spent inside the loop. Story 001 holds the
 * measurement behind it.
 */
const TRUST_HANDSHAKE_SETTLE_MS = 2_000;

/**
 * Startup shows a queue, not one gate: a Codex release turns the trust block into an update notice
 * followed by the trust block. The loop ends on its own once no unanswered block matches; this
 * only bounds how long an agent that keeps raising new ones is worked through.
 */
const MAX_STARTUP_BLOCKS = 3;

export async function answerStartupBlocks(
  herdr: HerdrCommand,
  name: string,
  kind: string,
  settleMs: number | undefined,
  deadlineUnixMs: number,
  signal?: AbortSignal,
): Promise<HerdrResult> {
  const settle = settleMs ?? TRUST_HANDSHAKE_SETTLE_MS;
  const remaining = () => deadlineUnixMs - Date.now();
  const answered = new Set<string>();
  let screen = "";

  while (answered.size < MAX_STARTUP_BLOCKS) {
    const inactive = trustHandshakeInactive(deadlineUnixMs, signal);
    if (inactive) return inactive;
    const read = await herdr(
      ["agent", "read", name, "--source", "detection"],
      Math.max(1, remaining()),
      signal,
    );
    if (!read.ok) return read;
    screen = read.stdout;

    const block = startupBlock(kind, screen, answered);
    if (!block) break;

    const inactiveAfterRead = trustHandshakeInactive(deadlineUnixMs, signal);
    if (inactiveAfterRead) return inactiveAfterRead;
    const sent = await herdr(
      ["agent", "send-keys", name, ...block.keys],
      Math.max(1, remaining()),
      signal,
    );
    if (!sent.ok) return sent;
    answered.add(block.id);

    // Settling is only worth it if the operation can still use the agent afterwards. Spending the
    // last of the deadline here would report a timeout against an agent that is past its blocks,
    // so stop instead and let the caller's own deadline check decide.
    if (remaining() <= settle) break;
    if (!(await abortableDelay(settle, signal))) {
      return { ok: false, error: "operation cancelled", timedOut: false, cancelled: true };
    }
  }

  if (answered.size === 0) {
    return {
      ok: false,
      error: `agent startup stopped at an unrecognized startup block: ${oneLine(screen)}`,
      timedOut: false,
      cancelled: false,
    };
  }

  const inactiveAfterInput = trustHandshakeInactive(deadlineUnixMs, signal);
  if (inactiveAfterInput) return inactiveAfterInput;
  const waitMs = Math.max(1, remaining());
  const ready = await herdr(
    ["agent", "wait", name, "--until", "idle", "--until", "done", "--timeout", String(waitMs)],
    waitMs + HERDR_REPORT_GRACE_MS,
    signal,
  );
  if (!ready.ok) return ready;
  // Herdr answers this call for a blocked agent too. Reporting it started would put the prompt
  // into a pane that is still showing a question, where it is typed and discarded.
  const waited = reportedAgent(ready.result);
  if (settledState(waited) === "blocked") {
    return {
      ok: false,
      error:
        `agent is still blocked after ${answered.size} answered startup block(s): ` +
        oneLine(screen),
      timedOut: false,
      cancelled: false,
    };
  }
  return trustHandshakeInactive(deadlineUnixMs, signal) ?? ready;
}

function trustHandshakeInactive(
  deadlineUnixMs: number,
  signal: AbortSignal | undefined,
): Extract<HerdrResult, { ok: false }> | undefined {
  if (signal?.aborted) {
    return {
      ok: false,
      error: "operation cancelled",
      timedOut: false,
      cancelled: true,
    };
  }
  if (deadlineUnixMs <= Date.now()) {
    return {
      ok: false,
      error: "operation deadline exceeded",
      timedOut: true,
      cancelled: false,
    };
  }
  return undefined;
}

/**
 * Every phrase must appear for the block to be answered, and the keys must reach the option those
 * phrases name even if the menu is reordered: Codex's update block offers `curl | sh` above the
 * option this host wants, so it is dismissed by the digit that labels the option and never by
 * arrowing onto it.
 */
type StartupBlockSpec = {
  id: string;
  kind: string;
  phrases: readonly string[];
  keys: readonly string[];
};

const STARTUP_BLOCKS: readonly StartupBlockSpec[] = [
  {
    id: "claude-trust",
    kind: "claude",
    phrases: [
      "Quick safety check: Is this a project you created or one you trust?",
      "Yes, I trust this folder",
    ],
    keys: ["down", "enter"],
  },
  {
    id: "codex-trust",
    kind: "codex",
    phrases: ["Do you trust the contents of this directory?", "1. Yes, continue"],
    keys: ["enter"],
  },
  {
    // codex-cli 0.159 renamed its trust block, and a digit only moves its cursor: the phrase holds
    // the cursor on the option, so enter confirms that one.
    id: "codex-folder-access",
    kind: "codex",
    phrases: ["Folder access", "Trust this folder?", "› 1. Trust and continue"],
    keys: ["enter"],
  },
  {
    id: "codex-update",
    kind: "codex",
    phrases: ["Update available!", "2. Skip"],
    keys: ["2"],
  },
];

/**
 * The block is rendered into the pane's own width and styled by the agent's own TUI, so neither
 * the whitespace nor the escape sequences in it are ours to predict: a half-width pane broke
 * Codex's question across two lines, and a terminal breaking at the column rather than at a space
 * turns `directory?` into `direc tory?`. None of the phrases mean anything by their spacing, so
 * none of it is compared.
 */
function matchable(text: string): string {
  return text.replace(ANSI_SEQUENCE, "").replace(/\s+/g, "");
}

/**
 * An answered block whose screen has not repainted away still matches, and both Codex blocks can
 * be on the pane at once. Table order would then choose the keys, and on the update block the
 * wrong keys run an installer — so the live block is taken to be the lowest one on the screen.
 */
function startupBlock(kind: string, screen: string, answered: ReadonlySet<string>) {
  const normalized = matchable(screen);
  const at = (block: StartupBlockSpec) =>
    Math.min(...block.phrases.map((phrase) => normalized.indexOf(matchable(phrase))));
  return STARTUP_BLOCKS.filter(
    (block) =>
      block.kind === kind &&
      !answered.has(block.id) &&
      block.phrases.every((phrase) => normalized.includes(matchable(phrase))),
  ).sort((left, right) => at(right) - at(left))[0];
}

/** Enough of an unanswerable screen to name it, on the single line an error detail gets. */
function oneLine(screen: string): string {
  const unwrapped = readable(screen).replace(/\s+/g, " ").trim();
  return unwrapped.length > 300 ? `${unwrapped.slice(0, 300)}…` : unwrapped;
}
