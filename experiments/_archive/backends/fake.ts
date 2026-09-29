/** The fake backend now ships with the harness; E2's reporting acts stayed here. */
export {
  createFakeSessionDriver as createFakeBackend,
  createManualClock,
  type FakeSessionDriver as FakeBackend,
} from "@agentswf/harness/testing";
export * from "../fake-reporting";
