export type HarnessName = "claude" | "codex" | "pi" | "cursor";

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

export type Harness = {
  /** `herdr agent start --kind`. */
  kind: string;
  /** Non-interactive argv. The prompt goes on stdin where the CLI accepts it, else as argv. */
  headless(prompt: string): string[];
  /** Prompts over ~100KB blow the argv limit, so the big cases pipe instead. */
  promptOnStdin: boolean;
  /** Reply text and usage out of whatever the harness prints in its JSON mode. */
  parse(stdout: string): { reply: string; usage: Usage };
};

export const HARNESSES: Record<HarnessName, Harness> = {
  claude: {
    kind: "claude",
    headless: () => ["claude", "-p", "--output-format", "json"],
    promptOnStdin: true,
    parse(stdout) {
      const result = lastJson(stdout);
      const usage = record(result?.usage);
      return {
        reply: string(result?.result),
        usage: {
          inputTokens: number(usage?.input_tokens),
          outputTokens: number(usage?.output_tokens),
          costUsd: number(result?.total_cost_usd),
        },
      };
    },
  },

  codex: {
    kind: "codex",
    headless: () => ["codex", "exec", "--json", "--skip-git-repo-check", "-"],
    promptOnStdin: true,
    parse(stdout) {
      const events = jsonLines(stdout);
      const message = events.findLast(
        (event) => string(record(event.item)?.type) === "agent_message",
      );
      const completed = events.findLast((event) => string(event.type) === "turn.completed");
      const usage = record(completed?.usage);
      return {
        reply: string(record(message?.item)?.text),
        usage: {
          inputTokens: number(usage?.input_tokens),
          outputTokens: number(usage?.output_tokens),
        },
      };
    },
  },

  pi: {
    kind: "pi",
    headless: () => ["pi", "--print", "--mode", "json"],
    promptOnStdin: true,
    parse(stdout) {
      const events = jsonLines(stdout);
      const end = events.findLast((event) => string(event.type) === "turn_end");
      const message = record(end?.message);
      const usage = record(message?.usage);
      const content = Array.isArray(message?.content) ? message.content : [];
      const text = content
        .map((part) => string(record(part)?.text))
        .join("")
        .trim();
      return {
        reply: text,
        usage: {
          inputTokens: number(usage?.input),
          outputTokens: number(usage?.output),
          costUsd: number(record(usage?.cost)?.total),
        },
      };
    },
  },

  cursor: {
    kind: "cursor",
    headless: () => ["cursor-agent", "-p", "--output-format", "json"],
    promptOnStdin: true,
    parse(stdout) {
      const result = lastJson(stdout);
      const usage = record(result?.usage);
      return {
        reply: string(result?.result),
        usage: {
          inputTokens: number(usage?.inputTokens),
          outputTokens: number(usage?.outputTokens),
        },
      };
    },
  },
};

type Row = Record<string, unknown>;

function jsonLines(stdout: string): Row[] {
  const rows: Row[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") rows.push(parsed as Row);
    } catch {
      // A partial line is not a result; the events that matter are complete ones.
    }
  }
  return rows;
}

function lastJson(stdout: string): Row | undefined {
  return jsonLines(stdout).at(-1);
}

function record(value: unknown): Row | undefined {
  return value && typeof value === "object" ? (value as Row) : undefined;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
