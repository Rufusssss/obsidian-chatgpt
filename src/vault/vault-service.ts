import type { BigIntStats } from "node:fs";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { createNoteRevision } from "./note-revision.ts";
import {
  parseObsidianMetadata,
  type FrontmatterMetadata,
  type NoteHeading,
} from "./obsidian-metadata.ts";
import {
  VaultLinkResolver,
  type ResolvedOutgoingLink,
} from "./wikilink-resolver.ts";
import {
  NoteWriter,
  type CreatedNoteResult,
  type ModifiedNoteResult,
} from "./note-writer.ts";
import { NoteWriterError } from "./note-writer-errors.ts";
import {
  createSearchNoteResult,
  prepareSearchQuery,
  type SearchNoteResult,
  type SearchScope,
} from "./note-search.ts";
import {
  VaultPathError,
  type VaultPathPolicy,
} from "./path-policy.ts";

const defaultMaxNoteBytes = 1_048_576;
const defaultMaxListedNotes = 10_000;
const defaultMaxSearchFiles = 2_000;
const defaultMaxSearchBytes = 20 * 1_048_576;
const defaultSearchLimit = 20;
const maximumSearchLimit = 50;
const defaultMaxSnippetCodePoints = 320;
const streamChunkBytes = 64 * 1_024;
const defaultBacklinkLimit = 50;
const maximumBacklinkLimit = 100;
const maximumIndexedLinksPerNote = 1_000;

const vaultServiceErrorMessages = {
  INVALID_OPTIONS: "The vault service configuration is invalid.",
  INVALID_QUERY: "The search query must contain between 1 and 256 characters.",
  INVALID_LIMIT: "The result limit is outside the allowed range.",
  NOTE_TOO_LARGE: "The requested note exceeds the configured read size limit.",
  INVALID_ENCODING: "The requested note is not valid UTF-8.",
  NOTE_CHANGED_DURING_READ:
    "The requested note changed while it was being read; retry the read.",
  INVALID_REVISION: "The expected note revision is invalid.",
  VERSION_CONFLICT:
    "The note changed since the expected revision was observed; read it again before writing.",
  UNSAFE_FILESYSTEM:
    "The filesystem cannot provide the no-clobber operation required for a safe write.",
  RECOVERY_REQUIRED:
    "An incomplete or ambiguous write transaction requires local recovery before more writes.",
  BACKUP_NOT_FOUND: "The requested recovery backup does not exist or is invalid.",
  LIST_LIMIT_REACHED:
    "The vault contains more notes than the configured listing limit.",
  SEARCH_LIMIT_REACHED:
    "The search exceeded its configured file or byte work limit; narrow the query.",
  IO_ERROR: "The vault operation failed because of a filesystem error.",
} as const;

export type VaultServiceErrorCode = keyof typeof vaultServiceErrorMessages;

export interface ModelFacingVaultServiceError {
  readonly code: VaultServiceErrorCode;
  readonly message: string;
}

export class VaultServiceError extends Error {
  override readonly name = "VaultServiceError";
  readonly code: VaultServiceErrorCode;

  constructor(code: VaultServiceErrorCode) {
    super(vaultServiceErrorMessages[code]);
    this.code = code;
  }

  toModelError(): ModelFacingVaultServiceError {
    return Object.freeze({ code: this.code, message: this.message });
  }
}

export interface ObsidianVaultServiceOptions {
  readonly maxNoteBytes?: number;
  readonly maxListedNotes?: number;
  readonly maxSearchFiles?: number;
  readonly maxSearchBytes?: number;
  readonly maxSnippetCodePoints?: number;
}

export interface ReadNoteResult {
  readonly path: string;
  readonly content: string;
  readonly byteSize: number;
  readonly modifiedAt: string;
  readonly revision: string;
}

export interface SearchNotesOptions {
  readonly limit?: number;
  readonly caseSensitive?: boolean;
  readonly folder?: string;
  readonly scope?: SearchScope;
}

export interface ListNotesOptions {
  readonly folder?: string;
  readonly recursive?: boolean;
}

export interface NoteMetadataResult {
  readonly path: string;
  readonly revision: string;
  readonly frontmatter: FrontmatterMetadata;
  readonly tags: readonly string[];
  readonly headings: readonly NoteHeading[];
  readonly outgoingLinks: readonly ResolvedOutgoingLink[];
  readonly incomplete: boolean;
}

export interface BacklinkReference {
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly line: number;
  readonly target: string;
  readonly alias?: string;
}

export interface GetBacklinksOptions {
  readonly limit?: number;
}

export interface BacklinksResult {
  readonly path: string;
  readonly revision: string;
  readonly backlinks: readonly BacklinkReference[];
  readonly totalMatches: number;
  readonly truncated: boolean;
  readonly scanIncomplete: boolean;
}

export type { SearchNoteResult } from "./note-search.ts";
export type { CreatedNoteResult, ModifiedNoteResult } from "./note-writer.ts";

interface ServiceLimits {
  readonly maxNoteBytes: number;
  readonly maxListedNotes: number;
  readonly maxSearchFiles: number;
  readonly maxSearchBytes: number;
  readonly maxSnippetCodePoints: number;
}

interface NoteSnapshot {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedNanoseconds: bigint;
  readonly changedNanoseconds: bigint;
}

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VaultServiceError("INVALID_OPTIONS");
  }
}

function createLimits(options: ObsidianVaultServiceOptions): ServiceLimits {
  const limits = {
    maxNoteBytes: options.maxNoteBytes ?? defaultMaxNoteBytes,
    maxListedNotes: options.maxListedNotes ?? defaultMaxListedNotes,
    maxSearchFiles: options.maxSearchFiles ?? defaultMaxSearchFiles,
    maxSearchBytes: options.maxSearchBytes ?? defaultMaxSearchBytes,
    maxSnippetCodePoints:
      options.maxSnippetCodePoints ?? defaultMaxSnippetCodePoints,
  } satisfies ServiceLimits;

  for (const value of Object.values(limits)) {
    assertPositiveInteger(value);
  }

  if (limits.maxSnippetCodePoints > defaultMaxSnippetCodePoints) {
    throw new VaultServiceError("INVALID_OPTIONS");
  }

  return Object.freeze(limits);
}

function comparePaths(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function isFilesystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isInvisibleEnumerationError(error: unknown): boolean {
  return error instanceof VaultPathError && error.code !== "FILESYSTEM_ERROR";
}

function captureSnapshot(
  fileStatus: BigIntStats,
): NoteSnapshot {
  return Object.freeze({
    device: BigInt(fileStatus.dev),
    inode: BigInt(fileStatus.ino),
    size: BigInt(fileStatus.size),
    modifiedNanoseconds: BigInt(fileStatus.mtimeNs),
    changedNanoseconds: BigInt(fileStatus.ctimeNs),
  });
}

function hasSameIdentity(left: NoteSnapshot, right: NoteSnapshot): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function hasSameSnapshot(left: NoteSnapshot, right: NoteSnapshot): boolean {
  return (
    hasSameIdentity(left, right) &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.changedNanoseconds === right.changedNanoseconds
  );
}

export class ObsidianVaultService {
  readonly #pathPolicy: VaultPathPolicy;
  readonly #limits: ServiceLimits;
  readonly #noteWriter: NoteWriter;

  constructor(
    pathPolicy: VaultPathPolicy,
    options: ObsidianVaultServiceOptions = {},
  ) {
    this.#pathPolicy = pathPolicy;
    this.#limits = createLimits(options);
    this.#noteWriter = new NoteWriter(
      pathPolicy,
      this.#limits.maxNoteBytes,
      async (requestedPath) => this.readNote(requestedPath),
    );
  }

  async listNotes(
    options: ListNotesOptions = {},
  ): Promise<readonly string[]> {
    const notes: string[] = [];
    const directories = [options.folder ?? ""];
    const recursive = options.recursive ?? true;

    while (directories.length > 0) {
      const relativeDirectory = directories.pop();
      if (relativeDirectory === undefined) {
        break;
      }

      const resolvedDirectory = await this.#pathPolicy.resolveDirectoryPath(
        relativeDirectory,
      );
      let entries;
      try {
        entries = await readdir(resolvedDirectory.absolutePath, {
          withFileTypes: true,
        });
      } catch {
        throw new VaultServiceError("IO_ERROR");
      }

      entries.sort((left, right) => comparePaths(left.name, right.name));
      const childDirectories: string[] = [];

      for (const entry of entries) {
        const relativePath =
          relativeDirectory.length === 0
            ? entry.name
            : `${relativeDirectory}/${entry.name}`;

        if (entry.isDirectory()) {
          try {
            const child = await this.#pathPolicy.resolveDirectoryPath(relativePath);
            childDirectories.push(child.relativePath);
          } catch (error: unknown) {
            if (!isInvisibleEnumerationError(error)) {
              throw new VaultServiceError("IO_ERROR");
            }
          }
          continue;
        }

        if (!entry.isFile() || path.posix.extname(entry.name).toLowerCase() !== ".md") {
          continue;
        }

        try {
          const note = await this.#pathPolicy.resolveNotePath(relativePath);
          notes.push(note.relativePath);
          if (notes.length > this.#limits.maxListedNotes) {
            throw new VaultServiceError("LIST_LIMIT_REACHED");
          }
        } catch (error: unknown) {
          if (error instanceof VaultServiceError) {
            throw error;
          }

          if (!isInvisibleEnumerationError(error)) {
            throw new VaultServiceError("IO_ERROR");
          }
        }
      }

      if (!recursive) {
        continue;
      }

      for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
        const childDirectory = childDirectories[index];
        if (childDirectory !== undefined) {
          directories.push(childDirectory);
        }
      }
    }

    notes.sort(comparePaths);
    return Object.freeze(notes);
  }

  async readNote(requestedPath: string): Promise<ReadNoteResult> {
    return this.#readNoteWithinLimit(requestedPath, this.#limits.maxNoteBytes);
  }

  async getNoteMetadata(requestedPath: string): Promise<NoteMetadataResult> {
    const note = await this.readNote(requestedPath);
    const notePaths = await this.listNotes();
    const resolver = new VaultLinkResolver(notePaths);
    const parsed = parseObsidianMetadata(note.content);
    const outgoingLinks = parsed.outgoingLinks.map((link) =>
      resolver.resolve(note.path, link),
    );

    return Object.freeze({
      path: note.path,
      revision: note.revision,
      frontmatter: parsed.frontmatter,
      tags: parsed.tags,
      headings: parsed.headings,
      outgoingLinks: Object.freeze(outgoingLinks),
      incomplete: parsed.incomplete,
    });
  }

  async getBacklinks(
    requestedPath: string,
    options: GetBacklinksOptions = {},
  ): Promise<BacklinksResult> {
    const limit = options.limit ?? defaultBacklinkLimit;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > maximumBacklinkLimit
    ) {
      throw new VaultServiceError("INVALID_LIMIT");
    }

    const target = await this.readNote(requestedPath);
    const notePaths = await this.listNotes();
    if (notePaths.length > this.#limits.maxSearchFiles) {
      throw new VaultServiceError("SEARCH_LIMIT_REACHED");
    }

    const resolver = new VaultLinkResolver(notePaths);
    const backlinks: BacklinkReference[] = [];
    let totalMatches = 0;
    let scannedBytes = 0;
    let scanIncomplete = false;

    for (const sourcePath of notePaths) {
      const remainingBytes = this.#limits.maxSearchBytes - scannedBytes;
      if (remainingBytes < 1) {
        throw new VaultServiceError("SEARCH_LIMIT_REACHED");
      }

      let source: ReadNoteResult;
      try {
        source = await this.#readNoteWithinLimit(
          sourcePath,
          Math.min(this.#limits.maxNoteBytes, remainingBytes),
        );
      } catch (error: unknown) {
        if (
          error instanceof VaultServiceError &&
          error.code === "NOTE_TOO_LARGE"
        ) {
          throw new VaultServiceError("SEARCH_LIMIT_REACHED");
        }
        throw error;
      }
      scannedBytes += source.byteSize;

      const parsed = parseObsidianMetadata(source.content, {
        maxOutgoingLinks: maximumIndexedLinksPerNote,
      });
      scanIncomplete = parsed.outgoingLinksTruncated || scanIncomplete;
      for (const link of parsed.outgoingLinks) {
        const resolved = resolver.resolve(source.path, link);
        if (resolved.resolvedPath !== target.path) {
          continue;
        }

        totalMatches += 1;
        if (backlinks.length < limit) {
          backlinks.push(
            Object.freeze({
              sourcePath: source.path,
              sourceRevision: source.revision,
              line: link.line,
              target: link.target,
              ...(link.alias === undefined ? {} : { alias: link.alias }),
            }),
          );
        }
      }
    }

    return Object.freeze({
      path: target.path,
      revision: target.revision,
      backlinks: Object.freeze(backlinks),
      totalMatches,
      truncated: totalMatches > backlinks.length,
      scanIncomplete,
    });
  }

  async createNote(
    requestedPath: string,
    content: string,
  ): Promise<CreatedNoteResult> {
    return this.#runWriteOperation(
      this.#noteWriter.createNote(requestedPath, content),
    );
  }

  async appendToNote(
    requestedPath: string,
    content: string,
    expectedRevision?: string,
  ): Promise<ModifiedNoteResult> {
    return this.#runWriteOperation(
      this.#noteWriter.appendToNote(
        requestedPath,
        content,
        expectedRevision,
      ),
    );
  }

  async updateNote(
    requestedPath: string,
    content: string,
    expectedRevision: string,
  ): Promise<ModifiedNoteResult> {
    return this.#runWriteOperation(
      this.#noteWriter.updateNote(
        requestedPath,
        content,
        expectedRevision,
      ),
    );
  }

  async recoverBackup(
    backupId: string,
    expectedRevision: string,
  ): Promise<ModifiedNoteResult> {
    return this.#runWriteOperation(
      this.#noteWriter.recoverBackup(backupId, expectedRevision),
    );
  }

  async #runWriteOperation<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error: unknown) {
      if (error instanceof NoteWriterError) {
        throw new VaultServiceError(error.code);
      }
      throw error;
    }
  }

  async #readNoteWithinLimit(
    requestedPath: string,
    maximumBytes: number,
  ): Promise<ReadNoteResult> {
    const initiallyResolved = await this.#pathPolicy.resolveNotePath(
      requestedPath,
    );
    let fileHandle: FileHandle;

    try {
      fileHandle = await open(initiallyResolved.absolutePath, "r");
    } catch (error: unknown) {
      if (isFilesystemError(error, "ENOENT")) {
        await this.#pathPolicy.resolveNotePath(requestedPath);
      }
      throw new VaultServiceError("IO_ERROR");
    }

    try {
      const resolvedBeforeRead = await this.#pathPolicy.resolveNotePath(
        requestedPath,
      );
      const openedStatus = await fileHandle.stat({ bigint: true });
      const pathStatus = await stat(resolvedBeforeRead.absolutePath, {
        bigint: true,
      });
      const openedSnapshot = captureSnapshot(openedStatus);
      const pathSnapshot = captureSnapshot(pathStatus);

      if (
        resolvedBeforeRead.absolutePath !== initiallyResolved.absolutePath ||
        !openedStatus.isFile() ||
        openedStatus.nlink > 1n ||
        !hasSameIdentity(openedSnapshot, pathSnapshot)
      ) {
        throw new VaultServiceError("NOTE_CHANGED_DURING_READ");
      }

      if (openedSnapshot.size > BigInt(maximumBytes)) {
        throw new VaultServiceError("NOTE_TOO_LARGE");
      }

      const chunks: Buffer[] = [];
      let byteSize = 0;
      const stream = fileHandle.createReadStream({
        autoClose: false,
        highWaterMark: streamChunkBytes,
        start: 0,
      });

      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteSize += bytes.byteLength;
        if (byteSize > maximumBytes) {
          throw new VaultServiceError("NOTE_TOO_LARGE");
        }
        chunks.push(bytes);
      }

      const statusAfterRead = await fileHandle.stat({ bigint: true });
      const snapshotAfterRead = captureSnapshot(statusAfterRead);
      if (!hasSameSnapshot(openedSnapshot, snapshotAfterRead)) {
        throw new VaultServiceError("NOTE_CHANGED_DURING_READ");
      }

      const resolvedAfterRead = await this.#pathPolicy.resolveNotePath(
        requestedPath,
      );
      const pathStatusAfterRead = await stat(resolvedAfterRead.absolutePath, {
        bigint: true,
      });
      const pathSnapshotAfterRead = captureSnapshot(pathStatusAfterRead);
      if (
        resolvedAfterRead.absolutePath !== resolvedBeforeRead.absolutePath ||
        !hasSameSnapshot(openedSnapshot, pathSnapshotAfterRead)
      ) {
        throw new VaultServiceError("NOTE_CHANGED_DURING_READ");
      }

      const rawContent = Buffer.concat(chunks, byteSize);
      let content: string;
      try {
        content = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(rawContent);
      } catch {
        throw new VaultServiceError("INVALID_ENCODING");
      }

      return Object.freeze({
        path: resolvedAfterRead.relativePath,
        content,
        byteSize,
        modifiedAt: new Date(
          Number(openedSnapshot.modifiedNanoseconds / 1_000_000n),
        ).toISOString(),
        revision: createNoteRevision(rawContent),
      });
    } catch (error: unknown) {
      if (error instanceof VaultPathError || error instanceof VaultServiceError) {
        throw error;
      }

      throw new VaultServiceError("IO_ERROR");
    } finally {
      await fileHandle.close().catch(() => undefined);
    }
  }

  async searchNotes(
    query: string,
    options: SearchNotesOptions = {},
  ): Promise<readonly SearchNoteResult[]> {
    const trimmedQuery = query.trim();
    if (
      trimmedQuery.length === 0 ||
      Array.from(trimmedQuery).length > 256
    ) {
      throw new VaultServiceError("INVALID_QUERY");
    }

    const limit = options.limit ?? defaultSearchLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumSearchLimit) {
      throw new VaultServiceError("INVALID_LIMIT");
    }

    const caseSensitive = options.caseSensitive ?? false;
    const preparedQuery = prepareSearchQuery(
      trimmedQuery,
      caseSensitive,
      options.scope ?? "both",
    );
    const notePaths = await this.listNotes(
      options.folder === undefined ? {} : { folder: options.folder },
    );
    if (notePaths.length > this.#limits.maxSearchFiles) {
      throw new VaultServiceError("SEARCH_LIMIT_REACHED");
    }

    const matches: SearchNoteResult[] = [];
    let scannedBytes = 0;

    for (const notePath of notePaths) {
      const remainingSearchBytes = this.#limits.maxSearchBytes - scannedBytes;
      if (remainingSearchBytes < 1) {
        throw new VaultServiceError("SEARCH_LIMIT_REACHED");
      }

      let note: ReadNoteResult;
      try {
        note = await this.#readNoteWithinLimit(
          notePath,
          Math.min(this.#limits.maxNoteBytes, remainingSearchBytes),
        );
      } catch (error: unknown) {
        if (
          error instanceof VaultServiceError &&
          error.code === "NOTE_TOO_LARGE"
        ) {
          throw new VaultServiceError("SEARCH_LIMIT_REACHED");
        }
        throw error;
      }
      scannedBytes += note.byteSize;

      const match = createSearchNoteResult(
        note.path,
        note.content,
        preparedQuery,
        this.#limits.maxSnippetCodePoints,
      );

      if (match === undefined) {
        continue;
      }

      matches.push(match);
    }

    matches.sort(
      (left, right) =>
        right.score - left.score || comparePaths(left.path, right.path),
    );
    return Object.freeze(matches.slice(0, limit));
  }
}
