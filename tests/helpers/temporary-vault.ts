import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const temporaryRootPrefix = "obsidian-chatgpt-test-";
const sourceFixturePath = path.resolve(
  "tests",
  "fixtures",
  "synthetic-vault",
);

export interface TemporaryVault {
  readonly rootPath: string;
  readonly vaultPath: string;
  readonly outsidePath: string;
}

export async function createTemporaryVault(): Promise<TemporaryVault> {
  const rootPath = await mkdtemp(path.join(tmpdir(), temporaryRootPrefix));
  const vaultPath = path.join(rootPath, "vault");
  const outsidePath = path.join(rootPath, "outside-vault");

  await cp(sourceFixturePath, vaultPath, { recursive: true });
  await mkdir(outsidePath);
  await writeFile(
    path.join(vaultPath, ".obsidian-mcp-test-vault"),
    `${randomUUID()}\n`,
    "utf8",
  );

  return Object.freeze({ rootPath, vaultPath, outsidePath });
}

export async function removeTemporaryVault(
  fixture: TemporaryVault,
): Promise<void> {
  const canonicalTemporaryRoot = path.resolve(tmpdir());
  const candidateRoot = path.resolve(fixture.rootPath);
  const relativePath = path.relative(canonicalTemporaryRoot, candidateRoot);

  if (
    path.basename(candidateRoot).startsWith(temporaryRootPrefix) &&
    relativePath !== "" &&
    !path.isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`)
  ) {
    await rm(candidateRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
    return;
  }

  throw new Error("Refusing to remove a directory outside the test temp root.");
}

export async function writeVaultNote(
  fixture: TemporaryVault,
  relativePath: string,
  content = "# Synthetic note\n",
): Promise<string> {
  const targetPath = path.join(
    fixture.vaultPath,
    ...relativePath.split("/"),
  );
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  return targetPath;
}
