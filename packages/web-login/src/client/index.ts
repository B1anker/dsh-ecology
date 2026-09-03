/**
 * Client entry: the module the DSH shell loads at startup.
 *
 * Registers zh/en copy with the shell `locale` service and mounts the account
 * section into `settings.section`. React stays external so the shell's copy is
 * the one that renders this panel.
 *
 * @module @seaveyon/dsh-web-login/client
 */

import { createElement } from 'react'
import { AccountPanel } from './account-panel.js'
import type { ClientContext } from './host-types.js'
import { DICTS, LOCALE_NS } from './locales.js'

export const name = '@seaveyon/dsh-web-login'

export const inject = ['slots', 'locale']

/**
 * Register the account settings section when the shell exposes slots + locale.
 * @param ctx - Cordis-style client context.
 */
export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots')
  const locale = ctx.locale ?? ctx.get('locale')
  if (slots === undefined || locale === undefined) return

  ctx.effect?.(() => locale.register(LOCALE_NS, DICTS), 'dsh-web-login: account dictionaries')

  const t = locale.bind(LOCALE_NS)
  const Panel = (props: { t?: typeof t }) =>
    createElement(AccountPanel, {
      t: props.t ?? t,
      locale,
    })

  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: 'dsh-web-login-account',
        order: 20,
        locale: LOCALE_NS,
        label: () => t('nav'),
      },
      Panel,
    ),
  )
}
