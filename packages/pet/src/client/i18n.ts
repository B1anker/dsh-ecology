/**
 * Self-contained zh/en strings.
 *
 * The shell has a `locale` service, but its client-side contract is not part
 * of the M0-verified surface (see host-types.ts), so injecting it would bind
 * the plugin to a guess. For the MVP the dictionary ships inside the bundle
 * and the locale comes from `navigator.language` — anything starting with
 * `zh` gets Chinese, everything else English. When the locale contract is
 * verified, this module is the single seam to rewire.
 *
 * @module @seaveyon/dsh-pet/client/i18n
 */

export type Locale = 'zh' | 'en'

export interface Strings {
  /** Label of the settings section slot. */
  settingsSection: string
  /** Settings panel: pet appearance picker. */
  appearanceLabel: string
  /** Settings panel: note that the pet itself lives on the desktop. */
  desktopHint: string
  /** Settings panel: rename input. */
  nameLabel: string
  /** Settings panel: desktop-companion summon row label. */
  companionLabel: string
  /** Settings panel: the desktop app answers the bridge. */
  companionConnected: string
  /** Badge marking an imported (non-built-in) desktop pet in the picker. */
  desktopPetBadge: string
  /** Settings panel: the desktop app is unreachable, showing the fallback roster. */
  desktopOfflineHint: string
  /** Settings panel: button that asks the host to launch the desktop app. */
  launchButton: string
  /** Settings panel: launch requested, waiting for the app to come up. */
  launchStarting: string
  /** Settings panel: the host reports the desktop app is not installed. */
  launchNotInstalled: string
  /** Settings panel: the launch request itself failed. */
  launchFailed: string
  /** Settings panel: link to the desktop app's download page. */
  launchDownloadLabel: string
}

const DICTIONARIES: Record<Locale, Strings> = {
  zh: {
    settingsSection: '宠物',
    appearanceLabel: '形象',
    desktopHint: '宠物显示在桌面 App 里，不在本页面上。',
    nameLabel: '名字',
    companionLabel: '桌面伴侣',
    companionConnected: '桌面宠物已连接。',
    desktopPetBadge: '导入',
    desktopOfflineHint: '桌面 App 未连接，连接后可选择形象。',
    launchButton: '启动桌面 App',
    launchStarting: '正在启动桌面 App…',
    launchNotInstalled: '这台机器上还没安装桌面 App。',
    launchFailed: '启动失败，请手动打开桌面 App。',
    launchDownloadLabel: '去下载',
  },
  en: {
    settingsSection: 'Pet',
    appearanceLabel: 'Appearance',
    desktopHint: 'The pet lives in the desktop app, not on this page.',
    nameLabel: 'Name',
    companionLabel: 'Desktop companion',
    companionConnected: 'Desktop pet connected.',
    desktopPetBadge: 'Imported',
    desktopOfflineHint: 'Desktop app not connected — connect it to pick a pet.',
    launchButton: 'Launch desktop app',
    launchStarting: 'Starting the desktop app…',
    launchNotInstalled: 'The desktop app is not installed on this machine.',
    launchFailed: 'Launch failed — open the desktop app manually.',
    launchDownloadLabel: 'Download it',
  },
}

/**
 * Pick a locale from a BCP-47 tag. Only the `zh` prefix matters; the runner-
 * up is always English, so unknown tags degrade gracefully.
 */
export function detectLocale(language: string | undefined): Locale {
  return language !== undefined && language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** The runtime strings for this page load. */
export function getStrings(locale: Locale = detectLocale(navigator.language)): Strings {
  return DICTIONARIES[locale]
}
