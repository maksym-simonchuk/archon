/** Result type — boundaries return Results instead of throwing. */
export type Result<T, E = ArchonError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface ArchonError {
  code: string;
  message: string;
  cause?: unknown;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * Marks an unimplemented seam in the MVP scaffold. Throws with a pointer to the
 * ROADMAP milestone that will fill it in. Returns `never`, so it satisfies any
 * declared return type at the call site.
 */
export function notImplemented(what: string, milestone: string): never {
  throw new Error(`[archon] not implemented: ${what} — see docs/ROADMAP.md (${milestone})`);
}
