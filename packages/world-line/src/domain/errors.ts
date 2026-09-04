/**
 * Error taxonomy and exit-code contract.
 *
 * WORLD-LINE-SPEC §3: verification failures exit 1, invocation/file errors
 * exit 2, internal-invariant errors exit 3. Every user-visible failure path in
 * the CLI funnels through one of these classes so the mapping cannot drift.
 */

/** Exit code for a failed verification (a check or probe reported a defect). */
export const EXIT_VERIFICATION = 1
/** Exit code for a usage or file error (bad invocation, missing/unreadable file). */
export const EXIT_USAGE = 2
/** Exit code for an internal invariant error (a bug or a corrupt world-line store). */
export const EXIT_INTERNAL = 3

/**
 * Base class for every error the CLI knows how to render. The message may
 * embed file content (YAML diagnostics echo snippets), so the renderer runs
 * every message through the redactor before printing.
 */
export class WlError extends Error {
  /** Stable machine code, echoed in the JSON envelope's error.code. */
  readonly code: string
  /** Exit code per the spec's contract. */
  readonly exitCode: number

  constructor(code: string, exitCode: number, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.code = code
    this.exitCode = exitCode
  }
}

/** Bad invocation: unknown command, bad flag, invalid profile name, malformed value. */
export class UsageError extends WlError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('E_USAGE', EXIT_USAGE, message, options)
  }
}

/** Missing, unreadable, or structurally invalid file or directory. */
export class FileError extends WlError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('E_FILE', EXIT_USAGE, message, options)
  }
}

/** A verification or probe failed; nothing was changed. */
export class VerificationError extends WlError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('E_VERIFY', EXIT_VERIFICATION, message, options)
  }
}

/** An internal invariant broke (corrupt vault, hash mismatch, impossible state). */
export class InvariantError extends WlError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('E_INTERNAL', EXIT_INTERNAL, message, options)
  }
}

/**
 * The profile write lock is held by a live writer, or is stale and the caller
 * did not confirm breaking it (invariant 4: one writer per `{dshHome,
 * profile}`; a live lock is never overridden, a stale one only with explicit
 * user confirmation).
 */
export class LockedError extends WlError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('E_LOCKED', EXIT_USAGE, message, options)
  }
}
