import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNoteRevision } from "../src/vault/note-revision.ts";

describe("createNoteRevision", () => {
  it("returns a stable SHA-256 token over the complete raw bytes", () => {
    const bytes = Buffer.from("# Alpha\r\n\uFEFF[[Beta]]\n", "utf8");

    assert.equal(
      createNoteRevision(bytes),
      "sha256:e73898a38d7625d9636f2fb4423113ab04828fb7c289053ae9181953fff43cc5",
    );
    assert.equal(createNoteRevision(bytes), createNoteRevision(Buffer.from(bytes)));
  });

  it("changes when any content byte changes", () => {
    assert.notEqual(
      createNoteRevision(Buffer.from("alpha", "utf8")),
      createNoteRevision(Buffer.from("Alpha", "utf8")),
    );
  });
});
