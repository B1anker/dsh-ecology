/**
 * The built-in pet roster: metadata only.
 *
 * Sprites live in the desktop app (packages/pet-desktop/assets), which serves
 * them to the picker over its bridge server — the page no longer draws pets
 * itself. What the plugin still needs to know is which roster ids are
 * built-in (versus imported): built-ins get localized display names here,
 * imports get a humanized id and an *Imported* badge in the picker
 * (settings-panel.tsx).
 *
 * @module @seaveyon/dsh-pet/client/pets
 */

import type { Locale } from './i18n.js'

/** One built-in pet. */
export interface PetDefinition {
  id: string
  label: Record<Locale, string>
}

/** The built-in roster, in picker order. Must match the desktop manifest. */
export const PETS: readonly PetDefinition[] = [
  { id: 'deepseek-chan', label: { zh: 'DeepSeek 酱', en: 'DeepSeek-chan' } },
]
