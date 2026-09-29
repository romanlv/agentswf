import { describe, expect, test } from "bun:test";
import { extractImports, hasUnresolvedDynamicImport } from "./boundary-imports";

describe("boundary import extraction", () => {
  test("finds static, side-effect, dynamic, and require specifiers", () => {
    const source =
      `
      import value from "@agentswf/contract";
      import "./register";
      await import("../../engine/src/index");
      require('@agentswf/harness');
      import(` +
      "`@agentswf/engine`" +
      `);
    `;

    expect(extractImports(source).sort()).toEqual([
      "../../engine/src/index",
      "./register",
      "@agentswf/contract",
      "@agentswf/engine",
      "@agentswf/harness",
    ]);
  });

  test("identifies computed imports that cannot be checked statically", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template literal
    expect(hasUnresolvedDynamicImport("import(`@agentswf/${name}`)")).toBe(true);
    expect(hasUnresolvedDynamicImport('import("@agentswf/contract")')).toBe(false);
  });
});
