import type { ProbeResult } from '../domain/probe.js'
export function failureSummary(probes: ProbeResult[], error = '', _candidate = '') {
  const details = [...new Set(probes.map((p) => p.detail || p.label || p.check).filter(Boolean))]
  const text = [error, ...details].join('\n')
  if (probes.some((p) => p.check === 'client-observations' && p.status === 'inconclusive'))
    return {
      title: '核心检查已完成，另有异常影响待确认',
      next: '日志异常不等于插件损坏。请查看异常地址并在实验中试用相关功能；确认原因后重验，无需重复安装。尚未证实这些外部能力正常，因此暂不合入。',
      login: false,
      details,
    }
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(text))
    return {
      title: '有服务连接被拒绝，原因尚未确认',
      next: '展开请求地址和失败步骤确认是哪项服务。不能仅凭端口或包名判断原因；插件已安装时可直接重验，无需重新安装。',
      login: false,
      details,
    }
  if (/login|登录|authentication|unauthorized/i.test(text))
    return {
      title: '验证浏览器需要完成登录',
      next: '点击下方“打开本机验证浏览器并继续”。系统先尝试复用实验授权；若旧版登录组件仍显示登录页，完成登录后自动继续。',
      login: true,
      details,
    }
  if (/pnpm|registry|ENOTFOUND|ETIMEDOUT|ERR_PNPM/i.test(text))
    return {
      title: '依赖安装未完成',
      next: '检查网络和插件名称、版本。解决后使用“修改规格并重新安装”重新执行安装。',
      login: false,
      details,
    }
  return {
    title: '实验未达到安全合入条件',
    next: '先重验当前实验。若重复失败，展开技术详情或查看诊断报告，依据失败步骤处理；来源环境仍保持原样。',
    login: false,
    details,
  }
}
