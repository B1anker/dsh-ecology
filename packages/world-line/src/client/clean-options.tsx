import { useEffect, useState } from 'react'
import { MultiSelect } from './select.js'

export function CleanOptions({
  api,
  source,
  value,
  onChange,
  copyConfig,
  onCopyConfig,
  disabled,
}: {
  api(body: unknown, signal?: AbortSignal): Promise<any>
  source: string
  value: string[]
  onChange(value: string[]): void
  copyConfig: boolean
  onCopyConfig(value: boolean): void
  disabled: boolean
}) {
  const [plugins, setPlugins] = useState<{ id: string; disabled: boolean }[] | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setPlugins(null)
    setError('')
    void api({ action: 'clean-plugins', id: source }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPlugins(result.plugins)
        return undefined
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message)
      })
    return () => controller.abort()
  }, [api, source, revision])
  return (
    <>
      <p className="wl-muted">
        从核心插件和全新配置开始，不复制会话、账户绑定或登录状态。运行时仍沿用环境变量中的模型凭据。
      </p>
      <MultiSelect
        label="添加现有插件（可选）"
        value={value}
        onChange={onChange}
        options={(plugins ?? []).map((p) => ({ value: p.id, label: p.id, disabled: p.disabled }))}
        disabled={disabled || plugins === null}
        placeholder={
          error
            ? '插件列表加载失败，仍可创建纯核心环境'
            : plugins === null
              ? '正在获取插件…'
              : '不添加插件，仅加载核心'
        }
      />
      {error && (
        <p className="wl-error" role="alert">
          {error}{' '}
          <button type="button" className="wl-button" onClick={() => setRevision((n) => n + 1)}>
            重试
          </button>
        </p>
      )}
      {!!value.length && (
        <label className="wl-choice">
          <input
            type="checkbox"
            checked={copyConfig}
            disabled={disabled}
            onChange={(e) => onCopyConfig(e.target.checked)}
          />
          同时复制这些插件的配置
        </label>
      )}
    </>
  )
}
