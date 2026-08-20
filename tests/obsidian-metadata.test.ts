import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseObsidianMetadata,
} from "../src/vault/obsidian-metadata.ts";
import { VaultLinkResolver } from "../src/vault/wikilink-resolver.ts";

describe("Obsidian metadata parsing", () => {
  it("detects frontmatter, tags, headings, wikilinks, and aliases without parsing code", () => {
    const content =
      "\ufeff---\n" +
      "aliases:\n" +
      "  - Alpha\n" +
      "tags: [project, \"nested/topic\"]\n" +
      "owner: Synthetic Team\n" +
      "---\n" +
      "# Project Alpha\n" +
      "Body #planning links to [[Projects/Roadmap|the roadmap]].\n" +
      "It also links to [[Missing Note]] and [[#Local section]].\n" +
      "`[[Ignored inline]] #ignored`\n" +
      "```md\n" +
      "[[Ignored fenced]] #ignored-too\n" +
      "## Ignored heading\n" +
      "```\n" +
      "## Local section\n";

    const metadata = parseObsidianMetadata(content);

    assert.deepEqual(metadata.frontmatter, {
      present: true,
      valid: true,
      keys: ["aliases", "tags", "owner"],
      raw:
        "aliases:\n  - Alpha\ntags: [project, \"nested/topic\"]\nowner: Synthetic Team",
      truncated: false,
    });
    assert.deepEqual(metadata.tags, ["nested/topic", "planning", "project"]);
    assert.deepEqual(metadata.headings, [
      { level: 1, text: "Project Alpha", line: 7 },
      { level: 2, text: "Local section", line: 15 },
    ]);
    assert.deepEqual(metadata.outgoingLinks, [
      {
        target: "Projects/Roadmap",
        alias: "the roadmap",
        line: 8,
      },
      { target: "Missing Note", line: 9 },
      { target: "#Local section", line: 9 },
    ]);
    assert.equal(metadata.incomplete, false);
  });

  it("reports malformed frontmatter and bounds model-facing metadata", () => {
    const metadata = parseObsidianMetadata(
      "---\ntags: [one, two]\n# Not a body heading\n[[Not a body link]]\n",
      { maxFrontmatterCodePoints: 12 },
    );

    assert.equal(metadata.frontmatter.present, true);
    assert.equal(metadata.frontmatter.valid, false);
    assert.equal(metadata.frontmatter.truncated, true);
    assert.deepEqual(metadata.headings, []);
    assert.deepEqual(metadata.outgoingLinks, []);
    assert.equal(metadata.outgoingLinksTruncated, true);
    assert.equal(metadata.incomplete, true);

    const boundedLinks = parseObsidianMetadata(
      "# Note\n[[One]] and [[Two|second alias]]\n",
      { maxOutgoingLinks: 1 },
    );
    assert.deepEqual(boundedLinks.outgoingLinks, [
      { target: "One", line: 2 },
    ]);
    assert.equal(boundedLinks.outgoingLinksTruncated, true);
    assert.equal(boundedLinks.incomplete, true);
  });

  it("resolves explicit, unique, local, missing, and ambiguous wikilinks deterministically", () => {
    const resolver = new VaultLinkResolver([
      "Projects/Roadmap.md",
      "Teams/A/Shared.md",
      "Teams/B/Shared.md",
      "Unique.md",
    ]);
    const link = (target: string) => ({ target, line: 1 });

    assert.deepEqual(
      resolver.resolve("Projects/Source.md", link("Projects/Roadmap#Q4")),
      {
        target: "Projects/Roadmap#Q4",
        line: 1,
        resolution: "resolved",
        resolvedPath: "Projects/Roadmap.md",
      },
    );
    assert.equal(
      resolver.resolve("Other/Source.md", link("Unique")).resolvedPath,
      "Unique.md",
    );
    assert.equal(
      resolver.resolve("Teams/A/Source.md", link("Shared")).resolvedPath,
      "Teams/A/Shared.md",
    );
    assert.equal(
      resolver.resolve("Other/Source.md", link("Shared")).resolution,
      "ambiguous",
    );
    assert.equal(
      resolver.resolve("Other/Source.md", link("Does not exist")).resolution,
      "missing",
    );
    assert.equal(
      resolver.resolve("Other/Source.md", link("#Heading")).resolvedPath,
      "Other/Source.md",
    );
  });
});
