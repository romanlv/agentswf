#!/usr/bin/env bun
// A stand-in for the designed `wf` messaging commands (docs/design/messaging.md), against a state
// file. It answers as the engine would and logs every call; nothing is delivered anywhere.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Peer = { name: string; can: "send" | "reply" | "both"; state: string; purpose: string };
type State = {
  callId: string;
  message: boolean;
  peers: Peer[];
  owes: string[];
  awaiting: string | null;
  deadline: string;
  settled?: boolean;
};

const dir = process.env.WF_STATE!;
const file = join(dir, "state.json");
const state: State = JSON.parse(readFileSync(file, "utf8"));
const argv = process.argv.slice(2);
const stdin = process.stdin.isTTY ? "" : await Bun.stdin.text().catch(() => "");
const log = (entry: object) =>
  appendFileSync(
    join(dir, "calls.jsonl"),
    `${JSON.stringify({ at: Date.now(), argv, ...entry })}\n`,
  );
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const out = (line: string) => process.stderr.write(`wf: ${line}\n`);
const obligation = () => {
  for (const peer of state.owes) out(`you owe ${peer} a reply (wf reply ${peer}).`);
  if (state.awaiting) out(`you await ${state.awaiting}'s reply, until ${state.deadline}.`);
};
const refuse = (code: string, text: string) => {
  log({ refused: code });
  out(`${argv[0]} refused (${code}): ${text}`);
  process.exit(1);
};

const [command, ...rest] = argv;
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const positional = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1] === "--timeout"));
obligation();

switch (command) {
  case "peers": {
    log({});
    console.log("peer       you can  state      purpose");
    for (const p of state.peers)
      console.log(`${p.name.padEnd(10)} ${p.can.padEnd(8)} ${p.state.padEnd(10)} “${p.purpose}”`);
    break;
  }
  case "send": {
    const [peer, ...words] = positional;
    const text = words.join(" ") || stdin;
    const route = state.peers.find((p) => p.name === peer && p.can !== "reply");
    if (!route) refuse("no-route", `no route to ${peer}. Your routes: wf peers`);
    const await_ = flags.has("--await-reply");
    if (await_ && state.awaiting)
      refuse(
        "awaiting",
        `you already await ${state.awaiting}. End your turn, or send without --await-reply.`,
      );
    log({ peer, text, awaitReply: await_ });
    if (await_) {
      state.awaiting = peer!;
      save();
      out(`sent to ${peer}. Its reply starts your next turn (deadline ${state.deadline}).`);
      out(
        "Go on with work that does not need the answer, then end your turn with one line saying what you",
      );
      out("await; do not poll or sleep.");
      if (!state.message)
        out(
          "If you find the answer first, or decide not to wait, finish with wf result; the wait is dropped.",
        );
    } else out(`sent to ${peer}; it reads this when its current turn ends.`);
    break;
  }
  case "reply": {
    const [peer, ...words] = positional;
    const text = words.join(" ") || stdin;
    if (!state.owes.includes(peer!))
      refuse("none-owed", `you owe ${peer} nothing. Send it with wf send ${peer}.`);
    log({ peer, text, reply: true });
    state.owes = state.owes.filter((p) => p !== peer);
    save();
    out(`replied to ${peer}.`);
    break;
  }
  case "result": {
    const [callId] = positional;
    if (callId !== state.callId) refuse("unknown-call", `no open call ${callId}.`);
    if (state.message)
      refuse("no-result", `${callId} is a message, not a task; it needs no result. End your turn.`);
    if (state.owes.length)
      refuse(
        "owes-reply",
        `you owe ${state.owes[0]} a reply. Send it with wf reply ${state.owes[0]}, then run wf result ${callId} again.`,
      );
    log({ result: stdin || positional.slice(1).join(" "), droppedWait: state.awaiting });
    state.awaiting = null;
    state.settled = true;
    save();
    out("result accepted.");
    break;
  }
  case "waiting": {
    if (state.message)
      refuse("no-result", `${positional[0]} is a message, not a task. End your turn.`);
    if (state.owes.length)
      refuse(
        "owes-reply",
        `you owe ${state.owes[0]} a reply. Send it with wf reply ${state.owes[0]} first.`,
      );
    log({});
    if (state.awaiting)
      out(
        `you already await ${state.awaiting}'s reply, until ${state.deadline}. End your turn, or finish with wf result.`,
      );
    else out(`waiting granted until ${state.deadline}.`);
    break;
  }
  default:
    log({ usage: true });
    out(
      "usage: wf peers | wf send [--await-reply] {peer} | wf reply {peer} | wf result {call-id} | wf waiting {call-id}",
    );
    process.exit(2);
}
