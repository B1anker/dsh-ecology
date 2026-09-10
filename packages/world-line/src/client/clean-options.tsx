import { useCallback } from 'react'
import type { ApiFn } from './api-types.js'
import { useApiQuery } from './async.js'
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
  api: ApiFn
  source: string
  value: string[]
  onChange(value: string[]): void
  copyConfig: boolean
  onCopyConfig(value: boolean): void
  disabled: boolean
}) {
  const request = useCallback(
    (signal: AbortSignal) =>
      api({ action: 'clean-plugins', id: source }, signal).then(
        (result: { plugins: { id: string; disabled: boolean }[] }) => result.plugins,
      ),
    [api, source],
  )
  const {
    data: plugins,
    error,
    reload,
  } = useApiQuery<{ id: string; disabled: boolean }[]>(api, request, [source])
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
          <button type="button" className="wl-button" onClick={reload}>
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
