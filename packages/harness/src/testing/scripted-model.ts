import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Harness } from "../types";

/**
 * A model server for the real harness CLIs, whose replies a test scripts: pi asks it over Chat
 * Completions, codex over Responses, claude over Anthropic Messages, and each runs the shell
 * command a reply names with its own tool. What a harness reads back from it — usage, request ids
 * — is shaped as the real APIs send it, since awf's readers take those from the harness's records.
 */

export type ScriptedProtocol = "chat" | "responses" | "messages";

export type ScriptedRequest = {
  protocol: ScriptedProtocol;
  model: string;
  /** Every user message's text, oldest first: the session's history, this turn's prompt last. */
  userTexts: string[];
  /** Whether the request answers a tool call, so the turn is under way. */
  afterToolResult: boolean;
};

export type ScriptedReply = { shell: string } | { text: string };

export type ScriptedModel = {
  /** Without the version path: what a provider's base URL is built on. */
  url: string;
  requests: ScriptedRequest[];
  stop(): Promise<void>;
};

const USAGE = { input: 100, output: 10 };

export function startScriptedModel(
  script: (request: ScriptedRequest) => ScriptedReply,
): ScriptedModel {
  const requests: ScriptedRequest[] = [];
  let sequence = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.endsWith("/models")) {
        return Response.json({ object: "list", data: [] });
      }
      if (request.method !== "POST") return new Response("not scripted", { status: 404 });
      const body = (await request.json()) as Body;
      const id = `scripted_${++sequence}`;
      const answer = (parsed: ScriptedRequest) => {
        requests.push(parsed);
        return script(parsed);
      };
      if (path.endsWith("/chat/completions")) return chat(body, id, answer(readChat(body)));
      if (path.endsWith("/responses")) return responses(body, id, answer(readResponses(body)));
      if (path.endsWith("/messages/count_tokens"))
        return Response.json({ input_tokens: USAGE.input });
      if (path.endsWith("/messages")) return messages(body, id, answer(readMessages(body)));
      return new Response("not scripted", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

/**
 * The `wfa result` command the latest prompt names, each `--flag <type>` placeholder filled from
 * `values`; undefined when the prompt names none.
 */
export function resultCommand(
  request: ScriptedRequest,
  values: Readonly<Record<string, string | number>>,
): string | undefined {
  const prompt = request.userTexts.at(-1) ?? "";
  const line = [...prompt.matchAll(/^.*\bwfa result .*$/gm)].at(-1)?.[0];
  return line?.replace(/--([\w-]+) <[^>]+>/g, (placeholder, flag: string) =>
    flag in values ? `--${flag} ${shellWord(values[flag]!)}` : placeholder,
  );
}

function shellWord(value: string | number): string {
  return typeof value === "number" ? String(value) : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The model each harness is run at against the scripted server. */
export const SCRIPTED_MODELS = {
  pi: "scripted/scripted-model",
  codex: "scripted-model",
  // claude takes no model it does not know; the server answers whatever is asked.
  claude: "claude-sonnet-5-5",
} as const satisfies Partial<Record<Harness, string>>;

/**
 * State directories, under `root`, that point each harness at `model`, and the environment that
 * selects them, `HOME` included so nothing of the operator's is read. codex and claude get a login
 * that reads as a subscription to `codex login status` and `claude auth status`, which awf checks
 * before it opens their agents; neither token is a credential, and neither leaves this machine.
 */
export async function scriptedHomes(
  root: string,
  model: Pick<ScriptedModel, "url">,
): Promise<Record<string, string>> {
  const home = join(root, "home");
  const pi = join(root, "pi");
  const codex = join(root, "codex");
  const claude = join(root, "claude");
  await Promise.all([home, pi, codex, claude].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(
    join(pi, "models.json"),
    JSON.stringify({
      providers: {
        scripted: {
          baseUrl: `${model.url}/v1`,
          api: "openai-completions",
          apiKey: "scripted",
          models: [{ id: "scripted-model" }],
        },
      },
    }),
  );
  await writeFile(
    join(codex, "config.toml"),
    [
      'model_provider = "scripted"',
      "[model_providers.scripted]",
      'name = "scripted"',
      `base_url = "${model.url}/v1"`,
      'wire_api = "responses"',
      "",
    ].join("\n"),
  );
  const token = unsignedJwt({
    email: "scripted@example.invalid",
    exp: 4_102_444_800,
    "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "scripted" },
  });
  await writeFile(
    join(codex, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: token,
        access_token: token,
        refresh_token: "scripted",
        account_id: "scripted",
      },
      last_refresh: new Date().toISOString(),
    }),
  );
  // In settings, not the environment: awf refuses ANTHROPIC_BASE_URL in its own.
  await writeFile(
    join(claude, "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: model.url,
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-scripted",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    }),
  );
  return {
    HOME: home,
    PI_CODING_AGENT_DIR: pi,
    CODEX_HOME: codex,
    CLAUDE_CONFIG_DIR: claude,
  };
}

function unsignedJwt(claims: object): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.scripted`;
}

// biome-ignore lint/suspicious/noExplicitAny: three foreign wire formats, read loosely
type Body = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: as above
type Item = Record<string, any>;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: Item) => (typeof part.text === "string" ? part.text : "")).join("");
}

function readChat(body: Body): ScriptedRequest {
  const messages: Item[] = body.messages ?? [];
  return {
    protocol: "chat",
    model: String(body.model),
    userTexts: messages.filter((m) => m.role === "user").map((m) => textOf(m.content)),
    afterToolResult: messages.at(-1)?.role === "tool",
  };
}

function readResponses(body: Body): ScriptedRequest {
  const input: Item[] = Array.isArray(body.input) ? body.input : [];
  return {
    protocol: "responses",
    model: String(body.model),
    userTexts: input
      .filter((item) => item.type === "message" && item.role === "user")
      .map((item) => textOf(item.content)),
    afterToolResult: ["function_call_output", "custom_tool_call_output"].includes(
      input.at(-1)?.type,
    ),
  };
}

function readMessages(body: Body): ScriptedRequest {
  const messages: Item[] = body.messages ?? [];
  const isToolResult = (m: Item) =>
    Array.isArray(m.content) && m.content.some((part: Item) => part.type === "tool_result");
  return {
    protocol: "messages",
    model: String(body.model),
    userTexts: messages
      .filter((m) => m.role === "user" && !isToolResult(m))
      .map((m) => textOf(m.content)),
    afterToolResult: messages.at(-1) !== undefined && isToolResult(messages.at(-1)!),
  };
}

function toolNames(body: Body): string[] {
  return (body.tools ?? []).map((tool: Item) => String(tool.name ?? tool.function?.name));
}

function stream(events: { event?: string; data: unknown }[], id: string): Response {
  const text = events
    .map(
      ({ event, data }) =>
        `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
    )
    .join("");
  // claude records the request id it is answered under, which awf keys its usage by.
  return new Response(text, {
    headers: { "content-type": "text/event-stream", "request-id": `req_${id}` },
  });
}

/** One tool, the shell, under the name and arguments the harness gave it. */
function shellCall(tools: string[], command: string): { name: string; input: object } {
  if (tools.includes("bash")) return { name: "bash", input: { command } };
  if (tools.includes("Bash")) return { name: "Bash", input: { command, description: "scripted" } };
  if (tools.includes("exec_command")) return { name: "exec_command", input: { cmd: command } };
  if (tools.includes("shell"))
    return { name: "shell", input: { command: ["bash", "-lc", command] } };
  throw new Error(`no shell tool among ${tools.join(", ")}`);
}

function chat(body: Body, id: string, reply: ScriptedReply): Response {
  const chunk = (delta: object, finish: string | null, usage?: object) => ({
    data: {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    },
  });
  const usage = {
    prompt_tokens: USAGE.input,
    completion_tokens: USAGE.output,
    total_tokens: USAGE.input + USAGE.output,
  };
  if ("text" in reply) {
    return stream(
      [
        chunk({ role: "assistant", content: reply.text }, null),
        chunk({}, "stop", usage),
        { data: "[DONE]" },
      ],
      id,
    );
  }
  const call = shellCall(toolNames(body), reply.shell);
  const toolCall = {
    index: 0,
    id: `call_${id}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  };
  return stream(
    [
      chunk({ role: "assistant", tool_calls: [toolCall] }, null),
      chunk({}, "tool_calls", usage),
      { data: "[DONE]" },
    ],
    id,
  );
}

function responses(body: Body, id: string, reply: ScriptedReply): Response {
  let item: object;
  if ("text" in reply) {
    item = {
      type: "message",
      id: `msg_${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: reply.text, annotations: [] }],
    };
  } else {
    const call = shellCall(toolNames(body), reply.shell);
    item = {
      type: "function_call",
      id: `fc_${id}`,
      call_id: `call_${id}`,
      name: call.name,
      arguments: JSON.stringify(call.input),
      status: "completed",
    };
  }
  const response = {
    id: `resp_${id}`,
    object: "response",
    created_at: 0,
    model: body.model,
    status: "completed",
    output: [item],
    usage: {
      input_tokens: USAGE.input,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: USAGE.output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: USAGE.input + USAGE.output,
    },
  };
  const event = (type: string, data: object) => ({ event: type, data: { type, ...data } });
  return stream(
    [
      event("response.created", { response: { ...response, status: "in_progress", output: [] } }),
      event("response.output_item.added", { output_index: 0, item }),
      event("response.output_item.done", { output_index: 0, item }),
      event("response.completed", { response }),
    ],
    id,
  );
}

function messages(body: Body, id: string, reply: ScriptedReply): Response {
  const usage = {
    input_tokens: USAGE.input,
    output_tokens: USAGE.output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const call = "shell" in reply ? shellCall(toolNames(body), reply.shell) : undefined;
  const block = call
    ? { type: "tool_use", id: `toolu_${id}`, name: call.name, input: call.input }
    : { type: "text", text: "text" in reply ? reply.text : "" };
  const stop = call ? "tool_use" : "end_turn";
  const message = {
    id: `msg_${id}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: [] as object[],
    stop_reason: null,
    stop_sequence: null,
    usage,
  };
  if (!body.stream) {
    return Response.json(
      { ...message, content: [block], stop_reason: stop },
      { headers: { "request-id": `req_${id}` } },
    );
  }
  const event = (type: string, data: object) => ({ event: type, data: { type, ...data } });
  return stream(
    [
      event("message_start", { message }),
      event("content_block_start", {
        index: 0,
        content_block: call ? { ...block, input: {} } : { type: "text", text: "" },
      }),
      event("content_block_delta", {
        index: 0,
        delta: call
          ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) }
          : { type: "text_delta", text: "text" in reply ? reply.text : "" },
      }),
      event("content_block_stop", { index: 0 }),
      event("message_delta", {
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: USAGE.output },
      }),
      event("message_stop", {}),
    ],
    id,
  );
}
