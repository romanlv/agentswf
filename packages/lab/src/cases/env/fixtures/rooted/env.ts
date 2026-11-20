import { defineEnv } from "../../index";

// `until` names a stage the workflow lacks; this file, loaded before setup, holds the name itself.
export default defineEnv({
  workflow: () => import("../rooted"),
  setup(c) {
    const input: { until?: string } = c.input;
    return { until: input.until ?? "gahter", observe: (result) => ({ n: result?.n ?? null }) };
  },
});
