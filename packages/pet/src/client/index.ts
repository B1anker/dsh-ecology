/**
 * Client entry: the module the DSH shell loads at startup.
 *
 * The build wraps this module in the `__ModuleLoader__.load({ id, factory })`
 * envelope (see rslib.config.ts); from here down it is ordinary ESM TypeScript.
 * `react` is external in the bundle: the factory's `require` resolves it
 * against the shell's static module table at runtime.
 *
 * The plugin renders nothing on the page beyond its settings section. Its job
 * is being the desktop pet's mood source: `apply` assembles the settings
 * store and the mood state machine, wires live agent state into the machine
 * ({@link wireMoodSource}), and lets the bridge POST every mood change to the
 * desktop companion app. Everything degrades gracefully — no `slots` means
 * there is nowhere to render the panel; no `sessions` means the pet idles;
 * no `settingsScope` (or a throwing binder) means localStorage-only
 * persistence; no desktop app means the bridge sends into the void, silently.
 */

import { createElement } from 'react'

import { DesktopBridge } from './bridge.js'
import { DesktopPetsStore } from './desktop-pets.js'
import type { ClientContext } from './host-types.js'
import { getStrings } from './i18n.js'
import { PetStateMachine } from './mood.js'
import { wireMoodSource } from './mood-source.js'
import { PetSettingsStore } from './settings.js'
import { PetSettingsPanel } from './settings-panel.js'

export const name = '@seaveyon/dsh-pet'

// `locale` is deliberately absent: its client contract is unverified (see
// i18n.ts), and injecting an unknown service would bind us to a guess.
export const inject = ['slots', 'sessions', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const sessions = ctx.get('sessions')
  const settingsScope = ctx.get('settingsScope')
  const settings = new PetSettingsStore({ binder: settingsScope })
  const machine = new PetStateMachine()
  const strings = getStrings()

  // The mood source: agent snapshots in, moods out. Disposed with the plugin
  // where the context offers an effect hook.
  const disposeMoodSource = wireMoodSource(sessions, machine)
  ctx.effect?.(() => disposeMoodSource(), 'dsh-pet:mood-source')

  // Side channel to the desktop app: self-subscribed, silent when the setting
  // is off or the app isn't there. Disposed the same way.
  const bridge = new DesktopBridge({ settings, machine })
  ctx.effect?.(() => () => bridge.dispose(), 'dsh-pet:bridge')

  // Imported-pet discovery: one shared roster the settings panel pulls lazily
  // (each time it opens). Empty until the desktop app answers, and simply
  // empty when it never does.
  const desktopPets = new DesktopPetsStore()

  const slots = ctx.get('slots')
  if (slots === undefined) return

  // The slot API mounts components without props, so the component is a
  // closure over the wiring above.
  const Panel = () => createElement(PetSettingsPanel, { settings, desktopPets })

  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: 'dsh-pet-settings',
        order: 60,
        label: () => strings.settingsSection,
      },
      Panel,
    ),
  )
}
