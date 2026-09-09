import { describe, expect, test } from '@rstest/core'
import {
  browserVerdict,
  changeCounts,
  retentionCounts,
} from '../../src/client/result-visual-data.js'

describe('visual summaries preserve result meaning', () => {
  test('unchanged rows do not inflate change counts, and all three grains remain separate', () => {
    const result = changeCounts({
      dependencies: [{ status: 'unchanged' }, { status: 'added' }],
      files: [{ status: 'removed' }],
      patches: [{ status: 'changed' }],
    })
    expect(result.map((row) => row.values)).toEqual([
      [1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ])
  })
  test('missing, skipped and inconclusive browser results cannot imply success', () => {
    expect(browserVerdict(undefined)).toEqual({ state: 'unknown', text: '未记录' })
    expect(browserVerdict('inconclusive')).toEqual({ state: 'unknown', text: '待判断' })
    expect(browserVerdict('skipped')).toEqual({ state: 'unknown', text: '未执行' })
    expect(browserVerdict('pass').state).toBe('pass')
    expect(browserVerdict('fail').state).toBe('fail')
  })
  test('retained count includes every non-candidate, not only protected rows', () => {
    expect(retentionCounts(10, ['a', 'b'])).toEqual({
      total: 10,
      removed: 2,
      kept: 8,
      keptPercent: 80,
      removedPercent: 20,
    })
  })
  test('empty cleanup stays finite and all-delete/all-keep keep correct proportions', () => {
    expect(retentionCounts(0, [])).toEqual({
      total: 0,
      removed: 0,
      kept: 0,
      keptPercent: 0,
      removedPercent: 0,
    })
    expect(retentionCounts(2, ['a', 'b']).removedPercent).toBe(100)
    expect(retentionCounts(2, []).keptPercent).toBe(100)
  })
})
