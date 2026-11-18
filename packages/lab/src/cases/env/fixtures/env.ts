import * as fs from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineEnv } from "../index";
import * as service from "./app/service";

// One environment for the end-to-end tests: `input.json` names the scenario.
type Input = {
  scenario: string;
  argv: string[];
  until?: string;
  given?: Record<string, unknown>;
  facts?: "null" | "undefined" | "object";
};

export default defineEnv({
  workflow: () => import("./app/workflow"),

  async setup(c) {
    const input: Input = c.input;
    c.cleanup(() => writeFileSync(join(c.scratch, "cleaned"), input.scenario));
    if (input.scenario === "setup-throws") throw new Error("setup broke");
    if (input.scenario === "setup-slow") await Bun.sleep(30_000);
    if (input.scenario === "mock-node") c.mock(fs, {});

    const items: string[] = input.scenario === "nothing-to-send" ? [] : ["a", "b"];
    const spies = c.mock(
      service,
      { list: async () => items, send: async () => {}, connect: async () => db },
      { real: ["parse"] },
    );
    const db = c.fake<service.Db>({ name: "db1", query: async () => ["row"] });
    c.mock(service.client, { ping: async () => "pong" });
    c.http({
      "GET https://api.test/items/:id": (_request, { params }) => Response.json({ id: params.id }),
      "POST https://api.test/forms": () => new Response(null, { status: 201 }),
    });

    const given = input.given;
    return {
      argv: input.argv,
      until: input.until,
      stages: given
        ? Object.fromEntries(Object.entries(given).map(([name, value]) => [name, () => value]))
        : undefined,
      observe: (result, { stages }) => {
        if (input.facts === "undefined") return { missing: (result as { nope?: string }).nope };
        if (input.facts === "object") return { stages: stages as never };
        return {
          count: result?.count ?? null,
          notes: result?.notes.join("|") ?? null,
          sends: spies.send.mock.calls.length,
          gathered: JSON.stringify(stages.gather ?? null),
          requests: c.http.requests.map((request) => `${request.method} ${request.url}`).join("|"),
          none: input.facts === "null" ? null : "x",
          params: JSON.stringify(c.params),
        };
      },
    };
  },
});
