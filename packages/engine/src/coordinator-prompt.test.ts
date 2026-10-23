import { describe, expect, test } from "bun:test";
import type { CoordinatorHolder } from "./coordinator-port";
import { type LineReader, promptCoordinator, replyHints } from "./coordinator-prompt";
import type { HolderRequest, MessagingEventBody } from "./messaging/messaging";

/** A terminal whose lines come from `typed`, in order; `undefined` waits until the prompt is passed over. */
function terminal(typed: (string | undefined)[]) {
  const prompts: string[] = [];
  const shown: string[] = [];
  let closed = false;
  const reader: LineReader = {
    async read(prompt, signal) {
      prompts.push(prompt);
      const line = typed.shift();
      if (line !== undefined) return line;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      return undefined;
    },
    above: (line) => shown.push(line),
    close: () => {
      closed = true;
    },
  };
  return { reader, prompts, shown, closed: () => closed };
}

function run(typed: (string | undefined)[], coordinators = ["coordinator"]) {
  const term = terminal(typed);
  const log: string[] = [];
  const holds: boolean[] = [];
  const replies: HolderRequest[] = [];
  const prompt = promptCoordinator(term.reader, {
    log: (line) => log.push(line),
    hold: (above) => holds.push(above !== undefined),
  });
  const holder: CoordinatorHolder = {
    reply: async (request) => {
      replies.push(request);
      return { code: "delivered", message: request.to! };
    },
    send: async () => ({ code: "ended", error: "" }),
    open: () => [],
  };
  prompt.attach(holder);
  for (const participant of coordinators)
    prompt.recorded({ kind: "participant-connected", participant });
  let n = 0;
  const ask = (from: string, text: string, to = "coordinator") =>
    prompt.recorded(sent(++n, from, to, text, true));
  const report = (from: string, text: string) =>
    prompt.recorded(sent(++n, from, "coordinator", text, false));
  return { ...term, prompt, log, holds, replies, ask, report };
}

function sent(
  message: number,
  from: string,
  to: string,
  text: string,
  asks: boolean,
): MessagingEventBody {
  return {
    kind: "message-sent",
    message,
    from,
    to,
    operationId: "op",
    text,
    bytes: text.length,
    ...(asks ? { awaitsReply: {} } : {}),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("awf run's prompt for a coordinator", () => {
  test("a report is a line; a question is asked, and the answer goes as the terminal's", async () => {
    const term = run(["Keep two, and link them."]);
    term.report("investigator", "5xx at 4×.");
    term.ask("investigator", "Merge or keep two?");
    await settle();
    expect(term.log).toEqual([
      "● investigator → coordinator:\n                5xx at 4×.",
      "● investigator asks:\n                Merge or keep two?",
    ]);
    expect(term.prompts).toEqual(["reply to investigator › "]);
    expect(term.replies).toEqual([
      {
        coordinator: "coordinator",
        agent: "investigator",
        to: 2,
        text: "Keep two, and link them.",
        via: "terminal",
      },
    ]);
    // The progress block holds while the prompt is open, and goes on after.
    expect(term.holds).toEqual([true, false]);
  });

  test("questions are asked oldest first; an empty line leaves one open and goes on", async () => {
    const term = run(["", "Yes."]);
    term.ask("a", "First?");
    term.ask("b", "Second?");
    await settle();
    expect(term.prompts).toEqual(["reply to a › ", "reply to b › "]);
    expect(term.replies.map((each) => [each.agent, each.text])).toEqual([["b", "Yes."]]);
  });

  test("a question asked after others shows its text again when its prompt opens", async () => {
    const term = run(["Yes.", "No."]);
    term.ask("a", "First?");
    term.ask("b", "Second?");
    await settle();
    expect(term.log).toEqual([
      "● a asks:\n                First?",
      "● b asks:\n                Second?",
      "● b asked:\n                Second?",
    ]);
  });

  test("with several coordinators, the prompt names the one asked", async () => {
    const term = run(["ok"], ["coordinator", "pager"]);
    term.ask("investigator", "Page?", "pager");
    await settle();
    expect(term.prompts).toEqual(["reply to investigator as pager › "]);
    expect(term.replies[0]).toMatchObject({ coordinator: "pager" });
  });

  test("a question answered elsewhere, or closed, is passed over", async () => {
    const term = run([undefined, "Later."]);
    term.ask("a", "First?");
    term.ask("b", "Second?");
    term.ask("c", "Third?");
    await settle();
    term.prompt.recorded({
      kind: "request-ended",
      message: 2,
      owedBy: "coordinator",
      asker: "b",
      end: "replied",
    });
    term.prompt.recorded({
      kind: "request-ended",
      message: 1,
      owedBy: "coordinator",
      asker: "a",
      end: "replied",
    });
    await settle();
    expect(term.prompts).toEqual(["reply to a › ", "reply to c › "]);
    expect(term.replies.map((each) => each.agent)).toEqual(["c"]);
  });

  test("an answer from elsewhere, and a question closing unanswered, are lines", async () => {
    const term = run([undefined]);
    term.ask("a", "First?");
    term.ask("b", "Second?");
    await settle();
    term.prompt.recorded({
      kind: "message-sent",
      message: 3,
      from: "coordinator",
      to: "a",
      via: "command",
      text: "No.",
      bytes: 3,
      replyTo: 1,
    });
    term.prompt.recorded({
      kind: "request-ended",
      message: 1,
      owedBy: "coordinator",
      asker: "a",
      end: "replied",
      reply: 3,
    });
    term.prompt.recorded({
      kind: "request-ended",
      message: 2,
      owedBy: "coordinator",
      asker: "b",
      end: "timed-out",
    });
    await settle();
    expect(term.log.slice(2)).toEqual([
      "● coordinator → a (command):\n                No.",
      "● b's question closed unanswered: timed-out",
    ]);
    expect(term.prompt.shows({ from: "a", to: "coordinator" })).toBe(true);
    expect(term.prompt.shows({ from: "a", to: "b" })).toBe(false);
  });

  test("closing it stops the prompt open and asks nothing more", async () => {
    const term = run([undefined]);
    term.ask("a", "First?");
    term.ask("b", "Second?");
    await settle();
    term.prompt.close();
    await settle();
    expect(term.prompts).toEqual(["reply to a › "]);
    expect(term.closed()).toBe(true);
  });
});

describe("awf run without a prompt", () => {
  test("each question to a coordinator says how to answer it; a report says nothing", () => {
    const log: string[] = [];
    const hints = replyHints("investigate/r1", [], 2, (line) => log.push(line));
    hints.recorded({ kind: "participant-connected", participant: "coordinator" });
    hints.recorded(sent(1, "investigator", "coordinator", "Starting.", false));
    hints.recorded(sent(2, "investigator", "coordinator", "Merge or keep two?", true));
    hints.recorded(sent(3, "coordinator", "investigator", "Keep two.", false));
    expect(log).toEqual([
      [
        "● investigator asks coordinator (2.2):",
        "                Merge or keep two?",
        "  answer: awf reply investigate/r1 investigator --to 2.2 '…'",
      ].join("\n"),
    ]);
    expect(hints.shows({ to: "coordinator", asks: true })).toBe(true);
    expect(hints.shows({ to: "coordinator" })).toBe(false);
  });

  test("with several coordinators, the command names the one asked, and where the run is", () => {
    const log: string[] = [];
    const hints = replyHints("investigate/r1", ["--run-root", "/tmp/my runs"], 1, (line) =>
      log.push(line),
    );
    hints.recorded({ kind: "participant-connected", participant: "coordinator" });
    hints.recorded({ kind: "participant-connected", participant: "pager" });
    hints.recorded(sent(1, "investigator", "pager", "Page?", true));
    expect(log[0]).toEndWith(
      "awf reply investigate/r1 investigator --to 1.1 --as pager --run-root '/tmp/my runs' '…'",
    );
  });
});
