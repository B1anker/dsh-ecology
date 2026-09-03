/**
 * Client entry: the module the DSH shell loads at startup.
 *
 * The build wraps this module in the `__ModuleLoader__.load({ id, factory })`
 * envelope (see rslib.config.ts); from here down it is ordinary ESM TypeScript.
 * `react` is external in the bundle: the factory's `require` resolves it
 * against the shell's static module table at runtime.
 *
 * Wiring only: `apply` assembles the settings store and the mood state
 * machine, then hands both to the two slot components. Everything degrades
 * gracefully — no `slots` means there is nowhere to render, so the plugin
 * inertly returns; no `sessions` means the pet idles; no `settingsScope`
 * (or a throwing binder) means localStorage-only persistence.
 */

import { createElement } from 'react'

import { DesktopBridge } from './bridge.js'
import { DesktopPetsStore } from './desktop-pets.js'
import type { ClientContext } from './host-types.js'
import { getStrings } from './i18n.js'
import { PetStateMachine } from './mood.js'
import { PetOverlay } from './overlay.js'
import { PetSettingsStore } from './settings.js'
import { PetSettingsPanel } from './settings-panel.js'

export const name = '@seaveyon/dsh-pet'

// `locale` is deliberately absent: its client contract is unverified (see
// i18n.ts), and injecting an unknown service would bind us to a guess.
export const inject = ['slots', 'sessions', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots')
  if (slots === undefined) return

  const sessions = ctx.get('sessions')
  const settingsScope = ctx.get('settingsScope')
  const settings = new PetSettingsStore({ binder: settingsScope })
  const machine = new PetStateMachine()
  const strings = getStrings()

  // Side channel to the optional desktop app: self-subscribed, silent when
  // the setting is off (the default) or the app isn't there. Disposed with
  // the plugin where the context offers an effect hook.
  const bridge = new DesktopBridge({ settings, machine })
  ctx.effect?.(() => () => bridge.dispose(), 'dsh-pet:bridge')

  // Imported-pet discovery: one shared roster, pulled lazily by the surfaces
  // (overlay on mount, panel each time it opens). Empty until the desktop app
  // answers, and simply empty when it never does.
  const desktopPets = new DesktopPetsStore()

  // The slot API mounts components without props, so the components are
  // closures over the wiring above.
  const Overlay = () => createElement(PetOverlay, { settings, machine, sessions, desktopPets })
  const Panel = () => createElement(PetSettingsPanel, { settings, desktopPets })

  slots.inject('shell.overlay', () =>
    slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-pet',
        order: 900,
        label: () => settings.getSnapshot().name || strings.defaultPetName,
      },
      Overlay,
    ),
  )
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
