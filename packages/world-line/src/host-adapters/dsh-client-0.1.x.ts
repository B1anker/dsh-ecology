/**
 * DSH 0.1.2-rc.1 web-client contract (Phase 3, empirically exercised on
 * 2026-09-04 against a real boot + headless Google Chrome):
 *
 *  - The page (title "DeepSeek Harness") is an SPA with a single mount
 *    `#root`; the URL drops the `?token=` query after session handoff.
 *  - Boot globals injected by the app shell: `window.__DSH_BOOT__`
 *    ({rev, entries[], batches[]} — the plugin client manifest) and
 *    `window.__DSH_BOOT_READY__` (object; presence only, no promise).
 *  - The settled shell shows: buttons "新会话" and "设置", a conversation
 *    tree `[role=tree]` (empty state "暂无会话"), and "工作区" /
 *    "选择一个工作区开始" workspace empty state, plus a beta-notice dialog
 *    that does not block these markers. No console errors, pageerrors, or
 *    failed /plugins requests in a healthy boot.
 *
 * A healthy session produced zero console/page/request errors; these markers
 * are the `clientReady` signal consumed by the browser probe (§6 steps 4-6).
 */

/** Marker texts the settled shell must expose (aside/beta dialog included). */
export const CLIENT_SHELL_MARKERS = ['新会话', '设置'] as const

/** The conversation/workspace shell is reached via one of these empty states. */
export const CLIENT_SHELL_STATES = ['暂无会话', '选择一个工作区开始', '标准模式'] as const

/** Boot globals injected by the app shell (presence check only). */
export const CLIENT_BOOT_GLOBALS = ['__DSH_BOOT__', '__DSH_BOOT_READY__'] as const

/** Mount element that must hold children once the shell renders. */
export const CLIENT_MOUNT_SELECTOR = '#root'

/** Failed same-origin /plugins|/api|/sse requests count against the boot. */
export const CLIENT_BAD_REQUEST_RE = /^\/(?:plugins|api|sse)/
