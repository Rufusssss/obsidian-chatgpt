import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { createNoteRevision } from "./note-revision.ts";
import { NoteWriterError } from "./note-writer-errors.ts";
import {
  RecoveryStore,
  type CreateTransaction,
  type ModifyTransaction,
  type WriteTransaction,
} from "./recovery-store.ts";
import {
  syncDirectory,
  writeExclusiveFile,
} from "./safe-write-primitives.ts";
import {
  VaultPathError,
  type ResolvedNoteLocation,
  type VaultPathPolicy,
} from "./path-policy.ts";

const revisionPattern = /^sha256:[0-9a-f]{64}$/u;
const internalFilePattern = /^\.obsidian-chatgpt-[0-9a-f-]{36}\.(?:probe|recovery|stage)$/u;

export interface StableReadNote {
  readonly path: string;
  readonly content: string;
  readonly byteSize: number;
  readonly modifiedAt: string;
  readonly revision: string;
}

export interface CreatedNoteResult {
  readonly path: string;
  readonly byteSize: number;
  readonly modifiedAt: string;
  readonly revision: string;
}

export interface ModifiedNoteResult extends CreatedNoteResult {
  readonly previousRevision: string;
  readonly backupId?: string;
}

interface InternalFileSnapshot {
  readonly content: Buffer;
  readonly revision: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly links: bigint;
}

class AsyncMutex {
  #tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isNoClobberUnsupported(error: unknown): boolean {
  return ["EXDEV", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].some((code) =>
    hasErrorCode(error, code),
  );
}

function stagingName(transactionId: string): string {
  return `.obsidian-chatgpt-${transactionId}.stage`;
}

function recoveryName(transactionId: string): string {
  return `.obsidian-chatgpt-${transactionId}.recovery`;
}

function probeName(transactionId: string): string {
  return `.obsidian-chatgpt-${transactionId}.probe`;
}

function validateInternalName(
  name: string,
  expectedName: string,
): void {
  if (name !== expectedName || !internalFilePattern.test(name)) {
    throw new NoteWriterError("RECOVERY_REQUIRED");
  }
}

function assertRevision(revision: string): void {
  if (!revisionPattern.test(revision)) {
    throw new NoteWriterError("INVALID_REVISION");
  }
}

function encodeContent(content: string, maximumBytes: number): Buffer {
  if (typeof content !== "string") {
    throw new NoteWriterError("INVALID_ENCODING");
  }

  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > maximumBytes) {
    throw new NoteWriterError("NOTE_TOO_LARGE");
  }

  const roundTrip = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  if (roundTrip !== content) {
    throw new NoteWriterError("INVALID_ENCODING");
  }

  return bytes;
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function inspectInternalFile(
  filePath: string,
  maximumBytes: number,
): Promise<InternalFileSnapshot | undefined> {
  let fileHandle: FileHandle | undefined;
  try {
    const pathStatus = await lstat(filePath, { bigint: true });
    if (pathStatus.isSymbolicLink() || !pathStatus.isFile()) {
      throw new NoteWriterError("RECOVERY_REQUIRED");
    }
    if (pathStatus.size > BigInt(maximumBytes)) {
      throw new NoteWriterError("RECOVERY_REQUIRED");
    }

    fileHandle = await open(filePath, "r");
    const before = await fileHandle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.dev !== pathStatus.dev ||
      before.ino !== pathStatus.ino
    ) {
      throw new NoteWriterError("RECOVERY_REQUIRED");
    }

    const content = await fileHandle.readFile();
    const after = await fileHandle.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      content.byteLength !== Number(before.size)
    ) {
      throw new NoteWriterError("RECOVERY_REQUIRED");
    }

    return Object.freeze({
      content,
      revision: createNoteRevision(content),
      device: before.dev,
      inode: before.ino,
      links: before.nlink,
    });
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    if (error instanceof NoteWriterError) {
      throw error;
    }
    throw new NoteWriterError("IO_ERROR");
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

function sameIdentity(
  left: InternalFileSnapshot,
  right: InternalFileSnapshot,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export class NoteWriter {
  readonly #pathPolicy: VaultPathPolicy;
  readonly #maximumBytes: number;
  readonly #readNote: (requestedPath: string) => Promise<StableReadNote>;
  readonly #recoveryStore: RecoveryStore;
  readonly #writeMutex = new AsyncMutex();

  constructor(
    pathPolicy: VaultPathPolicy,
    maximumBytes: number,
    readNote: (requestedPath: string) => Promise<StableReadNote>,
  ) {
    this.#pathPolicy = pathPolicy;
    this.#maximumBytes = maximumBytes;
    this.#readNote = readNote;
    this.#recoveryStore = new RecoveryStore(pathPolicy);
  }

  async createNote(
    requestedPath: string,
    content: string,
  ): Promise<CreatedNoteResult> {
    return this.#writeMutex.run(async () => {
      await this.#recoverPendingTransactions();
      const bytes = encodeContent(content, this.#maximumBytes);
      const location = await this.#pathPolicy.resolveNoteLocation(
        requestedPath,
        { createParents: true },
      );
      await this.#pathPolicy.resolveNotePath(requestedPath, {
        expectation: "new",
      });

      const transactionId = randomUUID();
      const stageName = stagingName(transactionId);
      const stagePath = path.join(location.parentAbsolutePath, stageName);
      const transaction: CreateTransaction = {
        version: 1,
        operation: "create",
        transactionId,
        notePath: location.relativePath,
        intendedRevision: createNoteRevision(bytes),
        stagingName: stageName,
      };

      try {
        await writeExclusiveFile(stagePath, bytes, 0o666);
        await this.#probeNoClobber(location, stagePath, transactionId);
        await this.#recoveryStore.createTransaction(transaction);
        await this.#pathPolicy.resolveNotePath(requestedPath, {
          expectation: "new",
        });
        await link(stagePath, location.absolutePath);
      } catch (error: unknown) {
        await removeIfPresent(stagePath).catch(() => undefined);
        await this.#recoveryStore
          .removeTransaction(transactionId)
          .catch(() => undefined);
        if (error instanceof VaultPathError || error instanceof NoteWriterError) {
          throw error;
        }
        if (hasErrorCode(error, "EEXIST")) {
          throw new VaultPathError("NOTE_ALREADY_EXISTS");
        }
        if (isNoClobberUnsupported(error)) {
          throw new NoteWriterError("UNSAFE_FILESYSTEM");
        }
        throw new NoteWriterError("IO_ERROR");
      }

      try {
        await unlink(stagePath);
        await syncDirectory(location.parentAbsolutePath);
        await this.#recoveryStore.removeTransaction(transactionId);
      } catch {
        await this.#recoverTransaction(transaction);
      }

      return this.#createdResult(location, bytes);
    });
  }

  async appendToNote(
    requestedPath: string,
    content: string,
    expectedRevision?: string,
  ): Promise<ModifiedNoteResult> {
    if (expectedRevision !== undefined) {
      assertRevision(expectedRevision);
    }

    return this.#modifyNote(
      "append",
      requestedPath,
      expectedRevision,
      (currentBytes) => {
        const appendedBytes = encodeContent(content, this.#maximumBytes);
        const nextSize = currentBytes.byteLength + appendedBytes.byteLength;
        if (nextSize > this.#maximumBytes) {
          throw new NoteWriterError("NOTE_TOO_LARGE");
        }
        return Buffer.concat([currentBytes, appendedBytes], nextSize);
      },
    );
  }

  async updateNote(
    requestedPath: string,
    content: string,
    expectedRevision: string,
  ): Promise<ModifiedNoteResult> {
    assertRevision(expectedRevision);
    const replacement = encodeContent(content, this.#maximumBytes);
    return this.#modifyNote(
      "update",
      requestedPath,
      expectedRevision,
      () => replacement,
    );
  }

  async recoverBackup(
    backupId: string,
    expectedRevision: string,
  ): Promise<ModifiedNoteResult> {
    assertRevision(expectedRevision);
    const backup = await this.#recoveryStore.readBackup(backupId);
    let content;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(backup.content);
    } catch {
      throw new NoteWriterError("INVALID_ENCODING");
    }

    return this.updateNote(
      backup.manifest.notePath,
      content,
      expectedRevision,
    );
  }

  async #modifyNote(
    operation: "append" | "update",
    requestedPath: string,
    expectedRevision: string | undefined,
    createContent: (currentBytes: Buffer) => Buffer,
  ): Promise<ModifiedNoteResult> {
    return this.#writeMutex.run(async () => {
      await this.#recoverPendingTransactions();
      const current = await this.#readCurrent(requestedPath);
      if (
        expectedRevision !== undefined &&
        current.note.revision !== expectedRevision
      ) {
        throw new NoteWriterError("VERSION_CONFLICT");
      }

      const effectiveExpectedRevision = current.note.revision;
      const nextBytes = createContent(current.bytes);
      const intendedRevision = createNoteRevision(nextBytes);
      if (intendedRevision === effectiveExpectedRevision) {
        return Object.freeze({
          path: current.note.path,
          byteSize: current.note.byteSize,
          modifiedAt: current.note.modifiedAt,
          revision: current.note.revision,
          previousRevision: current.note.revision,
        });
      }

      const transactionId = randomUUID();
      const stageName = stagingName(transactionId);
      const capturedName = recoveryName(transactionId);
      const stagePath = path.join(current.location.parentAbsolutePath, stageName);
      const recoveryPath = path.join(
        current.location.parentAbsolutePath,
        capturedName,
      );
      const fileMode = current.mode & 0o777;

      try {
        await writeExclusiveFile(stagePath, nextBytes, fileMode);
        await this.#probeNoClobber(
          current.location,
          stagePath,
          transactionId,
        );
      } catch (error: unknown) {
        await removeIfPresent(stagePath).catch(() => undefined);
        if (error instanceof NoteWriterError) {
          throw error;
        }
        throw new NoteWriterError("IO_ERROR");
      }

      let backup;
      try {
        backup = await this.#recoveryStore.createBackup(
          current.note.path,
          current.bytes,
        );
      } catch (error: unknown) {
        await removeIfPresent(stagePath).catch(() => undefined);
        throw error;
      }

      const transaction: ModifyTransaction = {
        version: 1,
        operation,
        transactionId,
        notePath: current.note.path,
        expectedRevision: effectiveExpectedRevision,
        intendedRevision,
        backupId: backup.id,
        stagingName: stageName,
        recoveryName: capturedName,
      };

      try {
        await this.#recoveryStore.createTransaction(transaction);
        const latest = await this.#readCurrent(requestedPath);
        if (latest.note.revision !== effectiveExpectedRevision) {
          await removeIfPresent(stagePath).catch(() => undefined);
          await this.#recoveryStore
            .removeTransaction(transactionId)
            .catch(() => undefined);
          throw new NoteWriterError("VERSION_CONFLICT");
        }
        await this.#pathPolicy.resolveNotePath(requestedPath);
        await rename(latest.location.absolutePath, recoveryPath);
      } catch (error: unknown) {
        const recovery = await inspectInternalFile(
          recoveryPath,
          this.#maximumBytes,
        ).catch(() => undefined);
        if (recovery === undefined) {
          await removeIfPresent(stagePath).catch(() => undefined);
          await this.#recoveryStore
            .removeTransaction(transactionId)
            .catch(() => undefined);
        }
        if (error instanceof VaultPathError || error instanceof NoteWriterError) {
          throw error;
        }
        throw new NoteWriterError("IO_ERROR");
      }

      const captured = await inspectInternalFile(
        recoveryPath,
        this.#maximumBytes,
      );
      if (
        captured === undefined ||
        captured.revision !== effectiveExpectedRevision
      ) {
        await this.#restoreCapturedOrRequireRecovery(transaction, recoveryPath);
        throw new NoteWriterError("VERSION_CONFLICT");
      }

      try {
        await link(stagePath, current.location.absolutePath);
      } catch (error: unknown) {
        await this.#restoreCapturedOrRequireRecovery(transaction, recoveryPath);
        if (hasErrorCode(error, "EEXIST")) {
          throw new NoteWriterError("VERSION_CONFLICT");
        }
        if (isNoClobberUnsupported(error)) {
          throw new NoteWriterError("UNSAFE_FILESYSTEM");
        }
        throw new NoteWriterError("IO_ERROR");
      }

      try {
        await unlink(stagePath);
        await syncDirectory(current.location.parentAbsolutePath);
        await this.#recoveryStore.preserveCapturedFile(
          backup.id,
          recoveryPath,
        );
        await this.#recoveryStore.removeTransaction(transactionId);
      } catch {
        await this.#recoverTransaction(transaction);
      }

      return Object.freeze({
        ...(await this.#createdResult(current.location, nextBytes)),
        previousRevision: effectiveExpectedRevision,
        backupId: backup.id,
      });
    });
  }

  async #readCurrent(requestedPath: string): Promise<{
    readonly note: StableReadNote;
    readonly bytes: Buffer;
    readonly location: ResolvedNoteLocation;
    readonly mode: number;
  }> {
    const note = await this.#readNote(requestedPath);
    const bytes = encodeContent(note.content, this.#maximumBytes);
    if (
      note.byteSize !== bytes.byteLength ||
      note.revision !== createNoteRevision(bytes)
    ) {
      throw new NoteWriterError("IO_ERROR");
    }

    const resolved = await this.#pathPolicy.resolveNotePath(requestedPath);
    const location = await this.#pathPolicy.resolveNoteLocation(requestedPath);
    if (resolved.absolutePath !== location.absolutePath) {
      throw new NoteWriterError("VERSION_CONFLICT");
    }

    try {
      const status = await lstat(resolved.absolutePath);
      if (status.isSymbolicLink() || !status.isFile() || status.nlink > 1) {
        throw new NoteWriterError("VERSION_CONFLICT");
      }
      return Object.freeze({ note, bytes, location, mode: status.mode });
    } catch (error: unknown) {
      if (error instanceof NoteWriterError) {
        throw error;
      }
      throw new NoteWriterError("IO_ERROR");
    }
  }

  async #probeNoClobber(
    location: ResolvedNoteLocation,
    stagePath: string,
    transactionId: string,
  ): Promise<void> {
    const probePath = path.join(
      location.parentAbsolutePath,
      probeName(transactionId),
    );
    try {
      await link(stagePath, probePath);
      await unlink(probePath);
      await syncDirectory(location.parentAbsolutePath);
    } catch (error: unknown) {
      await removeIfPresent(probePath).catch(() => undefined);
      if (isNoClobberUnsupported(error)) {
        throw new NoteWriterError("UNSAFE_FILESYSTEM");
      }
      throw new NoteWriterError("IO_ERROR");
    }
  }

  async #createdResult(
    location: ResolvedNoteLocation,
    content: Buffer,
  ): Promise<CreatedNoteResult> {
    try {
      const fileStatus = await stat(location.absolutePath);
      return Object.freeze({
        path: location.relativePath,
        byteSize: content.byteLength,
        modifiedAt: fileStatus.mtime.toISOString(),
        revision: createNoteRevision(content),
      });
    } catch {
      throw new NoteWriterError("IO_ERROR");
    }
  }

  async #restoreCapturedOrRequireRecovery(
    transaction: ModifyTransaction,
    recoveryPath: string,
  ): Promise<void> {
    const location = await this.#pathPolicy.resolveNoteLocation(
      transaction.notePath,
    );
    try {
      await link(recoveryPath, location.absolutePath);
      await unlink(recoveryPath);
      await removeIfPresent(
        path.join(location.parentAbsolutePath, transaction.stagingName),
      );
      await this.#recoveryStore.removeTransaction(transaction.transactionId);
      await syncDirectory(location.parentAbsolutePath);
    } catch {
      throw new NoteWriterError("RECOVERY_REQUIRED");
    }
  }

  async #recoverPendingTransactions(): Promise<void> {
    const transactions = await this.#recoveryStore.listTransactions();
    for (const transaction of transactions) {
      await this.#recoverTransaction(transaction);
    }
  }

  async #recoverTransaction(transaction: WriteTransaction): Promise<void> {
    const location = await this.#pathPolicy.resolveNoteLocation(
      transaction.notePath,
    );
    validateInternalName(
      transaction.stagingName,
      stagingName(transaction.transactionId),
    );
    const stagePath = path.join(
      location.parentAbsolutePath,
      transaction.stagingName,
    );
    const target = await inspectInternalFile(
      location.absolutePath,
      this.#maximumBytes,
    );
    const stage = await inspectInternalFile(stagePath, this.#maximumBytes);

    if (transaction.operation === "create") {
      if (
        target?.revision === transaction.intendedRevision &&
        ((stage !== undefined &&
          (!sameIdentity(target, stage) ||
            target.links !== 2n ||
            stage.links !== 2n)) ||
          (stage === undefined && target.links !== 1n))
      ) {
        throw new NoteWriterError("RECOVERY_REQUIRED");
      }

      await removeIfPresent(stagePath).catch(() => undefined);
      await this.#recoveryStore.removeTransaction(transaction.transactionId);
      await syncDirectory(location.parentAbsolutePath);
      return;
    }

    validateInternalName(
      transaction.recoveryName,
      recoveryName(transaction.transactionId),
    );
    const recoveryPath = path.join(
      location.parentAbsolutePath,
      transaction.recoveryName,
    );
    const recovery = await inspectInternalFile(
      recoveryPath,
      this.#maximumBytes,
    );
    const backup = await this.#recoveryStore.readBackup(transaction.backupId);
    if (
      backup.manifest.notePath !== transaction.notePath ||
      backup.manifest.revision !== transaction.expectedRevision
    ) {
      throw new NoteWriterError("RECOVERY_REQUIRED");
    }

    if (target?.revision === transaction.intendedRevision) {
      if (
        (stage !== undefined &&
          (stage.revision !== transaction.intendedRevision ||
            !sameIdentity(target, stage) ||
            target.links !== 2n ||
            stage.links !== 2n)) ||
        (stage === undefined && target.links !== 1n)
      ) {
        throw new NoteWriterError("RECOVERY_REQUIRED");
      }
      await removeIfPresent(stagePath).catch(() => undefined);
      if (recovery !== undefined) {
        await this.#recoveryStore.preserveCapturedFile(
          transaction.backupId,
          recoveryPath,
        );
      }
      await this.#recoveryStore.removeTransaction(transaction.transactionId);
      await syncDirectory(location.parentAbsolutePath);
      return;
    }

    if (
      target?.revision === transaction.expectedRevision &&
      target.links === 1n &&
      recovery === undefined
    ) {
      await removeIfPresent(stagePath).catch(() => undefined);
      await this.#recoveryStore.removeTransaction(transaction.transactionId);
      await syncDirectory(location.parentAbsolutePath);
      return;
    }

    if (target === undefined && recovery?.revision === transaction.expectedRevision) {
      await this.#restoreCapturedOrRequireRecovery(transaction, recoveryPath);
      return;
    }

    if (target === undefined && recovery === undefined) {
      try {
        await writeExclusiveFile(location.absolutePath, backup.content, 0o600);
        await removeIfPresent(stagePath).catch(() => undefined);
        await this.#recoveryStore.removeTransaction(transaction.transactionId);
        await syncDirectory(location.parentAbsolutePath);
        return;
      } catch {
        throw new NoteWriterError("RECOVERY_REQUIRED");
      }
    }

    throw new NoteWriterError("RECOVERY_REQUIRED");
  }
}
