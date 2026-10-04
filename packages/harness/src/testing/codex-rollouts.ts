import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A codex home holding a parent's rollout and its fork's, as `thread/fork` leaves them. */
export function codexForkHome(): { home: string; fork: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), "codex-fork-"));
  const day = join(home, "sessions", "2026", "10", "03");
  mkdirSync(day, { recursive: true });
  const meta = (payload: object) => `${JSON.stringify({ type: "session_meta", payload })}\n`;
  writeFileSync(
    join(day, "rollout-2026-10-03T00-00-00-thread-1.jsonl"),
    meta({ session_id: "thread-1", id: "thread-1", source: "exec" }),
  );
  const fork = join(day, "rollout-2026-10-03T00-00-01-thread-2.jsonl");
  writeFileSync(
    fork,
    meta({ session_id: "thread-2", id: "thread-2", forked_from_id: "thread-1", source: "exec" }),
  );
  const operator = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  return {
    home,
    fork,
    restore: () => {
      if (operator === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = operator;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
