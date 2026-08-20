import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSearchNoteResult,
  prepareSearchQuery,
} from "../src/vault/note-search.ts";

describe("note search scoring", () => {
  it("uses a Markdown H1 after frontmatter as the title", () => {
    const query = prepareSearchQuery("project alpha", false);
    const result = createSearchNoteResult(
      "Projects/Planning.md",
      "---\ntags: [project]\n---\n# Project Alpha\nBody text.\n",
      query,
      320,
    );

    assert.equal(result?.title, "Project Alpha");
    assert.ok((result?.score ?? 0) >= 100);
  });

  it("counts repeated terms but caps and bounds deterministic output", () => {
    const query = prepareSearchQuery("alpha alpha", false);
    assert.deepEqual(query.terms, ["alpha"]);

    const first = createSearchNoteResult(
      "Notes/Test.md",
      `# Test\n${"before ".repeat(20)}alpha alpha alpha${" after".repeat(20)}`,
      query,
      40,
    );
    const second = createSearchNoteResult(
      "Notes/Test.md",
      `# Test\n${"before ".repeat(20)}alpha alpha alpha${" after".repeat(20)}`,
      query,
      40,
    );

    assert.deepEqual(second, first);
    assert.ok((first?.score ?? 0) > 0);
    assert.ok(Array.from(first?.snippet ?? "").length <= 40);
    assert.match(first?.snippet ?? "", /alpha/u);
  });

  it("returns no result when neither title, path, nor content matches", () => {
    const result = createSearchNoteResult(
      "Notes/One.md",
      "# One\nUnrelated text.\n",
      prepareSearchQuery("missing", false),
      320,
    );

    assert.equal(result, undefined);
  });

  it("uses the vault-relative path as the excerpt for a path-only match", () => {
    const result = createSearchNoteResult(
      "Projects/Unique-Needle.md",
      "# Unrelated heading\nNo matching body text.\n",
      prepareSearchQuery("unique-needle", false, "path"),
      320,
    );

    assert.equal(result?.matchKind, "path");
    assert.equal(result?.line, undefined);
    assert.equal(result?.snippet, "Projects/Unique-Needle.md");
  });
});
