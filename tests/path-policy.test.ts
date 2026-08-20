import assert from "node:assert/strict";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  VaultPathError,
  type VaultPathErrorCode,
  VaultPathPolicy,
} from "../src/vault/path-policy.ts";
import {
  createTemporaryVault,
  removeTemporaryVault,
  type TemporaryVault,
  writeVaultNote,
} from "./helpers/temporary-vault.ts";

async function withTemporaryPolicy(
  callback: (
    fixture: TemporaryVault,
    policy: VaultPathPolicy,
  ) => Promise<void>,
): Promise<void> {
  const fixture = await createTemporaryVault();

  try {
    const policy = await VaultPathPolicy.create({
      vaultPath: fixture.vaultPath,
      backupDir: ".obsidian-chatgpt/backups",
    });
    await callback(fixture, policy);
  } finally {
    await removeTemporaryVault(fixture);
  }
}

async function assertPathError(
  operation: Promise<unknown>,
  expectedCode: VaultPathErrorCode,
  forbiddenAbsolutePath: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof VaultPathError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.message.includes(forbiddenAbsolutePath), false);
    assert.deepEqual(error.toModelError(), {
      code: expectedCode,
      message: error.message,
    });
    return true;
  });
}

describe("VaultPathPolicy", () => {
  it("resolves the vault root and safe nested directories for enumeration", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      const root = await policy.resolveDirectoryPath();
      const nested = await policy.resolveDirectoryPath("Projects");

      assert.deepEqual(root, {
        relativePath: "",
        absolutePath: fixture.vaultPath,
      });
      assert.deepEqual(nested, {
        relativePath: "Projects",
        absolutePath: path.join(fixture.vaultPath, "Projects"),
      });
    });
  });

  it("applies the same traversal and hidden-directory rules to enumeration", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      await assertPathError(
        policy.resolveDirectoryPath("../outside-vault"),
        "PATH_TRAVERSAL",
        fixture.vaultPath,
      );
      await assertPathError(
        policy.resolveDirectoryPath(".obsidian"),
        "DENIED_DIRECTORY",
        fixture.vaultPath,
      );
    });
  });

  it("resolves a normal Markdown note", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      await writeVaultNote(fixture, "Note.md");

      const resolved = await policy.resolveNotePath("Note.md");

      assert.equal(resolved.relativePath, "Note.md");
      assert.equal(resolved.absolutePath, path.join(fixture.vaultPath, "Note.md"));
      assert.equal(resolved.exists, true);
    });
  });

  it("resolves nested and Unicode Markdown notes with POSIX separators", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      await writeVaultNote(fixture, "Projects/Café/Plan.MD");

      const resolved = await policy.resolveNotePath("Projects/Café/Plan.MD");

      assert.equal(resolved.relativePath, "Projects/Café/Plan.MD");
      assert.equal(
        resolved.absolutePath,
        path.join(fixture.vaultPath, "Projects", "Café", "Plan.MD"),
      );
    });
  });

  it("resolves a safe missing target only when creation is expected", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      await mkdir(path.join(fixture.vaultPath, "Projects"), {
        recursive: true,
      });

      const resolved = await policy.resolveNotePath("Projects/New.md", {
        expectation: "new",
      });

      assert.equal(resolved.exists, false);
      assert.equal(resolved.relativePath, "Projects/New.md");
      assert.equal(
        resolved.absolutePath,
        path.join(fixture.vaultPath, "Projects", "New.md"),
      );
    });
  });

  it("rejects parent traversal", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      for (const requestedPath of [
        "../Outside.md",
        "Notes/../Outside.md",
        "Notes/../../Outside.md",
      ]) {
        await assertPathError(
          policy.resolveNotePath(requestedPath),
          "PATH_TRAVERSAL",
          fixture.vaultPath,
        );
      }
    });
  });

  it("rejects POSIX, Windows drive, UNC, and drive-relative paths", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      const absolutePaths = [
        "/tmp/Outside.md",
        "C:\\Users\\example\\Outside.md",
        "C:Outside.md",
        "\\\\server\\share\\Outside.md",
        path.join(fixture.vaultPath, "Outside.md"),
      ];

      for (const requestedPath of absolutePaths) {
        await assertPathError(
          policy.resolveNotePath(requestedPath),
          "ABSOLUTE_PATH",
          fixture.vaultPath,
        );
      }
    });
  });

  it("rejects encoded and ambiguous path forms without decoding them", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      for (const requestedPath of [
        "Notes/%2e%2e/Outside.md",
        "Notes/%2FOutside.md",
        "Notes/%5cOutside.md",
      ]) {
        await assertPathError(
          policy.resolveNotePath(requestedPath),
          "ENCODED_PATH",
          fixture.vaultPath,
        );
      }

      await assertPathError(
        policy.resolveNotePath("Notes\\Outside.md"),
        "INVALID_SEPARATOR",
        fixture.vaultPath,
      );
      await assertPathError(
        policy.resolveNotePath("Notes//Outside.md"),
        "INVALID_SEGMENT",
        fixture.vaultPath,
      );
      await assertPathError(
        policy.resolveNotePath("Note.md:stream"),
        "INVALID_CHARACTERS",
        fixture.vaultPath,
      );
      await assertPathError(
        policy.resolveNotePath("CON.md"),
        "RESERVED_NAME",
        fixture.vaultPath,
      );
    });
  });

  it("rejects symlink or junction escape outside the vault", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      await writeFile(
        path.join(fixture.outsidePath, "Outside.md"),
        "# Outside\n",
        "utf8",
      );
      await symlink(
        fixture.outsidePath,
        path.join(fixture.vaultPath, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );

      await assertPathError(
        policy.resolveNotePath("linked/Outside.md"),
        "SYMLINK_NOT_ALLOWED",
        fixture.vaultPath,
      );
    });
  });

  it("rejects a symlinked or junction vault root", async () => {
    const fixture = await createTemporaryVault();

    try {
      const linkedRoot = path.join(fixture.rootPath, "linked-vault");
      await symlink(
        fixture.vaultPath,
        linkedRoot,
        process.platform === "win32" ? "junction" : "dir",
      );

      await assertPathError(
        VaultPathPolicy.create({ vaultPath: linkedRoot }),
        "INVALID_VAULT_ROOT",
        fixture.vaultPath,
      );
    } finally {
      await removeTemporaryVault(fixture);
    }
  });

  it("rejects .obsidian, .trash, hidden, and configured backup directories", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      for (const requestedPath of [
        ".obsidian/Config.md",
        ".OBSIDIAN/Config.md",
        ".trash/Deleted.md",
        ".internal/State.md",
        "Notes/.private/State.md",
        ".obsidian-chatgpt/backups/Previous.md",
      ]) {
        await assertPathError(
          policy.resolveNotePath(requestedPath),
          "DENIED_DIRECTORY",
          fixture.vaultPath,
        );
      }
    });
  });

  it("rejects a configured non-hidden backup directory", async () => {
    const fixture = await createTemporaryVault();

    try {
      const policy = await VaultPathPolicy.create({
        vaultPath: fixture.vaultPath,
        backupDir: "server-data/backups",
      });

      await assertPathError(
        policy.resolveNotePath("server-data/backups/Previous.md"),
        "DENIED_DIRECTORY",
        fixture.vaultPath,
      );
    } finally {
      await removeTemporaryVault(fixture);
    }
  });

  it("allows a dot-prefixed Markdown filename outside hidden directories", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      await writeVaultNote(fixture, ".private.md");

      const resolved = await policy.resolveNotePath(".private.md");

      assert.equal(resolved.relativePath, ".private.md");
    });
  });

  it("rejects non-Markdown targets", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      for (const requestedPath of [
        "Document.txt",
        "Document",
        "Document.md.exe",
      ]) {
        await assertPathError(
          policy.resolveNotePath(requestedPath),
          "NOT_MARKDOWN",
          fixture.vaultPath,
        );
      }
    });
  });

  it("rejects hard-linked note aliases", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      const outsideFile = path.join(fixture.outsidePath, "Outside.md");
      await writeFile(outsideFile, "# Outside\n", "utf8");
      await link(outsideFile, path.join(fixture.vaultPath, "Alias.md"));

      await assertPathError(
        policy.resolveNotePath("Alias.md"),
        "HARD_LINK_NOT_ALLOWED",
        fixture.vaultPath,
      );
    });
  });

  it("returns typed errors for missing notes and existing create targets", async () => {
    await withTemporaryPolicy(async (fixture, policy) => {
      await assertPathError(
        policy.resolveNotePath("Missing.md"),
        "NOTE_NOT_FOUND",
        fixture.vaultPath,
      );

      await writeVaultNote(fixture, "Existing.md");
      await assertPathError(
        policy.resolveNotePath("Existing.md", { expectation: "new" }),
        "NOTE_ALREADY_EXISTS",
        fixture.vaultPath,
      );
    });
  });
});
