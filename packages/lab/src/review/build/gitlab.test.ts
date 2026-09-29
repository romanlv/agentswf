import { describe, expect, test } from "bun:test";
import { glabSource } from "./gitlab";

function notesPage(nodes: unknown[], endCursor: string | null) {
  return {
    data: {
      project: {
        mergeRequest: {
          notes: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes },
        },
      },
    },
  };
}

const descriptionNote = (at: string, text: string) => ({
  createdAt: at,
  author: null,
  systemNoteMetadata: {
    action: "description",
    descriptionVersion: { description: text, diff: null },
  },
});

describe("glabSource", () => {
  test("pages through REST lists and GraphQL notes, keeping only description edits", async () => {
    const calls: string[][] = [];
    const source = glabSource({
      hostname: "gitlab.example",
      run: async (args) => {
        calls.push(args);
        const path = args[2]!;
        if (path === "graphql") {
          const after = args.find((arg) => arg.startsWith("after="));
          return JSON.stringify(
            after
              ? notesPage([descriptionNote("2026-01-02T00:00:00Z", "second")], null)
              : notesPage(
                  [
                    descriptionNote("2026-01-01T00:00:00Z", "first"),
                    {
                      createdAt: "x",
                      author: null,
                      systemNoteMetadata: { action: "title", descriptionVersion: null },
                    },
                  ],
                  "c1",
                ),
          );
        }
        if (path.includes("/discussions?")) {
          const page = Number(/[?&]page=(\d+)/.exec(path)![1]);
          return JSON.stringify(
            Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => ({
              id: `${page}-${i}`,
              notes: [],
            })),
          );
        }
        if (path.includes("/versions?")) return "[]";
        return JSON.stringify({ path });
      },
    });

    const data = await source.fetch("acme/shop", 7);
    expect(data.discussions).toHaveLength(103);
    expect(data.descriptions.map((d) => d.description)).toEqual(["first", "second"]);
    expect(data.descriptions[0]!.author).toBe("");
    expect(calls.every((args) => args[0] === "--hostname" && args[1] === "gitlab.example")).toBe(
      true,
    );
    expect(calls.some((args) => args[2] === "projects/acme%2Fshop/merge_requests/7")).toBe(true);
  });

  test("surfaces GraphQL errors instead of treating them as no edits", async () => {
    const source = glabSource({
      run: async (args) =>
        args[0] === "graphql"
          ? JSON.stringify({ errors: [{ message: "field diff doesn't exist" }] })
          : args[0]!.includes("?")
            ? "[]"
            : "{}",
    });
    await expect(source.fetch("acme/shop", 7)).rejects.toThrow("field diff doesn't exist");
  });
});
