export type PluginSource = 'registry' | 'local'
export function localPluginPath(input: string): string | null {
  const text = input.trim()
  if (/^@?(?:file|link):/.test(text)) return text.replace(/^@?(?:file|link):/, '')
  return text.startsWith('/') ? text : null
}
export function pluginInstallSpec(
  source: PluginSource,
  input: string,
): { spec: string; error?: string } {
  const text = input.trim()
  if (!text) return { spec: '' }
  if (source === 'local') {
    const path = localPluginPath(text) ?? text
    if (!path.startsWith('/') || path.startsWith('//'))
      return {
        spec: '',
        error: '请填写运行 DSH 的电脑上的绝对路径，例如 /Users/你的用户名/code/my-plugin。',
      }
    return { spec: `file:${path}` }
  }
  const match = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@([^\s]+))?$/.exec(text)
  if (!match)
    return { spec: '', error: '请输入包名或包名@版本，例如 @seaveyon/dsh-web-login@0.5.0。' }
  return { spec: `${match[1]}@${match[2] ?? 'latest'}` }
}
