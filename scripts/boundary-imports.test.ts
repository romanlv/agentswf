import { describe, expect, test } from "bun:test";
import { extractImports, hasUnresolvedDynamicImport } from "./boundary-imports";

describe("boundary import extraction", () => {
  test("finds static, side-effect, dynamic, and require specifiers", () => {
    const source = `
      import value from "@wf/contract";
      import "./register";
      await import("../../engine/src/index");
      require('@wf/harness');
      import(` + "`@wf/engine`" + `);
    `;

    expect(extractImports(source).sort()).toEqual([
      "../../engine/src/index",
      "./register",
      "@wf/contract",
      "@wf/engine",
      "@wf/harness",
    ]);
  });

  test("identifies computed imports that cannot be checked statically", () => {
    expect(hasUnresolvedDynamicImport("import(`@wf/${name}`)")).toBe(true);
    expect(hasUnresolvedDynamicImport('import("@wf/contract")')).toBe(false);
  });
});
