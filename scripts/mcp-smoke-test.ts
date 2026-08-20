import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  listNotesOutputSchema,
  readNoteOutputSchema,
  searchNotesOutputSchema,
} from "../src/mcp/tool-schemas.ts";
import {
  startStreamableHttpServer,
  type RunningMcpHttpServer,
} from "../src/mcp/transport/streamable-http.ts";
import { VaultPathPolicy } from "../src/vault/path-policy.ts";
import { ObsidianVaultService } from "../src/vault/vault-service.ts";
import {
  createTemporaryVault,
  removeTemporaryVault,
} from "../tests/helpers/temporary-vault.ts";

const expectedTools = [
  "list_notes",
  "search_notes",
  "read_note",
  "get_note_metadata",
  "get_backlinks",
  "create_note",
  "append_to_note",
  "update_note",
] as const;
const expectedServerName = "obsidian-chatgpt-mcp";

class SmokeCheckError extends Error {
  override readonly name = "SmokeCheckError";
}

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new SmokeCheckError(message);
  }
}

function parseToolResult(value: unknown): CallToolResult {
  return CallToolResultSchema.parse(value);
}

function requireSuccess(result: CallToolResult): Record<string, unknown> {
  requireCondition(result.isError !== true, "The tool returned an MCP error.");
  requireCondition(
    result.structuredContent !== undefined,
    "The tool omitted structured content.",
  );
  return result.structuredContent;
}

function toolText(result: CallToolResult): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function runCheck(
  number: number,
  label: string,
  check: () => Promise<void>,
): Promise<void> {
  try {
    await check();
    process.stdout.write(`PASS ${number}/7 ${label}\n`);
  } catch (error: unknown) {
    throw new SmokeCheckError(`Check ${number}/7 failed: ${label}`, {
      cause: error,
    });
  }
}

async function main(): Promise<void> {
  const fixture = await createTemporaryVault();
  let httpServer: RunningMcpHttpServer | undefined;
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;

  try {
    await writeFile(
      path.join(fixture.outsidePath, "Outside.md"),
      "# Synthetic outside-boundary sentinel\n",
      "utf8",
    );
    await symlink(
      fixture.outsidePath,
      path.join(fixture.vaultPath, "linked-outside"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const pathPolicy = await VaultPathPolicy.create({
      vaultPath: fixture.vaultPath,
      backupDir: ".obsidian-chatgpt/backups",
    });
    const vaultService = new ObsidianVaultService(pathPolicy);
    httpServer = await startStreamableHttpServer({
      host: "127.0.0.1",
      port: 0,
      vaultService,
    });
    transport = new StreamableHTTPClientTransport(httpServer.mcpUrl);
    client = new Client({
      name: "obsidian-chatgpt-smoke-test",
      version: "1.0.0",
    });

    await runCheck(1, "MCP initialize succeeds", async () => {
      requireCondition(client !== undefined, "The MCP client was not created.");
      requireCondition(
        transport !== undefined,
        "The MCP transport was not created.",
      );
      // The SDK client performs the initialize exchange during connect().
      await client.connect(transport as Transport);
      requireCondition(
        client.getServerVersion()?.name === expectedServerName,
        "The initialized server identity was unexpected.",
      );
    });

    await runCheck(2, "tools/list contains exactly the expected tools", async () => {
      requireCondition(client !== undefined, "The MCP client was not created.");
      const result = await client.listTools();
      const names = result.tools.map((tool) => tool.name).toSorted();
      const expectedNames = expectedTools.toSorted();

      requireCondition(
        names.length === expectedNames.length,
        "The server advertised an unexpected number of tools.",
      );
      requireCondition(
        names.every((name, index) => name === expectedNames[index]),
        "The server advertised an unexpected tool.",
      );
    });

    await runCheck(3, "list_notes works", async () => {
      requireCondition(client !== undefined, "The MCP client was not created.");
      const result = parseToolResult(
        await client.callTool({
          name: "list_notes",
          arguments: { folder: "Projects", recursive: false, limit: 10 },
        }),
      );
      const output = listNotesOutputSchema.parse(requireSuccess(result));

      requireCondition(
        output.notes.some((note) => note.path === "Projects/Alpha Project.md"),
        "The expected synthetic note was not listed.",
      );
    });

    await runCheck(4, "search_notes works", async () => {
      requireCondition(client !== undefined, "The MCP client was not created.");
      const result = parseToolResult(
        await client.callTool({
          name: "search_notes",
          arguments: {
            query: "handshaking lemma",
            folder: "Research",
            scope: "content",
            limit: 5,
          },
        }),
      );
      const output = searchNotesOutputSchema.parse(requireSuccess(result));

      requireCondition(
        output.matches.some(
          (match) => match.path === "Research/Graph Theory.md",
        ),
        "The expected synthetic search result was not returned.",
      );
    });

    await runCheck(5, "read_note works", async () => {
      requireCondition(client !== undefined, "The MCP client was not created.");
      const result = parseToolResult(
        await client.callTool({
          name: "read_note",
          arguments: { path: "Projects/Alpha Project.md" },
        }),
      );
      const output = readNoteOutputSchema.parse(requireSuccess(result));

      requireCondition(
        output.path === "Projects/Alpha Project.md",
        "The returned path did not match the requested synthetic note.",
      );
      requireCondition(
        output.version.startsWith("sha256:"),
        "The note revision was missing.",
      );
    });

    await runCheck(6, "malformed input returns a controlled error", async () => {
      requireCondition(client !== undefined, "The MCP client was not created.");
      const result = parseToolResult(
        await client.callTool({
          name: "read_note",
          arguments: {},
        }),
      );
      const text = toolText(result);

      requireCondition(result.isError === true, "Malformed input was accepted.");
      requireCondition(
        result.structuredContent === undefined,
        "An error result contained success data.",
      );
      requireCondition(
        /Input validation error/iu.test(text),
        "The malformed-input error was not controlled.",
      );
      requireCondition(
        !text.includes(fixture.rootPath),
        "The malformed-input error exposed a host path.",
      );
    });

    await runCheck(7, "paths outside the vault are rejected", async () => {
      requireCondition(client !== undefined, "The MCP client was not created.");
      const result = parseToolResult(
        await client.callTool({
          name: "read_note",
          arguments: { path: "linked-outside/Outside.md" },
        }),
      );
      const text = toolText(result);

      requireCondition(
        result.isError === true,
        "A linked path outside the vault was accepted.",
      );
      requireCondition(
        /^LINK_NOT_ALLOWED:/u.test(text),
        "The outside-vault rejection did not use the controlled link error.",
      );
      requireCondition(
        !text.includes(fixture.rootPath),
        "The outside-vault error exposed a host path.",
      );
      requireCondition(
        !text.includes("Synthetic outside-boundary sentinel"),
        "The server returned content from outside the vault.",
      );
    });

    process.stdout.write("MCP smoke test passed: 7/7 checks.\n");
  } finally {
    await transport?.terminateSession().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await httpServer?.close().catch(() => undefined);
    await removeTemporaryVault(fixture);
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof SmokeCheckError
      ? error.message
      : "MCP smoke-test setup or cleanup failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
