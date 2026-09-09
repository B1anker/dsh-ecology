import { describe, expect, test } from '@rstest/core'
import { validateAction } from '../../src/web/action-schema.js'

describe('merge request boundary', () => {
  for (const action of ['merge-preview', 'merge-prepare']) {
    const fields =
      action === 'merge-prepare'
        ? { revision: 'revision-1', plugins: ['@fixture/plugin'], includeConfig: false }
        : {}
    test(`${action} accepts selected targets and legacy default target`, () => {
      for (const targetId of [undefined, 'origin', 'lab-destination']) {
        expect(
          validateAction({
            action,
            id: 'lab-source',
            ...fields,
            ...(targetId ? { targetId } : {}),
          }),
        ).toBe(action)
      }
    })
    test(`${action} rejects invalid targets and unrelated fields`, () => {
      for (const targetId of ['', ' ', 42, null, {}, []]) {
        expect(() => validateAction({ action, id: 'lab-source', ...fields, targetId })).toThrow()
      }
      expect(() => validateAction({ action, id: 'lab-source', ...fields, home: '/tmp' })).toThrow()
    })
  }
})
