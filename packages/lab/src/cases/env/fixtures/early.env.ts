import { defineEnv } from "../index";
import early from "./app/early";

// Imports its workflow statically, as an env.ts must not: the mocks would miss what it took.
export default defineEnv({
  workflow: () => import("./app/early"),
  setup: () => ({ observe: (result) => ({ ran: result.ran && early !== undefined }) }),
});
