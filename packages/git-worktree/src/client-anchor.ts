/**
 * Where the worktree control mounts in the shell.
 *
 * The conversation hero row — the workspace chip, then the agent-preset seat —
 * declares no list slot a plugin could register into, so the control is
 * appended to that row by DOM lookup. The row's CSS-module class keeps its
 * source name as a suffix (`<hash>_heroWorkspaceRow`), which is the most
 * stable handle the host offers: it survives a rebuild, a locale switch, and
 * whatever preset the user has selected.
 *
 * The anchor it replaces was the preset seat's *label*. That label is the
 * selected preset's name, so the control only appeared while the default
 * "标准模式 / Standard mode" preset was active and the UI ran in one of the
 * two locales that string was matched in. It stays as the last resort for
 * hosts whose hero row predates the class.
 *
 * @module client-anchor
 */

/** The subset of `Document` the lookup needs; a test hands in a jsdom one. */
export type AnchorDocument = Pick<Document, 'querySelector' | 'querySelectorAll'>

const HERO_ROW_SELECTOR = '[class*="_heroWorkspaceRow"]'
const LEGACY_SEAT_LABEL = /标准模式|standard mode/i

/**
 * Find the element the worktree control should be appended to.
 * @param doc - the document to search; the shell's `document` in production.
 * @returns the hero row, the legacy seat's parent, or undefined when the hero
 *   is not on screen (mid-session, login page).
 */
export function findMountHost(doc: AnchorDocument): HTMLElement | undefined {
  const row = doc.querySelector<HTMLElement>(HERO_ROW_SELECTOR)
  if (row !== null) return row
  const seat = [...doc.querySelectorAll<HTMLElement>('button')].find((element) =>
    LEGACY_SEAT_LABEL.test(element.textContent ?? ''),
  )
  return seat?.parentElement ?? undefined
}
