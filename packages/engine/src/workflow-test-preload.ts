// `awf test` preloads this into `bun test`, so a workflow's tests in any folder import the author
// surface and `agentswf/testing` with nothing installed there.
import { plugin } from "bun";
import { serveAuthorSurface } from "./workflow-loader";
import * as testing from "./workflow-testing";

serveAuthorSurface();
plugin({
  name: "agentswf testing",
  setup(build) {
    build.module("agentswf/testing", () => ({ exports: testing, loader: "object" }));
  },
});
