import { type FSWatcher, watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
/** Cache derived reads by source metadata; failed reads are never cached. */
export class ReadCache {
  private entries = new Map<string, { signature: string; at: number; value: Promise<unknown> }>()
  invalidate(prefix: string) {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key)
  }
  async read<T>(key: string, paths: string[], read: () => Promise<T>, ttl = 30000): Promise<T> {
    const signature = (
      await Promise.all(
        paths.map(async (path) => {
          try {
            const s = await stat(path)
            return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
            throw e
          }
        }),
      )
    ).join('|')
    const previous = this.entries.get(key)
    if (previous?.signature === signature && Date.now() - previous.at < ttl)
      return previous.value as Promise<T>
    const value = read()
    this.entries.set(key, { signature, at: Date.now(), value })
    if (this.entries.size > 10000) this.entries.delete(this.entries.keys().next().value!)
    try {
      return await value
    } catch (e) {
      if (this.entries.get(key)?.value === value) this.entries.delete(key)
      throw e
    }
  }
}
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++
        if (index >= items.length) return
        results[index] = await fn(items[index]!)
      }
    }),
  )
  return results
}

/** Watch authoritative metadata, with periodic stat/TTL reads as the portable fallback. */
export function watchWorldLine(home: string, cache: ReadCache): () => void {
  let watcher: FSWatcher | undefined
  const connect = () => {
    if (watcher) return
    try {
      watcher = watch(join(home, 'world-line'), { recursive: true }, (_event, file) => {
        if (
          !file ||
          /(?:^|\/)(?:manifest|probe|service|state)\.json$|journal\.jsonl$|(?:^|\/)snapshots(?:\/|$)/.test(
            file.toString(),
          )
        )
          cache.invalidate(`${home}:`)
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = undefined
        cache.invalidate(`${home}:`)
      })
    } catch {
      /* Missing store or unsupported watcher; metadata cache still expires. */
    }
  }
  connect()
  const timer = setInterval(connect, 30000)
  timer.unref()
  return () => {
    clearInterval(timer)
    watcher?.close()
  }
}
