import path from "node:path";

import { z } from "zod";

const loopbackHosts = ["127.0.0.1", "::1", "localhost"] as const;
const logLevels = ["debug", "info", "warn", "error"] as const;

const vaultPathSchema = z
  .string()
  .trim()
  .min(1, "is required")
  .refine((value) => !value.includes("\0"), "must not contain NUL characters")
  .refine((value) => path.isAbsolute(value), "must be an absolute path");

const portSchema = z
  .string()
  .trim()
  .regex(/^\d+$/u, "must be an integer from 1024 through 65535")
  .transform(Number)
  .pipe(
    z
      .number()
      .int()
      .min(1024, "must be an unprivileged port from 1024 through 65535")
      .max(65535, "must be an integer from 1024 through 65535"),
  );

function isSafeVaultRelativeDirectory(value: string): boolean {
  if (
    path.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    return false;
  }

  if (value.includes("\\") || /[\0:]/u.test(value)) {
    return false;
  }

  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

const backupDirectorySchema = z
  .string()
  .trim()
  .min(1, "is required")
  .refine(
    isSafeVaultRelativeDirectory,
    "must be a safe vault-relative directory without traversal",
  );

export const environmentSchema = z
  .object({
    OBSIDIAN_VAULT_PATH: vaultPathSchema,
    MCP_HOST: z.enum(loopbackHosts, {
      error: "must be a loopback host: 127.0.0.1, ::1, or localhost",
    }).default("127.0.0.1"),
    MCP_PORT: portSchema.default(3000),
    LOG_LEVEL: z.enum(logLevels, {
      error: "must be one of: debug, info, warn, error",
    }).default("info"),
    BACKUP_DIR: backupDirectorySchema.default(".obsidian-chatgpt/backups"),
  })
  .strict();

export type EnvironmentConfiguration = z.infer<typeof environmentSchema>;
export type LogLevel = (typeof logLevels)[number];
