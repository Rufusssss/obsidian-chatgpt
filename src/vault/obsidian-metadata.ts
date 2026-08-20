const defaultMaximumFrontmatterCodePoints = 8_192;
const defaultMaximumTags = 200;
const defaultMaximumHeadings = 200;
const defaultMaximumOutgoingLinks = 200;
const maximumFrontmatterKeys = 100;
const maximumTagCodePoints = 128;
const maximumHeadingCodePoints = 300;
const maximumLinkTargetCodePoints = 512;
const maximumLinkAliasCodePoints = 256;

export interface FrontmatterMetadata {
  readonly present: boolean;
  readonly valid: boolean;
  readonly keys: readonly string[];
  readonly raw?: string;
  readonly truncated: boolean;
}

export interface NoteHeading {
  readonly level: number;
  readonly text: string;
  readonly line: number;
}

export interface ParsedOutgoingLink {
  readonly target: string;
  readonly alias?: string;
  readonly line: number;
}

export interface ParsedObsidianMetadata {
  readonly frontmatter: FrontmatterMetadata;
  readonly tags: readonly string[];
  readonly headings: readonly NoteHeading[];
  readonly outgoingLinks: readonly ParsedOutgoingLink[];
  readonly outgoingLinksTruncated: boolean;
  readonly incomplete: boolean;
}

export interface ParseObsidianMetadataOptions {
  readonly maxFrontmatterCodePoints?: number;
  readonly maxTags?: number;
  readonly maxHeadings?: number;
  readonly maxOutgoingLinks?: number;
}

interface ParserLimits {
  readonly maxFrontmatterCodePoints: number;
  readonly maxTags: number;
  readonly maxHeadings: number;
  readonly maxOutgoingLinks: number;
}

interface FrontmatterRegion {
  readonly metadata: FrontmatterMetadata;
  readonly bodyStartLine: number;
  readonly tags: readonly string[];
  readonly incomplete: boolean;
}

interface ActiveFence {
  readonly marker: "`" | "~";
  readonly length: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value < 1
    ? fallback
    : value;
}

function createLimits(options: ParseObsidianMetadataOptions): ParserLimits {
  return Object.freeze({
    maxFrontmatterCodePoints: positiveInteger(
      options.maxFrontmatterCodePoints,
      defaultMaximumFrontmatterCodePoints,
    ),
    maxTags: positiveInteger(options.maxTags, defaultMaximumTags),
    maxHeadings: positiveInteger(options.maxHeadings, defaultMaximumHeadings),
    maxOutgoingLinks: positiveInteger(
      options.maxOutgoingLinks,
      defaultMaximumOutgoingLinks,
    ),
  });
}

function boundCodePoints(
  value: string,
  maximum: number,
): { readonly value: string; readonly truncated: boolean } {
  const codePoints = Array.from(value);
  if (codePoints.length <= maximum) {
    return { value, truncated: false };
  }

  return {
    value: `${codePoints.slice(0, Math.max(0, maximum - 1)).join("")}…`,
    truncated: true,
  };
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === "\"" && last === "\"") ||
    (first === "'" && last === "'")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function normalizeTag(value: string): string | undefined {
  const withoutQuotes = stripMatchingQuotes(value);
  const withoutHash = withoutQuotes.startsWith("#")
    ? withoutQuotes.slice(1)
    : withoutQuotes;
  if (
    withoutHash.length === 0 ||
    Array.from(withoutHash).length > maximumTagCodePoints ||
    !/^[\p{L}\p{N}_/-]+$/u.test(withoutHash) ||
    !/[\p{L}_-]/u.test(withoutHash)
  ) {
    return undefined;
  }
  return withoutHash;
}

function splitCommaValues(value: string): readonly string[] {
  const values: string[] = [];
  let start = 0;
  let quote: "\"" | "'" | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\"" || character === "'") {
      quote = quote === undefined ? character : quote === character ? undefined : quote;
    } else if (character === "," && quote === undefined) {
      values.push(value.slice(start, index));
      start = index + 1;
    }
  }
  values.push(value.slice(start));
  return values;
}

function frontmatterTags(lines: readonly string[]): readonly string[] {
  const tags: string[] = [];
  const tagKeyIndex = lines.findIndex((line) => /^tags\s*:/iu.test(line));
  if (tagKeyIndex === -1) {
    return tags;
  }

  const tagLine = lines[tagKeyIndex] ?? "";
  const value = tagLine.slice(tagLine.indexOf(":") + 1).trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    for (const candidate of splitCommaValues(value.slice(1, -1))) {
      const tag = normalizeTag(candidate);
      if (tag !== undefined) {
        tags.push(tag);
      }
    }
    return tags;
  }

  if (value.length > 0) {
    const candidates = value.includes(",") ? splitCommaValues(value) : [value];
    for (const candidate of candidates) {
      const tag = normalizeTag(candidate);
      if (tag !== undefined) {
        tags.push(tag);
      }
    }
    return tags;
  }

  for (let index = tagKeyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^[^\s][^:]*:/u.test(line)) {
      break;
    }
    const item = /^\s+-\s+(.+?)\s*$/u.exec(line)?.[1];
    if (item !== undefined) {
      const tag = normalizeTag(item);
      if (tag !== undefined) {
        tags.push(tag);
      }
    }
  }
  return tags;
}

function frontmatterRegion(
  lines: readonly string[],
  maximumCodePoints: number,
): FrontmatterRegion {
  const firstLine = (lines[0] ?? "").replace(/^\uFEFF/u, "");
  if (firstLine.trim() !== "---") {
    return {
      metadata: Object.freeze({
        present: false,
        valid: false,
        keys: Object.freeze([]),
        truncated: false,
      }),
      bodyStartLine: 0,
      tags: Object.freeze([]),
      incomplete: false,
    };
  }

  const closingIndex = lines.findIndex(
    (line, index) =>
      index > 0 && (line.trim() === "---" || line.trim() === "..."),
  );
  const valid = closingIndex !== -1;
  const metadataLines = lines.slice(1, valid ? closingIndex : lines.length);
  const raw = boundCodePoints(metadataLines.join("\n"), maximumCodePoints);
  const keys: string[] = [];
  let keysTruncated = false;
  for (const line of metadataLines) {
    const key = /^([A-Za-z0-9_-][A-Za-z0-9 _-]{0,127})\s*:/u.exec(line)?.[1];
    if (key === undefined) {
      continue;
    }
    if (keys.length >= maximumFrontmatterKeys) {
      keysTruncated = true;
      break;
    }
    keys.push(key.trim());
  }

  return {
    metadata: Object.freeze({
      present: true,
      valid,
      keys: Object.freeze(keys),
      raw: raw.value,
      truncated: raw.truncated || keysTruncated,
    }),
    bodyStartLine: valid ? closingIndex + 1 : lines.length,
    tags: Object.freeze(frontmatterTags(metadataLines)),
    incomplete: !valid || raw.truncated || keysTruncated,
  };
}

function updateFence(line: string, active: ActiveFence | undefined): ActiveFence | undefined {
  const match = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
  if (match === undefined) {
    return active;
  }

  const marker = match[0] as "`" | "~";
  if (active === undefined) {
    return { marker, length: match.length };
  }
  return marker === active.marker && match.length >= active.length
    ? undefined
    : active;
}

function maskInlineCode(line: string): string {
  const characters = line.split("");
  let index = 0;
  while (index < characters.length) {
    if (characters[index] !== "`") {
      index += 1;
      continue;
    }

    let runLength = 1;
    while (characters[index + runLength] === "`") {
      runLength += 1;
    }
    const closing = characters
      .slice(index + runLength)
      .join("")
      .indexOf("`".repeat(runLength));
    const end =
      closing === -1
        ? characters.length
        : index + runLength + closing + runLength;
    for (let maskIndex = index; maskIndex < end; maskIndex += 1) {
      characters[maskIndex] = " ";
    }
    index = end;
  }
  return characters.join("");
}

function unescapedPipe(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "|" && value[index - 1] !== "\\") {
      return index;
    }
  }
  return -1;
}

function parsedWikilinks(
  originalLine: string,
  searchableLine: string,
  lineNumber: number,
): {
  readonly links: readonly ParsedOutgoingLink[];
  readonly skippedOversized: boolean;
} {
  const links: ParsedOutgoingLink[] = [];
  let skippedOversized = false;
  const pattern = /\[\[([^\]\r\n]+)\]\]/gu;
  for (const match of searchableLine.matchAll(pattern)) {
    const matchIndex = match.index;
    if (matchIndex === undefined) {
      continue;
    }
    if (matchIndex > 0 && searchableLine[matchIndex - 1] === "!") {
      continue;
    }
    const inner = originalLine.slice(matchIndex + 2, matchIndex + match[0].length - 2);
    const pipeIndex = unescapedPipe(inner);
    const target = (pipeIndex === -1 ? inner : inner.slice(0, pipeIndex)).trim();
    const alias =
      pipeIndex === -1
        ? undefined
        : inner.slice(pipeIndex + 1).replace(/\\\|/gu, "|").trim();
    if (
      target.length === 0 ||
      Array.from(target).length > maximumLinkTargetCodePoints ||
      (alias !== undefined && Array.from(alias).length > maximumLinkAliasCodePoints)
    ) {
      skippedOversized = true;
      continue;
    }
    links.push(
      Object.freeze({
        target,
        line: lineNumber,
        ...(alias === undefined || alias.length === 0 ? {} : { alias }),
      }),
    );
  }
  return { links, skippedOversized };
}

function addTag(
  tags: Map<string, string>,
  candidate: string,
  maximum: number,
): boolean {
  const normalized = normalizeTag(candidate);
  if (normalized === undefined) {
    return false;
  }
  const key = normalized.toLocaleLowerCase("en-US");
  if (tags.has(key)) {
    return false;
  }
  if (tags.size >= maximum) {
    return true;
  }
  tags.set(key, normalized);
  return false;
}

export function parseObsidianMetadata(
  content: string,
  options: ParseObsidianMetadataOptions = {},
): ParsedObsidianMetadata {
  const limits = createLimits(options);
  const lines = content.split(/\r?\n/u);
  const frontmatter = frontmatterRegion(lines, limits.maxFrontmatterCodePoints);
  const tags = new Map<string, string>();
  let incomplete = frontmatter.incomplete;
  for (const tag of frontmatter.tags) {
    incomplete = addTag(tags, tag, limits.maxTags) || incomplete;
  }

  const headings: NoteHeading[] = [];
  const outgoingLinks: ParsedOutgoingLink[] = [];
  let outgoingLinksTruncated =
    frontmatter.metadata.present && !frontmatter.metadata.valid;
  let activeFence: ActiveFence | undefined;

  for (let index = frontmatter.bodyStartLine; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextFence = updateFence(line, activeFence);
    if (nextFence !== activeFence) {
      activeFence = nextFence;
      continue;
    }
    if (activeFence !== undefined) {
      continue;
    }

    const searchable = maskInlineCode(line);
    const heading = /^\s{0,3}(#{1,6})[ \t]+(.+?)\s*$/u.exec(searchable);
    if (heading !== null) {
      const text = (heading[2] ?? "")
        .replace(/[ \t]+#+[ \t]*$/u, "")
        .trim();
      if (text.length > 0) {
        if (headings.length < limits.maxHeadings) {
          const bounded = boundCodePoints(text, maximumHeadingCodePoints);
          headings.push(
            Object.freeze({
              level: (heading[1] ?? "").length,
              text: bounded.value,
              line: index + 1,
            }),
          );
          incomplete = bounded.truncated || incomplete;
        } else {
          incomplete = true;
        }
      }
    }

    const inlineTagPattern = /(^|[\s(])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;
    for (const match of searchable.matchAll(inlineTagPattern)) {
      const tag = match[2];
      if (tag !== undefined) {
        incomplete = addTag(tags, tag, limits.maxTags) || incomplete;
      }
    }

    const parsedLinks = parsedWikilinks(line, searchable, index + 1);
    outgoingLinksTruncated =
      parsedLinks.skippedOversized || outgoingLinksTruncated;
    for (const link of parsedLinks.links) {
      if (outgoingLinks.length < limits.maxOutgoingLinks) {
        outgoingLinks.push(link);
      } else {
        incomplete = true;
        outgoingLinksTruncated = true;
      }
    }
  }

  return Object.freeze({
    frontmatter: frontmatter.metadata,
    tags: Object.freeze(
      [...tags.values()].sort((left, right) => left.localeCompare(right, "en")),
    ),
    headings: Object.freeze(headings),
    outgoingLinks: Object.freeze(outgoingLinks),
    outgoingLinksTruncated,
    incomplete: incomplete || outgoingLinksTruncated,
  });
}
