import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { createNoteRevision } from "./note-revision.ts";
import { NoteWriterError } from "./note-writer-errors.ts";
import type { VaultPathPolicy } from "./path-policy.ts";
import {
  syncDirectory,
  writeExclusiveFile,
} from "./safe-write-primitives.ts";

const backupDirectoryPrefix = "backup-";
const transactionFilePrefix = "transaction-";
const transactionFileSuffix = ".json";

const backupManifestSchema = z
  .object({
    version: z.literal(1),
    backupId: z.string().uuid(),
    notePath: z.string().min(1).max(2_048),
    revision: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    byteSize: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .strict();

const createTransactionSchema = z
  .object({
    version: z.literal(1),
    operation: z.literal("create"),
    transactionId: z.string().uuid(),
    notePath: z.string().min(1).max(2_048),
    intendedRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    stagingName: z.string().min(1).max(255),
  })
  .strict();

const modifyTransactionSchema = z
  .object({
    version: z.literal(1),
    operation: z.enum(["append", "update"]),
    transactionId: z.string().uuid(),
    notePath: z.string().min(1).max(2_048),
    expectedRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    intendedRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    backupId: z.string().uuid(),
    stagingName: z.string().min(1).max(255),
    recoveryName: z.string().min(1).max(255),
  })
  .strict();

const transactionSchema = z.discriminatedUnion("operation", [
  createTransactionSchema,
  modifyTransactionSchema,
]);

export type BackupManifest = z.infer<typeof backupManifestSchema>;
export type CreateTransaction = z.infer<typeof createTransactionSchema>;
export type ModifyTransaction = z.infer<typeof modifyTransactionSchema>;
export type WriteTransaction = z.infer<typeof transactionSchema>;

export interface CreatedBackup {
  readonly id: string;
  readonly manifest: BackupManifest;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function transactionFileName(transactionId: string): string {
  return `${transactionFilePrefix}${transactionId}${transactionFileSuffix}`;
}

export class RecoveryStore {
  readonly #pathPolicy: VaultPathPolicy;

  constructor(pathPolicy: VaultPathPolicy) {
    this.#pathPolicy = pathPolicy;
  }

  async #rootPath(): Promise<string> {
    return (await this.#pathPolicy.ensureBackupDirectory()).absolutePath;
  }

  async createBackup(
    notePath: string,
    content: Uint8Array,
  ): Promise<CreatedBackup> {
    const rootPath = await this.#rootPath();
    const backupId = randomUUID();
    const entryPath = path.join(
      rootPath,
      `${backupDirectoryPrefix}${backupId}`,
    );
    const rawContent = Buffer.from(content);
    const manifest = backupManifestSchema.parse({
      version: 1,
      backupId,
      notePath,
      revision: createNoteRevision(rawContent),
      byteSize: rawContent.byteLength,
      createdAt: new Date().toISOString(),
    });

    try {
      await mkdir(entryPath, { mode: 0o700 });
      await writeExclusiveFile(
        path.join(entryPath, "note.md"),
        rawContent,
        0o600,
      );
      await writeExclusiveFile(
        path.join(entryPath, "manifest.json"),
        Buffer.from(`${JSON.stringify(manifest, undefined, 2)}\n`, "utf8"),
        0o600,
      );
      await syncDirectory(entryPath);
      await syncDirectory(rootPath);
    } catch {
      throw new NoteWriterError("IO_ERROR");
    }

    return Object.freeze({ id: backupId, manifest: Object.freeze(manifest) });
  }

  async readBackup(backupId: string): Promise<{
    readonly manifest: BackupManifest;
    readonly content: Buffer;
  }> {
    const idResult = z.string().uuid().safeParse(backupId);
    if (!idResult.success) {
      throw new NoteWriterError("BACKUP_NOT_FOUND");
    }

    const rootPath = await this.#rootPath();
    const entryPath = path.join(
      rootPath,
      `${backupDirectoryPrefix}${idResult.data}`,
    );

    try {
      const entryStatus = await lstat(entryPath);
      if (entryStatus.isSymbolicLink() || !entryStatus.isDirectory()) {
        throw new NoteWriterError("BACKUP_NOT_FOUND");
      }

      const manifestStatus = await lstat(path.join(entryPath, "manifest.json"));
      const noteStatus = await lstat(path.join(entryPath, "note.md"));
      if (
        manifestStatus.isSymbolicLink() ||
        !manifestStatus.isFile() ||
        manifestStatus.nlink > 1 ||
        noteStatus.isSymbolicLink() ||
        !noteStatus.isFile() ||
        noteStatus.nlink > 1
      ) {
        throw new NoteWriterError("BACKUP_NOT_FOUND");
      }

      const manifest = backupManifestSchema.parse(
        JSON.parse(await readFile(path.join(entryPath, "manifest.json"), "utf8")),
      );
      const content = await readFile(path.join(entryPath, "note.md"));
      if (
        manifest.backupId !== idResult.data ||
        manifest.byteSize !== content.byteLength ||
        manifest.revision !== createNoteRevision(content)
      ) {
        throw new NoteWriterError("BACKUP_NOT_FOUND");
      }

      return Object.freeze({
        manifest: Object.freeze(manifest),
        content,
      });
    } catch (error: unknown) {
      if (error instanceof NoteWriterError) {
        throw error;
      }
      throw new NoteWriterError("BACKUP_NOT_FOUND");
    }
  }

  async createTransaction(transaction: WriteTransaction): Promise<void> {
    const parsed = transactionSchema.parse(transaction);
    const rootPath = await this.#rootPath();
    try {
      await writeExclusiveFile(
        path.join(rootPath, transactionFileName(parsed.transactionId)),
        Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8"),
        0o600,
      );
      await syncDirectory(rootPath);
    } catch {
      throw new NoteWriterError("IO_ERROR");
    }
  }

  async listTransactions(): Promise<readonly WriteTransaction[]> {
    const rootPath = await this.#rootPath();
    let entries;
    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      throw new NoteWriterError("IO_ERROR");
    }

    const transactions: WriteTransaction[] = [];
    for (const entry of entries) {
      if (
        !entry.name.startsWith(transactionFilePrefix) ||
        !entry.name.endsWith(transactionFileSuffix)
      ) {
        continue;
      }

      if (!entry.isFile()) {
        throw new NoteWriterError("RECOVERY_REQUIRED");
      }

      try {
        const parsed = transactionSchema.parse(
          JSON.parse(await readFile(path.join(rootPath, entry.name), "utf8")),
        );
        if (entry.name !== transactionFileName(parsed.transactionId)) {
          throw new NoteWriterError("RECOVERY_REQUIRED");
        }
        transactions.push(parsed);
      } catch (error: unknown) {
        if (error instanceof NoteWriterError) {
          throw error;
        }
        throw new NoteWriterError("RECOVERY_REQUIRED");
      }
    }

    transactions.sort((left, right) =>
      left.transactionId.localeCompare(right.transactionId, "en-US"),
    );
    return Object.freeze(transactions);
  }

  async removeTransaction(transactionId: string): Promise<void> {
    if (!z.string().uuid().safeParse(transactionId).success) {
      throw new NoteWriterError("RECOVERY_REQUIRED");
    }
    const rootPath = await this.#rootPath();
    try {
      await unlink(path.join(rootPath, transactionFileName(transactionId)));
      await syncDirectory(rootPath);
    } catch (error: unknown) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw new NoteWriterError("IO_ERROR");
      }
    }
  }

  async preserveCapturedFile(
    backupId: string,
    recoveryPath: string,
  ): Promise<void> {
    if (!z.string().uuid().safeParse(backupId).success) {
      throw new NoteWriterError("RECOVERY_REQUIRED");
    }
    const rootPath = await this.#rootPath();
    const entryPath = path.join(rootPath, `${backupDirectoryPrefix}${backupId}`);
    const capturedPath = path.join(entryPath, "captured.md");

    try {
      await link(recoveryPath, capturedPath);
      await unlink(recoveryPath);
      await syncDirectory(entryPath);
      await syncDirectory(path.dirname(recoveryPath));
    } catch (error: unknown) {
      if (hasErrorCode(error, "EEXIST")) {
        try {
          const [recoveryStatus, capturedStatus] = await Promise.all([
            lstat(recoveryPath, { bigint: true }),
            lstat(capturedPath, { bigint: true }),
          ]);
          if (
            recoveryStatus.isSymbolicLink() ||
            !recoveryStatus.isFile() ||
            capturedStatus.isSymbolicLink() ||
            !capturedStatus.isFile() ||
            recoveryStatus.dev !== capturedStatus.dev ||
            recoveryStatus.ino !== capturedStatus.ino
          ) {
            throw new NoteWriterError("RECOVERY_REQUIRED");
          }
          await unlink(recoveryPath);
          await syncDirectory(entryPath);
          await syncDirectory(path.dirname(recoveryPath));
          return;
        } catch (existingError: unknown) {
          if (existingError instanceof NoteWriterError) {
            throw existingError;
          }
          throw new NoteWriterError("RECOVERY_REQUIRED");
        }
      }

      if (!hasErrorCode(error, "ENOENT")) {
        throw new NoteWriterError("IO_ERROR");
      }

      try {
        const capturedStatus = await lstat(capturedPath);
        if (
          capturedStatus.isSymbolicLink() ||
          !capturedStatus.isFile() ||
          capturedStatus.nlink > 1
        ) {
          throw new NoteWriterError("RECOVERY_REQUIRED");
        }
      } catch (capturedError: unknown) {
        if (capturedError instanceof NoteWriterError) {
          throw capturedError;
        }
        throw new NoteWriterError("RECOVERY_REQUIRED");
      }
    }
  }
}
