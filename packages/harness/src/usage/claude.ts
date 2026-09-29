import { join } from "node:path";
import { count, type Row, record, text } from "../json";
import { harnessState } from "../state";
import { entries, isFile, jsonRows, safeId } from "./files";
import type { SessionRead, UsageRecord } from "./records";

/** Under `home`, the harness's home: the operator's unless an agent was given its own. */
export function claudeProjectsDirectory(home = harnessState().claude): string {
  return join(home, "projects");
}

/**
 * Claude Code writes one transcript per session and one more per subagent under a directory named
 * for the session, nested further for workflow agents, so the tree is walked: reading only the
 * session file undercounts a delegating agent by a third or more.
 */
export async function readClaudeUsage(
  sessions: readonly string[],
  cwd: string,
  projects = claudeProjectsDirectory(),
): Promise<SessionRead | undefined> {
  const files: string[] = [];
  for (const id of sessions) {
    if (!safeId(id)) continue;
    const directory = await projectDirectory(projects, cwd, id);
    if (directory === undefined) continue;
    // The session's own transcript before its subagents': a request both log is the session's.
    files.push(join(directory, `${id}.jsonl`));
    const nested = (await entries(join(directory, id), true)).filter((name) =>
      name.endsWith(".jsonl"),
    );
    files.push(...nested.sort().map((name) => join(directory, id, name)));
  }
  if (files.length === 0) return undefined;

  const requests = new Map<string, { record: UsageRecord; file: string }>();
  for (const file of new Set(files)) {
    for (const row of await jsonRows(file)) {
      const read = readRecord(row);
      if (!read) continue;
      const seen = requests.get(read.key);
      // A request is logged once per content block while it streams, so within a file the last
      // row is the whole request. A forked subagent or a resumed session copies it again, partial
      // or zeroed, so across files only a larger output replaces it. Whoever logged it first is
      // who spent it.
      const replaces =
        !seen ||
        (seen.file === file
          ? read.tokens.output >= seen.record.tokens.output
          : read.tokens.output > seen.record.tokens.output);
      if (!replaces) continue;
      requests.set(read.key, {
        record: seen ? { ...read, delegated: seen.record.delegated } : read,
        file: seen?.file ?? file,
      });
    }
  }
  // Claude writes nothing once its pane or process is gone: an answered agent's session ends on
  // its `wf result` call for good. There is no turn left to wait for.
  return { records: [...requests.values()].map(({ record }) => record), open: false };
}

function readRecord(row: Row): UsageRecord | undefined {
  const requestId = text(row.requestId);
  const at = text(row.timestamp);
  const message = record(row.message);
  const usage = record(message?.usage);
  const model = text(message?.model);
  // `<synthetic>` is the placeholder an API error is logged under; it bills nothing.
  if (!requestId || !at || !usage || !model || model === "<synthetic>") return undefined;
  const creation = record(usage.cache_creation);
  const details = record(usage.output_tokens_details);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const output = count(usage.output_tokens);
  return {
    key: requestId,
    at,
    model,
    provider: "anthropic",
    delegated: row.isSidechain === true,
    tokens: {
      input: count(usage.input_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite,
      // Without the breakdown the lifetime is unknown, and the cheaper class understates.
      ...(creation
        ? { cacheWrite1h: Math.min(cacheWrite, count(creation.ephemeral_1h_input_tokens)) }
        : {}),
      output,
      ...(details ? { reasoning: Math.min(output, count(details.thinking_tokens)) } : {}),
    },
  };
}

/**
 * The directory is named for the session's cwd, but the encoding is the harness's to change, so
 * the derived name is only a fast guess; a miss finds the session by its id, which is unique.
 */
async function projectDirectory(
  projects: string,
  cwd: string,
  id: string,
): Promise<string | undefined> {
  const guess = join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  if (await isFile(join(guess, `${id}.jsonl`))) return guess;
  for (const name of await entries(projects)) {
    if (await isFile(join(projects, name, `${id}.jsonl`))) return join(projects, name);
  }
  return undefined;
}
