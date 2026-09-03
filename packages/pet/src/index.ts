/**
 * Host entry: a deliberate no-op Cordis plugin.
 *
 * The client module system only discovers packages that sit in the host
 * Loader's tree (see cordis.patch.yml), and a Loader row must resolve to a
 * loadable plugin module — so the package needs a host face even though every
 * feature lives in the browser bundle. Keeping it empty is the point: no
 * routes, no services, nothing to break when the host moves.
 */

export const name = 'dsh-pet'

export function apply(): void {}
