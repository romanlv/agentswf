// Checked by `tsc --noEmit`, never run: what `defineEnv` and `c` let an env.ts write, and what
// they refuse before any trial.

import type * as service from "./fixtures/app/service";
import { defineEnv } from "./index";

export const typed = defineEnv({
  workflow: () => import("./fixtures/app/workflow"),

  async setup(c) {
    const input: { today: string } = c.input;
    const count: number = c.json<{ count: number }>("x.json").count;
    const mod: typeof service = await import("./fixtures/app/service");

    const spies = c.mock(mod, { list: async () => [input.today], send: async () => {} });
    spies.list.mockResolvedValueOnce([]);
    // @ts-expect-error An export the module doesn't have.
    c.mock(mod, { nope: async () => {} });
    // @ts-expect-error Sync where the function is async.
    c.mock(mod, { list: () => ["x"] });
    // @ts-expect-error A wrong parameter.
    c.mock(mod, { send: async (_to: number) => {} });
    c.mock(mod, {}, { real: ["parse"] });

    const db = c.fake<service.Db>({ name: "db1", query: async () => ["row"] });
    // @ts-expect-error A fake of the wrong shape.
    c.fake<service.Db>({ query: async () => 1 });
    // @ts-expect-error A member the type doesn't have.
    c.fake<service.Db>({ drop: async () => {} });
    c.mock(mod, { connect: async () => db });

    c.http({ "GET https://api.test/x/:id": (_request, { params }) => Response.json(params.id) });
    const seen: readonly { method: string; url: string }[] = c.http.requests;

    return {
      argv: ["plain"],
      observe: (result, { stages }) => {
        const sent: string[] = result.sent;
        // @ts-expect-error `result` is the workflow's own result, inferred from its run.
        result.nope;
        return {
          count: result.count + count,
          sent: sent.join(","),
          reads: db.query.mock.calls.length + seen.length,
          gathered: stages.gather === undefined,
        };
      },
    };
  },
});

// Under `until` the result is `null`, which observe says by its parameter's type.
export const untilStage = defineEnv({
  workflow: () => import("./fixtures/app/workflow"),
  setup: () => ({
    until: "gather",
    observe: (result: import("./fixtures/app/workflow").Outcome | null) => ({
      count: result?.count ?? null,
    }),
  }),
});

export const badFacts = defineEnv({
  workflow: () => import("./fixtures/app/workflow"),
  setup: () => ({
    // @ts-expect-error A fact is flat: an object isn't one.
    observe: (result) => ({ result }),
  }),
});
