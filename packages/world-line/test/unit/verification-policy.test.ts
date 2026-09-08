import { expect, test } from '@rstest/core'
import { probe, summarizeProbes } from '../../src/domain/probe.js'
import { canAcceptReview, classifyClientGate } from '../../src/lab/promote.js'

test('required skipped or warning checks cannot fabricate verification', () => {
  for (const status of ['skip', 'warn', 'inconclusive', 'fail'] as const) {
    expect(
      summarizeProbes([probe(new Date(), 'required', 'required', status, { required: true })]).ok,
    ).toBe(false)
  }
  expect(
    summarizeProbes([probe(new Date(), 'optional', 'optional', 'fail', { required: false })]).ok,
  ).toBe(true)
})
test('v2 coverage is separate from the compatibility gate', () => {
  const core = probe(new Date(), 'browser-boot', 'core', 'pass')
  const coverage = probe(new Date(), 'plugin-function', 'not tested', 'skip', { required: false })
  const review = probe(new Date(), 'client-observations', 'unknown impact', 'inconclusive')
  expect(classifyClientGate([core, coverage])).toBe('pass')
  expect(classifyClientGate([core, coverage, review])).toBe('inconclusive')
  expect(summarizeProbes([core, coverage, review]).ok).toBe(false)
})

test('single-run risk acceptance cannot override missing or failed core evidence', () => {
  const core = probe(new Date(), 'browser-boot', 'core', 'pass')
  const coverage = probe(new Date(), 'plugin-function', 'not tested', 'skip', { required: false })
  const review = probe(new Date(), 'client-observations', 'unknown impact', 'inconclusive')
  expect(canAcceptReview([core, coverage, review])).toBe(true)
  for (const status of ['fail', 'inconclusive', 'skip'] as const) {
    expect(canAcceptReview([{ ...core, status }, coverage, review])).toBe(false)
  }
  expect(canAcceptReview([coverage, review])).toBe(false)
})
