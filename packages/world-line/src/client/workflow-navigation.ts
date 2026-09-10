/** User goals are shared by maintenance entry points, result links and panel titles. */
export type ResearchTopic = 'diagnose' | 'transfer' | 'updates' | 'deployment'
export const researchGoals: Record<ResearchTopic, { title: string; description: string }> = {
  diagnose: {
    title: '定位故障变更',
    description: '环境检查没有说明原因时，排查哪次变更或哪个插件导致问题。',
  },
  transfer: {
    title: '环境导入导出',
    description: '把配置与本地插件打包带走，或在隔离环境中导入验证。',
  },
  updates: {
    title: '插件与宿主升级',
    description: '先验证插件新版本；指定 DSH 版本的兼容测试在高级选项中。',
  },
  deployment: {
    title: '独立部署与回退',
    description: '为外部启动器准备部署、切换运行版本并设置自动回退。',
  },
}
export function jobResearchTopic(kind: string): ResearchTopic | undefined {
  switch (kind) {
    case 'investigate':
      return 'diagnose'
    case 'upgrade-check':
    case 'version-matrix':
      return 'updates'
    case 'deployment-stage':
      return 'deployment'
    default:
      return undefined
  }
}
