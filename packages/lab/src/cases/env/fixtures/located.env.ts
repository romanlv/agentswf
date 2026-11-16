import { defineEnv } from "../index";

export default defineEnv({
  workflow: () => import("./app/located"),
  setup: () => ({ observe: (result) => ({ located: result.located }) }),
});
