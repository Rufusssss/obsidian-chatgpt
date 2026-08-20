import { z } from "zod";

const controlCharacterPattern = /[\u0000-\u001f\u007f]/u;
const encodedBytePattern = /%[0-9a-f]{2}/iu;
const windowsDeviceNamePattern =
  /^(?:aux|clock\$|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/iu;
const versionPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumNoteBytes = 1_048_576;

function hasSafeCodePointLength(value: string, maximum: number): boolean {
  return Array.from(value).length <= maximum;
}

function hasSafeRelativeSegments(value: string, allowEmpty: boolean): boolean {
  if (value.length === 0) {
    return allowEmpty;
  }

  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-z]:/iu.test(value) ||
    value.includes("\\") ||
    value.includes(":") ||
    encodedBytePattern.test(value) ||
    controlCharacterPattern.test(value)
  ) {
    return false;
  }

  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.endsWith(".") &&
      !segment.endsWith(" ") &&
      hasSafeCodePointLength(segment, 255) &&
      !windowsDeviceNamePattern.test(segment),
  );
}

export const notePathSchema = z
  .string()
  .min(1)
  .refine((value) => hasSafeCodePointLength(value, 1_024), {
    message: "must contain at most 1024 Unicode characters",
  })
  .refine((value) => hasSafeRelativeSegments(value, false), {
    message: "must be a safe vault-relative path using forward slashes",
  })
  .refine((value) => value.toLocaleLowerCase("en-US").endsWith(".md"), {
    message: "must identify a Markdown file ending in .md",
  })
  .describe("Vault-relative Markdown note path using forward slashes.");

export const folderPathSchema = z
  .string()
  .refine((value) => hasSafeCodePointLength(value, 1_024), {
    message: "must contain at most 1024 Unicode characters",
  })
  .refine((value) => hasSafeRelativeSegments(value, true), {
    message:
      "must be empty for the vault root or a safe vault-relative folder path",
  })
  .describe(
    "Vault-relative folder path using forward slashes; an empty string means the vault root.",
  );

const cursorSchema = z
  .string()
  .uuid()
  .describe("Opaque cursor returned by the immediately preceding matching call.");

const versionSchema = z
  .string()
  .regex(versionPattern)
  .describe(
    "Opaque SHA-256 revision returned by read_note; copy it rather than constructing it.",
  );
const modifiedAtSchema = z.string().datetime({ offset: true });

function noteContentSchema(options: {
  readonly allowEmpty: boolean;
  readonly description: string;
}): z.ZodString {
  const schema = options.allowEmpty ? z.string() : z.string().min(1);
  return schema
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= maximumNoteBytes,
      { message: `must encode to at most ${maximumNoteBytes} UTF-8 bytes` },
    )
    .describe(options.description);
}

export const listNotesInputSchema = z
  .object({
    folder: folderPathSchema.default(""),
    recursive: z
      .boolean()
      .default(true)
      .describe("Whether to include notes in nested folders."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(100)
      .describe("Maximum number of notes to return in this page."),
    cursor: cursorSchema.optional(),
  })
  .strict();

export const listNotesOutputSchema = z
  .object({
    notes: z.array(
      z
        .object({
          path: notePathSchema,
          name: z.string().min(1).max(255),
          version: versionSchema,
          size_bytes: z.number().int().nonnegative(),
          modified_at: modifiedAtSchema,
        })
        .strict(),
    ),
    next_cursor: cursorSchema.optional(),
  })
  .strict();

export const searchNotesInputSchema = z
  .object({
    query: z
      .string()
      .refine((value) => value.trim().length > 0, {
        message: "must not be empty or whitespace only",
      })
      .refine((value) => hasSafeCodePointLength(value, 256), {
        message: "must contain at most 256 Unicode characters",
      })
      .describe("Literal text to search for; regular expressions are not used."),
    folder: folderPathSchema.default(""),
    scope: z.enum(["content", "path", "both"]).default("both"),
    case_sensitive: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: cursorSchema.optional(),
  })
  .strict();

export const searchNotesOutputSchema = z
  .object({
    matches: z.array(
      z
        .object({
          path: notePathSchema,
          version: versionSchema,
          modified_at: modifiedAtSchema,
          match_kind: z.enum(["content", "path"]),
          line: z.number().int().positive().optional(),
          excerpt: z.string().refine((value) => hasSafeCodePointLength(value, 320)),
        })
        .strict(),
    ),
    next_cursor: cursorSchema.optional(),
    incomplete: z.boolean(),
  })
  .strict();

export const readNoteInputSchema = z
  .object({
    path: notePathSchema,
  })
  .strict();

export const readNoteOutputSchema = z
  .object({
    path: notePathSchema,
    content: z.string(),
    version: versionSchema,
    size_bytes: z.number().int().nonnegative(),
    modified_at: modifiedAtSchema,
  })
  .strict();

const metadataFrontmatterSchema = z
  .object({
    present: z.boolean(),
    valid: z.boolean(),
    keys: z.array(z.string().min(1).max(128)).max(100),
    raw: z
      .string()
      .refine((value) => hasSafeCodePointLength(value, 8_192))
      .optional(),
    truncated: z.boolean(),
  })
  .strict();

const headingSchema = z
  .object({
    level: z.number().int().min(1).max(6),
    text: z
      .string()
      .min(1)
      .refine((value) => hasSafeCodePointLength(value, 300)),
    line: z.number().int().positive(),
  })
  .strict();

const outgoingLinkSchema = z
  .object({
    target: z
      .string()
      .min(1)
      .refine((value) => hasSafeCodePointLength(value, 512)),
    alias: z
      .string()
      .min(1)
      .refine((value) => hasSafeCodePointLength(value, 256))
      .optional(),
    line: z.number().int().positive(),
    resolution: z.enum(["resolved", "missing", "ambiguous"]),
    resolved_path: notePathSchema.optional(),
  })
  .strict();

export const getNoteMetadataInputSchema = z
  .object({
    path: notePathSchema,
  })
  .strict();

export const getNoteMetadataOutputSchema = z
  .object({
    path: notePathSchema,
    version: versionSchema,
    frontmatter: metadataFrontmatterSchema,
    tags: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => hasSafeCodePointLength(value, 128)),
      )
      .max(200),
    headings: z.array(headingSchema).max(200),
    outgoing_links: z.array(outgoingLinkSchema).max(200),
    incomplete: z.boolean(),
  })
  .strict();

export const getBacklinksInputSchema = z
  .object({
    path: notePathSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("Maximum number of backlink occurrences to return."),
  })
  .strict();

export const getBacklinksOutputSchema = z
  .object({
    path: notePathSchema,
    version: versionSchema,
    backlinks: z
      .array(
        z
          .object({
            source_path: notePathSchema,
            source_version: versionSchema,
            line: z.number().int().positive(),
            target: z
              .string()
              .min(1)
              .refine((value) => hasSafeCodePointLength(value, 512)),
            alias: z
              .string()
              .min(1)
              .refine((value) => hasSafeCodePointLength(value, 256))
              .optional(),
          })
          .strict(),
      )
      .max(100),
    total_matches: z.number().int().nonnegative(),
    truncated: z.boolean(),
    scan_incomplete: z.boolean(),
  })
  .strict();

export const createNoteInputSchema = z
  .object({
    path: notePathSchema.describe(
      "New vault-relative Markdown path; the call fails if it already exists.",
    ),
    content: noteContentSchema({
      allowEmpty: true,
      description:
        "Complete UTF-8 content for the new note. Existing notes are never overwritten.",
    }),
  })
  .strict();

export const createNoteOutputSchema = z
  .object({
    path: notePathSchema,
    version: versionSchema,
    size_bytes: z.number().int().nonnegative(),
    modified_at: modifiedAtSchema,
  })
  .strict();

export const appendToNoteInputSchema = z
  .object({
    path: notePathSchema,
    content: noteContentSchema({
      allowEmpty: false,
      description:
        "UTF-8 text to append exactly as supplied; no newline or delimiter is inserted automatically.",
    }),
    expected_revision: versionSchema.describe(
      "Current version returned by read_note for this path. A stale value is rejected.",
    ),
  })
  .strict();

export const updateNoteInputSchema = z
  .object({
    path: notePathSchema,
    edits: z
      .array(
        z
          .object({
            old_text: noteContentSchema({
              allowEmpty: false,
              description:
                "Exact text that must occur exactly once in the current Markdown body.",
            }),
            new_text: noteContentSchema({
              allowEmpty: true,
              description:
                "Exact replacement text; an empty string intentionally removes old_text.",
            }),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine(
        (edits) =>
          edits.reduce(
            (total, edit) =>
              total +
              Buffer.byteLength(edit.old_text, "utf8") +
              Buffer.byteLength(edit.new_text, "utf8"),
            0,
          ) <= maximumNoteBytes,
        { message: `must encode to at most ${maximumNoteBytes} UTF-8 bytes` },
      )
      .describe(
        "One to 100 exact, non-overlapping replacements applied atomically to the original Markdown body.",
      ),
    expected_revision: versionSchema.describe(
      "Current version returned by read_note for this path. A stale value is rejected.",
    ),
  })
  .strict();

export const modifiedNoteOutputSchema = z
  .object({
    path: notePathSchema,
    previous_version: versionSchema,
    version: versionSchema,
    size_bytes: z.number().int().nonnegative(),
    modified_at: modifiedAtSchema,
  })
  .strict();

export const updatedNoteOutputSchema = modifiedNoteOutputSchema.extend({
  edits_applied: z.number().int().min(1).max(100),
});

export type ListNotesInput = z.infer<typeof listNotesInputSchema>;
export type ListNotesOutput = z.infer<typeof listNotesOutputSchema>;
export type SearchNotesInput = z.infer<typeof searchNotesInputSchema>;
export type SearchNotesOutput = z.infer<typeof searchNotesOutputSchema>;
export type ReadNoteOutput = z.infer<typeof readNoteOutputSchema>;
export type GetNoteMetadataOutput = z.infer<
  typeof getNoteMetadataOutputSchema
>;
export type GetBacklinksOutput = z.infer<typeof getBacklinksOutputSchema>;
export type CreateNoteOutput = z.infer<typeof createNoteOutputSchema>;
export type ModifiedNoteOutput = z.infer<typeof modifiedNoteOutputSchema>;
export type UpdatedNoteOutput = z.infer<typeof updatedNoteOutputSchema>;
