import { describe, expect, it, vi } from "vitest";

import { buildRuntimeBaseTools } from "../src/server.js";

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");

  return {
    ...actual,
    BRAVE_ANSWERS_API_KEY: undefined,
  };
});

describe("buildRuntimeBaseTools", () => {
  it("hides brave_answers when no Brave Answers key is configured", () => {
    const tools = buildRuntimeBaseTools();

    expect(tools.some((tool) => tool.name === "brave_answers")).toBe(false);
    expect(tools.some((tool) => tool.name === "brave_web_search")).toBe(true);
  });
});
