import { expect, test } from "bun:test";
import { ClientError as Contract } from "@agentswf/contract/client";
import { ClientError, client } from "./client";

test("agentswf/client publishes the one ClientError, a value a handler can instanceof", () => {
  expect(ClientError).toBe(Contract);
  const error = new ClientError("no-run", "no run review/x", "review/x");
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ name: "ClientError", code: "no-run", ref: "review/x" });
  expect(typeof client).toBe("function");
});
