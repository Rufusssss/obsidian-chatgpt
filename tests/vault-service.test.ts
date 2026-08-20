import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { createNoteRevision } from "../src/vault/note-revision.ts";
import {
  ObsidianVaultService,
  VaultServiceError,
  type VaultServiceErrorCode,
} from "../src/vault/vault-service.ts";
import { VaultPathPolicy } from "../src/vault/path-policy.ts";
import {
  createTemporaryVault,
  removeTemporaryVault,
  type TemporaryVault,
  writeVaultNote,
} from "./helpers/temporary-vault.ts";

async function withTemporaryService(
  callback: (
    fixture: TemporaryVault,
    service: ObsidianVaultService,
    policy: VaultPathPolicy,
  ) => Promise<void>,
  options: ConstructorParameters<typeof ObsidianVaultService>[1] = {},
): Promise<void> {
  const fixture = await createTemporaryVault();

  try {
    const policy = await VaultPathPolicy.create({
      vaultPath: fixture.vaultPath,
      backupDir: ".obsidian-chatgpt/backups",
    });
    const service = new ObsidianVaultService(policy, options);
    await callback(fixture, service, policy);
  } finally {
    await removeTemporaryVault(fixture);
  }
}

async function assertServiceError(
  operation: Promise<unknown>,
  expectedCode: VaultServiceErrorCode,
  forbiddenAbsolutePath: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof VaultServiceError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(forbiddenAbsolutePath), false);
    assert.deepEqual(error.toModelError(), {
      code: expectedCode,
      message: error.message,
    });
    return true;
  });
}

describe("ObsidianVaultService integration", () => {
  it("recursively lists only policy-approved Markdown notes in deterministic order", async () => {
    await withTemporaryService(async (_fixture, service) => {
      const expected = [
        "Archive/alpha-retrospective.md",
        "Daily/2026-08-19.md",
        "Notes/Café.md",
        "Projects/Alpha Project.md",
        "Projects/Roadmap.md",
        "Research/Graph Theory.md",
        "Welcome.md",
      ];

      assert.deepEqual(await service.listNotes(), expected);
      assert.deepEqual(await service.listNotes(), expected);
    });
  });

  it("limits listing to a validated folder and recursion mode", async () => {
    await withTemporaryService(async (fixture, service) => {
      await writeVaultNote(
        fixture,
        "Projects/Nested/Details.md",
        "# Nested details\n",
      );

      assert.deepEqual(
        await service.listNotes({ folder: "Projects", recursive: false }),
        ["Projects/Alpha Project.md", "Projects/Roadmap.md"],
      );
      assert.deepEqual(
        await service.listNotes({ folder: "Projects", recursive: true }),
        [
          "Projects/Alpha Project.md",
          "Projects/Nested/Details.md",
          "Projects/Roadmap.md",
        ],
      );
    });
  });

  it("does not follow a linked directory while enumerating", async () => {
    await withTemporaryService(async (fixture, service) => {
      await writeFile(
        path.join(fixture.outsidePath, "Outside.md"),
        "# Outside\nsecret sentinel\n",
        "utf8",
      );
      await symlink(
        fixture.outsidePath,
        path.join(fixture.vaultPath, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const notes = await service.listNotes();
      const matches = await service.searchNotes("secret sentinel");

      assert.equal(notes.some((note) => note.startsWith("linked/")), false);
      assert.deepEqual(matches, []);
    });
  });

  it("reads exact UTF-8 content and returns raw-byte metadata and revision", async () => {
    await withTemporaryService(async (fixture, service) => {
      const absolutePath = path.join(
        fixture.vaultPath,
        "Projects",
        "Alpha Project.md",
      );
      const rawContent = await readFile(absolutePath);

      const first = await service.readNote("Projects/Alpha Project.md");
      const second = await service.readNote("Projects/Alpha Project.md");

      assert.equal(first.path, "Projects/Alpha Project.md");
      assert.equal(first.content, rawContent.toString("utf8"));
      assert.equal(first.content.startsWith("---\n"), true);
      assert.equal(first.content.includes("[[Projects/Roadmap|the roadmap]]"), true);
      assert.equal(first.content.includes("$E = mc^2$"), true);
      assert.equal(first.byteSize, rawContent.byteLength);
      assert.equal(first.revision, createNoteRevision(rawContent));
      assert.match(first.revision, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(first.revision, second.revision);
      assert.equal(Number.isNaN(Date.parse(first.modifiedAt)), false);

      await writeFile(
        absolutePath,
        Buffer.concat([rawContent, Buffer.from("\nRevision change.\n", "utf8")]),
      );
      const changed = await service.readNote("Projects/Alpha Project.md");
      assert.notEqual(changed.revision, first.revision);
    });
  });

  it("preserves a UTF-8 BOM in decoded content and hashes it", async () => {
    await withTemporaryService(async (fixture, service) => {
      const rawContent = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("# BOM note\n[[Welcome]]\n", "utf8"),
      ]);
      const absolutePath = await writeVaultNote(fixture, "Notes/BOM.md", "");
      await writeFile(absolutePath, rawContent);

      const note = await service.readNote("Notes/BOM.md");

      assert.equal(note.content.startsWith("\uFEFF# BOM note"), true);
      assert.equal(note.byteSize, rawContent.byteLength);
      assert.equal(note.revision, createNoteRevision(rawContent));
    });
  });

  it("returns bounded Obsidian-aware frontmatter, tags, headings, and outgoing links", async () => {
    await withTemporaryService(async (_fixture, service) => {
      const metadata = await service.getNoteMetadata(
        "Projects/Alpha Project.md",
      );

      assert.equal(metadata.path, "Projects/Alpha Project.md");
      assert.match(metadata.revision, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(metadata.frontmatter.present, true);
      assert.equal(metadata.frontmatter.valid, true);
      assert.deepEqual(metadata.frontmatter.keys, ["aliases", "tags", "owner"]);
      assert.match(metadata.frontmatter.raw ?? "", /Synthetic Team/u);
      assert.deepEqual(metadata.tags, ["active", "planning", "project"]);
      assert.deepEqual(metadata.headings, [
        { level: 1, text: "Project Alpha", line: 10 },
      ]);
      assert.deepEqual(metadata.outgoingLinks, [
        {
          target: "Projects/Roadmap",
          alias: "the roadmap",
          line: 15,
          resolution: "resolved",
          resolvedPath: "Projects/Roadmap.md",
        },
        {
          target: "Research/Graph Theory#Euler paths",
          line: 15,
          resolution: "resolved",
          resolvedPath: "Research/Graph Theory.md",
        },
      ]);
      assert.equal(metadata.incomplete, false);

      const missingTarget = await service.getNoteMetadata("Welcome.md");
      assert.deepEqual(missingTarget.outgoingLinks, [
        {
          target: "Another synthetic note",
          line: 10,
          resolution: "missing",
        },
      ]);
    });
  });

  it("builds deterministic bounded backlinks from a fresh vault scan", async () => {
    await withTemporaryService(async (_fixture, service) => {
      const result = await service.getBacklinks(
        "Projects/Alpha Project.md",
      );

      assert.equal(result.path, "Projects/Alpha Project.md");
      assert.match(result.revision, /^sha256:[0-9a-f]{64}$/u);
      assert.deepEqual(
        result.backlinks.map((backlink) => backlink.sourcePath),
        [
          "Daily/2026-08-19.md",
          "Projects/Roadmap.md",
          "Research/Graph Theory.md",
        ],
      );
      assert.equal(result.totalMatches, 3);
      assert.equal(result.truncated, false);
      assert.equal(result.scanIncomplete, false);
      for (const backlink of result.backlinks) {
        assert.match(backlink.sourceRevision, /^sha256:[0-9a-f]{64}$/u);
        assert.equal(backlink.target, "Projects/Alpha Project");
      }

      const bounded = await service.getBacklinks(
        "Projects/Alpha Project.md",
        { limit: 1 },
      );
      assert.equal(bounded.backlinks.length, 1);
      assert.equal(bounded.totalMatches, 3);
      assert.equal(bounded.truncated, true);
    });
  });

  it("handles duplicate filenames conservatively when resolving backlinks", async () => {
    await withTemporaryService(async (fixture, service) => {
      await writeVaultNote(fixture, "Teams/A/Shared.md", "# Shared A\n");
      await writeVaultNote(fixture, "Teams/B/Shared.md", "# Shared B\n");
      await writeVaultNote(
        fixture,
        "Teams/A/Local Source.md",
        "# Local source\n[[Shared]]\n",
      );
      await writeVaultNote(
        fixture,
        "Other/Ambiguous Source.md",
        "# Ambiguous source\n[[Shared]]\n",
      );
      await writeVaultNote(
        fixture,
        "Other/Explicit Source.md",
        "# Explicit source\n[[Teams/B/Shared|Shared B alias]]\n",
      );

      const ambiguous = await service.getNoteMetadata(
        "Other/Ambiguous Source.md",
      );
      assert.equal(ambiguous.outgoingLinks[0]?.resolution, "ambiguous");
      assert.equal(ambiguous.outgoingLinks[0]?.resolvedPath, undefined);

      const sharedA = await service.getBacklinks("Teams/A/Shared.md");
      assert.deepEqual(
        sharedA.backlinks.map((backlink) => backlink.sourcePath),
        ["Teams/A/Local Source.md"],
      );

      const sharedB = await service.getBacklinks("Teams/B/Shared.md");
      assert.deepEqual(sharedB.backlinks, [
        {
          sourcePath: "Other/Explicit Source.md",
          sourceRevision: sharedB.backlinks[0]?.sourceRevision,
          line: 2,
          target: "Teams/B/Shared",
          alias: "Shared B alias",
        },
      ]);
      assert.equal(sharedB.totalMatches, 1);
    });
  });

  it("rejects invalid UTF-8 and notes above the configured read limit", async () => {
    await withTemporaryService(async (fixture, service) => {
      const invalidPath = await writeVaultNote(fixture, "Notes/Invalid.md", "");
      await writeFile(invalidPath, Buffer.from([0xc3, 0x28]));

      await assertServiceError(
        service.readNote("Notes/Invalid.md"),
        "INVALID_ENCODING",
        fixture.vaultPath,
      );
    });

    await withTemporaryService(
      async (fixture, service) => {
        await assertServiceError(
          service.readNote("Welcome.md"),
          "NOTE_TOO_LARGE",
          fixture.vaultPath,
        );
      },
      { maxNoteBytes: 32 },
    );
  });

  it("searches headings, paths, frontmatter tags, and Markdown contents", async () => {
    await withTemporaryService(async (_fixture, service) => {
      const titleMatches = await service.searchNotes("graph theory");
      const pathMatches = await service.searchNotes("roadmap");
      const tagMatches = await service.searchNotes("mathematics");
      const mathMatches = await service.searchNotes("handshaking lemma");
      const internalMatches = await service.searchNotes("Internal Obsidian state");

      assert.equal(titleMatches[0]?.path, "Research/Graph Theory.md");
      assert.equal(titleMatches[0]?.title, "Graph Theory Notes");
      assert.match(titleMatches[0]?.snippet ?? "", /Graph Theory Notes/iu);
      assert.equal(pathMatches.some((match) => match.path === "Projects/Roadmap.md"), true);
      assert.equal(tagMatches[0]?.path, "Research/Graph Theory.md");
      assert.match(mathMatches[0]?.snippet ?? "", /handshaking lemma/iu);
      assert.deepEqual(internalMatches, []);
    });
  });

  it("supports folder and path/content search scopes", async () => {
    await withTemporaryService(async (_fixture, service) => {
      const folderMatches = await service.searchNotes("alpha", {
        folder: "Archive",
      });
      const pathOnly = await service.searchNotes("handshaking lemma", {
        scope: "path",
      });
      const contentOnly = await service.searchNotes("handshaking lemma", {
        scope: "content",
      });

      assert.deepEqual(
        folderMatches.map((match) => match.path),
        ["Archive/alpha-retrospective.md"],
      );
      assert.deepEqual(pathOnly, []);
      assert.equal(contentOnly[0]?.path, "Research/Graph Theory.md");
      assert.equal(contentOnly[0]?.matchKind, "content");
      assert.ok((contentOnly[0]?.line ?? 0) > 0);
    });
  });

  it("uses duplicate literal terms in a simple deterministic relevance score", async () => {
    await withTemporaryService(async (_fixture, service) => {
      const first = await service.searchNotes("alpha", { limit: 3 });
      const second = await service.searchNotes("alpha", { limit: 3 });

      assert.deepEqual(second, first);
      assert.equal(first.length, 3);
      assert.equal(first[0]?.path, "Projects/Alpha Project.md");
      assert.ok((first[0]?.score ?? 0) > (first[1]?.score ?? 0));
      assert.match(first[0]?.snippet ?? "", /alpha/iu);
    });
  });

  it("treats query punctuation literally and honors case sensitivity", async () => {
    await withTemporaryService(async (_fixture, service) => {
      const literal = await service.searchNotes("$E = mc^2$");
      const insensitive = await service.searchNotes("PROJECT ALPHA");
      const sensitive = await service.searchNotes("PROJECT ALPHA", {
        caseSensitive: true,
      });

      assert.equal(literal[0]?.path, "Projects/Alpha Project.md");
      assert.equal(insensitive.some((match) => match.path === "Projects/Alpha Project.md"), true);
      assert.deepEqual(sensitive, []);
    });
  });

  it("bounds result count and snippet size", async () => {
    await withTemporaryService(
      async (fixture, service) => {
        await writeVaultNote(
          fixture,
          "Notes/Long.md",
          `# Long\n${"before ".repeat(100)}needle ${"after ".repeat(100)}\n`,
        );

        const matches = await service.searchNotes("needle", { limit: 1 });

        assert.equal(matches.length, 1);
        assert.ok(Array.from(matches[0]?.snippet ?? "").length <= 80);
        assert.match(matches[0]?.snippet ?? "", /needle/u);
      },
      { maxSnippetCodePoints: 80 },
    );
  });

  it("fails with typed errors for invalid queries, limits, and bounded search work", async () => {
    await withTemporaryService(async (fixture, service) => {
      await assertServiceError(
        service.searchNotes("   "),
        "INVALID_QUERY",
        fixture.vaultPath,
      );
      await assertServiceError(
        service.searchNotes("alpha", { limit: 51 }),
        "INVALID_LIMIT",
        fixture.vaultPath,
      );
    });

    await withTemporaryService(
      async (fixture, service) => {
        await assertServiceError(
          service.searchNotes("alpha"),
          "SEARCH_LIMIT_REACHED",
          fixture.vaultPath,
        );
      },
      { maxSearchFiles: 1 },
    );

    await withTemporaryService(
      async (fixture, service) => {
        await assertServiceError(
          service.searchNotes("alpha"),
          "SEARCH_LIMIT_REACHED",
          fixture.vaultPath,
        );
      },
      { maxSearchBytes: 1 },
    );
  });
});
