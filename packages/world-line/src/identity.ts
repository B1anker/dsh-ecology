/**
 * Identity constants shared by the vault, manifests, and the JSON envelope.
 *
 * `world-line` version and the on-disk format version are deliberately
 * separate: the format version gates vault readers, the package version is
 * advisory metadata recorded in every manifest.
 */

/** The CLI's own version (kept in step with package.json by hand). */
export const WORLD_LINE_VERSION = '0.1.0'

/** Machine-readable output envelope version (WORLD-LINE-SPEC §3). */
export const ENVELOPE_SCHEMA_VERSION = 1

/** On-disk world-line store format version (state.json, manifests, objects). */
export const WORLD_LINE_FORMAT_VERSION = 1

/** The default profile name (WORLD-LINE-SPEC §3). */
export const DEFAULT_PROFILE = 'web'
