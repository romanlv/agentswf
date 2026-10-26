// What the tool types must allow and refuse; type-checked, never run.
import {
  type AgentDirectory,
  type JsonObject,
  type ToolSpec,
  tool,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

declare const agents: AgentDirectory;

void agents.open({
  key: "typed",
  runtime: "cheap",
  tools: {
    close: tool({
      description: "Typed from its schema.",
      input: outputSchema(
        Type.Object({
          status: Type.Union([Type.Literal("closed"), Type.Literal("noise")]),
          count: Type.Optional(Type.Integer()),
        }),
      ),
      handler: ({ status, count }) => {
        const narrowed: "closed" | "noise" = status;
        const maybe: number | undefined = count;
        // @ts-expect-error A wrong input type fails.
        const wrong: number = status;
        void [narrowed, maybe, wrong];
        return { closed: true };
      },
    }),
    nothing: tool({ description: "Returns nothing.", handler: () => {} }),
    // @ts-expect-error With no input, the handler is given {}, so it can't expect fields.
    untyped: tool({ description: "No input.", handler: (input: { id: string }) => input.id }),
    // @ts-expect-error Nor can an explicit type give it some.
    explicit: tool<{ id: string }>({ description: "No input.", handler: ({ id }) => id }),
    later: tool({ description: "Async, returns nothing.", handler: async () => {} }),
    unwrapped: tool({
      description: "A TypeBox schema not wrapped in outputSchema types as JsonObject, not never.",
      input: Type.Object({ id: Type.String() }),
      handler: (input) => {
        const object: JsonObject = input;
        // @ts-expect-error A JsonObject isn't a number, as never would be.
        const notNever: number = input;
        // @ts-expect-error Its fields aren't typed.
        const id: string = input.id;
        void [object, notNever, id];
      },
    }),
    json: tool({
      description: "A JSON Schema object.",
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: (input) => JSON.stringify(input),
    }),
    scalar: tool({
      description: "Not an object.",
      // @ts-expect-error A non-object schema fails.
      input: outputSchema(Type.String()),
      handler: () => 1,
    }),
    // @ts-expect-error A handler returning what isn't JSON fails.
    date: tool({ description: "A Date.", handler: () => new Date() }),
  },
});

// A spec kept apart from `open` still takes a typed tool.
const kept: ToolSpec = tool({
  description: "Kept.",
  input: outputSchema(Type.Object({ id: Type.String() })),
  handler: ({ id }) => id,
});
void kept;

// @ts-expect-error A fork of the calling session takes no tools.
void agents.forkCaller({ key: "fork", tools: {} });
