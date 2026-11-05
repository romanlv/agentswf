// A program that drives pr-review and release: a GitHub webhook, a Slack relay, and a release
// script. It runs where the operator does: the same user, HOME, and a PATH with the harnesses.
import { type Client, client } from "agentswf/client";
import review from "./pr-review";
import release from "./release";

// #region webhook
/** A GitHub push or close, as the webhook handler has verified and parsed it. */
export type GithubEvent =
  | { kind: "push"; delivery: string; pr: number; sha: string; branch: string }
  | { kind: "closed"; delivery: string; pr: number; merged: boolean };

export async function onGithub(runs: Client, event: GithubEvent) {
  // The delivery id is the event's: GitHub resends a delivery, and the resend is a duplicate.
  const options = { eventId: eventIdOf(event.delivery), source: "github" };
  const run = `pr-${event.pr}`;
  return event.kind === "push"
    ? runs.emit(
        review,
        run,
        "pr.pushed",
        { sha: event.sha, branch: event.branch },
        options,
      )
    : runs.emit(review, run, "pr.closed", { merged: event.merged }, options);
}
// #endregion webhook

// #region ids
/**
 * An event id is lowercase letters, digits, `.`, `_`, `@` and `-`, at most 128, and never starts
 * `awf.`, which is awf's own; a foreign id that doesn't fit is hashed: the same id hashes the
 * same, so a resend is still a duplicate.
 */
export function eventIdOf(foreign: string): string {
  if (
    /^[a-z0-9][a-z0-9._@-]{0,127}$/.test(foreign) &&
    !foreign.startsWith("awf.")
  )
    return foreign;
  return `h-${new Bun.CryptoHasher("sha256").update(foreign).digest("hex").slice(0, 40)}`;
}
// #endregion ids

// #region relay
/**
 * Posts what the runs said to their Slack threads, each once, and returns the cursor to read on
 * from: kept where a restart finds it, or a restarted program posts everything again.
 */
export async function relayPosts(
  runs: Client,
  cursor: string | undefined,
  post: (ref: string, text: string) => Promise<void>,
): Promise<string | undefined> {
  const items = await runs.inbox(
    review,
    cursor === undefined ? {} : { after: cursor },
  );
  for (const item of items)
    if (item.kind === "post") await post(item.ref, item.text);
  return items.at(-1)?.cursor ?? cursor;
}

/** A person's answer in the thread, back to the run: Slack's message ts names it. */
export async function onThreadReply(
  runs: Client,
  pr: number,
  ts: string,
  text: string,
  author: string,
) {
  return runs.emit(
    review,
    `pr-${pr}`,
    "thread:reply",
    { text, author },
    {
      eventId: eventIdOf(ts),
      source: "slack",
    },
  );
}

// #endregion relay

// #region script
/** Starts the notes for a version, and waits, at most half an hour, until nothing will continue it. */
export async function releaseNotes(runs: Client, version: string) {
  const started = await runs.start(
    release,
    { version, dryRun: false },
    { id: `v${version}` },
  );
  if (!started.ok)
    throw new Error(`not launched: ${started.did} ${started.error ?? ""}`);
  return started.run.wait({
    final: true,
    signal: AbortSignal.timeout(30 * 60_000),
  });
}
// #endregion script

// #region serve
if (import.meta.main) {
  const runs = client();
  Bun.serve({
    port: 8787,
    async fetch(request) {
      const event = await verifiedGithubEvent(request);
      if (!event) return new Response("not ours", { status: 401 });
      // Answered first: an emit that starts a run waits for its attempt, which can take seconds,
      // and GitHub gives a delivery ten.
      void onGithub(runs, event).catch((error) =>
        console.error(`${event.delivery}:`, error),
      );
      return new Response(null, { status: 202 });
    },
  });
}
// #endregion serve

/** Checks the request's signature with the webhook's secret, which is the program's job. */
async function verifiedGithubEvent(
  _request: Request,
): Promise<GithubEvent | undefined> {
  return undefined;
}
