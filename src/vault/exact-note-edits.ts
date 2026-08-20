const exactNoteEditErrorMessages = {
  MATCH_NOT_FOUND:
    "An exact old_text value was not found in the current Markdown body.",
  AMBIGUOUS_MATCH:
    "An exact old_text value occurs more than once in the current Markdown body.",
  OVERLAPPING_EDITS:
    "Two requested exact edits overlap in the current Markdown body.",
  FRONTMATTER_PROTECTED:
    "YAML frontmatter cannot be changed through update_note.",
  NO_CHANGE: "The requested exact edits would not change the note.",
} as const;

export type ExactNoteEditErrorCode = keyof typeof exactNoteEditErrorMessages;

export class ExactNoteEditError extends Error {
  override readonly name = "ExactNoteEditError";
  readonly code: ExactNoteEditErrorCode;

  constructor(code: ExactNoteEditErrorCode) {
    super(exactNoteEditErrorMessages[code]);
    this.code = code;
  }
}

export interface ExactNoteEdit {
  readonly oldText: string;
  readonly newText: string;
}

interface LocatedEdit extends ExactNoteEdit {
  readonly start: number;
  readonly end: number;
}

function lineEnd(content: string, start: number): number {
  const newline = content.indexOf("\n", start);
  return newline === -1 ? content.length : newline + 1;
}

function lineText(content: string, start: number, end: number): string {
  const withoutNewline = end > start && content[end - 1] === "\n" ? end - 1 : end;
  const withoutCarriageReturn =
    withoutNewline > start && content[withoutNewline - 1] === "\r"
      ? withoutNewline - 1
      : withoutNewline;
  return content.slice(start, withoutCarriageReturn);
}

function protectedFrontmatterEnd(content: string): number {
  const documentStart = content.startsWith("\ufeff") ? 1 : 0;
  const openingEnd = lineEnd(content, documentStart);
  if (lineText(content, documentStart, openingEnd) !== "---") {
    return documentStart;
  }

  let current = openingEnd;
  while (current < content.length) {
    const end = lineEnd(content, current);
    if (lineText(content, current, end) === "---") {
      return end;
    }
    current = end;
  }

  throw new ExactNoteEditError("FRONTMATTER_PROTECTED");
}

function findOccurrences(
  content: string,
  value: string,
  start: number,
): readonly number[] {
  const occurrences: number[] = [];
  let candidate = content.indexOf(value, start);

  while (candidate !== -1) {
    occurrences.push(candidate);
    if (occurrences.length > 1) {
      break;
    }
    candidate = content.indexOf(value, candidate + 1);
  }

  return occurrences;
}

export function applyExactNoteEdits(
  content: string,
  edits: readonly ExactNoteEdit[],
): string {
  const bodyStart = protectedFrontmatterEnd(content);
  const located: LocatedEdit[] = edits.map((edit) => {
    const occurrences = findOccurrences(content, edit.oldText, bodyStart);
    if (occurrences.length === 0) {
      if (content.slice(0, bodyStart).includes(edit.oldText)) {
        throw new ExactNoteEditError("FRONTMATTER_PROTECTED");
      }
      throw new ExactNoteEditError("MATCH_NOT_FOUND");
    }
    if (occurrences.length > 1) {
      throw new ExactNoteEditError("AMBIGUOUS_MATCH");
    }

    const start = occurrences[0];
    if (start === undefined) {
      throw new ExactNoteEditError("MATCH_NOT_FOUND");
    }
    return {
      ...edit,
      start,
      end: start + edit.oldText.length,
    };
  });

  located.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < located.length; index += 1) {
    const previous = located[index - 1];
    const current = located[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.start < previous.end
    ) {
      throw new ExactNoteEditError("OVERLAPPING_EDITS");
    }
  }

  let nextContent = content;
  for (let index = located.length - 1; index >= 0; index -= 1) {
    const edit = located[index];
    if (edit !== undefined) {
      nextContent =
        nextContent.slice(0, edit.start) +
        edit.newText +
        nextContent.slice(edit.end);
    }
  }

  if (nextContent === content) {
    throw new ExactNoteEditError("NO_CHANGE");
  }
  return nextContent;
}
