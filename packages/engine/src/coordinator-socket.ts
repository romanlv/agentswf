import { createHash } from "node:crypto";
import { chmod, mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ParticipantResultJson } from "@agentswf/contract/records";
import { decodeHolderRequest, type NudgeWireResult } from "@agentswf/contract/wire";
import type { CoordinatorHolder, CoordinatorPort } from "./coordinator-port";
import { realPath } from "./files";
import type { MessagingEventBody } from "./messaging/messaging";
import type { RunStatus } from "./run-state";

/** A request is a line of text and its JSON; well past a message's own 16 KB limit. */
const MAX_REQUEST_BYTES = 256 * 1024;
const CONNECTION_LIFETIME_MS = 30_000;

type Connection = {
  chunks: Buffer[];
  bytes: number;
  /** Its request was taken, answered or refused: nothing more is read. */
  taken: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * A run's coordinator socket: named by a hash of its run directory, so any depth of directory fits
 * `sun_path`'s 104 bytes, in a folder only the operator can open.
 */
export function coordinatorSocketPath(dir: string, runDir: string): string {
  // Its real path: a holder reaching it through a symlink, or `/tmp` for `/private/tmp`, names it alike.
  const name = createHash("sha256").update(realPath(runDir)).digest("hex").slice(0, 32);
  return join(dir, `${name}.sock`);
}

/**
 * Refuses a coordinator folder inside the workflow's directory, where its agents work, through
 * symlinks too, and one given as a relative path, which each command would read from where it ran.
 * Then makes it, the operator's alone, before any sandbox is resolved against it.
 */
export async function prepareCoordinatorDir(
  dir: string,
  workflowDir: string,
  /** It was moved with `AWF_COORDINATOR_DIR`; `~/.awf`'s own is kept from sandboxes as `~/.awf` is. */
  moved = true,
): Promise<void> {
  if (!isAbsolute(dir)) throw new Error(`AWF_COORDINATOR_DIR ${dir} is not an absolute path`);
  const real = async (path: string): Promise<string> => {
    try {
      return await realpath(path);
    } catch {
      // Not there yet: its parent's real path, and its own name.
      const parent = dirname(path);
      return parent === path ? path : join(await real(parent), basename(path));
    }
  };
  const inside = relative(await real(workflowDir), await real(dir));
  const within =
    inside === "" || !(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside));
  if (moved && within)
    throw new Error(
      `AWF_COORDINATOR_DIR ${dir} is inside the workflow's directory, where its agents work; move it out`,
    );
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/**
 * The socket `awf reply` and `awf send` reach a live run through. It opens once the workflow
 * connects an outside participant and goes when the run ends; each connection is one request
 * line and one `ParticipantResultJson` line back.
 */
export function coordinatorSocket(options: {
  dir: string;
  runDir: string;
  attempt: number;
  /** Why the socket did not open: the run goes on, and no holder's command reaches it. */
  failed(reason: string): void;
  /** A nudge: the run's mailbox has a new event. Given, the socket opens at once, for awf's nudge. */
  nudged?(): void;
}): CoordinatorPort & { close(): Promise<void>; readonly path: string } {
  const path = coordinatorSocketPath(options.dir, options.runDir);
  let holder: CoordinatorHolder | undefined;
  let listener: Bun.UnixSocketListener<{ chunks: Buffer[]; bytes: number }> | undefined;
  let opening: Promise<void> | undefined;
  let closed = false;
  const id = (n: number) => `${options.attempt}.${n}`;

  /** Undefined for a request no `awf` command makes: the connection closes unanswered. */
  const answer = async (
    frame: string,
  ): Promise<ParticipantResultJson | NudgeWireResult | undefined> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      return undefined;
    }
    const decoded = decodeHolderRequest(parsed);
    if (!decoded.ok) return undefined;
    const request = decoded.value;
    if (request.command === "nudge") {
      if (!options.nudged) return undefined;
      options.nudged();
      return { v: 1, code: "nudged" };
    }
    if (!holder) return refused("no-participant", "the run has no coordinator connected");
    // Another attempt's question is never open in this one: a number no message has.
    const to =
      request.to === undefined
        ? undefined
        : request.to.split(".")[0] === String(options.attempt)
          ? Number(request.to.split(".")[1])
          : 0;
    const asked = {
      ...(request.participant === undefined ? {} : { coordinator: request.participant }),
      agent: request.agent,
      ...(to === undefined ? {} : { to }),
      text: request.text,
      via: "command" as const,
    };
    const result =
      request.command === "reply" ? await holder.reply(asked) : await holder.send(asked);
    return result.code === "delivered"
      ? { v: 1, code: "delivered", id: id(result.message) }
      : {
          v: 1,
          code: result.code,
          error: result.error,
          ...(result.choices ? { choices: result.choices } : {}),
        };
  };

  const open = async () => {
    // A socket a killed run left here is no one's: this run's directory names it.
    await rm(path, { force: true });
    if (closed) return;
    listener = Bun.listen<Connection>({
      unix: path,
      allowHalfOpen: true,
      data: { chunks: [], bytes: 0, taken: false },
      socket: {
        open(socket) {
          socket.data = {
            chunks: [],
            bytes: 0,
            taken: false,
            // Only while the request is read: an answer being made is never cut off.
            timer: setTimeout(() => socket.terminate(), CONNECTION_LIFETIME_MS),
          };
        },
        data(socket, data) {
          if (socket.data.taken) return;
          socket.data.bytes += data.byteLength;
          if (socket.data.bytes > MAX_REQUEST_BYTES) {
            take(socket);
            socket.end(`${JSON.stringify(refused("too-large", "the request is too large"))}\n`);
            return;
          }
          socket.data.chunks.push(Buffer.from(data));
          // A request is one line: it is answered at its end, whether or not the client half-closes.
          const text = Buffer.concat(socket.data.chunks).toString("utf8");
          const newline = text.indexOf("\n");
          if (newline >= 0) respond(socket, text.slice(0, newline));
        },
        end(socket) {
          if (!socket.data.taken)
            respond(socket, Buffer.concat(socket.data.chunks).toString("utf8"));
        },
        close(socket) {
          clearTimeout(socket.data.timer);
        },
        error(socket) {
          socket.terminate();
        },
      },
    });
    await chmod(path, 0o600);
  };
  const take = (socket: Bun.Socket<Connection>) => {
    socket.data.taken = true;
    clearTimeout(socket.data.timer);
  };
  const respond = (socket: Bun.Socket<Connection>, frame: string) => {
    take(socket);
    void answer(frame)
      .catch(() => undefined)
      .then((result) => socket.end(result ? `${JSON.stringify(result)}\n` : undefined));
  };

  if (options.nudged)
    opening = open().catch((error: unknown) =>
      options.failed(error instanceof Error ? error.message : String(error)),
    );
  return {
    path,
    attach(given) {
      holder = given;
    },
    recorded(event: MessagingEventBody) {
      if (event.kind === "participant-connected" && !opening) {
        opening = open().catch((error: unknown) =>
          options.failed(error instanceof Error ? error.message : String(error)),
        );
      }
    },
    async close() {
      closed = true;
      await opening;
      listener?.stop(true);
      if (listener) await rm(path, { force: true });
    },
  };
}

function refused(
  code: Exclude<ParticipantResultJson["code"], "delivered">,
  error: string,
): ParticipantResultJson {
  return { v: 1, code, error };
}

/**
 * The socket of a run still live, or undefined: `run-state` decides, so a socket a killed run left
 * behind is not trusted.
 */
export async function liveCoordinatorSocket(
  dir: string,
  status: Pick<RunStatus, "state" | "run">,
): Promise<string | undefined> {
  if (status.state !== "running") return undefined;
  const path = coordinatorSocketPath(dir, status.run.dir);
  return (await stat(path).then(
    () => true,
    () => false,
  ))
    ? path
    : undefined;
}
