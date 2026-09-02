import { expect, test } from '@rstest/core'
import {
  contextContractCases,
  verifyContract,
  webServerContractCases,
} from '../src/contract/core.js'
import { createMockContextDriver, createMockWebServerDriver } from '../src/mock-drivers.js'

test('the mock context satisfies the portable context contract', async () => {
  const report = await verifyContract(contextContractCases, createMockContextDriver)
  expect(report).toMatchObject({ passed: true })
  expect(report.cases.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: 'context.services.provide-set-dispose', status: 'pass' },
    { id: 'context.events.disposer-order', status: 'pass' },
    { id: 'context.waterfall.short-circuit', status: 'pass' },
    { id: 'context.effects.reverse-cleanup', status: 'pass' },
  ])
})

test('the mock web server satisfies the portable route contract', async () => {
  const report = await verifyContract(webServerContractCases, createMockWebServerDriver)
  expect(report.passed).toBe(true)
  expect(report.cases).toHaveLength(7)
})

test('a portable contract reports a failed case after always disposing its driver', async () => {
  let disposed = false
  const report = await verifyContract(
    [
      {
        id: 'fixture.failure',
        title: 'records failures',
        run: () => {
          throw new Error('expected failure')
        },
        afterDispose: () => {
          expect(disposed).toBe(true)
        },
      },
    ],
    async () => ({
      dispose: () => {
        disposed = true
      },
    }),
  )
  expect(report).toMatchObject({
    passed: false,
    cases: [
      { id: 'fixture.failure', status: 'fail', error: expect.stringContaining('expected failure') },
    ],
  })
})
