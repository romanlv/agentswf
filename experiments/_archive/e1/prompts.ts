import { readFileSync } from "node:fs";

const CHECK_PAGE =
  "/Users/roman/dev/braintrust/docs/projects/code-reviews/categories/checks/observability.md";

const TARGET_BYTES = 15_360;
const BLOCK_BYTES = 1_000;

export const TRIVIAL = "Reply with exactly the word: pong";

export type BigPrompt = {
  text: string;
  bytes: number;
  firstBlock: string;
  lastBlock: string;
  /** What a reply must contain for the prompt to have arrived whole. */
  expected: string;
};

const ASK = [
  "",
  "Reply with exactly three space-separated tokens and nothing else:",
  "the number on the first [[BLOCK n]] marker above, the number on the last one,",
  "then the word: pong",
].join("\n");

/**
 * The check page, repeated to 15KB and cut into numbered blocks. The numbers are the truncation
 * detector: an agent can echo two markers it read, where it cannot count the bytes it received.
 */
export function bigPrompt(): BigPrompt {
  const page = readFileSync(CHECK_PAGE, "utf8");
  const body = TARGET_BYTES - Buffer.byteLength(ASK);
  const blocks: string[] = [];
  let bytes = 0;
  while (bytes < body) {
    const marker = `[[BLOCK ${String(blocks.length + 1).padStart(3, "0")}]]\n`;
    const room = Math.min(BLOCK_BYTES, body - bytes) - Buffer.byteLength(marker) - 1;
    const offset = (blocks.length * BLOCK_BYTES) % page.length;
    const block = marker + page.slice(offset, offset + room);
    blocks.push(block);
    bytes += Buffer.byteLength(block) + 1;
  }

  const firstBlock = "001";
  const lastBlock = String(blocks.length).padStart(3, "0");
  const text = `${blocks.join("\n")}${ASK}`;
  return {
    text,
    bytes: Buffer.byteLength(text),
    firstBlock,
    lastBlock,
    expected: `${firstBlock} ${lastBlock} pong`,
  };
}
