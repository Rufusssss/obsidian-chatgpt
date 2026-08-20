import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyExactNoteEdits,
  ExactNoteEditError,
} from "../src/vault/exact-note-edits.ts";

function assertEditError(
  operation: () => unknown,
  code: ExactNoteEditError["code"],
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof ExactNoteEditError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("applyExactNoteEdits", () => {
  it("applies multiple body edits while preserving frontmatter and untouched Obsidian syntax", () => {
    const content =
      "\ufeff---\r\ntags: [project]\r\n---\r\n# Alpha\r\n\r\nStatus: draft\r\nSee [[Roadmap]].\r\n";

    const updated = applyExactNoteEdits(content, [
      { oldText: "Status: draft", newText: "Status: reviewed" },
      { oldText: "[[Roadmap]]", newText: "[[Projects/Roadmap|roadmap]]" },
    ]);

    assert.equal(
      updated,
      "\ufeff---\r\ntags: [project]\r\n---\r\n# Alpha\r\n\r\nStatus: reviewed\r\nSee [[Projects/Roadmap|roadmap]].\r\n",
    );
  });

  it("rejects missing and repeated body matches", () => {
    assertEditError(
      () =>
        applyExactNoteEdits("# Note\nalpha alpha\n", [
          { oldText: "missing", newText: "replacement" },
        ]),
      "MATCH_NOT_FOUND",
    );
    assertEditError(
      () =>
        applyExactNoteEdits("# Note\nalpha alpha\n", [
          { oldText: "alpha", newText: "beta" },
        ]),
      "AMBIGUOUS_MATCH",
    );
  });

  it("rejects overlapping edits located against the original content", () => {
    assertEditError(
      () =>
        applyExactNoteEdits("# Note\nStatus: draft\n", [
          { oldText: "Status: draft", newText: "Status: reviewed" },
          { oldText: "draft", newText: "reviewed" },
        ]),
      "OVERLAPPING_EDITS",
    );
  });

  it("protects valid and malformed leading YAML frontmatter", () => {
    assertEditError(
      () =>
        applyExactNoteEdits("---\ntags: [draft]\n---\n# Note\n", [
          { oldText: "tags: [draft]", newText: "tags: [reviewed]" },
        ]),
      "FRONTMATTER_PROTECTED",
    );
    assertEditError(
      () =>
        applyExactNoteEdits("---\ntags: [draft]\n# Missing close\n", [
          { oldText: "Missing close", newText: "Changed" },
        ]),
      "FRONTMATTER_PROTECTED",
    );
  });

  it("rejects edits that make no change", () => {
    assertEditError(
      () =>
        applyExactNoteEdits("# Note\nStatus: draft\n", [
          { oldText: "Status: draft", newText: "Status: draft" },
        ]),
      "NO_CHANGE",
    );
  });
});
