import { defineEnv } from "../index";

export default defineEnv({
  workflow: () => import("./app/events"),
  setup: () => ({ observe: () => ({}) }),
});
