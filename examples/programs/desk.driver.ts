// A program that keeps a glossary through agentswf/client: it sends each term to the glossary's
// run and relays the definition the run posts, closes the run, then starts a plain run with the
// definitions as its args and waits for its paragraph.
//
//   bun examples/programs/desk.driver.ts idempotent backpressure
//
// It runs where `awf` does: the same user and HOME, a PATH with codex, and the project's agentswf
// installed, which in this repository `bun install` does.
import { type Client, client } from "agentswf/client";
import glossary from "./glossary";
import summary from "./summary";

/** How long the program waits for a run to come to rest before it gives up. */
const PATIENCE_MS = 5 * 60_000;

/**
 * Sends each term to the glossary run `id`, and after each, waits for the run to park and hands
 * `onPost` what it posted since. Returns the definitions, in order, and the cursor to read on from.
 */
export async function defineTerms(
  runs: Client,
  id: string,
  terms: string[],
  onPost: (text: string) => void,
): Promise<string[]> {
  const definitions: string[] = [];
  let cursor: string | undefined;
  for (const term of terms) {
    // The term names the event: the same term sent twice is a duplicate, defined once.
    const sent = await runs.emit(
      glossary,
      id,
      "term",
      { term },
      {
        eventId: eventIdOf(term),
        source: "desk",
      },
    );
    if (!sent.ok)
      throw new Error(
        `${term}: ${sent.ref} ${sent.outcome}, ${sent.why}${sent.error ? `: ${sent.error}` : ""}`,
      );
    const run = await runs.get(glossary, id);
    const rest = await run.wait({ signal: AbortSignal.timeout(PATIENCE_MS) });
    if (rest.state !== "parked") throw new Error(`${run.ref} is ${rest.state}, not waiting`);
    const items = await runs.inbox(glossary, cursor === undefined ? {} : { after: cursor });
    for (const item of items)
      if (item.ref === run.ref && item.kind === "post") {
        definitions.push(item.text);
        onPost(item.text);
      }
    cursor = items.at(-1)?.cursor ?? cursor;
  }
  return definitions;
}

/** Closes the glossary run `id` and waits until it has returned. */
export async function closeGlossary(runs: Client, id: string) {
  await runs.emit(glossary, id, "close", null, { eventId: "close", source: "desk" });
  const run = await runs.get(glossary, id);
  return run.wait({ final: true, signal: AbortSignal.timeout(PATIENCE_MS) });
}

/** Starts the summary of these definitions as the run `id`, and waits until it is final. */
export async function summarize(runs: Client, id: string, definitions: string[]) {
  const started = await runs.start(summary, { definitions }, { id });
  if (!started.ok) throw new Error(`${started.run.ref}: ${started.did} ${started.error ?? ""}`);
  return started.run.wait({ final: true, signal: AbortSignal.timeout(PATIENCE_MS) });
}

/** A term as an event id: lowercase letters, digits, `.`, `_`, `@` and `-`, or else hashed. */
export function eventIdOf(term: string): string {
  const slug = term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)
    ? `term-${slug}`
    : `term-${new Bun.CryptoHasher("sha256").update(term).digest("hex").slice(0, 32)}`;
}

if (import.meta.main) {
  const terms = process.argv.slice(2);
  if (terms.length === 0) {
    console.error("usage: bun examples/programs/desk.driver.ts {term} [{term} ...]");
    process.exit(2);
  }
  const runs = client();
  // A glossary per invocation: the same id again would find its run returned.
  const id = `g-${Date.now().toString(36)}`;
  console.log(`glossary/${id}`);
  const definitions = await defineTerms(runs, id, terms, (text) => console.log(`  ${text}`));
  const closed = await closeGlossary(runs, id);
  console.log(`glossary/${id}: ${closed.state}`);
  const done = await summarize(runs, id, definitions);
  console.log(`glossary-summary/${id}: ${done.state}`);
  if (done.ending?.kind === "completed") console.log(`\n${done.ending.value}`);
  else process.exit(1);
}
