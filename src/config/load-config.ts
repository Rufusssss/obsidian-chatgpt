import type { ZodIssue } from "zod";

import {
  environmentSchema,
  type LogLevel,
} from "./config-schema.ts";

export interface AppConfig {
  readonly vaultPath: string;
  readonly mcpHost: string;
  readonly mcpPort: number;
  readonly logLevel: LogLevel;
  readonly backupDir: string;
}

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

function formatIssue(issue: ZodIssue): string {
  const field = issue.path.length > 0 ? String(issue.path[0]) : "configuration";
  return `${field}: ${issue.message}`;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<AppConfig> {
  const result = environmentSchema.safeParse({
    OBSIDIAN_VAULT_PATH: environment.OBSIDIAN_VAULT_PATH,
    MCP_HOST: environment.MCP_HOST,
    MCP_PORT: environment.MCP_PORT,
    LOG_LEVEL: environment.LOG_LEVEL,
    BACKUP_DIR: environment.BACKUP_DIR,
  });

  if (!result.success) {
    throw new ConfigurationError(result.error.issues.map(formatIssue));
  }

  return Object.freeze({
    vaultPath: result.data.OBSIDIAN_VAULT_PATH,
    mcpHost: result.data.MCP_HOST,
    mcpPort: result.data.MCP_PORT,
    logLevel: result.data.LOG_LEVEL,
    backupDir: result.data.BACKUP_DIR,
  });
}
