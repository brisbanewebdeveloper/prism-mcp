import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHttpServer, type PrismHttpServerHandle } from "../src/http/server.js";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
};

async function parseMcpResponse(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  const rawBody = await response.text();

  if (contentType.includes("application/json")) {
    return rawBody ? JSON.parse(rawBody) : null;
  }

  if (contentType.includes("text/event-stream")) {
    const dataLine = rawBody
      .split("\n")
      .find(line => line.startsWith("data: "));

    if (!dataLine) {
      throw new Error(`Missing SSE data line in response: ${rawBody}`);
    }

    return JSON.parse(dataLine.slice(6));
  }

  throw new Error(`Unsupported response content type: ${contentType}`);
}

async function postJson(url: string, body: unknown, sessionId?: string) {
  const headers = sessionId
    ? { ...JSON_HEADERS, "mcp-session-id": sessionId }
    : JSON_HEADERS;

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("HTTP MCP transport", () => {
  let server: PrismHttpServerHandle;
  let url: string;
  const originalArgv = [...process.argv];

  beforeAll(async () => {
    process.argv = [...process.argv, "--no-lock"];
    server = await createHttpServer({ port: 0 });
    url = `http://127.0.0.1:${server.port}${server.path}`;
  });

  afterAll(async () => {
    process.argv = originalArgv;
    await server.close();
  });

  it("initializes an MCP session and reuses it for later requests", async () => {
    const initializeResponse = await postJson(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: {
          name: "vitest",
          version: "1.0.0",
        },
      },
    });

    expect(initializeResponse.ok).toBe(true);
    const initializePayload = await parseMcpResponse(initializeResponse);
    const sessionId = initializeResponse.headers.get("mcp-session-id");

    expect(sessionId).toBeTruthy();
    expect(initializePayload.result.serverInfo.name).toBe("prism-mcp");

    const initializedResponse = await postJson(url, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, sessionId || undefined);
    expect(initializedResponse.ok).toBe(true);

    const toolsResponse = await postJson(url, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }, sessionId || undefined);

    expect(toolsResponse.ok).toBe(true);
    const toolsPayload = await parseMcpResponse(toolsResponse);
    expect(Array.isArray(toolsPayload.result.tools)).toBe(true);
    expect(toolsPayload.result.tools.length).toBeGreaterThan(0);
  });

  it("rejects unknown session ids", async () => {
    const response = await postJson(url, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/list",
    }, "missing-session");

    expect(response.status).toBe(404);
    const payload = await response.json();
    expect(payload.error.message).toContain("Session not found");
  });

  it("tears down sessions via DELETE", async () => {
    const initializeResponse = await postJson(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: {
          name: "vitest",
          version: "1.0.0",
        },
      },
    });
    const sessionId = initializeResponse.headers.get("mcp-session-id");

    expect(sessionId).toBeTruthy();

    const deleteResponse = await fetch(url, {
      method: "DELETE",
      headers: {
        "Accept": "application/json, text/event-stream",
        "mcp-session-id": sessionId || "",
      },
    });

    expect(deleteResponse.ok).toBe(true);

    const followUpResponse = await postJson(url, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
    }, sessionId || undefined);

    expect(followUpResponse.status).toBe(404);
  });
});
