import { createInterface, type Interface } from "node:readline/promises";
import type { CoordinatorHolder, CoordinatorPort } from "./coordinator-port";
import type { MessagingEventBody } from "./messaging/messaging";

/** Where the prompt reads a line: `awf run`'s terminal, or a test's script. */
export type LineReader = {
  /** The line typed after `prompt`; undefined when `signal` aborts first, or input ended. */
  read(prompt: string, signal: AbortSignal): Promise<string | undefined>;
  /** Writes a line above the prompt open, if any, and draws it again under it. */
  above(line: string): void;
  close(): void;
};

/** What the prompt shows beside the progress view, which holds its block while a prompt is open. */
export type PromptOutput = {
  /** A line in the run's log, above the progress block. */
  log(line: string): void;
  /** The progress block stops redrawing while a prompt waits for a line, and lines go above it. */
  hold(above: ((line: string) => void) | undefined): void;
};

type Question = { coordinator: string; message: number; asker: string };

/** What an agent wrote, safe on a terminal: no escape sequences or other control characters. */
function shown(text: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips.
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").split("\n");
}

const indented = (text: string) => shown(text).map((line) => `                ${line}`);

/**
 * `awf run`'s interactive mode: each message to a coordinator is a line in the run's log, and each
 * question is asked at the terminal, oldest first, for every coordinator. An empty line leaves it
 * open for another holder; one another holder answers, or that closes, is passed over.
 */
export function promptCoordinator(
  reader: LineReader,
  output: PromptOutput,
): CoordinatorPort & { close(): void; shows(message: { from: string; to: string }): boolean } {
  let holder: CoordinatorHolder | undefined;
  const connected = new Set<string>();
  const queue: Question[] = [];
  let asking: { question: Question; stop: AbortController } | undefined;
  /** Questions this prompt answered: their answers are what was typed, shown already. */
  const typed = new Set<number>();
  /** Questions still open, by number: an end names its asker. */
  const open = new Map<number, Question>();
  let closed = false;

  const ask = async (question: Question): Promise<void> => {
    const stop = new AbortController();
    asking = { question, stop };
    output.hold((line) => reader.above(line));
    let line: string | undefined;
    try {
      const as = connected.size > 1 ? ` as ${question.coordinator}` : "";
      line = (await reader.read(`reply to ${question.asker}${as} › `, stop.signal))?.trim();
    } finally {
      // Released before the reply: what it records comes as lines, not under a prompt answered.
      asking = undefined;
      output.hold(undefined);
    }
    if (!line || !holder) return;
    // Before the reply: its record arrives while it is being made.
    typed.add(question.message);
    const result = await holder.reply({
      coordinator: question.coordinator,
      agent: question.asker,
      to: question.message,
      text: line,
      via: "terminal",
    });
    if (result.code !== "delivered") {
      typed.delete(question.message);
      output.log(`awf: not delivered: ${result.error}`);
    }
  };

  const next = async (): Promise<void> => {
    while (!asking && !closed && holder) {
      const question = queue.shift();
      if (!question) return;
      // One that fails is said and passed over; the others are still asked.
      await ask(question).catch((error: unknown) =>
        output.log(`awf: the prompt failed: ${error instanceof Error ? error.message : error}`),
      );
    }
  };

  const ended = (message: number) => {
    const at = queue.findIndex((each) => each.message === message);
    if (at >= 0) queue.splice(at, 1);
    if (asking?.question.message === message) asking.stop.abort();
  };

  return {
    attach(given) {
      holder = given;
    },
    recorded(event: MessagingEventBody) {
      if (event.kind === "participant-connected") connected.add(event.participant);
      if (event.kind === "request-ended" && connected.has(event.owedBy)) {
        ended(event.message);
        const question = open.get(event.message);
        open.delete(event.message);
        if (question && event.end !== "replied")
          output.log(`● ${question.asker}'s question closed unanswered: ${event.end}`);
        return;
      }
      if (event.kind !== "message-sent") return;
      // The coordinator's answers and sends that came another way: a holder's, or a script's.
      if (connected.has(event.from)) {
        if (event.replyTo !== undefined && typed.has(event.replyTo)) return;
        const how = "via" in event && event.via ? ` (${event.via})` : "";
        output.log([`● ${event.from} → ${event.to}${how}:`, ...indented(event.text)].join("\n"));
        return;
      }
      if (!connected.has(event.to)) return;
      const asks = event.awaitsReply !== undefined;
      output.log(
        [`● ${event.from} ${asks ? "asks" : `→ ${event.to}`}:`, ...indented(event.text)].join("\n"),
      );
      if (!asks) return;
      const question = { coordinator: event.to, message: event.message, asker: event.from };
      open.set(event.message, question);
      queue.push(question);
      void next();
    },
    shows: ({ from, to }) => connected.has(from) || connected.has(to),
    close() {
      closed = true;
      queue.length = 0;
      asking?.stop.abort();
      reader.close();
    },
  };
}

/**
 * Reads lines from this process's terminal, writing on stderr beside the progress view. It holds
 * stdin only while a question is asked, so typing at any other time reaches nothing, and a run
 * that asks none leaves the terminal as it found it.
 */
export function terminalReader(): LineReader {
  let lines: Interface | undefined;
  let closed = false;
  const clearLine = () => process.stderr.write("\r\x1b[2K");
  return {
    async read(prompt, signal) {
      if (closed) return undefined;
      const current = createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
      });
      lines = current;
      // Ctrl-C at the prompt asks the run to stop, as it does anywhere else.
      current.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
      // Ctrl-D ends the input: the question is left open, as an empty line leaves it.
      const ended = new Promise<undefined>((resolve) =>
        current.once("close", () => resolve(undefined)),
      );
      // The progress view hides the cursor and clips long lines; typing needs both back.
      process.stderr.write("\x1b[?7h\x1b[?25h");
      try {
        return await Promise.race([current.question(prompt, { signal }), ended]);
      } catch (error) {
        if (signal.aborted) return undefined;
        throw error;
      } finally {
        if (signal.aborted || closed) clearLine();
        lines = undefined;
        current.close();
        process.stderr.write("\x1b[?25l\x1b[?7l");
      }
    },
    above(line) {
      clearLine();
      process.stderr.write(`${line}\n`);
      lines?.prompt(true);
    },
    close() {
      closed = true;
      if (lines) clearLine();
      lines?.close();
    },
  };
}
