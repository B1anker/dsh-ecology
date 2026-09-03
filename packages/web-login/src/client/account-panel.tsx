/**
 * Account section for the shell settings surface.
 *
 * Copy comes from the shell `locale` service (`t`). Colors use `--dsw-alias-*`
 * tokens so light/dark/system themes apply without a local palette.
 *
 * @module @seaveyon/dsh-web-login/client/account-panel
 */

import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import type { LocaleService, Translate } from './host-types.js'
import {
  fetchSessionInfo,
  githubOAuthAppUrl,
  type SessionAuthStatus,
  type SessionInfo,
} from './session.js'

const sectionStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '14px',
} as const

const rowStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(7rem, 9rem) 1fr',
  gap: '8px 12px',
  alignItems: 'baseline',
  margin: 0,
  fontSize: '13px',
  lineHeight: 1.45,
} as const

const labelStyle = {
  color: 'var(--dsw-alias-label-secondary)',
} as const

const valueStyle = {
  color: 'var(--dsw-alias-label-primary)',
  fontWeight: 560,
  overflowWrap: 'anywhere',
} as const

const mutedStyle = {
  ...valueStyle,
  fontWeight: 400,
  color: 'var(--dsw-alias-label-tertiary)',
} as const

const monoStyle = {
  ...valueStyle,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: '12px',
  fontWeight: 500,
} as const

const linkStyle = {
  ...valueStyle,
  color: 'var(--dsw-alias-brand-primary)',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
} as const

const primaryButtonStyle = {
  appearance: 'none',
  display: 'inline-block',
  border: '1px solid transparent',
  borderRadius: '8px',
  padding: '8px 12px',
  font: 'inherit',
  fontSize: '13px',
  fontWeight: 560,
  cursor: 'pointer',
  textDecoration: 'none',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-inverted)',
} as const

const secondaryLinkStyle = {
  ...primaryButtonStyle,
  background: 'transparent',
  color: 'var(--dsw-alias-brand-text)',
  borderColor: 'var(--dsw-alias-border-l2)',
} as const

const dangerButtonStyle = {
  ...primaryButtonStyle,
  background: 'transparent',
  color: 'var(--dsw-alias-state-error-primary)',
  borderColor: 'var(--dsw-alias-state-error-secondary)',
} as const

const hintStyle = {
  margin: 0,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: '12px',
  lineHeight: 1.45,
} as const

const actionsStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
} as const

const footerStyle = {
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'space-between',
  gap: '12px',
  marginTop: '8px',
} as const

const footStyle = {
  ...hintStyle,
  margin: 0,
  flex: '1 1 auto',
} as const

export interface AccountPanelProps {
  /** Bound translate function for {@link LOCALE_NS}. */
  t: Translate
  /** Live locale service for date formatting + re-render on language switch. */
  locale: LocaleService
}

/**
 * Build a public GitHub profile URL for a login handle.
 * @param login - GitHub login; empty/unsafe values yield null.
 * @returns an https profile URL, or null when the login cannot be linked.
 */
function githubProfileUrl(login: string | null): string | null {
  if (login === null || login === '') return null
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(login)) return null
  return `https://github.com/${login}`
}

/**
 * Map shell locale id to an Intl locale tag.
 * @param active - `locale.getSnapshot().active`.
 * @returns BCP-47 tag for DateTimeFormat.
 */
function intlLocale(active: string): string {
  return active.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/**
 * Format an ISO timestamp for the panel.
 * @param value - ISO string.
 * @param activeLocale - shell locale id.
 * @returns localized date-time text, or the raw value on parse failure.
 */
function formatTimestamp(value: string, activeLocale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  try {
    return new Intl.DateTimeFormat(intlLocale(activeLocale), {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  } catch {
    return date.toLocaleString()
  }
}

/**
 * Describe how long remains before the cookie session expires.
 * @param remainingMs - milliseconds remaining.
 * @param t - translate function.
 * @returns short remaining-time text.
 */
function formatRemaining(remainingMs: number, t: Translate): string {
  if (remainingMs <= 60_000) return t('remainingSoon')
  const minutes = Math.round(remainingMs / 60_000)
  if (minutes < 90) return t('remainingMinutes', { count: minutes })
  const hours = Math.round(remainingMs / 3_600_000)
  if (hours < 48) return t('remainingHours', { count: hours })
  const days = Math.round(remainingMs / 86_400_000)
  return t('remainingDays', { count: days })
}

/**
 * Human-readable auth-mode label.
 * @param status - server status code.
 * @param t - translate function.
 * @returns display text.
 */
function statusLabel(status: SessionAuthStatus, t: Translate): string {
  switch (status) {
    case 'password_only':
      return t('statusPasswordOnly')
    case 'awaiting_github_bind':
      return t('statusAwaitingBind')
    case 'github_bound':
      return t('statusGitHubBound')
    default:
      return status
  }
}

/**
 * Human-readable method value for a session provider.
 * @param info - session payload.
 * @param t - translate function.
 * @returns display nodes (GitHub login may be a profile link).
 */
function methodValue(info: SessionInfo, t: Translate): ReactNode {
  switch (info.provider) {
    case 'github': {
      const profile = githubProfileUrl(info.githubLogin)
      const handle = info.githubLogin ? `@${info.githubLogin}` : null
      if (handle !== null && profile !== null) {
        return (
          <>
            {t('methodGitHub')}{' '}
            <a href={profile} target="_blank" rel="noopener noreferrer" style={linkStyle}>
              {handle}
            </a>
            {info.githubUserId !== null ? (
              <span style={mutedStyle}> (id {info.githubUserId})</span>
            ) : null}
          </>
        )
      }
      if (info.githubUserId !== null) {
        return `${t('methodGitHub')} (id ${info.githubUserId})`
      }
      return t('methodGitHub')
    }
    case 'password':
      return t('methodPassword')
    case 'password-bootstrap':
      return t('methodBootstrap')
    case 'recovery':
      return t('methodRecovery')
    default:
      return info.provider
  }
}

/**
 * Human-readable role label.
 * @param role - session role.
 * @param t - translate function.
 * @returns display text.
 */
function roleLabel(role: SessionInfo['role'], t: Translate): string {
  return role === 'owner' ? t('roleOwner') : t('roleMember')
}

export function AccountPanel({ t, locale }: AccountPanelProps) {
  const [info, setInfo] = useState<SessionInfo | null | undefined>(undefined)
  const activeLocale = useSyncExternalStore(
    (onStoreChange) => locale.subscribe(onStoreChange),
    () => locale.getSnapshot().active,
    () => locale.getSnapshot().active,
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next = await fetchSessionInfo()
      if (!cancelled) setInfo(next)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section aria-label={t('nav')} style={sectionStyle}>
      {info === undefined ? (
        <p style={hintStyle}>{t('loading')}</p>
      ) : info === null ? (
        <p style={hintStyle}>{t('loadError')}</p>
      ) : (
        <>
          <p style={rowStyle}>
            <span style={labelStyle}>{t('methodLabel')}</span>
            <span style={valueStyle}>{methodValue(info, t)}</span>
          </p>
          <p style={rowStyle}>
            <span style={labelStyle}>{t('roleLabel')}</span>
            <span style={valueStyle}>{roleLabel(info.role, t)}</span>
          </p>
          <p style={rowStyle}>
            <span style={labelStyle}>{t('statusLabel')}</span>
            <span style={valueStyle}>{statusLabel(info.status, t)}</span>
          </p>
          {info.enrolledAt !== null ? (
            <p style={rowStyle}>
              <span style={labelStyle}>{t('enrolledLabel')}</span>
              <span style={valueStyle}>{formatTimestamp(info.enrolledAt, activeLocale)}</span>
            </p>
          ) : null}
          {info.lastLoginAt !== null ? (
            <p style={rowStyle}>
              <span style={labelStyle}>{t('lastLoginLabel')}</span>
              <span style={valueStyle}>{formatTimestamp(info.lastLoginAt, activeLocale)}</span>
            </p>
          ) : null}
          <p style={rowStyle}>
            <span style={labelStyle}>{t('sessionExpiresLabel')}</span>
            <span style={valueStyle}>
              {formatRemaining(info.sessionRemainingMs, t)}
              <span style={mutedStyle}>
                {' '}
                · {formatTimestamp(info.sessionExpiresAt, activeLocale)}
              </span>
            </span>
          </p>
          {info.githubEnabled && info.githubClientId !== null ? (
            <p style={rowStyle}>
              <span style={labelStyle}>{t('clientIdLabel')}</span>
              <span style={monoStyle}>{info.githubClientId}</span>
            </p>
          ) : null}
          <div style={actionsStyle}>
            {info.canBindGitHub ? (
              <a href="/auth/github/enroll" style={primaryButtonStyle}>
                {t('bindGitHub')}
              </a>
            ) : null}
            {info.githubEnabled ? (
              <a
                href={githubOAuthAppUrl(info.githubOAuthAppId)}
                target="_blank"
                rel="noopener noreferrer"
                style={secondaryLinkStyle}
              >
                {t('oauthApp')}
              </a>
            ) : null}
          </div>
          {info.canBindGitHub ? <p style={hintStyle}>{t('bindGitHubHint')}</p> : null}
          {info.githubEnabled ? <p style={hintStyle}>{t('oauthAppHint')}</p> : null}
          <div style={footerStyle}>
            <p style={footStyle}>{t('sessionFoot')}</p>
            <form method="post" action="/logout" style={{ margin: 0, flex: '0 0 auto' }}>
              <button type="submit" style={dangerButtonStyle}>
                {t('signOut')}
              </button>
            </form>
          </div>
        </>
      )}
    </section>
  )
}
