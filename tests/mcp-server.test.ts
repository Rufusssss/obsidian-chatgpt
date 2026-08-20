import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  createNoteOutputSchema,
  getBacklinksOutputSchema,
  getNoteMetadataOutputSchema,
  listNotesOutputSchema,
  modifiedNoteOutputSchema,
  readNoteOutputSchema,
  searchNotesOutputSchema,
  updatedNoteOutputSchema,
} from "../src/mcp/tool-schemas.ts";
import {
  McpHttpServerError,
  startStreamableHttpServer,
  type RunningMcpHttpServer,
} from "../src/mcp/transport/streamable-http.ts";
import { VaultPathPolicy } from "../src/vault/path-policy.ts";
import { ObsidianVaultService } from "../src/vault/vault-service.ts";
import {
  createTemporaryVault,
  removeTemporaryVault,
  type TemporaryVault,
} from "./helpers/temporary-vault.ts";

let fixture: TemporaryVault;
let httpServer: RunningMcpHttpServer;
let transport: StreamableHTTPClientTransport;
let client: Client;
let vaultService: ObsidianVaultService;

function assertToolResult(
  result: CallToolResult,
): asserts result is CallToolResult & { structuredContent: Record<string, unknown> } {
  assert.notEqual(result.isError, true);
  assert.ok(result.structuredContent);
}

function parseToolResult(result: unknown): CallToolResult {
  return CallToolResultSchema.parse(result);
}

function toolText(result: CallToolResult): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function assertInvalidToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const result = parseToolResult(
    await client.callTool({ name, arguments: args }),
  );
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  const text = toolText(result);
  assert.match(text, /Input validation error/iu);
  assert.equal(text.includes(fixture.vaultPath), false);
}

describe("MCP Streamable HTTP integration", () => {
  before(async () => {
    fixture = await createTemporaryVault();
    const pathPolicy = await VaultPathPolicy.create({
      vaultPath: fixture.vaultPath,
      backupDir: ".obsidian-chatgpt/backups",
    });
    vaultService = new ObsidianVaultService(pathPolicy);
    httpServer = await startStreamableHttpServer({
      host: "127.0.0.1",
      port: 0,
      vaultService,
    });
    transport = new StreamableHTTPClientTransport(httpServer.mcpUrl);
    client = new Client({
      name: "obsidian-chatgpt-integration-tests",
      version: "1.0.0",
    });
    await client.connect(transport as Transport);
  });

  after(async () => {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
    await httpServer.close();
    await removeTemporaryVault(fixture);
  });

  it("initializes with the required server instructions", () => {
    const instructions = client.getInstructions() ?? "";

    assert.match(instructions, /call search_notes and never invent a path/u);
    assert.match(instructions, /Read an existing note with read_note before modifying/u);
    assert.match(instructions, /returned version as expected_revision/u);
    assert.match(instructions, /Prefer append_to_note/u);
    assert.match(instructions, /update_note applies exact body replacements/u);
    assert.match(instructions, /Use get_note_metadata for bounded structure/u);
    assert.match(instructions, /use get_backlinks for incoming wikilinks/u);
    assert.match(instructions, /relative to the configured Obsidian vault/u);
    assert.match(instructions, /Move and delete operations are unavailable/u);
  });

  it("lists exactly eight local-vault tools with truthful annotations", async () => {
    const result = await client.listTools();

    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      [
        "list_notes",
        "search_notes",
        "read_note",
        "get_note_metadata",
        "get_backlinks",
        "create_note",
        "append_to_note",
        "update_note",
      ],
    );

    const expectedAnnotations = {
      list_notes: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      search_notes: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      read_note: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      get_note_metadata: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      get_backlinks: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      create_note: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      append_to_note: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      update_note: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    } as const;

    for (const tool of result.tools) {
      assert.ok(tool.title);
      assert.ok(tool.description?.includes("Do not use"));
      assert.ok(tool.outputSchema);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.deepEqual(
        tool.annotations,
        expectedAnnotations[tool.name as keyof typeof expectedAnnotations],
      );
    }

    assert.match(
      result.tools.find((tool) => tool.name === "create_note")?.description ?? "",
      /never overwrites user data/u,
    );
    assert.match(
      result.tools.find((tool) => tool.name === "append_to_note")?.description ?? "",
      /preserves all existing bytes/u,
    );
    assert.match(
      result.tools.find((tool) => tool.name === "update_note")?.description ?? "",
      /can overwrite existing user data/u,
    );
  });

  it("calls list_notes and follows its opaque cursor", async () => {
    const firstResult = parseToolResult(
      await client.callTool({
        name: "list_notes",
        arguments: { folder: "Projects", recursive: false, limit: 1 },
      }),
    );
    assertToolResult(firstResult);
    const firstPage = listNotesOutputSchema.parse(firstResult.structuredContent);

    assert.equal(firstPage.notes.length, 1);
    assert.equal(firstPage.notes[0]?.path, "Projects/Alpha Project.md");
    assert.match(firstPage.notes[0]?.version ?? "", /^sha256:[0-9a-f]{64}$/u);
    assert.ok(firstPage.next_cursor);

    const secondResult = parseToolResult(
      await client.callTool({
        name: "list_notes",
        arguments: {
          folder: "Projects",
          recursive: false,
          limit: 1,
          cursor: firstPage.next_cursor,
        },
      }),
    );
    assertToolResult(secondResult);
    const secondPage = listNotesOutputSchema.parse(secondResult.structuredContent);

    assert.equal(secondPage.notes[0]?.path, "Projects/Roadmap.md");
    assert.equal(secondPage.next_cursor, undefined);
  });

  it("calls search_notes and returns bounded structured matches", async () => {
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
    assertToolResult(result);
    const output = searchNotesOutputSchema.parse(result.structuredContent);

    assert.equal(output.matches.length, 1);
    assert.equal(output.matches[0]?.path, "Research/Graph Theory.md");
    assert.equal(output.matches[0]?.match_kind, "content");
    assert.ok((output.matches[0]?.line ?? 0) > 0);
    assert.match(output.matches[0]?.excerpt ?? "", /handshaking lemma/iu);
    assert.ok(Array.from(output.matches[0]?.excerpt ?? "").length <= 320);
    assert.equal(output.incomplete, false);
  });

  it("paginates search results with a query-bound opaque cursor", async () => {
    const firstResult = parseToolResult(
      await client.callTool({
        name: "search_notes",
        arguments: { query: "alpha", limit: 1 },
      }),
    );
    assertToolResult(firstResult);
    const firstPage = searchNotesOutputSchema.parse(
      firstResult.structuredContent,
    );
    assert.equal(firstPage.matches.length, 1);
    assert.ok(firstPage.next_cursor);

    const secondResult = parseToolResult(
      await client.callTool({
        name: "search_notes",
        arguments: {
          query: "alpha",
          limit: 1,
          cursor: firstPage.next_cursor,
        },
      }),
    );
    assertToolResult(secondResult);
    const secondPage = searchNotesOutputSchema.parse(
      secondResult.structuredContent,
    );

    assert.equal(secondPage.matches.length, 1);
    assert.notEqual(
      secondPage.matches[0]?.path,
      firstPage.matches[0]?.path,
    );

    const mismatchedResult = parseToolResult(
      await client.callTool({
        name: "search_notes",
        arguments: {
          query: "graph",
          limit: 1,
          cursor: firstPage.next_cursor,
        },
      }),
    );
    assert.equal(mismatchedResult.isError, true);
    assert.match(
      mismatchedResult.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n"),
      /^INVALID_CURSOR:/u,
    );
  });

  it("calls read_note without duplicating full content in the text summary", async () => {
    const result = parseToolResult(
      await client.callTool({
        name: "read_note",
        arguments: { path: "Projects/Alpha Project.md" },
      }),
    );
    assertToolResult(result);
    const output = readNoteOutputSchema.parse(result.structuredContent);
    const summary = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");

    assert.equal(output.path, "Projects/Alpha Project.md");
    assert.match(output.content, /^---\n/u);
    assert.match(output.content, /\[\[Projects\/Roadmap\|the roadmap\]\]/u);
    assert.match(output.version, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(summary.includes("Project Alpha is an invented planning note"), false);
  });

  it("calls get_note_metadata with bounded Obsidian-aware structured data", async () => {
    const result = parseToolResult(
      await client.callTool({
        name: "get_note_metadata",
        arguments: { path: "Projects/Alpha Project.md" },
      }),
    );
    assertToolResult(result);
    const output = getNoteMetadataOutputSchema.parse(result.structuredContent);
    const summary = toolText(result);

    assert.equal(output.path, "Projects/Alpha Project.md");
    assert.deepEqual(output.frontmatter.keys, ["aliases", "tags", "owner"]);
    assert.deepEqual(output.tags, ["active", "planning", "project"]);
    assert.equal(output.headings[0]?.text, "Project Alpha");
    assert.deepEqual(output.outgoing_links[0], {
      target: "Projects/Roadmap",
      alias: "the roadmap",
      line: 15,
      resolution: "resolved",
      resolved_path: "Projects/Roadmap.md",
    });
    assert.equal(output.incomplete, false);
    assert.equal(summary.includes("Synthetic Team"), false);
  });

  it("calls get_backlinks with deterministic bounded results", async () => {
    const result = parseToolResult(
      await client.callTool({
        name: "get_backlinks",
        arguments: { path: "Projects/Alpha Project.md", limit: 2 },
      }),
    );
    assertToolResult(result);
    const output = getBacklinksOutputSchema.parse(result.structuredContent);

    assert.equal(output.path, "Projects/Alpha Project.md");
    assert.equal(output.backlinks.length, 2);
    assert.deepEqual(
      output.backlinks.map((backlink) => backlink.source_path),
      ["Daily/2026-08-19.md", "Projects/Roadmap.md"],
    );
    assert.equal(output.total_matches, 3);
    assert.equal(output.truncated, true);
    assert.equal(output.scan_incomplete, false);
  });

  it("performs a complete create, discover, read, append, and update workflow", async () => {
    const notePath = "MCP Workflow/Write Contract.md";
    const initialContent =
      "---\ntags: [mcp-test]\n---\n# Write Contract\n\nSee [[Projects/Roadmap]].\n\nmcp-write-sentinel\n";

    const createResult = parseToolResult(
      await client.callTool({
        name: "create_note",
        arguments: { path: notePath, content: initialContent },
      }),
    );
    assertToolResult(createResult);
    const created = createNoteOutputSchema.parse(createResult.structuredContent);
    assert.equal(created.path, notePath);
    assert.match(created.version, /^sha256:[0-9a-f]{64}$/u);

    const listResult = parseToolResult(
      await client.callTool({
        name: "list_notes",
        arguments: { folder: "MCP Workflow", recursive: false },
      }),
    );
    assertToolResult(listResult);
    const listed = listNotesOutputSchema.parse(listResult.structuredContent);
    assert.equal(listed.notes[0]?.path, notePath);

    const searchResult = parseToolResult(
      await client.callTool({
        name: "search_notes",
        arguments: { query: "mcp-write-sentinel", limit: 5 },
      }),
    );
    assertToolResult(searchResult);
    const searched = searchNotesOutputSchema.parse(searchResult.structuredContent);
    assert.equal(searched.matches[0]?.path, notePath);

    const firstReadResult = parseToolResult(
      await client.callTool({
        name: "read_note",
        arguments: { path: notePath },
      }),
    );
    assertToolResult(firstReadResult);
    const firstRead = readNoteOutputSchema.parse(
      firstReadResult.structuredContent,
    );
    assert.equal(firstRead.content, initialContent);
    assert.equal(firstRead.version, created.version);

    const appendedText = "\nAppended exactly with [[Welcome]].\n";
    const appendResult = parseToolResult(
      await client.callTool({
        name: "append_to_note",
        arguments: {
          path: notePath,
          content: appendedText,
          expected_revision: firstRead.version,
        },
      }),
    );
    assertToolResult(appendResult);
    const appended = modifiedNoteOutputSchema.parse(
      appendResult.structuredContent,
    );
    assert.equal(appended.previous_version, firstRead.version);
    assert.notEqual(appended.version, firstRead.version);

    const secondReadResult = parseToolResult(
      await client.callTool({
        name: "read_note",
        arguments: { path: notePath },
      }),
    );
    assertToolResult(secondReadResult);
    const secondRead = readNoteOutputSchema.parse(
      secondReadResult.structuredContent,
    );
    assert.equal(secondRead.content, initialContent + appendedText);
    assert.equal(secondRead.version, appended.version);

    const updateResult = parseToolResult(
      await client.callTool({
        name: "update_note",
        arguments: {
          path: notePath,
          edits: [
            {
              old_text: "mcp-write-sentinel",
              new_text: "Updated deliberately.",
            },
            {
              old_text: "Appended exactly with [[Welcome]].",
              new_text: "Append was revised while [[Welcome]] stayed intact.",
            },
          ],
          expected_revision: secondRead.version,
        },
      }),
    );
    assertToolResult(updateResult);
    const updated = updatedNoteOutputSchema.parse(
      updateResult.structuredContent,
    );
    assert.equal(updated.previous_version, secondRead.version);
    assert.notEqual(updated.version, secondRead.version);
    assert.equal(updated.edits_applied, 2);

    const finalReadResult = parseToolResult(
      await client.callTool({
        name: "read_note",
        arguments: { path: notePath },
      }),
    );
    assertToolResult(finalReadResult);
    const finalRead = readNoteOutputSchema.parse(
      finalReadResult.structuredContent,
    );
    assert.equal(
      finalRead.content,
      initialContent
        .replace("mcp-write-sentinel", "Updated deliberately.") +
        appendedText.replace(
          "Appended exactly with [[Welcome]].",
          "Append was revised while [[Welcome]] stayed intact.",
        ),
    );
    assert.equal(finalRead.version, updated.version);
  });

  it("rejects stale append and update revisions without changing the newer note", async () => {
    const notePath = "MCP Workflow/Conflict.md";
    const initialContent = "# Conflict fixture\n";
    const createdResult = parseToolResult(
      await client.callTool({
        name: "create_note",
        arguments: { path: notePath, content: initialContent },
      }),
    );
    assertToolResult(createdResult);
    const created = createNoteOutputSchema.parse(createdResult.structuredContent);

    const winningAppend = parseToolResult(
      await client.callTool({
        name: "append_to_note",
        arguments: {
          path: notePath,
          content: "winner\n",
          expected_revision: created.version,
        },
      }),
    );
    assertToolResult(winningAppend);

    const staleAppend = parseToolResult(
      await client.callTool({
        name: "append_to_note",
        arguments: {
          path: notePath,
          content: "stale append\n",
          expected_revision: created.version,
        },
      }),
    );
    assert.equal(staleAppend.isError, true);
    assert.match(toolText(staleAppend), /^VERSION_CONFLICT:/u);

    const staleUpdate = parseToolResult(
      await client.callTool({
        name: "update_note",
        arguments: {
          path: notePath,
          edits: [{ old_text: "winner", new_text: "stale replacement" }],
          expected_revision: created.version,
        },
      }),
    );
    assert.equal(staleUpdate.isError, true);
    assert.match(toolText(staleUpdate), /^VERSION_CONFLICT:/u);

    const finalResult = parseToolResult(
      await client.callTool({
        name: "read_note",
        arguments: { path: notePath },
      }),
    );
    assertToolResult(finalResult);
    const finalNote = readNoteOutputSchema.parse(finalResult.structuredContent);
    assert.equal(finalNote.content, `${initialContent}winner\n`);
  });

  it("rejects update edits that target YAML frontmatter", async () => {
    const notePath = "MCP Workflow/Protected Frontmatter.md";
    const content = "---\ntags: [protected]\n---\n# Body\n";
    const createResult = parseToolResult(
      await client.callTool({
        name: "create_note",
        arguments: { path: notePath, content },
      }),
    );
    assertToolResult(createResult);
    const created = createNoteOutputSchema.parse(createResult.structuredContent);

    const updateResult = parseToolResult(
      await client.callTool({
        name: "update_note",
        arguments: {
          path: notePath,
          edits: [
            { old_text: "tags: [protected]", new_text: "tags: [changed]" },
          ],
          expected_revision: created.version,
        },
      }),
    );
    assert.equal(updateResult.isError, true);
    assert.match(toolText(updateResult), /^FRONTMATTER_PROTECTED:/u);

    const readResult = parseToolResult(
      await client.callTool({
        name: "read_note",
        arguments: { path: notePath },
      }),
    );
    assertToolResult(readResult);
    const note = readNoteOutputSchema.parse(readResult.structuredContent);
    assert.equal(note.content, content);
    assert.equal(note.version, created.version);
  });

  it("does not allow implicit overwrite or revision-free modification", async () => {
    const duplicate = parseToolResult(
      await client.callTool({
        name: "create_note",
        arguments: { path: "Welcome.md", content: "replacement" },
      }),
    );
    assert.equal(duplicate.isError, true);
    assert.match(toolText(duplicate), /^ALREADY_EXISTS:/u);

    await assertInvalidToolCall("append_to_note", {
      path: "Welcome.md",
      content: "missing revision",
    });
    await assertInvalidToolCall("update_note", {
      path: "Welcome.md",
      edits: [{ old_text: "Welcome", new_text: "Changed" }],
    });
    await assertInvalidToolCall("update_note", {
      path: "Welcome.md",
      edits: [{ old_text: "Welcome", new_text: "Changed" }],
      expected_revision: `sha256:${"0".repeat(64)}`,
      overwrite: true,
    });
  });

  it("rejects unknown fields, invalid limits, traversal, and missing arguments", async () => {
    await assertInvalidToolCall("list_notes", { unexpected: true });
    await assertInvalidToolCall("search_notes", {
      query: "alpha",
      limit: 51,
    });
    await assertInvalidToolCall("read_note", { path: "../Outside.md" });
    await assertInvalidToolCall("read_note", {});
    await assertInvalidToolCall("get_note_metadata", {});
    await assertInvalidToolCall("get_backlinks", {
      path: "Projects/Alpha Project.md",
      limit: 101,
    });
  });

  it("rejects unauthorized write paths without exposing the vault root", async () => {
    const validRevision = `sha256:${"0".repeat(64)}`;
    const calls = [
      client.callTool({
        name: "create_note",
        arguments: { path: ".obsidian/New.md", content: "not allowed" },
      }),
      client.callTool({
        name: "append_to_note",
        arguments: {
          path: ".trash/Discarded.md",
          content: "not allowed",
          expected_revision: validRevision,
        },
      }),
      client.callTool({
        name: "update_note",
        arguments: {
          path: ".obsidian/Workspace.md",
          edits: [{ old_text: "old", new_text: "not allowed" }],
          expected_revision: validRevision,
        },
      }),
    ];

    for (const pendingCall of calls) {
      const result = parseToolResult(await pendingCall);
      const text = toolText(result);
      assert.equal(result.isError, true);
      assert.match(text, /^PATH_FORBIDDEN:/u);
      assert.equal(text.includes(fixture.vaultPath), false);
    }

    await assertInvalidToolCall("create_note", {
      path: "../Outside.md",
      content: "not allowed",
    });
  });

  it("returns sanitized tool errors for policy-denied read paths", async () => {
    for (const name of [
      "read_note",
      "get_note_metadata",
      "get_backlinks",
    ]) {
      const result = parseToolResult(
        await client.callTool({
          name,
          arguments: { path: ".obsidian/Workspace.md" },
        }),
      );
      const text = toolText(result);

      assert.equal(result.isError, true);
      assert.match(text, /^PATH_FORBIDDEN:/u);
      assert.equal(text.includes(fixture.vaultPath), false);
    }
  });

  it("serves separate minimal health and readiness endpoints", async () => {
    const healthUrl = new URL("/health", httpServer.mcpUrl);
    const readinessUrl = new URL("/ready", httpServer.mcpUrl);
    const [health, readiness] = await Promise.all([
      fetch(healthUrl),
      fetch(readinessUrl),
    ]);

    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal(readiness.status, 200);
    assert.deepEqual(await readiness.json(), { status: "ready" });
  });

  it("refuses to bind the transport to a non-loopback host", async () => {
    await assert.rejects(
      startStreamableHttpServer({
        host: "0.0.0.0",
        port: 0,
        vaultService,
      }),
      McpHttpServerError,
    );
  });
});
