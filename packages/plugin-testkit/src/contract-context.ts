/**
 * The contract a Cordis-like plugin context has to satisfy.
 *
 * Covers `provide` visibility, event registration, emit order, waterfall
 * short-circuit, and reverse teardown — the behaviours hook and readiness
 * plugins depend on.
 *
 * @module @seaveyon/dsh-plugin-testkit/contract-context
 */

import { expect, test } from '@rstest/core'
import type { MockContext } from './context.js'

/**
 * Assert that an implementation satisfies the context contract.
 *
 * @param label - names the implementation in each test title.
 * @param create - produces a fresh context with an empty service table.
 */
export function runContextContract(label: string, create: () => MockContext): void {
  test(`${label}: provide publishes a value that get can read`, () => {
    const ctx = create()
    ctx.provide('ready', true)
    expect(ctx.get('ready')).toBe(true)
  })

  test(`${label}: provide publishes a value and returns a disposer`, () => {
    const ctx = create()
    const dispose = ctx.provide('gated', 'secret')
    expect(ctx.get('gated')).toBe('secret')
    dispose()
    expect(ctx.get('gated')).toBeUndefined()
  })

  test(`${label}: set replaces a provided entry`, () => {
    const ctx = create()
    ctx.provide('name', 'from-provide')
    ctx.set('name', 'from-set')
    expect(ctx.get('name')).toBe('from-set')
  })

  test(`${label}: the availability predicate gates dependents, not get`, () => {
    const ctx = create()
    let ready = false
    ctx.provide('gate', { ready: () => ready }, () => ready)
    // Cordis consults the predicate when deciding whether an injecting fiber
    // may load; reflect.get never does, so the value stays readable.
    expect(ctx.available('gate')).toBe(false)
    expect(ctx.get('gate')).toBeDefined()
    ready = true
    expect(ctx.available('gate')).toBe(true)
  })

  test(`${label}: a throwing availability predicate counts as unavailable`, () => {
    const ctx = create()
    ctx.provide('flaky', 1, () => {
      throw new Error('probe failed')
    })
    expect(ctx.available('flaky')).toBe(false)
    expect(ctx.logs.warn.some((line) => line.includes('probe failed'))).toBe(true)
  })

  test(`${label}: a service without a predicate is available while provided`, () => {
    const ctx = create()
    expect(ctx.available('plain')).toBe(false)
    const dispose = ctx.provide('plain', 1)
    expect(ctx.available('plain')).toBe(true)
    dispose()
    expect(ctx.available('plain')).toBe(false)
  })

  test(`${label}: on returns a disposer that removes the listener`, () => {
    const ctx = create()
    const seen: string[] = []
    const dispose = ctx.on('ping', ((value: string) => {
      seen.push(value)
    }) as (...args: never[]) => unknown)
    ctx.emit('ping', 'a')
    dispose()
    ctx.emit('ping', 'b')
    expect(seen).toEqual(['a'])
  })

  test(`${label}: emit delivers to listeners in registration order`, () => {
    const ctx = create()
    const order: string[] = []
    ctx.on('seq', (() => {
      order.push('first')
    }) as (...args: never[]) => unknown)
    ctx.on('seq', (() => {
      order.push('second')
    }) as (...args: never[]) => unknown)
    ctx.emit('seq')
    expect(order).toEqual(['first', 'second'])
  })

  test(`${label}: waterfall reaches a later listener only through next()`, () => {
    const ctx = create()
    const seen: string[] = []
    ctx.on('wf', ((_value: string, next: () => unknown) => {
      seen.push('outer')
      return next()
    }) as (...args: never[]) => unknown)
    ctx.on('wf', ((value: string, next: () => unknown) => {
      seen.push(value)
      return next()
    }) as (...args: never[]) => unknown)
    expect(ctx.waterfall('wf', 'inner')).toBeUndefined()
    expect(seen).toEqual(['outer', 'inner'])
  })

  test(`${label}: waterfall short-circuit skips downstream listeners`, () => {
    const ctx = create()
    const seen: string[] = []
    ctx.on('wf', (() => {
      seen.push('short')
      return 'done'
    }) as (...args: never[]) => unknown)
    ctx.on('wf', (() => {
      seen.push('never')
      return 'unreachable'
    }) as (...args: never[]) => unknown)
    expect(ctx.waterfall('wf')).toBe('done')
    expect(seen).toEqual(['short'])
  })

  test(`${label}: dispose runs teardowns in reverse order`, async () => {
    const ctx = create()
    const order: string[] = []
    ctx.effect(() => () => order.push('first'), 'first')
    ctx.effect(() => () => order.push('second'), 'second')
    await ctx.dispose()
    expect(order).toEqual(['second', 'first'])
  })
}
