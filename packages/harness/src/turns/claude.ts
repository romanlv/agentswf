import { record, text } from "../json";
import { claudeProjectDirectory } from "../usage/claude";
import { prepareTurnRecord, type TurnReading, type TurnRecordPlace } from "./record";

const MAX_ROWS = 4096;
const INTERRUPTED = "[Request interrupted by user";

/** A user message's text: a string, or its text blocks; a tool result's is none of it. */
function said(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => text(record(block)?.text) ?? "").join("");
}

/**
 * Only native prompt insertion and linked model output count; queued is not yet received. A prompt
 * may follow the `lead` typed before it. The turn ends at its `turn_duration` once its model has
 * answered, so an earlier turn's cannot end it, or at the interrupt claude writes on Escape, which
 * writes none.
 */
export function createClaudeReceiptReducer(marker: string, lead?: string) {
  const parents = new Map<string, string | undefined>();
  const inputs = new Set<string>();
  let accepted = false;
  let received = false;
  let ended: TurnReading["ended"];
  const matches = (value: unknown) => {
    if (typeof value !== "string") return false;
    const prompt = lead && value.startsWith(lead) ? value.slice(lead.length) : value;
    if (prompt.startsWith(marker)) return true;
    // Claude wraps terminal bracketed pastes before persisting the human input.
    const paste = /^\n\n<pasted_content id="[A-Za-z0-9]+">\n/.exec(prompt);
    return paste !== null && prompt.slice(paste[0].length).startsWith(marker);
  };
  const reading = (): TurnReading => ({ accepted, received, ...(ended ? { ended } : {}) });
  return {
    push(value: unknown): TurnReading {
      const row = record(value);
      if (!row || row.isSidechain === true || ended) return reading();
      const attachment = record(row.attachment);
      const message = record(row.message);
      if (accepted && row.type === "user" && said(message?.content).startsWith(INTERRUPTED)) {
        ended = "interrupted";
        return reading();
      }
      if (received) {
        if (row.type === "system" && row.subtype === "turn_duration") ended = "completed";
        return reading();
      }
      const input =
        (row.type === "user" && matches(message?.content)) ||
        (row.type === "attachment" &&
          attachment?.type === "queued_command" &&
          attachment.commandMode === "prompt" &&
          attachment.humanTurn === true &&
          record(attachment.origin)?.kind === "human" &&
          matches(attachment.prompt));
      if (
        input ||
        (row.type === "queue-operation" && row.operation === "enqueue" && matches(row.content))
      ) {
        accepted = true;
      }
      if (!accepted) return reading();
      const uuid = text(row.uuid);
      if (uuid) {
        if (parents.has(uuid)) return reading();
        if (parents.size >= MAX_ROWS) throw new Error("Claude receipt ancestry exceeds its bound");
        parents.set(uuid, text(row.parentUuid));
        if (input) inputs.add(uuid);
        if (
          row.type === "assistant" &&
          message?.role === "assistant" &&
          typeof message.model === "string" &&
          message.model !== "<synthetic>"
        ) {
          let parent = text(row.parentUuid);
          const visited = new Set<string>();
          while (parent && !visited.has(parent)) {
            if (inputs.has(parent)) {
              received = true;
              accepted = true;
              break;
            }
            visited.add(parent);
            parent = parents.get(parent);
          }
        }
      }
      return reading();
    },
  };
}

/** Where claude writes the sessions it runs in `cwd`: one directory, a file per session. */
export async function claudeTurnPlace(
  cwd: string,
  home?: string,
  session?: string,
): Promise<TurnRecordPlace> {
  return {
    root: await claudeProjectDirectory(cwd, home),
    directories: [""],
    ...(session ? { known: `${session}.jsonl` } : {}),
  };
}

/** claude's transcript for `cwd`, read for the turn whose prompt carries `marker`. */
export async function prepareClaudeReceipt(
  cwd: string,
  marker: string,
  home?: string,
  options: { sessionRef?: string; signal?: AbortSignal; lead?: string } = {},
) {
  options.signal?.throwIfAborted();
  return prepareTurnRecord(
    await claudeTurnPlace(cwd, home, options.sessionRef),
    marker,
    () => createClaudeReceiptReducer(marker, options.lead),
    options.signal ? { signal: options.signal } : {},
  );
}
