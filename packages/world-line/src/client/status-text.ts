/**
 * 状态文案映射，文案与 job-view.tsx STATUS_TEXT、workspace-tools.tsx 任务卡片内联 map、
 * timeline-model.ts stateLabel 逐字一致。ok/fail 在 job 与探针两套键下文案不同，故分开导出。
 */
const JOB_STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  ok: '已完成',
  fail: '验证失败',
  review: '异常待确认',
  awaiting_auth: '等待登录',
  incomplete: '验证未完成',
  error: '异常',
  interrupted: '已中断',
}
export const jobStatusText = (status: string) => JOB_STATUS_TEXT[status] ?? status

const LINE_STATE_TEXT: Record<string, string> = {
  running: '运行中',
  stopped: '已停止',
  failed: '失败',
  passed: '验证已完成',
  incomplete: '验证未完成',
  review: '异常待确认',
  awaiting_auth: '等待登录',
  applying: '准备中',
  created: '已创建',
  unreachable: '连接失效',
}
export const lineStateText = (state: string) => LINE_STATE_TEXT[state] ?? state

const PROBE_STATUS_TEXT: Record<string, string> = {
  pass: '通过',
  ok: '通过',
  fail: '失败',
  review: '异常待确认',
  awaiting_auth: '等待登录',
  incomplete: '验证未完成',
  warn: '警告',
  inconclusive: '不确定',
  info: '提示',
  skip: '跳过',
}
export const probeStatusText = (status: string) => PROBE_STATUS_TEXT[status] ?? status
