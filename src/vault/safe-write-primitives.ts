import { open, unlink, type FileHandle } from "node:fs/promises";

function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    codes.includes((error as NodeJS.ErrnoException).code ?? "")
  );
}

export async function writeExclusiveFile(
  filePath: string,
  content: Uint8Array,
  mode: number,
): Promise<void> {
  let fileHandle: FileHandle | undefined;
  let created = false;
  try {
    fileHandle = await open(filePath, "wx", mode);
    created = true;
    await fileHandle.writeFile(content);
    await fileHandle.sync();
  } catch (error: unknown) {
    await fileHandle?.close().catch(() => undefined);
    fileHandle = undefined;
    if (created) {
      await unlink(filePath).catch(() => undefined);
    }
    throw error;
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

export async function syncDirectory(directoryPath: string): Promise<void> {
  let directoryHandle: FileHandle | undefined;
  try {
    directoryHandle = await open(directoryPath, "r");
    await directoryHandle.sync();
  } catch (error: unknown) {
    if (
      !hasErrorCode(error, [
        "EBADF",
        "EINVAL",
        "EISDIR",
        "ENOSYS",
        "ENOTSUP",
        "EOPNOTSUPP",
        "EPERM",
      ])
    ) {
      throw error;
    }
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}
