/**
 * Programmatic surface of `@seaveyon/dsh-world-line`.
 *
 * The shipped artifact is a standalone CLI (`bin/dsh-world-line.mjs` →
 * `main`); this module also exposes the runner and identity constants so
 * tests and future tooling can drive the CLI in-process.
 */

export { main, runCli } from './cli.js'
export {
  FileError,
  InvariantError,
  LockedError,
  UsageError,
  VerificationError,
  WlError,
} from './domain/errors.js'
export {
  ENVELOPE_SCHEMA_VERSION,
  WORLD_LINE_FORMAT_VERSION,
  WORLD_LINE_VERSION,
} from './identity.js'

// DSH host plugin face; CLI imports remain available to existing consumers.
export { apply, inject, name } from './web/index.js'
