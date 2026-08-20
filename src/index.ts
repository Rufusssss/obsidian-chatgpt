import { ConfigurationError, loadConfig } from "./config/load-config.ts";
import {
  McpHttpServerError,
  startStreamableHttpServer,
} from "./mcp/transport/streamable-http.ts";
import { VaultPathError, VaultPathPolicy } from "./vault/path-policy.ts";
import { ObsidianVaultService } from "./vault/vault-service.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const pathPolicy = await VaultPathPolicy.create({
    vaultPath: config.vaultPath,
    backupDir: config.backupDir,
  });
  const vaultService = new ObsidianVaultService(pathPolicy);
  const httpServer = await startStreamableHttpServer({
    host: config.mcpHost,
    port: config.mcpPort,
    vaultService,
  });

  process.stdout.write(
    JSON.stringify({
      level: config.logLevel,
      event: "mcp_server_ready",
      mcpHost: config.mcpHost,
      mcpPort: httpServer.port,
      mcpEndpoint: "/mcp",
      toolsRegistered: 8,
    }) + "\n",
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await httpServer.close();
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

void main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    process.stderr.write(`${error.message}\n`);
  } else if (error instanceof VaultPathError || error instanceof McpHttpServerError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(
      "Startup failed because of an unexpected internal error.\n",
    );
  }

  process.exitCode = 1;
});
