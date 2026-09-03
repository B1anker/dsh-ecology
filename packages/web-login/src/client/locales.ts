/**
 * Locale dictionaries for the account settings section.
 *
 * Registered with the shell `locale` service under {@link LOCALE_NS}. Keys use
 * `{name}` placeholders resolved by `locale.bind(ns)`.
 *
 * @module @seaveyon/dsh-web-login/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const LOCALE_NS = 'settings.web-login'

/** Flat key → template string. */
export type LocaleDict = Record<string, string>

/** Simplified Chinese (key-set source of truth). */
export const ZH: LocaleDict = {
  nav: '账户',
  methodLabel: '当前登录方式',
  methodPassword: '密码',
  methodGitHub: 'GitHub',
  methodRecovery: '恢复链接',
  methodBootstrap: '密码（初始设置）',
  roleLabel: '角色',
  roleOwner: '所有者',
  roleMember: '成员',
  statusLabel: '授权状态',
  statusPasswordOnly: '仅密码',
  statusAwaitingBind: '可绑定 GitHub',
  statusGitHubBound: '已绑定 GitHub',
  enrolledLabel: 'GitHub 绑定时间',
  lastLoginLabel: '上次 GitHub 登录',
  sessionExpiresLabel: '当前会话',
  bindGitHub: '绑定 GitHub 账户',
  bindGitHubHint: '可选。绑定后也可以用 GitHub 登录。',
  clientIdLabel: 'OAuth Client ID',
  oauthApp: '管理 OAuth Apps',
  oauthAppHint:
    '打开后进入 OAuth Apps，用上方 Client ID 对照。若要直达编辑页，把 URL 里 /applications/ 后的数字填到配置 githubOAuthAppId。',
  signOut: '退出登录',
  loading: '正在加载会话…',
  loadError: '无法加载会话信息。',
  sessionFoot: '会话保存在内存中，服务器重启后会失效。',
  remainingDays: '约 {count} 天后失效',
  remainingHours: '约 {count} 小时后失效',
  remainingMinutes: '约 {count} 分钟后失效',
  remainingSoon: '即将失效',
}

/** English dictionary; keys must match {@link ZH}. */
export const EN: LocaleDict = {
  nav: 'Account',
  methodLabel: 'Signed in with',
  methodPassword: 'Password',
  methodGitHub: 'GitHub',
  methodRecovery: 'Recovery link',
  methodBootstrap: 'Password (setup)',
  roleLabel: 'Role',
  roleOwner: 'Owner',
  roleMember: 'Member',
  statusLabel: 'Auth mode',
  statusPasswordOnly: 'Password only',
  statusAwaitingBind: 'GitHub binding available',
  statusGitHubBound: 'GitHub bound',
  enrolledLabel: 'GitHub bound at',
  lastLoginLabel: 'Last GitHub sign-in',
  sessionExpiresLabel: 'This session',
  bindGitHub: 'Bind GitHub account',
  bindGitHubHint: 'Optional. After binding, you can also sign in with GitHub.',
  clientIdLabel: 'OAuth Client ID',
  oauthApp: 'Manage OAuth Apps',
  oauthAppHint:
    'Open OAuth Apps and match the Client ID above. To deep-link the edit page, set githubOAuthAppId to the number after /applications/ in the URL.',
  signOut: 'Sign out',
  loading: 'Loading session…',
  loadError: 'Could not load session details.',
  sessionFoot: 'Sessions are held in memory and end when the server restarts.',
  remainingDays: 'expires in about {count} day(s)',
  remainingHours: 'expires in about {count} hour(s)',
  remainingMinutes: 'expires in about {count} minute(s)',
  remainingSoon: 'expires soon',
}

/** Both shipped locales for a single `locale.register` call. */
export const DICTS = { zh: ZH, en: EN } as const
