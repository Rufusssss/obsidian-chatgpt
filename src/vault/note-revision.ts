import { createHash } from "node:crypto";

export function createNoteRevision(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
