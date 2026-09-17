/**
 * The fence between this plugin's React tree and the host shell's.
 *
 * The overlay is rendered inside the shell's own React root. Without a
 * boundary, one throw during a render — a malformed world response reaching
 * a component, a canvas node with a shape the renderer did not expect — does
 * not stop at the panel: React unmounts the nearest boundary's subtree, and
 * when the nearest boundary is the host's, that is the whole DSH page. So
 * every surface this plugin mounts sits behind one of these: the panel gets
 * a fallback that says what happened and offers a retry or a way out; the
 * corner entry gets a silent one, because an entry button that cannot
 * render is better absent than rendered as a crash card in the page corner.
 *
 * @module client/error-boundary
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface CrashFallbackProps {
  error: Error
  /** Remount the children; the fallback offers it as "retry". */
  reset(): void
}

interface Props {
  /** Rendered in place of the children after a render error. */
  fallback: (props: CrashFallbackProps) => ReactNode
  /** Where the error is reported besides the fallback; the console by default. */
  onError?: (error: Error, info: ErrorInfo) => void
  children?: ReactNode
}

interface State {
  error: Error | null
}

function reportToConsole(error: Error, info: ErrorInfo): void {
  console.error('[world-line] a panel render failed and was contained', error, info.componentStack)
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(thrown: unknown): State {
    return { error: thrown instanceof Error ? thrown : new Error(String(thrown)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    ;(this.props.onError ?? reportToConsole)(error, info)
  }

  private readonly reset = (): void => {
    this.setState({ error: null })
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return this.props.fallback({ error: this.state.error, reset: this.reset })
  }
}

/**
 * What the world-line panel shows in place of itself after a render error:
 * the panel's own frame, so the host's chrome stays where it was, and two
 * ways on — remount the panel, or close it and go back to the shell.
 */
export function PanelCrash({
  error,
  reset,
  close,
}: CrashFallbackProps & { close(): void }): ReactNode {
  return (
    <div className="wl-page wl-crash" role="alert" data-world-line-crash="true">
      <div className="wl-crash-card">
        <h2>世界线面板出错了</h2>
        <p>面板在渲染时抛出异常，已被隔离在面板内；DSH 的其余界面不受影响。</p>
        <pre className="wl-crash-detail">{error.message}</pre>
        <div className="wl-crash-actions">
          <button type="button" className="wl-button wl-primary" onClick={reset}>
            重试
          </button>
          <button type="button" className="wl-button" onClick={close}>
            关闭面板
          </button>
        </div>
      </div>
    </div>
  )
}

/** Styles for {@link PanelCrash}; appended to the plugin's stylesheet. */
export const crashStyles = `
.wl-page.wl-crash{display:grid;place-items:center;padding:32px;overflow:auto}
.wl-crash-card{max-width:520px;width:100%;padding:24px 28px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--wl-radius-panel,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
.wl-crash-card h2{margin:0 0 8px;font-size:16px;font-weight:600}
.wl-crash-card p{margin:0 0 12px;color:var(--dsw-alias-label-secondary)}
.wl-crash-detail{margin:0 0 16px;padding:10px 12px;max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-base);border-radius:var(--wl-radius-control,6px);user-select:text}
.wl-crash-actions{display:flex;gap:8px;justify-content:flex-end}
`
