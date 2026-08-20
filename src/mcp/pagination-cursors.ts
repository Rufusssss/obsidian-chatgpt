import { createHash, randomUUID } from "node:crypto";

const defaultCursorLifetimeMilliseconds = 5 * 60 * 1_000;
const defaultMaximumCursors = 128;

interface CursorState<T> {
  readonly fingerprint: string;
  readonly items: readonly T[];
  readonly offset: number;
  readonly expiresAt: number;
}

export class InvalidCursorError extends Error {
  override readonly name = "InvalidCursorError";

  constructor() {
    super("The pagination cursor is invalid or expired; restart the request.");
  }
}

export function fingerprintArguments(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class PaginationCursorStore<T> {
  readonly #states = new Map<string, CursorState<T>>();
  readonly #cursorLifetimeMilliseconds: number;
  readonly #maximumCursors: number;

  constructor(
    cursorLifetimeMilliseconds = defaultCursorLifetimeMilliseconds,
    maximumCursors = defaultMaximumCursors,
  ) {
    if (
      !Number.isSafeInteger(cursorLifetimeMilliseconds) ||
      cursorLifetimeMilliseconds < 1 ||
      !Number.isSafeInteger(maximumCursors) ||
      maximumCursors < 1
    ) {
      throw new InvalidCursorError();
    }

    this.#cursorLifetimeMilliseconds = cursorLifetimeMilliseconds;
    this.#maximumCursors = maximumCursors;
  }

  create(
    fingerprint: string,
    items: readonly T[],
    offset: number,
  ): string {
    this.#pruneExpired();
    while (this.#states.size >= this.#maximumCursors) {
      const oldestCursor = this.#states.keys().next().value as
        | string
        | undefined;
      if (oldestCursor === undefined) {
        break;
      }
      this.#states.delete(oldestCursor);
    }

    const cursor = randomUUID();
    this.#states.set(cursor, {
      fingerprint,
      items,
      offset,
      expiresAt: Date.now() + this.#cursorLifetimeMilliseconds,
    });
    return cursor;
  }

  resolve(cursor: string, fingerprint: string): CursorState<T> {
    this.#pruneExpired();
    const state = this.#states.get(cursor);
    if (state === undefined || state.fingerprint !== fingerprint) {
      throw new InvalidCursorError();
    }

    return state;
  }

  clear(): void {
    this.#states.clear();
  }

  #pruneExpired(): void {
    const now = Date.now();
    for (const [cursor, state] of this.#states) {
      if (state.expiresAt <= now) {
        this.#states.delete(cursor);
      }
    }
  }
}
