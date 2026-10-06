import { lstat, realpath, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { count, parseRow, type Row, record, text } from "../json";
import { harnessState } from "../state";
import { entries, isFile, jsonRows, safeId } from "./files";
import type { SessionRead, UsageRecord } from "./records";

/** Under `home`, the harness's home: the operator's unless an agent was given its own. */
export function claudeProjectsDirectory(home = harnessState().claude): string {
  return join(home, "projects");
}

export async function claudeProjectDirectory(cwd: string, home?: string): Promise<string> {
  const nativeCwd = await realpath(cwd).catch((error: unknown) => {
    if (record(error)?.code === "ENOENT") return cwd;
    throw error;
  });
  return join(claudeProjectsDirectory(home), nativeCwd.replace(/[^A-Za-z0-9]/g, "-"));
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
 * The files session `id` is made of, relative to `home`: its transcript and its subagents'. A
 * resume finds them under the directory named for `cwd`, so they keep that name in any home.
 */
export async function claudeSessionFiles(
  home: string,
  id: string,
  cwd: string,
): Promise<string[] | undefined> {
  if (!safeId(id)) return undefined;
  const projects = claudeProjectsDirectory(home);
  const directory = await projectDirectory(projects, cwd, id);
  if (directory === undefined) return undefined;
  const nested = (await entries(join(directory, id), true))
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(directory, id, name));
  return [join(directory, `${id}.jsonl`), ...nested].map((file) => relative(home, file));
}

/**
 * The session started since `since` whose transcript, in `cwd`'s directory, holds `marker`: a pane's
 * claude in a sandbox, whose session Herdr does not name, found by the operation id its prompt
 * carries. The earliest started wins.
 */
export async function findClaudeSession(
  marker: string,
  since: number,
  cwd: string,
  home?: string,
): Promise<string | undefined> {
  const directory = await claudeProjectDirectory(cwd, home);
  let found: { id: string; started: number } | undefined;
  for (const name of await entries(directory)) {
    if (!name.endsWith(".jsonl")) continue;
    let content: string;
    try {
      content = await Bun.file(join(directory, name)).text();
    } catch {
      continue;
    }
    if (!content.includes(marker)) continue;
    const started = Math.min(
      ...content
        .split("\n")
        .flatMap((line) => text(parseRow(line)?.timestamp) ?? [])
        .map((at) => Date.parse(at)),
    );
    if (!(started >= since)) continue;
    if (!found || started < found.started) found = { id: name.slice(0, -6), started };
  }
  return found?.id;
}

/** The summary of the session's last compaction: the row claude marks `isCompactSummary`. */
export async function readClaudeCompactSummary(
  id: string,
  cwd: string,
  projects = claudeProjectsDirectory(),
): Promise<string | undefined> {
  if (!safeId(id)) return undefined;
  const directory = await projectDirectory(projects, cwd, id);
  if (directory === undefined) return undefined;
  const rows = await jsonRows(join(directory, `${id}.jsonl`));
  const summary = rows.findLast((row) => row.isCompactSummary === true);
  const content = record(summary?.message)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.map((part) => text(record(part)?.text) ?? "").join("");
}

/**
 * Drops from fork `fork` of session `parent` the rows the command that wrote it added: claude
 * records a local command and its output as a turn, which the fork's pane would replay and its
 * model read; `/cost` prints the plan's usage since 2.1.291. A row copied from the parent keeps
 * its uuid, so a row the parent lacks is the command's, and a leaf naming one names the row it
 * followed.
 */
export async function dropClaudeForkCommand(
  parent: string,
  fork: string,
  projects = claudeProjectsDirectory(),
): Promise<void> {
  if (!safeId(parent) || !safeId(fork)) return;
  const directory = await projectDirectory(projects, undefined, parent);
  if (directory === undefined) return;
  const path = join(directory, `${fork}.jsonl`);
  if (!(await lstat(path).catch(() => undefined))?.isFile()) return;
  const kept = new Set((await jsonRows(join(directory, `${parent}.jsonl`))).map((row) => row.uuid));
  const lines = (await Bun.file(path).text()).split("\n");
  const rows = lines.map((line) => parseRow(line.trim()));
  const follows = new Map<unknown, unknown>();
  for (const row of rows) {
    if (row && typeof row.uuid === "string" && !kept.has(row.uuid))
      follows.set(row.uuid, row.parentUuid);
  }
  if (follows.size === 0) return;
  const keptAncestor = (uuid: unknown) => {
    let at = uuid;
    while (follows.has(at)) at = follows.get(at);
    return at;
  };
  const written = lines.flatMap((line, at) => {
    const row = rows[at];
    if (!row) return [line];
    if (follows.has(row.uuid)) return [];
    if (!follows.has(row.leafUuid)) return [line];
    return [JSON.stringify({ ...row, leafUuid: keptAncestor(row.leafUuid) })];
  });
  // A rename replaces the name, so a link put in the transcript's place is never written through.
  const staged = `${path}.awf-${process.pid}`;
  await writeFile(staged, written.join("\n"));
  await rename(staged, path);
}

/**
 * The directory is named for the session's cwd, but the encoding is the harness's to change, so
 * the derived name is only a fast guess; a miss finds the session by its id, which is unique.
 */
async function projectDirectory(
  projects: string,
  cwd: string | undefined,
  id: string,
): Promise<string | undefined> {
  const guess = cwd === undefined ? undefined : join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  if (guess && (await isFile(join(guess, `${id}.jsonl`)))) return guess;
  for (const name of await entries(projects)) {
    if (await isFile(join(projects, name, `${id}.jsonl`))) return join(projects, name);
  }
  return undefined;
}
