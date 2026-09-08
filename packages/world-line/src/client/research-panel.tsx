import { useEffect, useState } from 'react'
import { HudSelect, HudTabs } from './hud-controls.js'
export function ResearchPanel({
  id,
  api,
  onJob,
}: {
  id: string
  api(body: unknown): Promise<any>
  onJob(id: string): void
}) {
  const [topic, setTopic] = useState('diagnose')
  const [historyLimit, setHistoryLimit] = useState(5)
  const [breakStale, setBreakStale] = useState(false)
  const [entry, setEntry] = useState<{ id: string; url: string } | null>(null)
  const [sessions, setSessions] = useState<any[]>([]),
    [snapshots, setSnapshots] = useState<any[]>([]),
    [good, setGood] = useState(''),
    [bad, setBad] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [versions, setVersions] = useState(''),
    [policy, setPolicy] = useState<any>(null),
    [upgrades, setUpgrades] = useState<any[]>([]),
    [deployment, setDeployment] = useState<any>(null),
    [lab, setLab] = useState(''),
    [accepted, setAccepted] = useState(false)
  const [bundle, setBundle] = useState(''),
    [requirements, setRequirements] = useState<Record<string, string>>({})
  const refresh = async () => {
    const [a, b] = await Promise.all([
      api({ action: 'investigations' }),
      api({ action: 'snapshot-list', id }),
    ])
    setSessions(a.filter((s: any) => s.sourceId === id))
    setSnapshots(b)
    const [p, u, d] = await Promise.all([
      api({ action: 'upgrade-policy', id }),
      api({ action: 'upgrade-results' }),
      api({ action: 'deployment-status' }),
    ])
    setPolicy(p)
    setUpgrades(u.filter((r: any) => r.sourceId === id))
    setDeployment(d)
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message))
  }, [id])
  const act = async (body: object) => {
    setBusy(true)
    setError('')
    try {
      const r = await api(body)
      if (r.jobId) onJob(r.jobId)
      else await refresh()
      return r
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }
  const download = (value: unknown, name: string) => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  let required: string[] = []
  try {
    required = JSON.parse(bundle).requiredFiles ?? []
  } catch {}
  return (
    <div className="wl-flow-actions wl-workflow-body">
      <HudTabs
        value={topic}
        onChange={setTopic}
        label="排障与交付功能"
        items={[
          { id: 'diagnose', title: '定位问题' },
          { id: 'transfer', title: '环境交付' },
          { id: 'updates', title: '升级验证' },
          { id: 'deployment', title: '部署守护' },
        ]}
      />
      <p className="wl-workflow-intro">
        {
          {
            diagnose: '最近哪里变坏了？在隔离实验中逐步缩小范围，正式环境保持可用。',
            transfer: '带走一套可复现的配置。在目标电脑补充秘密，再验证是否适用。',
            updates: '先确认兼容，再决定升级。验证结果不会直接替换你正在使用的环境。',
            deployment: '把已验证环境保留为完整部署。准备、切换、启用守护是三个明确步骤。',
          }[topic]
        }
      </p>
      <label>
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        {topic === 'deployment'
          ? '我已核对目标环境，允许下方明确选择的部署操作'
          : '我已核对来源环境，下一步先在隔离环境中操作'}
      </label>
      <details className="wl-advanced">
        <summary>中断处理选项</summary>
        <label>
          <input
            type="checkbox"
            checked={breakStale}
            onChange={(e) => setBreakStale(e.target.checked)}
          />
          允许清理已确认死亡进程的失效锁；活动进程仍受保护。
        </label>
      </details>
      {error && (
        <p className="wl-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="wl-button"
        disabled={busy}
        onClick={() => void refresh().catch((e) => setError(e.message))}
      >
        刷新进度
      </button>
      <section hidden={topic !== 'diagnose'} className="wl-event-detail">
        <h3>定位什么时候开始出问题</h3>
        <p>从同一祖先链选择好点与坏点。每步建立独立实验，先复验两端。</p>
        <label>
          好点
          <HudSelect value={good} onChange={(e) => setGood(e.target.value)}>
            <option value="">选择快照</option>
            {snapshots.map((s: any) => (
              <option key={s.snapshotId ?? s.id} value={s.snapshotId ?? s.id}>
                {s.label ?? s.title ?? s.snapshotId ?? s.id}
              </option>
            ))}
          </HudSelect>
        </label>
        <label>
          坏点
          <HudSelect value={bad} onChange={(e) => setBad(e.target.value)}>
            <option value="">选择快照</option>
            {snapshots.map((s: any) => (
              <option key={s.snapshotId ?? s.id} value={s.snapshotId ?? s.id}>
                {s.label ?? s.title ?? s.snapshotId ?? s.id}
              </option>
            ))}
          </HudSelect>
        </label>
        <button
          className="wl-button"
          disabled={busy || !good || !bad}
          onClick={() =>
            void act({ action: 'investigation-create', kind: 'time', sourceId: id, good, bad })
          }
        >
          创建时间排障
        </button>
        <button
          className="wl-button"
          disabled={busy}
          onClick={() =>
            void act({ action: 'investigation-create', kind: 'plugins', sourceId: id })
          }
        >
          排查当前插件组合
        </button>
      </section>
      {topic === 'diagnose' &&
        sessions.slice(0, historyLimit).map((s) => (
          <article className="wl-event-detail" key={s.id}>
            <strong>{s.kind === 'time' ? '时间二分' : '插件组合排障'}</strong>
            <p>
              {s.id} ·{' '}
              {
                {
                  ready: '等待试验',
                  running: '验证中',
                  review: '等待判断',
                  complete: '定位完成',
                  inconclusive: '证据不足',
                }[s.status as string]
              }{' '}
              · 已完成 {s.trials.length} 次
            </p>
            <p>{s.note}</p>
            {s.active && (
              <>
                <p>
                  本步：{s.active.snapshotId ?? s.active.plugins?.join('、') ?? '仅核心'} ·{' '}
                  {s.active.labId}
                </p>
                {s.active.error && <p>{s.active.error}</p>}
              </>
            )}
            {s.status === 'ready' && (
              <>
                <button
                  className="wl-button"
                  disabled={busy}
                  onClick={() => void act({ action: 'investigation-run', id: s.id })}
                >
                  运行下一步，手动判断
                </button>
                <button
                  className="wl-button"
                  disabled={busy}
                  onClick={() =>
                    void act({ action: 'investigation-run', id: s.id, automatic: true })
                  }
                >
                  按浏览器探针自动排查
                </button>
              </>
            )}
            {s.status === 'review' && (
              <>
                <button
                  className="wl-button"
                  disabled={busy}
                  onClick={async () => {
                    const r = await act({ action: 'investigation-preview', id: s.id })
                    if (r?.url) setEntry(r)
                  }}
                >
                  启动本步试用副本
                </button>
                {entry && (
                  <a className="wl-button" href={entry.url} target="_blank" rel="noreferrer">
                    进入试用实例 {entry.id}
                  </a>
                )}
                <p>试用副本保留在画布中，可在那里停止。判断只记录本步结果。</p>
                <p>
                  探针建议：
                  {{ good: '正常', bad: '问题仍在', skip: '无法判断' }[
                    s.active?.suggested as string
                  ] ?? '等待探针'}
                  。请选择是否复现你遇到的问题。
                </p>
                <div className="wl-flow-actions-row">
                  {(['good', 'bad', 'skip'] as const).map((v, i) => (
                    <button
                      className="wl-button"
                      key={v}
                      disabled={busy}
                      onClick={() =>
                        void act({
                          action: 'investigation-answer',
                          id: s.id,
                          revision: String(s.revision),
                          verdict: v,
                        })
                      }
                    >
                      {['正常', '问题仍在', '跳过'][i]}
                    </button>
                  ))}
                </div>
              </>
            )}
            {s.status === 'running' && (
              <button
                className="wl-button"
                disabled={busy || !accepted}
                onClick={() =>
                  void act({ action: 'investigation-skip-interrupted', id: s.id, breakStale })
                }
              >
                处理已中断的这一步
              </button>
            )}
            {!!s.candidates.length && <pre>{s.candidates.join('\n')}</pre>}
          </article>
        ))}
      {topic === 'diagnose' && sessions.length > historyLimit && (
        <button className="wl-button" onClick={() => setHistoryLimit((n) => n + 5)}>
          再显示 5 条排障记录（剩余 {sessions.length - historyLimit}）
        </button>
      )}
      <section hidden={topic !== 'transfer'} className="wl-event-detail">
        <h3>导出和导入环境</h3>
        <label>
          要带走的快照
          <HudSelect aria-label="要导出的快照" value={bad} onChange={(e) => setBad(e.target.value)}>
            <option value="">选择快照</option>
            {snapshots.map((s) => (
              <option key={s.snapshotId} value={s.snapshotId}>
                {s.title} · {new Date(s.at).toLocaleString()}
              </option>
            ))}
          </HudSelect>
        </label>
        <p>
          导出包含受管配置与固定的本地插件源码，秘密文件只声明所需输入。导入先进入实验验证，通过后再手动合入。
        </p>
        <button
          className="wl-button"
          disabled={busy || !bad}
          onClick={async () => {
            const value = await act({ action: 'environment-export', id, snapshotId: bad })
            if (value) download(value, `${bad}.world-line.json`)
          }}
        >
          导出所选快照
        </button>
        <label>
          选择环境包
          <input
            type="file"
            accept=".json"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              if (f.size > 32 * 1024 * 1024) {
                setError('环境包超过 32 MiB')
                return
              }
              setBundle(await f.text())
              setRequirements({})
            }}
          />
        </label>
        {required.map((name) => (
          <label key={name}>
            {name}（仅写入新实验）
            <textarea
              value={requirements[name] ?? ''}
              onChange={(e) => setRequirements({ ...requirements, [name]: e.target.value })}
            />
          </label>
        ))}
        <button
          className="wl-button primary"
          disabled={busy || !accepted || !bundle || required.some((n) => !requirements[n])}
          onClick={() =>
            void act({
              action: 'environment-import',
              sourceId: id,
              bundleText: bundle,
              requiredFiles: requirements,
            })
          }
        >
          导入并验证
        </button>
      </section>
      <section hidden={topic !== 'updates'} className="wl-event-detail">
        <h3>宿主版本兼容验证</h3>
        <p>每个版本安装到独立目录。结果不修改宿主认证清单，也不直接升级正式宿主。</p>
        <input
          aria-label="精确宿主版本，以逗号分隔"
          value={versions}
          onChange={(e) => setVersions(e.target.value)}
          placeholder="0.1.2-rc.1, …"
        />
        <button
          className="wl-button"
          disabled={busy || !accepted || !versions}
          onClick={() =>
            void act({
              action: 'version-matrix',
              sourceId: id,
              versions: versions
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            })
          }
        >
          开始矩阵验证
        </button>
      </section>
      <section hidden={topic !== 'updates'} className="wl-event-detail">
        <h3>升级建议</h3>
        <p>
          以已验证稳定点为基线，独立验证新版本，通过后才显示合入入口。管理宿主运行期间按周期检查；也可用
          CLI 的 upgrade watch 独立运行。
        </p>
        <p>
          {policy?.enabled
            ? `已启用，每 ${policy.hours} 小时；下次 ${policy.nextAt}`
            : '周期检查已关闭'}
        </p>
        <button
          className="wl-button"
          disabled={busy || !accepted}
          onClick={() => void act({ action: 'upgrade-check', id })}
        >
          现在检查并验证
        </button>
        <button
          className="wl-button"
          disabled={busy || !accepted}
          onClick={() =>
            void act({ action: 'upgrade-policy', id, enabled: !policy?.enabled, hours: '24' })
          }
        >
          {policy?.enabled ? '关闭周期检查' : '启用每天检查'}
        </button>
        {upgrades.map((r: any) => (
          <div key={r.checkedAt}>
            <p>{r.checkedAt}</p>
            {r.rows
              .filter((p: any) => p.status === 'verified')
              .map((p: any) => (
                <div key={p.name}>
                  <p>
                    {p.name} {p.from} → {p.to} · 已通过验证
                  </p>
                  <button
                    className="wl-button"
                    disabled={busy || !accepted}
                    onClick={() => void act({ action: 'promote', id: p.labId, restart: true })}
                  >
                    合入此升级并验证重启
                  </button>
                </div>
              ))}
            <details>
              <summary>全部检查结果（含失败）</summary>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(r.rows, null, 2)}</pre>
            </details>
          </div>
        ))}
      </section>
      <section hidden={topic !== 'deployment'} className="wl-event-detail">
        <h3>独立 A/B 部署与自动回退</h3>
        <p>
          从已通过浏览器验证的实验准备完整部署。外部启动器运行选中的部署；切换只改变部署指针。连续启动失败时回到之前的已验证部署，不依赖故障实例里的
          Web 面板。
        </p>
        <input
          aria-label="部署来源实验编号"
          value={lab}
          onChange={(e) => setLab(e.target.value)}
          placeholder="lab-…"
        />
        <button
          className="wl-button"
          disabled={busy || !accepted || !lab}
          onClick={() => void act({ action: 'deployment-stage', id: lab })}
        >
          复制并验证部署
        </button>
        <p>
          当前：{deployment?.active ?? '未选择'}；稳定：{deployment?.stable ?? '无'}
        </p>
        <p>{deployment?.notice}</p>
        {deployment?.service?.error && <p className="wl-error">{deployment.service.error}</p>}
        {deployment?.slots.map((s: any) => (
          <div key={s.id}>
            <p>
              {s.id} · {s.verified ? '已验证' : '准备未完成'}
            </p>
            {s.verified && (
              <button
                className="wl-button"
                disabled={busy || !accepted}
                onClick={() => void act({ action: 'deployment-activate', id: s.id })}
              >
                切换到此部署
              </button>
            )}
          </div>
        ))}
        <button
          className="wl-button"
          disabled={busy || !accepted || !deployment?.active}
          onClick={() => void act({ action: 'deployment-rollback' })}
        >
          回到上一已验证部署
        </button>
        <button
          className="wl-button"
          disabled={busy || !accepted || !deployment?.active}
          onClick={() =>
            void act({ action: 'deployment-config', enabled: !deployment?.enabled, threshold: '3' })
          }
        >
          {deployment?.enabled ? '关闭自动回退' : '启用连续 3 次失败自动回退'}
        </button>
        <button
          className="wl-button"
          disabled={busy || !accepted || !deployment?.active}
          onClick={() =>
            void act({
              action: 'deployment-service',
              breakStale,
              operation: deployment?.service?.running ? 'stop' : 'start',
            })
          }
        >
          {deployment?.service?.running ? '停止外部启动器' : '启动外部启动器'}
        </button>
        {deployment?.service?.ready?.url && (
          <a
            className="wl-button"
            href={deployment.service.ready.url}
            target="_blank"
            rel="noreferrer"
          >
            进入当前部署实例
          </a>
        )}
      </section>
    </div>
  )
}
