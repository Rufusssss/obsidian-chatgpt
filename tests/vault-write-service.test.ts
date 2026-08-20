import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ObsidianVaultService,
  VaultServiceError,
} from "../src/vault/vault-service.ts";
import { createNoteRevision } from "../src/vault/note-revision.ts";
import { RecoveryStore } from "../src/vault/recovery-store.ts";
import { writeExclusiveFile } from "../src/vault/safe-write-primitives.ts";
import {
  VaultPathError,
  VaultPathPolicy,
} from "../src/vault/path-policy.ts";
import {
  createTemporaryVault,
  removeTemporaryVault,
  type TemporaryVault,
  writeVaultNote,
} from "./helpers/temporary-vault.ts";

async function withTemporaryWriteService(
  callback: (
    fixture: TemporaryVault,
    service: ObsidianVaultService,
  ) => Promise<void>,
  backupDir = ".obsidian-chatgpt/backups",
): Promise<void> {
  const fixture = await createTemporaryVault();
  try {
    const policy = await VaultPathPolicy.create({
      vaultPath: fixture.vaultPath,
      backupDir,
    });
    const service = new ObsidianVaultService(policy);
    await callback(fixture, service);
  } finally {
    await removeTemporaryVault(fixture);
  }
}

function assertVersionConflict(error: unknown): boolean {
  assert.ok(error instanceof VaultServiceError);
  assert.equal(error.code, "VERSION_CONFLICT");
  return true;
}

describe("ObsidianVaultService write layer", () => {
  it("creates a Markdown note and missing parent folders without overwriting", async () => {
    await withTemporaryWriteService(async (fixture, service) => {
      const content = "---\ntags: [synthetic]\n---\n# New note\nSee [[Welcome]].\n";
      const created = await service.createNote(
        "New/Nested/Created.md",
        content,
      );
      const read = await service.readNote("New/Nested/Created.md");

      assert.equal(created.path, "New/Nested/Created.md");
      assert.equal(created.revision, read.revision);
      assert.equal(created.byteSize, Buffer.byteLength(content));
      assert.equal(read.content, content);
      assert.equal(
        await readFile(
          path.join(fixture.vaultPath, "New", "Nested", "Created.md"),
          "utf8",
        ),
        content,
      );
    });
  });

  it("rejects duplicate creation and preserves the existing note", async () => {
    await withTemporaryWriteService(async (_fixture, service) => {
      const before = await service.readNote("Welcome.md");

      await assert.rejects(
        service.createNote("Welcome.md", "# Replacement\n"),
        (error: unknown) => {
          assert.ok(error instanceof VaultPathError);
          assert.equal(error.code, "NOTE_ALREADY_EXISTS");
          return true;
        },
      );

      const after = await service.readNote("Welcome.md");
      assert.equal(after.content, before.content);
      assert.equal(after.revision, before.revision);
    });
  });

  it("appends exact UTF-8 text while preserving all existing bytes", async () => {
    await withTemporaryWriteService(async (fixture, service) => {
      const notePath = "Notes/Append.md";
      const original = "---\r\ntags: [append]\r\n---\r\n# Log\r\nSee [[Welcome]].\r\n";
      const appended = "- Added without rewriting prior lines\r\n";
      await writeVaultNote(fixture, notePath, original);
      const before = await service.readNote(notePath);

      const result = await service.appendToNote(
        notePath,
        appended,
        before.revision,
      );
      const afterBytes = await readFile(
        path.join(fixture.vaultPath, "Notes", "Append.md"),
      );

      assert.equal(afterBytes.toString("utf8"), `${original}${appended}`);
      assert.equal(result.previousRevision, before.revision);
      assert.notEqual(result.revision, before.revision);
      assert.ok(result.backupId);
    });
  });

  it("allows append without a supplied revision but still appends to a stable current snapshot", async () => {
    await withTemporaryWriteService(async (_fixture, service) => {
      const before = await service.readNote("Welcome.md");
      await service.appendToNote("Welcome.md", "\nOptional revision append.\n");
      const after = await service.readNote("Welcome.md");

      assert.equal(after.content, `${before.content}\nOptional revision append.\n`);
    });
  });

  it("rejects stale append and update revisions without changing the note", async () => {
    await withTemporaryWriteService(async (_fixture, service) => {
      const original = await service.readNote("Projects/Roadmap.md");
      await service.appendToNote(
        "Projects/Roadmap.md",
        "\nCurrent change.\n",
        original.revision,
      );
      const current = await service.readNote("Projects/Roadmap.md");

      await assert.rejects(
        service.appendToNote(
          "Projects/Roadmap.md",
          "\nStale append.\n",
          original.revision,
        ),
        assertVersionConflict,
      );
      await assert.rejects(
        service.updateNote(
          "Projects/Roadmap.md",
          "# Stale replacement\n",
          original.revision,
        ),
        assertVersionConflict,
      );

      const after = await service.readNote("Projects/Roadmap.md");
      assert.equal(after.content, current.content);
      assert.equal(after.revision, current.revision);
    });
  });

  it("updates to the exact requested UTF-8 content and leaves unrelated syntax unchanged", async () => {
    await withTemporaryWriteService(async (fixture, service) => {
      const notePath = "Notes/Update.md";
      const original =
        "---\r\ntags: [project]\r\nstatus: draft\r\n---\r\n# Plan\r\nSee [[Projects/Roadmap]].\r\n";
      await writeVaultNote(fixture, notePath, original);
      const before = await service.readNote(notePath);
      const requested = before.content.replace("status: draft", "status: final");

      const result = await service.updateNote(
        notePath,
        requested,
        before.revision,
      );
      const after = await service.readNote(notePath);

      assert.equal(after.content, requested);
      assert.equal(after.content.includes("\r\n"), true);
      assert.equal(after.content.includes("[[Projects/Roadmap]]"), true);
      assert.equal(result.previousRevision, before.revision);
      assert.equal(result.revision, after.revision);
      assert.ok(result.backupId);
    });
  });

  it("rejects write paths that escape the vault", async () => {
    await withTemporaryWriteService(async (fixture, service) => {
      await assert.rejects(
        service.createNote("../Outside.md", "# Outside\n"),
        (error: unknown) => {
          assert.ok(error instanceof VaultPathError);
          assert.equal(error.code, "PATH_TRAVERSAL");
          assert.equal(error.message.includes(fixture.vaultPath), false);
          return true;
        },
      );
      await assert.rejects(
        service.appendToNote("../Outside.md", "not allowed"),
        VaultPathError,
      );
    });
  });

  it("leaves the live note unchanged when the recovery store cannot be prepared", async () => {
    await withTemporaryWriteService(async (fixture, service) => {
      const before = await service.readNote("Welcome.md");
      await writeFile(
        path.join(fixture.vaultPath, "write-failure"),
        "synthetic directory collision\n",
        "utf8",
      );

      await assert.rejects(
        service.updateNote(
          "Welcome.md",
          "# Must not be installed\n",
          before.revision,
        ),
        VaultPathError,
      );

      const after = await service.readNote("Welcome.md");
      assert.equal(after.content, before.content);
      assert.equal(after.revision, before.revision);
    }, "write-failure/backups");
  });

  it("recovers an exact pre-write backup without losing the replaced version", async () => {
    await withTemporaryWriteService(async (fixture, service) => {
      const notePath = "Projects/Alpha Project.md";
      const originalBytes = await readFile(
        path.join(fixture.vaultPath, "Projects", "Alpha Project.md"),
      );
      const before = await service.readNote(notePath);
      const changedContent = `${before.content}\nTemporary synthetic change.\n`;
      const changed = await service.updateNote(
        notePath,
        changedContent,
        before.revision,
      );
      assert.ok(changed.backupId);

      const current = await service.readNote(notePath);
      const recovered = await service.recoverBackup(
        changed.backupId,
        current.revision,
      );
      const restoredBytes = await readFile(
        path.join(fixture.vaultPath, "Projects", "Alpha Project.md"),
      );

      assert.deepEqual(restoredBytes, originalBytes);
      assert.equal(recovered.revision, before.revision);
      assert.ok(recovered.backupId);
      assert.notEqual(recovered.backupId, changed.backupId);
      assert.equal(
        (await service.listNotes()).some((listed) =>
          listed.startsWith(".obsidian-chatgpt/"),
        ),
        false,
      );
    });
  });

  it("recovers an interrupted captured transaction before the next write", async () => {
    const fixture = await createTemporaryVault();
    try {
      const policy = await VaultPathPolicy.create({
        vaultPath: fixture.vaultPath,
        backupDir: ".obsidian-chatgpt/backups",
      });
      const service = new ObsidianVaultService(policy);
      const store = new RecoveryStore(policy);
      const notePath = "Projects/Roadmap.md";
      const before = await service.readNote(notePath);
      const originalBytes = Buffer.from(before.content, "utf8");
      const interruptedBytes = Buffer.from(
        `${before.content}\nUncommitted staged content.\n`,
        "utf8",
      );
      const location = await policy.resolveNoteLocation(notePath);
      const transactionId = randomUUID();
      const stagingName = `.obsidian-chatgpt-${transactionId}.stage`;
      const recoveryName = `.obsidian-chatgpt-${transactionId}.recovery`;
      const stagePath = path.join(location.parentAbsolutePath, stagingName);
      const recoveryPath = path.join(
        location.parentAbsolutePath,
        recoveryName,
      );
      const backup = await store.createBackup(notePath, originalBytes);

      await writeExclusiveFile(stagePath, interruptedBytes, 0o600);
      await store.createTransaction({
        version: 1,
        operation: "update",
        transactionId,
        notePath,
        expectedRevision: before.revision,
        intendedRevision: createNoteRevision(interruptedBytes),
        backupId: backup.id,
        stagingName,
        recoveryName,
      });
      await rename(location.absolutePath, recoveryPath);

      await service.appendToNote(
        notePath,
        "\nWrite after automatic recovery.\n",
        before.revision,
      );
      const after = await service.readNote(notePath);

      assert.equal(
        after.content,
        `${before.content}\nWrite after automatic recovery.\n`,
      );
      await assert.rejects(lstat(stagePath), { code: "ENOENT" });
      await assert.rejects(lstat(recoveryPath), { code: "ENOENT" });
    } finally {
      await removeTemporaryVault(fixture);
    }
  });

  it("serializes concurrent writers so one stale revision conflicts", async () => {
    await withTemporaryWriteService(async (_fixture, service) => {
      const notePath = "Projects/Roadmap.md";
      const before = await service.readNote(notePath);
      const firstContent = `${before.content}\nConcurrent version A.\n`;
      const secondContent = `${before.content}\nConcurrent version B.\n`;

      const results = await Promise.allSettled([
        service.updateNote(notePath, firstContent, before.revision),
        service.updateNote(notePath, secondContent, before.revision),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assertVersionConflict(rejected[0]?.reason);

      const after = await service.readNote(notePath);
      assert.equal(
        after.content === firstContent || after.content === secondContent,
        true,
      );
    });
  });
});
