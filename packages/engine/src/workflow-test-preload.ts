// `awf test` preloads this into `bun test`, so a workflow's tests in any folder import the author
// surface and `agentswf/testing` with nothing installed there; and `agentswf/client`, so a
// program's code under test and the fake client share one `ClientError`.
import { plugin } from "bun";
import * as programs from "./client/published";
import { serveAuthorSurface } from "./workflow-loader";
import * as testing from "./workflow-testing";

serveAuthorSurface();
plugin({
  name: "agentswf testing",
  setup(build) {
    build.module("agentswf/testing", () => ({ exports: testing, loader: "object" }));
    build.module("agentswf/client", () => ({ exports: programs, loader: "object" }));
  },
});
