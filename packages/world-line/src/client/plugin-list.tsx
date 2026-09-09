import { CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight'
import { Copy } from '@phosphor-icons/react/dist/csr/Copy'
import { useState } from 'react'
import type { DependencyRecord } from '../domain/snapshot.js'

type Plugin = DependencyRecord & {
  displayVersion?: string
  bundle: boolean
  core?: boolean
  configLayers?: { label: string; entries: unknown[] }[]
  configIncomplete?: boolean
}
export function PluginList({
  plugins,
  onChange,
}: {
  plugins: Plugin[]
  onChange(plugin: Plugin, remove: boolean): void
}) {
  const [query, setQuery] = useState('')
  const [copyNotice, setCopyNotice] = useState('')
  const filtered = plugins.filter((plugin) =>
    plugin.name.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <div className="wl-plugin-list">
      <div className="wl-plugin-list-heading">
        <strong>{plugins.length} 个插件</strong>
        <span>点击插件查看配置和操作</span>
      </div>
      <input
        aria-label="搜索插件"
        placeholder="搜索插件名称"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="wl-plugin-columns" aria-hidden="true">
        <span>插件</span>
        <span>版本</span>
        <span />
      </div>
      {filtered.map((plugin) => (
        <details className="wl-plugin-row" key={plugin.name}>
          <summary>
            <span className="wl-plugin-row-layout">
              <span className="wl-plugin-name">
                <strong>{plugin.name}</strong>
                <small>
                  {plugin.core
                    ? '核心组件'
                    : plugin.kind === 'file' || plugin.kind === 'link'
                      ? '本地插件'
                      : '已安装'}
                </small>
              </span>
              <span className="wl-plugin-version">
                {plugin.displayVersion ?? plugin.resolved?.version ?? '版本未知'}
              </span>
              <CaretRight className="wl-plugin-expand-icon" size={14} aria-hidden="true" />
            </span>
          </summary>
          <div className="wl-plugin-expanded">
            <h4>配置信息</h4>
            <p className="wl-muted">以下是配置文件中的内容，不代表运行时状态。敏感值已隐藏。</p>
            {plugin.configIncomplete && (
              <p className="wl-error">部分配置未能读取，以下内容可能不完整。</p>
            )}
            {!plugin.configLayers?.length && (
              <p className="wl-muted">
                未找到这个插件的配置项，可能使用内置默认值或由其他组件加载。
              </p>
            )}
            {plugin.configLayers?.map((layer) => (
              <section key={layer.label}>
                <h5>{layer.label}</h5>
                {layer.entries.map((value, index) => {
                  const entry = value as {
                    id?: string
                    disabled?: boolean
                    fields?: { key: string; value: unknown }[]
                  }
                  const fields = (entry.fields ?? []).map(({ key, value }) => [key, value] as const)
                  return (
                    <div key={index} className="wl-plugin-config">
                      {layer.entries.length > 1 && <small>{entry.id ?? `配置 ${index + 1}`}</small>}
                      {entry.disabled === true && <p>此配置将插件停用</p>}
                      {!fields.length && <p className="wl-muted">没有额外参数</p>}
                      <dl>
                        {fields.map(([key, value]) => (
                          <div key={key}>
                            <dt>{key}</dt>
                            <dd>
                              {value && typeof value === 'object' && '__jsExpr' in value
                                ? '动态表达式（未执行）'
                                : typeof value === 'string'
                                  ? value === '<redacted>'
                                    ? '已隐藏'
                                    : value
                                  : JSON.stringify(value, null, 2)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  )
                })}
              </section>
            ))}
            <section className="wl-plugin-origin">
              <div className="wl-plugin-origin-heading">
                <h4>安装来源</h4>
                <span>
                  {(
                    {
                      registry: 'npm 包',
                      file: '本地文件',
                      link: '本地链接',
                      workspace: '工作区',
                      git: 'Git 仓库',
                      tarball: '压缩包',
                      unknown: '未知来源',
                    } as Record<string, string>
                  )[plugin.kind] ?? plugin.kind}
                </span>
              </div>
              <dl>
                {!(
                  plugin.target &&
                  ['file:', 'link:'].some((prefix) => plugin.spec === `${prefix}${plugin.target}`)
                ) && (
                  <div>
                    <dt>安装规格</dt>
                    <dd>
                      <code>{plugin.spec}</code>
                    </dd>
                  </div>
                )}
                {plugin.target && (
                  <div>
                    <dt>本地路径</dt>
                    <dd>
                      <code>{plugin.target}</code>
                      <span className={plugin.targetExists ? 'wl-muted' : 'wl-error'}>
                        {plugin.targetExists ? '路径可用' : '路径不可用'}
                      </span>
                    </dd>
                  </div>
                )}
              </dl>
              <button
                className="wl-plugin-copy"
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(plugin.target ?? plugin.spec)
                    setCopyNotice(`${plugin.name}:ok`)
                  } catch {
                    setCopyNotice(`${plugin.name}:error`)
                  }
                }}
              >
                <Copy size={13} />
                {plugin.target ? '复制路径' : '复制安装规格'}
              </button>
              {copyNotice.startsWith(`${plugin.name}:`) && (
                <span className="wl-plugin-copy-result" role="status">
                  {copyNotice.endsWith(':ok') ? '已复制' : '复制失败，请手动选择文字'}
                </span>
              )}
            </section>
            <div className="wl-flow-actions-row">
              <button className="wl-button" onClick={() => onChange(plugin, false)}>
                {plugin.kind === 'file' || plugin.kind === 'link' ? '验证本地更新' : '更换版本'}
              </button>
              <button
                className="wl-button"
                disabled={plugin.core}
                onClick={() => onChange(plugin, true)}
              >
                {plugin.core ? '核心组件不可卸载' : '卸载插件'}
              </button>
            </div>
          </div>
        </details>
      ))}
      {!filtered.length && (
        <p className="wl-muted">{plugins.length ? '没有匹配的插件' : '暂无插件记录'}</p>
      )}
    </div>
  )
}
