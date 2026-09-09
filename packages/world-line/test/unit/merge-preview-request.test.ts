import { describe, expect, test } from '@rstest/core'
import { requestMergePreview } from '../../src/client/merge-preview-request.js'
import type { MergePreview } from '../../src/domain/merge-types.js'

const preview: MergePreview = {
  sourceId: 'source',
  sourceName: 'login',
  targetId: 'origin',
  targetName: 'main',
  revision: '1',
  plugins: [],
  configChanged: false,
}
describe('bounded merge previews', () => {
  test('returns the selected target preview', async () => {
    const result = await requestMergePreview(
      async (body) => {
        expect(body).toEqual({ action: 'merge-preview', id: 'source', targetId: 'origin' })
        return preview
      },
      'source',
      'origin',
      new AbortController().signal,
    )
    expect(result).toBe(preview)
  })
  test('times out even when a queued request does not settle after abort', async () => {
    let requestSignal: AbortSignal | undefined
    await expect(
      requestMergePreview(
        (_, signal) => {
          requestSignal = signal
          return new Promise(() => {})
        },
        'source',
        'origin',
        new AbortController().signal,
        10,
      ),
    ).rejects.toThrow('比较超时')
    expect(requestSignal?.aborted).toBe(true)
  })
  test('cancels an old preview when the target changes or panel closes', async () => {
    const parent = new AbortController()
    let requestSignal: AbortSignal | undefined
    const result = requestMergePreview(
      (_, signal) => {
        requestSignal = signal
        return new Promise(() => {})
      },
      'source',
      'origin',
      parent.signal,
    )
    parent.abort()
    await expect(result).rejects.toThrow('Preview cancelled')
    expect(requestSignal?.aborted).toBe(true)
  })
  test('surfaces backend errors instead of leaving the loading state pending', async () => {
    await expect(
      requestMergePreview(
        async () => {
          throw new Error('目标不可用')
        },
        'source',
        'origin',
        new AbortController().signal,
      ),
    ).rejects.toThrow('目标不可用')
  })
})
