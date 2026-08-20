const noteWriterErrorMessages = {
  INVALID_REVISION: "The expected note revision is invalid.",
  NOTE_TOO_LARGE: "The requested note exceeds the configured write size limit.",
  INVALID_ENCODING: "The requested note content cannot be represented safely as UTF-8.",
  VERSION_CONFLICT:
    "The note changed since the expected revision was observed; read it again before writing.",
  UNSAFE_FILESYSTEM:
    "The filesystem cannot provide the no-clobber operation required for a safe write.",
  RECOVERY_REQUIRED:
    "An incomplete or ambiguous write transaction requires local recovery before more writes.",
  BACKUP_NOT_FOUND: "The requested recovery backup does not exist or is invalid.",
  IO_ERROR: "The vault write failed because of a filesystem error.",
} as const;

export type NoteWriterErrorCode = keyof typeof noteWriterErrorMessages;

export class NoteWriterError extends Error {
  override readonly name = "NoteWriterError";
  readonly code: NoteWriterErrorCode;

  constructor(code: NoteWriterErrorCode) {
    super(noteWriterErrorMessages[code]);
    this.code = code;
  }
}
