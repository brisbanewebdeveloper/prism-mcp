import { describe, expect, it, vi } from "vitest";

import { buildRuntimeBaseTools } from "../src/server.js";

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");

  return {
    ...actual,
    BRAVE_ANSWERS_API_KEY: undefined,
    PRISM_DISABLE_BRAVE_WEB_SEARCH_CODE_MODE: true,
  };
});

describe("buildRuntimeBaseTools", () => {
  it("hides disabled or unavailable base tools from normal runtime discovery", () => {
    const tools = buildRuntimeBaseTools();

    expect(tools.some((tool) => tool.name === "brave_answers")).toBe(false);
    expect(tools.some((tool) => tool.name === "brave_web_search_code_mode")).toBe(false);
    expect(tools.some((tool) => tool.name === "brave_web_search")).toBe(true);
  });
});
