import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  ExactNoteEditError,
  type ExactNoteEditErrorCode,
} from "../vault/exact-note-edits.ts";
import {
  InvalidCursorError,
} from "./pagination-cursors.ts";
import {
  VaultPathError,
  type VaultPathErrorCode,
} from "../vault/path-policy.ts";
import {
  VaultServiceError,
  type VaultServiceErrorCode,
} from "../vault/vault-service.ts";

type ToolErrorCode =
  | "ALREADY_EXISTS"
  | "BACKUP_NOT_FOUND"
  | "AMBIGUOUS_MATCH"
  | "FRONTMATTER_PROTECTED"
  | "INVALID_ARGUMENT"
  | "INVALID_CURSOR"
  | "INVALID_PATH"
  | "IO_ERROR"
  | "LINK_NOT_ALLOWED"
  | "MATCH_NOT_FOUND"
  | "NOT_FOUND"
  | "NOTE_TOO_LARGE"
  | "INVALID_ENCODING"
  | "PATH_FORBIDDEN"
  | "PATH_NOT_MARKDOWN"
  | "PATH_OUTSIDE_VAULT"
  | "OVERLAPPING_EDITS"
  | "RECOVERY_REQUIRED"
  | "SEARCH_LIMIT_REACHED"
  | "UNSAFE_FILESYSTEM"
  | "VERSION_CONFLICT";

const exactNoteEditErrorCodes: Readonly<
  Record<ExactNoteEditErrorCode, ToolErrorCode>
> = {
  MATCH_NOT_FOUND: "MATCH_NOT_FOUND",
  AMBIGUOUS_MATCH: "AMBIGUOUS_MATCH",
  OVERLAPPING_EDITS: "OVERLAPPING_EDITS",
  FRONTMATTER_PROTECTED: "FRONTMATTER_PROTECTED",
  NO_CHANGE: "INVALID_ARGUMENT",
};

const pathErrorCodes: Readonly<Record<VaultPathErrorCode, ToolErrorCode>> = {
  INVALID_VAULT_ROOT: "IO_ERROR",
  INVALID_POLICY_CONFIGURATION: "IO_ERROR",
  EMPTY_PATH: "INVALID_PATH",
  ABSOLUTE_PATH: "INVALID_PATH",
  PATH_TRAVERSAL: "INVALID_PATH",
  INVALID_SEPARATOR: "INVALID_PATH",
  ENCODED_PATH: "INVALID_PATH",
  INVALID_CHARACTERS: "INVALID_PATH",
  INVALID_SEGMENT: "INVALID_PATH",
  PATH_TOO_LONG: "INVALID_PATH",
  RESERVED_NAME: "INVALID_PATH",
  DENIED_DIRECTORY: "PATH_FORBIDDEN",
  NOT_MARKDOWN: "PATH_NOT_MARKDOWN",
  PATH_OUTSIDE_VAULT: "PATH_OUTSIDE_VAULT",
  SYMLINK_NOT_ALLOWED: "LINK_NOT_ALLOWED",
  HARD_LINK_NOT_ALLOWED: "LINK_NOT_ALLOWED",
  PATH_COMPONENT_NOT_DIRECTORY: "NOT_FOUND",
  NOTE_TARGET_NOT_FILE: "NOT_FOUND",
  DIRECTORY_NOT_FOUND: "NOT_FOUND",
  DIRECTORY_TARGET_NOT_DIRECTORY: "NOT_FOUND",
  NOTE_NOT_FOUND: "NOT_FOUND",
  NOTE_ALREADY_EXISTS: "ALREADY_EXISTS",
  FILESYSTEM_ERROR: "IO_ERROR",
};

const serviceErrorCodes: Readonly<
  Record<VaultServiceErrorCode, ToolErrorCode>
> = {
  INVALID_OPTIONS: "IO_ERROR",
  INVALID_REVISION: "INVALID_ARGUMENT",
  INVALID_QUERY: "INVALID_ARGUMENT",
  INVALID_LIMIT: "INVALID_ARGUMENT",
  NOTE_TOO_LARGE: "NOTE_TOO_LARGE",
  INVALID_ENCODING: "INVALID_ENCODING",
  NOTE_CHANGED_DURING_READ: "IO_ERROR",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  UNSAFE_FILESYSTEM: "UNSAFE_FILESYSTEM",
  RECOVERY_REQUIRED: "RECOVERY_REQUIRED",
  BACKUP_NOT_FOUND: "BACKUP_NOT_FOUND",
  LIST_LIMIT_REACHED: "SEARCH_LIMIT_REACHED",
  SEARCH_LIMIT_REACHED: "SEARCH_LIMIT_REACHED",
  IO_ERROR: "IO_ERROR",
};

function errorResult(code: ToolErrorCode, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
  };
}

export function toToolErrorResult(error: unknown): CallToolResult {
  if (error instanceof ExactNoteEditError) {
    return errorResult(exactNoteEditErrorCodes[error.code], error.message);
  }

  if (error instanceof VaultPathError) {
    return errorResult(pathErrorCodes[error.code], error.message);
  }

  if (error instanceof VaultServiceError) {
    return errorResult(serviceErrorCodes[error.code], error.message);
  }

  if (error instanceof InvalidCursorError) {
    return errorResult("INVALID_CURSOR", error.message);
  }

  return errorResult(
    "IO_ERROR",
    "The vault operation failed because of an unexpected internal error.",
  );
}
