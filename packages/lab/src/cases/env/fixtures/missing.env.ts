import { defineEnv } from "../index";

export default defineEnv({
  // @ts-expect-error A path that doesn't exist, as a template string tsc can't check would be.
  workflow: () => import("./app/not-there") as Promise<typeof import("./app/early")>,
  setup: () => ({ observe: (result) => ({ ran: result.ran }) }),
});
