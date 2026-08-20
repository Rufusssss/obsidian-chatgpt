import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  ConfigurationError,
  loadConfig,
} from "../src/config/load-config.ts";
import {
  createTemporaryVault,
  removeTemporaryVault,
  type TemporaryVault,
} from "./helpers/temporary-vault.ts";

let fixture: TemporaryVault;

function environment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    OBSIDIAN_VAULT_PATH: fixture.vaultPath,
    ...overrides,
  };
}

function assertConfigurationError(
  callback: () => unknown,
  expectedMessage: RegExp,
): void {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.match(error.message, expectedMessage);
    assert.doesNotMatch(error.message, /tests[\\/]fixtures/u);
    return true;
  });
}

describe("loadConfig", () => {
  before(async () => {
    fixture = await createTemporaryVault();
  });

  after(async () => {
    await removeTemporaryVault(fixture);
  });

  it("loads valid configuration with safe defaults", () => {
    const config = loadConfig(environment());

    assert.deepEqual(config, {
      vaultPath: fixture.vaultPath,
      mcpHost: "127.0.0.1",
      mcpPort: 3000,
      logLevel: "info",
      backupDir: ".obsidian-chatgpt/backups",
    });
    assert.equal(Object.isFrozen(config), true);
  });

  it("loads every supported configuration field", () => {
    const config = loadConfig(
      environment({
        MCP_HOST: "::1",
        MCP_PORT: "4321",
        LOG_LEVEL: "debug",
        BACKUP_DIR: ".obsidian-chatgpt/custom-backups",
      }),
    );

    assert.equal(config.mcpHost, "::1");
    assert.equal(config.mcpPort, 4321);
    assert.equal(config.logLevel, "debug");
    assert.equal(config.backupDir, ".obsidian-chatgpt/custom-backups");
  });

  it("requires OBSIDIAN_VAULT_PATH", () => {
    assertConfigurationError(
      () => loadConfig({}),
      /OBSIDIAN_VAULT_PATH/u,
    );
  });

  it("rejects a relative vault path without accessing it", () => {
    assertConfigurationError(
      () => loadConfig(environment({ OBSIDIAN_VAULT_PATH: "relative/vault" })),
      /OBSIDIAN_VAULT_PATH: must be an absolute path/u,
    );
  });

  it("rejects non-loopback MCP hosts", () => {
    assertConfigurationError(
      () => loadConfig(environment({ MCP_HOST: "0.0.0.0" })),
      /MCP_HOST: must be a loopback host/u,
    );
  });

  it("rejects invalid MCP ports", () => {
    assertConfigurationError(
      () => loadConfig(environment({ MCP_PORT: "80" })),
      /MCP_PORT: must be an unprivileged port/u,
    );
  });

  it("rejects absolute and traversing backup directories", () => {
    assertConfigurationError(
      () => loadConfig(environment({ BACKUP_DIR: "../backups" })),
      /BACKUP_DIR: must be a safe vault-relative directory/u,
    );
    assertConfigurationError(
      () => loadConfig(environment({ BACKUP_DIR: fixture.vaultPath })),
      /BACKUP_DIR: must be a safe vault-relative directory/u,
    );
  });

  it("does not include invalid configuration values in errors", () => {
    const invalidPath = "private-relative-vault";

    assert.throws(
      () => loadConfig(environment({ OBSIDIAN_VAULT_PATH: invalidPath })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.doesNotMatch(error.message, new RegExp(invalidPath, "u"));
        return true;
      },
    );
  });
});
