import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { count, jsonLines, parseRow, record, text } from "../json";
import { harnessState } from "../state";
import { entries, ownDirectory, ownFiles, safeId } from "./files";
import type { SessionRead, UsageRecord } from "./records";

/**
 * Where awf keeps a chat's turns' usage, which cursor prints once per headless turn and logs
 * nowhere: beside the chat, so a chat carried to another home carries it.
 */
const USAGE_FILE = "awf-usage.jsonl";

/**
 * The directory chat `id` lives in under `home`: `chats/{workspace}/{id}`, its `store.db` and a
 * sidecar, the workspace a hash of the directory cursor ran in.
 */
export async function cursorChatDirectory(
  id: string,
  home = harnessState().cursor,
): Promise<string | undefined> {
  if (!safeId(id)) return undefined;
  const chats = join(home, "chats");
  for (const workspace of await entries(chats)) {
    if ((await entries(join(chats, workspace))).includes(id)) return join(chats, workspace, id);
  }
  return undefined;
}

/**
 * Chat `session`'s directory under `home`, the operator's by its real path where none is given,
 * with nothing on the way a link: a sandboxed agent's home is its own to write, its home's place
 * too.
 */
async function ownChat(
  session: string,
  given: string | undefined,
): Promise<{ home: string; directory: string } | undefined> {
  const home = given ?? (await realpath(harnessState().cursor).catch(() => undefined));
  if (!home) return undefined;
  const directory = await cursorChatDirectory(session, home);
  return directory && (await ownDirectory(home, directory)) ? { home, directory } : undefined;
}

/** The file at `path` by a handle that follows no link, and whether it is still at `path`. */
async function openOwn(path: string, flags: number) {
  const handle = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const [opened, there] = await Promise.all([handle.stat(), lstat(path).catch(() => undefined)]);
  // A directory on the way swapped for a link between the check and the open lands elsewhere.
  if (opened.isFile() && there && opened.ino === there.ino && opened.dev === there.dev) {
    return handle;
  }
  await handle.close();
  return undefined;
}

/**
 * Keeps the usage a headless turn printed beside its chat. `inputTokens` is the uncached part:
 * a resume that read 37,004 cached tokens reported 109 input (fork-cache F11). A turn that printed
 * none, cut off or failed, leaves a row saying so: what it spent is unknown, not nothing.
 */
export async function keepCursorTurnUsage(
  stdout: string,
  session: string,
  model: string | undefined,
  home?: string,
): Promise<void> {
  const chat = await ownChat(session, home);
  if (!chat) return;
  const result = jsonLines(stdout).findLast((row) => row.type === "result");
  const usage = record(result?.usage);
  const key = text(result?.request_id);
  const at = new Date().toISOString();
  const row =
    usage && key
      ? {
          key,
          at,
          model: model ?? "unknown",
          tokens: {
            input: count(usage.inputTokens),
            cacheRead: count(usage.cacheReadTokens),
            cacheWrite: count(usage.cacheWriteTokens),
            output: count(usage.outputTokens),
          },
        }
      : { at, unknown: true };
  const handle = await openOwn(
    join(chat.directory, USAGE_FILE),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
  );
  if (!handle) return;
  try {
    await handle.appendFile(`${JSON.stringify(row)}\n`);
  } finally {
    await handle.close();
  }
}

/** Drops the usage a copied chat carried from its parent: those turns are the parent's. */
export async function dropCursorUsage(session: string, home?: string): Promise<void> {
  const chat = await ownChat(session, home);
  if (chat) await rm(join(chat.directory, USAGE_FILE), { force: true });
}

export async function readCursorUsage(
  sessions: readonly string[],
  home?: string,
): Promise<SessionRead | undefined> {
  const records = new Map<string, UsageRecord>();
  let found = false;
  for (const session of sessions) {
    const chat = await ownChat(session, home);
    // A pane's turns print nothing, so a chat with no usage kept is unknown, not free.
    const handle = chat
      ? await openOwn(join(chat.directory, USAGE_FILE), constants.O_RDONLY).catch(() => undefined)
      : undefined;
    if (!handle) continue;
    found = true;
    const rows = jsonLines(await handle.readFile("utf8").finally(() => handle.close()));
    if (rows.some((row) => row.unknown === true)) return undefined;
    for (const row of rows) {
      const key = text(row.key);
      const at = text(row.at);
      const tokens = record(row.tokens);
      if (!key || !at || !tokens) continue;
      records.set(key, {
        key,
        at,
        model: text(row.model) ?? "unknown",
        delegated: false,
        tokens: {
          input: count(tokens.input),
          cacheRead: count(tokens.cacheRead),
          cacheWrite: count(tokens.cacheWrite),
          output: count(tokens.output),
        },
      });
    }
  }
  // Each turn's usage is written once its process has ended, so no turn is ever open.
  return found ? { records: [...records.values()], open: false } : undefined;
}

/** Every chat in a home the agent had alone. */
export async function cursorHomeSessions(home: string): Promise<string[]> {
  const chats = new Set<string>();
  for (const name of await ownFiles(home, join(home, "chats"))) {
    const [, chat, file] = name.split("/");
    if (chat && file === "meta.json") chats.add(chat);
  }
  return [...chats];
}

/**
 * The chat a sandboxed pane's cursor began since `since`: its home holds its own chats alone, as
 * Herdr names none there and cursor keeps the prompts that would name it encrypted. Earliest first,
 * as a pane's first chat is its own.
 */
export async function findCursorChat(since: number, home: string): Promise<string | undefined> {
  const begun: { chat: string; at: number }[] = [];
  for (const name of await ownFiles(home, join(home, "chats"))) {
    const [workspace, chat, file] = name.split("/");
    if (!workspace || !chat || file !== "meta.json") continue;
    const meta = parseRow(
      await Bun.file(join(home, "chats", name))
        .text()
        .catch(() => ""),
    );
    const at = typeof meta?.createdAtMs === "number" ? meta.createdAtMs : undefined;
    if (at !== undefined && at >= since) begun.push({ chat, at });
  }
  return begun.sort((left, right) => left.at - right.at)[0]?.chat;
}

/** A chat's own files relative to `home`, without the usage awf kept for it. */
export async function cursorSessionFiles(
  home: string,
  session: string,
): Promise<string[] | undefined> {
  const directory = await cursorChatDirectory(session, home);
  if (!directory) return undefined;
  const chat = directory.slice(home.length + 1);
  return (await ownFiles(home, directory))
    .filter((name) => name !== USAGE_FILE)
    .map((name) => join(chat, name));
}
