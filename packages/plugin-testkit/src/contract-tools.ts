/**
 * The contract a minimal tools execution pipeline has to satisfy.
 *
 * Stated once so the mock here and any future host adapter can be pointed at
 * the same assertions. Covers pre-deny skipping the body, post still running
 * after deny, execute wrappers around the body, and thrown bodies becoming
 * `isError` results.
 *
 * @module @seaveyon/dsh-plugin-testkit/contract-tools
 */

import { expect, test } from '@rstest/core'
import type { MockContext } from './context.js'
import type { MockToolsPipeline } from './tools.js'
import type { ToolResult } from './types.js'

/** A pipeline plus the context its hooks register on. */
export interface ToolsPipelineHarness {
  ctx: MockContext
  pipeline: MockToolsPipeline
}

/**
 * Assert that an implementation satisfies the tools pipeline contract.
 *
 * @param label - names the implementation in each test title.
 * @param create - produces a fresh harness.
 */
export function runToolsPipelineContract(label: string, create: () => ToolsPipelineHarness): void {
  test(`${label}: a pre-execute deny skips the tool body`, async () => {
    const { ctx, pipeline } = create()
    let ran = false
    pipeline.service.register('echo', () => {
      ran = true
      return 'body'
    })
    ctx.on('tools/pre-execute', (() => ({ kind: 'deny', reason: 'blocked' })) as (
      ...args: never[]
    ) => unknown)

    const result = await pipeline.run({ name: 'echo' })
    expect(ran).toBe(false)
    expect(result).toEqual({ content: 'blocked', isError: true })
  })

  test(`${label}: post-execute still runs after a deny`, async () => {
    const { ctx, pipeline } = create()
    pipeline.service.register('echo', () => 'body')
    ctx.on('tools/pre-execute', (() => ({ kind: 'deny', reason: 'blocked' })) as (
      ...args: never[]
    ) => unknown)
    ctx.on('tools/post-execute', ((_exec: unknown, result: ToolResult) => {
      expect(result.isError).toBe(true)
      return { content: `noted:${result.content}`, isError: true }
    }) as (...args: never[]) => unknown)

    const result = await pipeline.run({ name: 'echo' })
    expect(result).toEqual({ content: 'noted:blocked', isError: true })
  })

  test(`${label}: an execute wrapper sees the body result through next()`, async () => {
    const { ctx, pipeline } = create()
    pipeline.service.register('echo', () => 'raw')
    ctx.on('tools/execute', (async (_exec: unknown, next: () => unknown) => {
      const value = await next()
      return `wrapped:${value}`
    }) as (...args: never[]) => unknown)

    const result = await pipeline.run({ name: 'echo' })
    expect(result).toEqual({ content: 'wrapped:raw', isError: false })
  })

  test(`${label}: a throwing tool body becomes an isError result`, async () => {
    const { ctx, pipeline } = create()
    pipeline.service.register('boom', () => {
      throw new Error('tool exploded')
    })
    // A post listener must still see the normalized failure, not an uncaught throw.
    ctx.on('tools/post-execute', ((_exec: unknown, result: ToolResult, next: () => unknown) => {
      expect(result.isError).toBe(true)
      return next()
    }) as (...args: never[]) => unknown)

    const result = await pipeline.run({ name: 'boom' })
    expect(result).toEqual({ content: 'tool exploded', isError: true })
  })

  test(`${label}: allow via next() reaches the tool body`, async () => {
    const { ctx, pipeline } = create()
    pipeline.service.register('echo', (exec) => exec.arguments)
    ctx.on('tools/pre-execute', ((_exec: unknown, next: () => unknown) => next()) as (
      ...args: never[]
    ) => unknown)

    const result = await pipeline.run({ name: 'echo', arguments: { n: 1 } })
    expect(result).toEqual({ content: { n: 1 }, isError: false })
  })

  test(`${label}: an unanswered ask is denied by default`, async () => {
    const { ctx, pipeline } = create()
    let ran = false
    pipeline.service.register('echo', () => {
      ran = true
      return 'body'
    })
    ctx.on('tools/pre-execute', (() => ({ kind: 'ask', reason: 'need approval' })) as (
      ...args: never[]
    ) => unknown)

    const result = await pipeline.run({ name: 'echo' })
    expect(ran).toBe(false)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/need approval|approval unavailable/)
  })

  test(`${label}: register returns a disposer and refuses duplicates`, () => {
    const { pipeline } = create()
    const dispose = pipeline.service.register('once', () => 'ok')
    expect(typeof dispose).toBe('function')
    expect(() => pipeline.service.register('once', () => 'again')).toThrow(/duplicate/)
    dispose()
    expect(() => pipeline.service.register('once', () => 'again')).not.toThrow()
  })
}
