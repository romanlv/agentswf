import type { Activity } from "@agentswf/contract/records";
import { parseRow, type Row, record, text } from "../json";
import { cut } from "./mask";
import { type ActivityItem, type ActivityLine, argumentOf, contentText } from "./read";

/** A tool call, its argument cut for the line and kept whole for `--full`. */
function tool(name: string, input: unknown, call?: string, background?: boolean): ActivityItem {
  const argument = argumentOf(input);
  return {
    activity: {
      type: "tool",
      tool: name,
      ...(argument ? { input: cut(argument) } : {}),
      ...(call ? { call } : {}),
      ...(background ? { background: true } : {}),
    },
    ...(argument === undefined ? {} : { text: argument }),
  };
}

function message(from: "agent" | "user", said: string): ActivityItem {
  return { activity: { type: "message", from, chars: said.length }, text: said };
}

function result(call: string | undefined, output: string, error: boolean, exit?: number) {
  const activity: Activity = {
    type: "tool-result",
    ...(call ? { call } : {}),
    ...(error ? { error: true } : {}),
    ...(exit === undefined ? {} : { exit }),
  };
  return { activity, text: output };
}

const COMPACTION: ActivityItem = { activity: { type: "compaction" } };

/** What claude writes as a user row that nobody typed: a slash command and its output. */
const CLAUDE_INJECTED = ["<command-name>", "<command-message>", "<local-command-"];

/** What codex puts in a user message beside the prompt: instructions and its environment. */
const CODEX_INJECTED = [
  "# AGENTS.md instructions",
  "<environment_context>",
  "<user_instructions>",
  "<permissions instructions>",
];

/**
 * A claude transcript row. The prompt awf sends is a user row too, and shown as one; a row claude
 * marks as meta is its own bookkeeping.
 */
export function claudeActivity(row: Row): ActivityLine {
  const at = text(row.timestamp);
  if (row.type === "system" && row.subtype === "compact_boundary") {
    return { ...(at ? { at } : {}), items: [COMPACTION] };
  }
  const content = record(row.message)?.content;
  const items: ActivityItem[] = [];
  if (row.type === "assistant" && Array.isArray(content)) {
    for (const block of content.map(record)) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        items.push(message("agent", block.text));
      } else if (block?.type === "tool_use") {
        const input = record(block.input);
        items.push(
          tool(
            text(block.name) ?? "tool",
            block.input,
            text(block.id),
            input?.run_in_background === true,
          ),
        );
      }
    }
  } else if (row.type === "user" && row.isMeta !== true && row.isCompactSummary !== true) {
    const results = Array.isArray(content)
      ? content.map(record).filter((block) => block?.type === "tool_result")
      : [];
    for (const block of results) {
      items.push(
        result(text(block!.tool_use_id), contentText(block!.content), block!.is_error === true),
      );
    }
    const said = Array.isArray(content)
      ? contentText(content.filter((block) => record(block)?.type === "text"))
      : contentText(content);
    if (results.length === 0 && said.trim()) {
      if (said.trimStart().startsWith("<task-notification>")) {
        items.push({ activity: { type: "background-ended" }, text: said });
      } else if (!CLAUDE_INJECTED.some((tag) => said.trimStart().startsWith(tag))) {
        items.push(message("user", said));
      }
    }
  }
  return { ...(at ? { at } : {}), items };
}

/**
 * A codex rollout row. The context codex injects into a user message is tagged, `<environment_…>`,
 * and passed over; a call's output names its exit code where the shell gave one.
 */
export function codexActivity(row: Row): ActivityLine {
  const at = text(row.timestamp);
  const payload = record(row.payload);
  const items: ActivityItem[] = [];
  if (row.type === "compacted" || payload?.type === "compaction") items.push(COMPACTION);
  else if (row.type === "response_item" && payload) {
    switch (payload.type) {
      case "message": {
        const said = contentText(payload.content);
        if (payload.role === "assistant" && said.trim()) items.push(message("agent", said));
        if (
          payload.role === "user" &&
          said.trim() &&
          !CODEX_INJECTED.some((prefix) => said.trimStart().startsWith(prefix))
        ) {
          items.push(message("user", said));
        }
        break;
      }
      case "function_call": {
        const raw = text(payload.arguments);
        items.push(
          tool(text(payload.name) ?? "tool", (raw && parseRow(raw)) ?? raw, text(payload.call_id)),
        );
        break;
      }
      case "custom_tool_call": {
        const input = text(payload.input) ?? "";
        // Codex's code mode runs a script; the command it runs is the argument worth showing.
        const command = /\bcmd\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/.exec(input)?.[2];
        items.push(tool(text(payload.name) ?? "tool", command ?? input, text(payload.call_id)));
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const output =
          typeof payload.output === "string" ? payload.output : contentText(payload.output);
        // Only a structured exit is taken: a script's output may print anything.
        const exit = record(parseRow(output)?.metadata)?.exit_code;
        const known = typeof exit === "number" ? exit : undefined;
        const failed = (known !== undefined && known !== 0) || output.startsWith("Script failed");
        items.push(result(text(payload.call_id), output, failed, known));
        break;
      }
    }
  }
  return { ...(at ? { at } : {}), items };
}

/** A pi session row. */
export function piActivity(row: Row): ActivityLine {
  const at = text(row.timestamp);
  if (row.type === "compaction") return { ...(at ? { at } : {}), items: [COMPACTION] };
  const entry = record(row.message);
  const items: ActivityItem[] = [];
  if (row.type === "message" && entry) {
    if (entry.role === "assistant" && Array.isArray(entry.content)) {
      for (const block of entry.content.map(record)) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          items.push(message("agent", block.text));
        } else if (block?.type === "toolCall") {
          items.push(tool(text(block.name) ?? "tool", block.arguments, text(block.id)));
        }
      }
    } else if (entry.role === "toolResult") {
      items.push(
        result(text(entry.toolCallId), contentText(entry.content), entry.isError === true),
      );
    } else if (entry.role === "user") {
      const said = contentText(entry.content);
      if (said.trim()) items.push(message("user", said));
    }
  }
  return { ...(at ? { at } : {}), items };
}
