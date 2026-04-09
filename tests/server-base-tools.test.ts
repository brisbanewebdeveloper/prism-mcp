import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/tools/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/index.js")>("../src/tools/index.js");

  return {
    ...actual,
    webSearchHandler: vi.fn(async () => ({
      content: [{ type: "text", text: "fallback search results" }],
      isError: false,
    })),
    braveWebSearchCodeModeHandler: vi.fn(async () => ({
      content: [{ type: "text", text: "code mode results" }],
      isError: false,
    })),
  };
});

import { buildRuntimeBaseTools, createServer } from "../src/server.js";
import {
  braveWebSearchCodeModeHandler,
  webSearchHandler,
} from "../src/tools/index.js";

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");

  return {
    ...actual,
    BRAVE_ANSWERS_API_KEY: undefined,
    PRISM_DISABLE_BRAVE_WEB_SEARCH_CODE_MODE: true,
  };
});

function getCallToolHandler() {
  const server = createServer() as unknown as {
    _requestHandlers: Map<
      string,
      (request: { method: string; params: { name: string; arguments: unknown } }) => Promise<unknown>
    >;
  };

  const handler = server._requestHandlers.get("tools/call");
  if (!handler) {
    throw new Error("tools/call handler was not registered");
  }

  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildRuntimeBaseTools", () => {
  it("hides disabled or unavailable base tools from normal runtime discovery", () => {
    const tools = buildRuntimeBaseTools();

    expect(tools.some((tool) => tool.name === "brave_answers")).toBe(false);
    expect(tools.some((tool) => tool.name === "brave_web_search_code_mode")).toBe(false);
    expect(tools.some((tool) => tool.name === "brave_web_search")).toBe(true);
  });

  it("falls back to standard web search when code mode is disabled", async () => {
    const handler = getCallToolHandler();

    const result = await handler({
      method: "tools/call",
      params: {
        name: "brave_web_search_code_mode",
        arguments: {
          query: "academic lottery wheeling system",
          count: 5,
          offset: 2,
          code: "console.log(DATA)",
          language: "javascript",
        },
      },
    });

    expect(webSearchHandler).toHaveBeenCalledWith({
      query: "academic lottery wheeling system",
      count: 5,
      offset: 2,
    });
    expect(braveWebSearchCodeModeHandler).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: [{ type: "text", text: "fallback search results" }],
      isError: false,
    });
  });
});
