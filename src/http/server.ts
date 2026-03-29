import * as http from "node:http";
import { randomUUID } from "node:crypto";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { PRISM_MCP_PATH, PRISM_MCP_PORT } from "../config.js";
import { registerShutdownHandlers } from "../lifecycle.js";
import {
  createServer,
  initializeRuntime,
  registerServerNotificationTarget,
} from "../server.js";

interface HttpSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  unregisterNotificationTarget: () => void;
}

export interface PrismHttpServerHandle {
  port: number;
  path: string;
  close: () => Promise<void>;
}

function resolveSessionId(req: http.IncomingMessage): string | undefined {
  const header = req.headers["mcp-session-id"];
  return Array.isArray(header) ? header[0] : header;
}

async function readParsedBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method !== "POST" && req.method !== "DELETE") {
    return undefined;
  }

  let body = "";
  for await (const chunk of req) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }

  if (!body.trim()) {
    return undefined;
  }

  return JSON.parse(body);
}

function writeJsonRpcError(
  res: http.ServerResponse,
  statusCode: number,
  message: string,
  code = -32000,
  id: string | number | null = null,
) {
  if (res.headersSent) {
    return;
  }

  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id,
  }));
}

export async function createHttpServer(options: {
  port?: number;
  path?: string;
} = {}): Promise<PrismHttpServerHandle> {
  await initializeRuntime();

  const path = options.path || PRISM_MCP_PATH;
  const configuredPort = options.port ?? PRISM_MCP_PORT;
  const sessions = new Map<string, HttpSession>();

  const closeSession = async (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    sessions.delete(sessionId);
    session.unregisterNotificationTarget();

    try {
      await session.transport.close();
    } catch (error) {
      console.error(`[HTTP MCP] Failed to close transport for session ${sessionId}: ${error}`);
    }

    try {
      await session.server.close();
    } catch (error) {
      console.error(`[HTTP MCP] Failed to close server for session ${sessionId}: ${error}`);
    }
  };

  const closeAllSessions = async () => {
    await Promise.all(Array.from(sessions.keys(), sessionId => closeSession(sessionId)));
  };

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== path) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
        writeJsonRpcError(res, 405, "Method not allowed.");
        return;
      }

      const parsedBody = await readParsedBody(req);
      const sessionId = resolveSessionId(req);
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        if (sessionId) {
          writeJsonRpcError(res, 404, "Session not found.");
          return;
        }

        if (req.method !== "POST" || !isInitializeRequest(parsedBody)) {
          writeJsonRpcError(res, 400, "Bad Request: No valid session ID provided.");
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: initializedSessionId => {
            if (session) {
              sessions.set(initializedSessionId, session);
            }
          },
          onsessionclosed: async closedSessionId => {
            await closeSession(closedSessionId);
          },
        });

        const server = createServer();
        await server.connect(transport);
        const unregisterNotificationTarget = registerServerNotificationTarget(server);
        session = { server, transport, unregisterNotificationTarget };
      }

      await session.transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      console.error(`[HTTP MCP] Error handling request: ${error}`);
      writeJsonRpcError(res, 500, "Internal server error", -32603);
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(configuredPort, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : configuredPort;
  console.error(`[Prism] MCP Streamable HTTP → http://localhost:${port}${path}`);

  return {
    port,
    path,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

export async function startHttpServer() {
  const handle = await createHttpServer();

  registerShutdownHandlers({
    watchStdin: false,
    onShutdown: async () => {
      await handle.close();
    },
  });
}
