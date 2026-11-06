import { expect, test } from "bun:test";
import { pathFrom } from "./display-path";

test("a path below the folder is relative, a child named `..x` included; one beside it is absolute", () => {
  expect(pathFrom("/repo", "/repo/a/b")).toBe("a/b");
  expect(pathFrom("/repo", "/repo/..x/b")).toBe("..x/b");
  expect(pathFrom("/repo", "/repo")).toBe("/repo");
  expect(pathFrom("/repo", "/other/b")).toBe("/other/b");
  expect(pathFrom("/repo", "/home/me/b", { home: "/home/me" })).toBe("~/b");
});
