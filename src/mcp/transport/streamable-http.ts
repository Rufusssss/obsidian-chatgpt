import { randomUUID } from "node:crypto";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server as NodeHttpServer,
  ServerResponse,
} from "node:http";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "../create-server.ts";
import type { ObsidianVaultService } from "../../vault/vault-service.ts";

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const defaultSessionIdleMilliseconds = 15 * 60 * 1_000;
const defaultMaximumSessions = 32;

interface ActiveSession {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  lastUsedAt: number;
}

interface McpHttpRequest extends IncomingMessage {
  readonly body?: unknown;
}

interface McpHttpResponse extends ServerResponse {
  status(code: number): McpHttpResponse;
  json(body: unknown): McpHttpResponse;
}

export interface StreamableHttpServerOptions {
  readonly host: string;
  readonly port: number;
  readonly vaultService: ObsidianVaultService;
  readonly sessionIdleMilliseconds?: number;
  readonly maximumSessions?: number;
}

export interface RunningMcpHttpServer {
  readonly host: string;
  readonly port: number;
  readonly mcpUrl: URL;
  close(): Promise<void>;
}

export class McpHttpServerError extends Error {
  override readonly name = "McpHttpServerError";

  constructor(message: string) {
    super(message);
  }
}

function getSessionId(
  headers: IncomingHttpHeaders,
): string | undefined {
  const value = headers["mcp-session-id"];
  return typeof value === "string" ? value : undefined;
}

function sendProtocolError(
  response: McpHttpResponse,
  status: number,
  message: string,
): void {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32_000, message },
    id: null,
  });
}

function validateOptions(options: StreamableHttpServerOptions): void {
  if (!loopbackHosts.has(options.host)) {
    throw new McpHttpServerError(
      "The MCP HTTP server can only bind to a loopback host.",
    );
  }

  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new McpHttpServerError("The MCP HTTP server port is invalid.");
  }

  for (const value of [
    options.sessionIdleMilliseconds ?? defaultSessionIdleMilliseconds,
    options.maximumSessions ?? defaultMaximumSessions,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new McpHttpServerError("The MCP HTTP server limits are invalid.");
    }
  }
}

async function closeNodeServer(server: NodeHttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export async function startStreamableHttpServer(
  options: StreamableHttpServerOptions,
): Promise<RunningMcpHttpServer> {
  validateOptions(options);
  const sessionIdleMilliseconds =
    options.sessionIdleMilliseconds ?? defaultSessionIdleMilliseconds;
  const maximumSessions = options.maximumSessions ?? defaultMaximumSessions;
  const sessions = new Map<string, ActiveSession>();
  const app = createMcpExpressApp({ host: options.host });
  let ready = true;

  app.get("/health", (_request: McpHttpRequest, response: McpHttpResponse) => {
    response.status(200).json({ status: "ok" });
  });

  app.get("/ready", (_request: McpHttpRequest, response: McpHttpResponse) => {
    response.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "stopping",
    });
  });

  app.post("/mcp", async (
    request: McpHttpRequest,
    response: McpHttpResponse,
  ) => {
    try {
      const sessionId = getSessionId(request.headers);
      if (sessionId !== undefined) {
        const session = sessions.get(sessionId);
        if (session === undefined) {
          sendProtocolError(response, 404, "Unknown or expired MCP session.");
          return;
        }

        session.lastUsedAt = Date.now();
        await session.transport.handleRequest(request, response, request.body);
        return;
      }

      if (!isInitializeRequest(request.body)) {
        sendProtocolError(
          response,
          400,
          "A new MCP session must begin with an initialize request.",
        );
        return;
      }

      if (sessions.size >= maximumSessions) {
        sendProtocolError(response, 503, "The MCP server is at its session limit.");
        return;
      }

      const mcpServer = createMcpServer(options.vaultService);
      let transport: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (initializedSessionId) => {
          sessions.set(initializedSessionId, {
            transport,
            server: mcpServer,
            lastUsedAt: Date.now(),
          });
        },
      });
      transport.onclose = () => {
        const initializedSessionId = transport.sessionId;
        if (initializedSessionId !== undefined) {
          sessions.delete(initializedSessionId);
        }
      };

      // The SDK's concrete transport is compatible at runtime; this cast works
      // around its optional-callback typing under exactOptionalPropertyTypes.
      await mcpServer.connect(transport as Transport);
      try {
        await transport.handleRequest(request, response, request.body);
      } catch (error: unknown) {
        await mcpServer.close().catch(() => undefined);
        throw error;
      }
    } catch {
      if (!response.headersSent) {
        sendProtocolError(response, 500, "Internal MCP transport error.");
      }
    }
  });

  app.get("/mcp", async (
    request: McpHttpRequest,
    response: McpHttpResponse,
  ) => {
    try {
      const sessionId = getSessionId(request.headers);
      const session =
        sessionId === undefined ? undefined : sessions.get(sessionId);
      if (session === undefined) {
        sendProtocolError(response, 400, "A valid MCP session is required.");
        return;
      }

      session.lastUsedAt = Date.now();
      await session.transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) {
        sendProtocolError(response, 500, "Internal MCP transport error.");
      }
    }
  });

  app.delete("/mcp", async (
    request: McpHttpRequest,
    response: McpHttpResponse,
  ) => {
    try {
      const sessionId = getSessionId(request.headers);
      const session =
        sessionId === undefined ? undefined : sessions.get(sessionId);
      if (session === undefined) {
        sendProtocolError(response, 400, "A valid MCP session is required.");
        return;
      }

      session.lastUsedAt = Date.now();
      await session.transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) {
        sendProtocolError(response, 500, "Internal MCP transport error.");
      }
    }
  });

  const sessionSweep = setInterval(() => {
    const expirationThreshold = Date.now() - sessionIdleMilliseconds;
    for (const session of sessions.values()) {
      if (session.lastUsedAt <= expirationThreshold) {
        void session.server.close().catch(() => undefined);
      }
    }
  }, Math.min(sessionIdleMilliseconds, 60_000));
  sessionSweep.unref();

  const httpServer = await new Promise<NodeHttpServer>((resolve, reject) => {
    const candidate = app.listen(options.port, options.host, () => {
      candidate.off("error", reject);
      resolve(candidate);
    });
    candidate.once("error", reject);
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    clearInterval(sessionSweep);
    await closeNodeServer(httpServer).catch(() => undefined);
    throw new McpHttpServerError(
      "The MCP HTTP server did not receive a usable TCP address.",
    );
  }

  const urlHost = options.host === "::1" ? "[::1]" : options.host;
  const mcpUrl = new URL(`http://${urlHost}:${address.port}/mcp`);

  return Object.freeze({
    host: options.host,
    port: address.port,
    mcpUrl,
    async close(): Promise<void> {
      if (!ready) {
        return;
      }

      ready = false;
      clearInterval(sessionSweep);
      const activeServers = [...sessions.values()].map(
        (session) => session.server,
      );
      sessions.clear();
      await Promise.all(
        activeServers.map(async (server) => {
          await server.close().catch(() => undefined);
        }),
      );
      await closeNodeServer(httpServer);
    },
  });
}
