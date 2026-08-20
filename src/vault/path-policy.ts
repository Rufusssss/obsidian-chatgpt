import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

const defaultBackupDirectory = ".obsidian-chatgpt/backups";
const deniedDirectoryNames = new Set([".obsidian", ".trash"]);
const encodedBytePattern = /%[0-9a-f]{2}/iu;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/u;
const windowsDeviceNamePattern =
  /^(?:aux|clock\$|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/iu;

const vaultPathErrorMessages = {
  INVALID_VAULT_ROOT:
    "The configured vault root must be an existing directory and cannot be a symbolic link.",
  INVALID_POLICY_CONFIGURATION:
    "The vault path policy configuration is invalid.",
  EMPTY_PATH: "A note path is required.",
  ABSOLUTE_PATH:
    "Note paths must be relative to the configured Obsidian vault.",
  PATH_TRAVERSAL: "Note paths cannot contain parent traversal segments.",
  INVALID_SEPARATOR: "Note paths must use forward slashes as separators.",
  ENCODED_PATH:
    "Percent-encoded path forms are not accepted; provide a plain vault-relative path.",
  INVALID_CHARACTERS: "The note path contains unsupported characters.",
  INVALID_SEGMENT: "The note path contains an invalid path segment.",
  PATH_TOO_LONG: "The note path exceeds the allowed length.",
  RESERVED_NAME: "The note path contains a reserved filesystem name.",
  DENIED_DIRECTORY:
    "The requested note is inside a hidden or reserved vault directory.",
  NOT_MARKDOWN: "Only Markdown files with a .md extension are available.",
  PATH_OUTSIDE_VAULT:
    "The requested note does not resolve inside the configured vault.",
  SYMLINK_NOT_ALLOWED:
    "The requested note path crosses a symbolic link or junction, which is not allowed.",
  HARD_LINK_NOT_ALLOWED:
    "The requested note is hard-linked and cannot be accessed safely.",
  PATH_COMPONENT_NOT_DIRECTORY:
    "A parent component of the requested note is not a directory.",
  NOTE_TARGET_NOT_FILE: "The requested note target is not a regular file.",
  DIRECTORY_NOT_FOUND: "The requested vault directory does not exist.",
  DIRECTORY_TARGET_NOT_DIRECTORY:
    "The requested vault directory target is not a directory.",
  NOTE_NOT_FOUND: "The requested Markdown note does not exist.",
  NOTE_ALREADY_EXISTS: "A note already exists at the requested path.",
  FILESYSTEM_ERROR:
    "The note path could not be validated because of a filesystem error.",
} as const;

export type VaultPathErrorCode = keyof typeof vaultPathErrorMessages;
export type NotePathExpectation = "existing" | "new" | "either";

export interface VaultPathPolicyConfiguration {
  readonly vaultPath: string;
  readonly backupDir?: string;
}

export interface ResolveNotePathOptions {
  readonly expectation?: NotePathExpectation;
}

export interface ResolvedNotePath {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly exists: boolean;
}

export interface ResolvedNoteLocation {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly parentAbsolutePath: string;
}

export interface ResolvedVaultDirectory {
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface ResolveNoteLocationOptions {
  readonly createParents?: boolean;
}

export interface ModelFacingPathError {
  readonly code: VaultPathErrorCode;
  readonly message: string;
}

export class VaultPathError extends Error {
  override readonly name = "VaultPathError";
  readonly code: VaultPathErrorCode;

  constructor(code: VaultPathErrorCode) {
    super(vaultPathErrorMessages[code]);
    this.code = code;
  }

  toModelError(): ModelFacingPathError {
    return Object.freeze({
      code: this.code,
      message: this.message,
    });
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isContainedBy(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (!path.isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`))
  );
}

function validateInternalDirectory(directory: string): readonly string[] {
  if (
    directory.length === 0 ||
    path.isAbsolute(directory) ||
    path.posix.isAbsolute(directory) ||
    path.win32.isAbsolute(directory) ||
    directory.includes("\\") ||
    controlCharacterPattern.test(directory) ||
    directory.includes(":") ||
    encodedBytePattern.test(directory)
  ) {
    throw new VaultPathError("INVALID_POLICY_CONFIGURATION");
  }

  const segments = directory.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        Array.from(segment).length > 255 ||
        windowsDeviceNamePattern.test(segment),
    )
  ) {
    throw new VaultPathError("INVALID_POLICY_CONFIGURATION");
  }

  return Object.freeze(segments);
}

function beginsWithSegments(
  candidate: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    candidate.length >= prefix.length &&
    prefix.every(
      (segment, index) =>
        candidate[index]?.toLocaleLowerCase("en-US") ===
        segment.toLocaleLowerCase("en-US"),
    )
  );
}

function validateToolFacingNotePath(
  requestedPath: string,
  backupSegments: readonly string[],
): readonly string[] {
  if (requestedPath.length === 0) {
    throw new VaultPathError("EMPTY_PATH");
  }

  if (requestedPath.length > 2_048 || Array.from(requestedPath).length > 1_024) {
    throw new VaultPathError("PATH_TOO_LONG");
  }

  if (
    path.isAbsolute(requestedPath) ||
    path.posix.isAbsolute(requestedPath) ||
    path.win32.isAbsolute(requestedPath) ||
    /^[a-z]:/iu.test(requestedPath)
  ) {
    throw new VaultPathError("ABSOLUTE_PATH");
  }

  if (requestedPath.includes("\\")) {
    throw new VaultPathError("INVALID_SEPARATOR");
  }

  if (encodedBytePattern.test(requestedPath)) {
    throw new VaultPathError("ENCODED_PATH");
  }

  if (
    controlCharacterPattern.test(requestedPath) ||
    requestedPath.includes(":")
  ) {
    throw new VaultPathError("INVALID_CHARACTERS");
  }

  const segments = requestedPath.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new VaultPathError("PATH_TRAVERSAL");
    }

    if (
      segment.length === 0 ||
      segment === "." ||
      segment.endsWith(".") ||
      segment.endsWith(" ")
    ) {
      throw new VaultPathError("INVALID_SEGMENT");
    }

    if (Array.from(segment).length > 255) {
      throw new VaultPathError("PATH_TOO_LONG");
    }

    if (windowsDeviceNamePattern.test(segment)) {
      throw new VaultPathError("RESERVED_NAME");
    }
  }

  const directorySegments = segments.slice(0, -1);
  if (
    directorySegments.some((segment) => {
      const normalizedSegment = segment.toLocaleLowerCase("en-US");
      return (
        segment.startsWith(".") || deniedDirectoryNames.has(normalizedSegment)
      );
    }) ||
    beginsWithSegments(segments, backupSegments)
  ) {
    throw new VaultPathError("DENIED_DIRECTORY");
  }

  const fileName = segments.at(-1);
  if (fileName === undefined || path.posix.extname(fileName).toLowerCase() !== ".md") {
    throw new VaultPathError("NOT_MARKDOWN");
  }

  return Object.freeze(segments);
}

function validateToolFacingDirectoryPath(
  requestedPath: string,
  backupSegments: readonly string[],
): readonly string[] {
  if (requestedPath.length === 0) {
    return Object.freeze([]);
  }

  if (requestedPath.length > 2_048 || Array.from(requestedPath).length > 1_024) {
    throw new VaultPathError("PATH_TOO_LONG");
  }

  if (
    path.isAbsolute(requestedPath) ||
    path.posix.isAbsolute(requestedPath) ||
    path.win32.isAbsolute(requestedPath) ||
    /^[a-z]:/iu.test(requestedPath)
  ) {
    throw new VaultPathError("ABSOLUTE_PATH");
  }

  if (requestedPath.includes("\\")) {
    throw new VaultPathError("INVALID_SEPARATOR");
  }

  if (encodedBytePattern.test(requestedPath)) {
    throw new VaultPathError("ENCODED_PATH");
  }

  if (
    controlCharacterPattern.test(requestedPath) ||
    requestedPath.includes(":")
  ) {
    throw new VaultPathError("INVALID_CHARACTERS");
  }

  const segments = requestedPath.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new VaultPathError("PATH_TRAVERSAL");
    }

    if (
      segment.length === 0 ||
      segment === "." ||
      segment.endsWith(".") ||
      segment.endsWith(" ")
    ) {
      throw new VaultPathError("INVALID_SEGMENT");
    }

    if (Array.from(segment).length > 255) {
      throw new VaultPathError("PATH_TOO_LONG");
    }

    if (windowsDeviceNamePattern.test(segment)) {
      throw new VaultPathError("RESERVED_NAME");
    }
  }

  if (
    segments.some((segment) => {
      const normalizedSegment = segment.toLocaleLowerCase("en-US");
      return (
        segment.startsWith(".") || deniedDirectoryNames.has(normalizedSegment)
      );
    }) ||
    beginsWithSegments(segments, backupSegments)
  ) {
    throw new VaultPathError("DENIED_DIRECTORY");
  }

  return Object.freeze(segments);
}

export class VaultPathPolicy {
  readonly #canonicalVaultRoot: string;
  readonly #backupSegments: readonly string[];

  private constructor(
    canonicalVaultRoot: string,
    backupSegments: readonly string[],
  ) {
    this.#canonicalVaultRoot = canonicalVaultRoot;
    this.#backupSegments = backupSegments;
  }

  static async create(
    configuration: VaultPathPolicyConfiguration,
  ): Promise<VaultPathPolicy> {
    if (!path.isAbsolute(configuration.vaultPath)) {
      throw new VaultPathError("INVALID_VAULT_ROOT");
    }

    const backupSegments = validateInternalDirectory(
      configuration.backupDir ?? defaultBackupDirectory,
    );

    try {
      const rootStatus = await lstat(configuration.vaultPath);
      if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
        throw new VaultPathError("INVALID_VAULT_ROOT");
      }

      const canonicalVaultRoot = await realpath(configuration.vaultPath);
      return new VaultPathPolicy(canonicalVaultRoot, backupSegments);
    } catch (error: unknown) {
      if (error instanceof VaultPathError) {
        throw error;
      }

      throw new VaultPathError("INVALID_VAULT_ROOT");
    }
  }

  async #resolveDirectorySegments(
    segments: readonly string[],
    createMissing: boolean,
    createMode?: number,
  ): Promise<string> {
    let rootStatus;
    let canonicalRoot;
    try {
      rootStatus = await lstat(this.#canonicalVaultRoot);
      canonicalRoot = await realpath(this.#canonicalVaultRoot);
    } catch {
      throw new VaultPathError("FILESYSTEM_ERROR");
    }

    if (
      rootStatus.isSymbolicLink() ||
      !rootStatus.isDirectory() ||
      path.relative(this.#canonicalVaultRoot, canonicalRoot) !== ""
    ) {
      throw new VaultPathError("PATH_OUTSIDE_VAULT");
    }

    let currentPath = this.#canonicalVaultRoot;
    for (const segment of segments) {
      currentPath = path.join(currentPath, segment);

      let status;
      try {
        status = await lstat(currentPath);
      } catch (error: unknown) {
        if (!hasErrorCode(error, "ENOENT") || !createMissing) {
          throw new VaultPathError(
            hasErrorCode(error, "ENOENT")
              ? "DIRECTORY_NOT_FOUND"
              : "FILESYSTEM_ERROR",
          );
        }

        try {
          await mkdir(
            currentPath,
            createMode === undefined ? {} : { mode: createMode },
          );
        } catch (mkdirError: unknown) {
          if (!hasErrorCode(mkdirError, "EEXIST")) {
            throw new VaultPathError("FILESYSTEM_ERROR");
          }
        }

        try {
          status = await lstat(currentPath);
        } catch {
          throw new VaultPathError("FILESYSTEM_ERROR");
        }
      }

      if (status.isSymbolicLink()) {
        throw new VaultPathError("SYMLINK_NOT_ALLOWED");
      }

      if (!status.isDirectory()) {
        throw new VaultPathError("PATH_COMPONENT_NOT_DIRECTORY");
      }

      let canonicalDirectory;
      try {
        canonicalDirectory = await realpath(currentPath);
      } catch {
        throw new VaultPathError("FILESYSTEM_ERROR");
      }

      if (!isContainedBy(this.#canonicalVaultRoot, canonicalDirectory)) {
        throw new VaultPathError("PATH_OUTSIDE_VAULT");
      }

      currentPath = canonicalDirectory;
    }

    return currentPath;
  }

  async resolveNoteLocation(
    requestedPath: string,
    options: ResolveNoteLocationOptions = {},
  ): Promise<ResolvedNoteLocation> {
    const segments = validateToolFacingNotePath(
      requestedPath,
      this.#backupSegments,
    );
    const parentSegments = segments.slice(0, -1);
    const parentAbsolutePath = await this.#resolveDirectorySegments(
      parentSegments,
      options.createParents ?? false,
    );
    const fileName = segments.at(-1);
    if (fileName === undefined) {
      throw new VaultPathError("EMPTY_PATH");
    }

    const absolutePath = path.join(parentAbsolutePath, fileName);
    if (!isContainedBy(this.#canonicalVaultRoot, absolutePath)) {
      throw new VaultPathError("PATH_OUTSIDE_VAULT");
    }

    return Object.freeze({
      relativePath: segments.join("/"),
      absolutePath,
      parentAbsolutePath,
    });
  }

  async ensureBackupDirectory(): Promise<ResolvedVaultDirectory> {
    const absolutePath = await this.#resolveDirectorySegments(
      this.#backupSegments,
      true,
      0o700,
    );

    return Object.freeze({
      relativePath: this.#backupSegments.join("/"),
      absolutePath,
    });
  }

  async resolveDirectoryPath(
    requestedPath = "",
  ): Promise<ResolvedVaultDirectory> {
    const segments = validateToolFacingDirectoryPath(
      requestedPath,
      this.#backupSegments,
    );
    const relativePath = segments.join("/");
    const absolutePath = path.resolve(this.#canonicalVaultRoot, ...segments);

    if (!isContainedBy(this.#canonicalVaultRoot, absolutePath)) {
      throw new VaultPathError("PATH_OUTSIDE_VAULT");
    }

    let currentPath = this.#canonicalVaultRoot;
    for (const segment of segments) {
      currentPath = path.join(currentPath, segment);

      let status;
      try {
        status = await lstat(currentPath);
      } catch (error: unknown) {
        if (hasErrorCode(error, "ENOENT")) {
          throw new VaultPathError("DIRECTORY_NOT_FOUND");
        }

        throw new VaultPathError("FILESYSTEM_ERROR");
      }

      if (status.isSymbolicLink()) {
        throw new VaultPathError("SYMLINK_NOT_ALLOWED");
      }

      if (!status.isDirectory()) {
        throw new VaultPathError("DIRECTORY_TARGET_NOT_DIRECTORY");
      }
    }

    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(absolutePath);
    } catch {
      throw new VaultPathError("FILESYSTEM_ERROR");
    }

    if (!isContainedBy(this.#canonicalVaultRoot, canonicalDirectory)) {
      throw new VaultPathError("PATH_OUTSIDE_VAULT");
    }

    return Object.freeze({
      relativePath,
      absolutePath: canonicalDirectory,
    });
  }

  async resolveNotePath(
    requestedPath: string,
    options: ResolveNotePathOptions = {},
  ): Promise<ResolvedNotePath> {
    const segments = validateToolFacingNotePath(
      requestedPath,
      this.#backupSegments,
    );
    const relativePath = segments.join("/");
    const absolutePath = path.resolve(this.#canonicalVaultRoot, ...segments);

    if (!isContainedBy(this.#canonicalVaultRoot, absolutePath)) {
      throw new VaultPathError("PATH_OUTSIDE_VAULT");
    }

    const expectation = options.expectation ?? "existing";
    let currentPath = this.#canonicalVaultRoot;

    for (const [index, segment] of segments.entries()) {
      const isTarget = index === segments.length - 1;
      const parentPath = currentPath;
      currentPath = path.join(currentPath, segment);

      let status;
      try {
        status = await lstat(currentPath);
      } catch (error: unknown) {
        if (hasErrorCode(error, "ENOENT")) {
          if (expectation === "existing") {
            throw new VaultPathError("NOTE_NOT_FOUND");
          }

          let canonicalParent: string;
          try {
            canonicalParent = await realpath(parentPath);
          } catch {
            throw new VaultPathError("FILESYSTEM_ERROR");
          }

          if (!isContainedBy(this.#canonicalVaultRoot, canonicalParent)) {
            throw new VaultPathError("PATH_OUTSIDE_VAULT");
          }

          return Object.freeze({
            relativePath,
            absolutePath,
            exists: false,
          });
        }

        throw new VaultPathError("FILESYSTEM_ERROR");
      }

      if (status.isSymbolicLink()) {
        throw new VaultPathError("SYMLINK_NOT_ALLOWED");
      }

      if (!isTarget && !status.isDirectory()) {
        throw new VaultPathError("PATH_COMPONENT_NOT_DIRECTORY");
      }

      if (isTarget) {
        if (!status.isFile()) {
          throw new VaultPathError("NOTE_TARGET_NOT_FILE");
        }

        if (status.nlink > 1) {
          throw new VaultPathError("HARD_LINK_NOT_ALLOWED");
        }
      }
    }

    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(absolutePath);
    } catch {
      throw new VaultPathError("FILESYSTEM_ERROR");
    }

    if (!isContainedBy(this.#canonicalVaultRoot, canonicalTarget)) {
      throw new VaultPathError("PATH_OUTSIDE_VAULT");
    }

    if (expectation === "new") {
      throw new VaultPathError("NOTE_ALREADY_EXISTS");
    }

    return Object.freeze({
      relativePath,
      absolutePath: canonicalTarget,
      exists: true,
    });
  }
}
