import path from "node:path";

const maximumTitleCodePoints = 200;

export interface PreparedSearchQuery {
  readonly normalizedQuery: string;
  readonly terms: readonly string[];
  readonly caseSensitive: boolean;
  readonly scope: SearchScope;
}

export type SearchScope = "content" | "path" | "both";

export interface SearchNoteResult {
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
  readonly matchKind: "content" | "path";
  readonly line?: number;
}

function normalize(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLocaleLowerCase("en-US");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;

  while (count < 100) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) {
      return count;
    }

    count += 1;
    offset = index + Math.max(needle.length, 1);
  }

  return count;
}

function stripLeadingFrontmatter(content: string): string {
  const withoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const lines = withoutBom.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") {
    return withoutBom;
  }

  const closingIndex = lines.findIndex(
    (line, index) =>
      index > 0 && (line.trim() === "---" || line.trim() === "..."),
  );
  return closingIndex === -1
    ? withoutBom
    : lines.slice(closingIndex + 1).join("\n");
}

function boundText(value: string, maximumCodePoints: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maximumCodePoints) {
    return value;
  }

  return `${codePoints.slice(0, maximumCodePoints - 1).join("")}…`;
}

function titleForNote(notePath: string, content: string): string {
  const body = stripLeadingFrontmatter(content);
  const heading = /^#\s+(.+?)\s*#*\s*$/mu.exec(body)?.[1]?.trim();
  const fallback = path.posix.basename(
    notePath,
    path.posix.extname(notePath),
  );
  return boundText(
    heading === undefined || heading.length === 0 ? fallback : heading,
    maximumTitleCodePoints,
  );
}

function relevanceScore(
  query: PreparedSearchQuery,
  normalizedTitle: string,
  normalizedPath: string,
  normalizedContent: string,
): number {
  let pathScore = normalizedTitle === query.normalizedQuery ? 100 : 0;
  pathScore += countOccurrences(normalizedTitle, query.normalizedQuery) * 30;
  pathScore += countOccurrences(normalizedPath, query.normalizedQuery) * 20;
  let contentScore =
    countOccurrences(normalizedContent, query.normalizedQuery) * 10;

  for (const term of query.terms) {
    pathScore += countOccurrences(normalizedTitle, term) * 8;
    pathScore += countOccurrences(normalizedPath, term) * 4;
    contentScore += countOccurrences(normalizedContent, term) * 2;
  }

  if (query.scope === "content") {
    return contentScore;
  }

  if (query.scope === "path") {
    return pathScore;
  }

  return pathScore + contentScore;
}

function firstRelevantIndex(
  normalizedContent: string,
  query: PreparedSearchQuery,
): number {
  const phraseIndex = normalizedContent.indexOf(query.normalizedQuery);
  if (phraseIndex !== -1) {
    return phraseIndex;
  }

  let bestIndex = -1;
  for (const term of query.terms) {
    const index = normalizedContent.indexOf(term);
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
    }
  }

  return bestIndex;
}

function relevantSnippet(
  content: string,
  query: PreparedSearchQuery,
  maximumCodePoints: number,
): string {
  const flattened = content.replace(/\s+/gu, " ").trim();
  if (flattened.length === 0) {
    return "";
  }

  const normalizedContent = normalize(flattened, query.caseSensitive);
  const matchIndex = firstRelevantIndex(normalizedContent, query);
  const matchCodePointIndex =
    matchIndex === -1 ? 0 : Array.from(flattened.slice(0, matchIndex)).length;
  const allCodePoints = Array.from(flattened);
  if (allCodePoints.length > maximumCodePoints && maximumCodePoints === 1) {
    return "…";
  }

  const contextBefore = Math.floor(maximumCodePoints / 3);
  let start = Math.max(0, matchCodePointIndex - contextBefore);
  let end = Math.min(allCodePoints.length, start + maximumCodePoints);

  if (end === allCodePoints.length) {
    start = Math.max(0, end - maximumCodePoints);
  }

  const hasPrefix = start > 0;
  const hasSuffix = end < allCodePoints.length;
  const contentBudget =
    maximumCodePoints - Number(hasPrefix) - Number(hasSuffix);
  end = Math.min(allCodePoints.length, start + Math.max(contentBudget, 0));

  return `${hasPrefix ? "…" : ""}${allCodePoints.slice(start, end).join("")}${
    hasSuffix ? "…" : ""
  }`;
}

export function prepareSearchQuery(
  query: string,
  caseSensitive: boolean,
  scope: SearchScope = "both",
): PreparedSearchQuery {
  const normalizedQuery = normalize(query, caseSensitive);
  return Object.freeze({
    normalizedQuery,
    terms: Object.freeze([
      ...new Set(
        normalizedQuery.split(/\s+/u).filter((term) => term.length > 0),
      ),
    ]),
    caseSensitive,
    scope,
  });
}

export function createSearchNoteResult(
  notePath: string,
  content: string,
  query: PreparedSearchQuery,
  maximumSnippetCodePoints: number,
): SearchNoteResult | undefined {
  const title = titleForNote(notePath, content);
  const normalizedContent = normalize(content, query.caseSensitive);
  const contentMatchIndex = firstRelevantIndex(normalizedContent, query);
  const score = relevanceScore(
    query,
    normalize(title, query.caseSensitive),
    normalize(notePath, query.caseSensitive),
    normalizedContent,
  );

  if (score === 0) {
    return undefined;
  }

  const matchKind =
    query.scope !== "path" && contentMatchIndex !== -1 ? "content" : "path";

  return Object.freeze({
    path: notePath,
    title,
    snippet:
      matchKind === "content"
        ? relevantSnippet(content, query, maximumSnippetCodePoints)
        : boundText(notePath, maximumSnippetCodePoints),
    score,
    matchKind,
    ...(matchKind === "content"
      ? { line: content.slice(0, contentMatchIndex).split(/\r\n|\r|\n/u).length }
      : {}),
  });
}
