/** Runner-independent scenarios for the Cordis context subset plugins use. */

import assert from 'node:assert/strict'
import type { ContractCase, DisposableDriver } from '../harness.js'
import type { ContextListener, Disposer, PluginContext } from '../types.js'

/** The public context subset a scenario can observe. */
export interface ContextContractSubject
  extends Omit<
    Required<
      Pick<
        PluginContext,
        'get' | 'effect' | 'logger' | 'provide' | 'set' | 'on' | 'emit' | 'waterfall'
      >
    >,
    'provide'
  > {
  provide: (name: string, value: unknown) => Disposer
}

/** A context plus the lifecycle that owns its effects and services. */
export interface ContextContractDriver extends DisposableDriver {
  ctx: ContextContractSubject
}

function listener(callback: (...args: never[]) => unknown): ContextListener {
  return callback as ContextListener
}

/** Behaviours shared by a mock context and a real Cordis context. */
export const contextContractCases: readonly ContractCase<ContextContractDriver>[] = [
  {
    id: 'context.services.provide-set-dispose',
    title: 'provided services are readable, writable by their owner, and disposable',
    run: ({ ctx }) => {
      const dispose = ctx.provide('ready', true)
      assert.equal(ctx.get('ready'), true)
      ctx.set('ready', false)
      assert.equal(ctx.get('ready'), false)
      dispose()
      assert.equal(ctx.get('ready'), undefined)
      assert.throws(() => ctx.set('missing', true), /set|provide/i)
    },
  },
  {
    id: 'context.events.disposer-order',
    title: 'event disposers remove listeners and emit preserves registration order',
    run: ({ ctx }) => {
      const seen: string[] = []
      const first = ctx.on(
        'contract:emit',
        listener(() => {
          seen.push('first')
        }),
      )
      ctx.on(
        'contract:emit',
        listener(() => {
          seen.push('second')
        }),
      )
      ctx.emit('contract:emit')
      first()
      ctx.emit('contract:emit')
      assert.deepEqual(seen, ['first', 'second', 'second'])
    },
  },
  {
    id: 'context.waterfall.short-circuit',
    title: 'waterfalls reach downstream listeners only through next',
    run: async ({ ctx }) => {
      const seen: string[] = []
      ctx.on(
        'contract:waterfall',
        listener((_value: string, next: () => unknown) => {
          seen.push('outer')
          return next()
        }),
      )
      ctx.on(
        'contract:waterfall',
        listener((value: string) => {
          seen.push(value)
          return 'done'
        }),
      )
      assert.equal(await ctx.waterfall('contract:waterfall', 'inner'), 'done')
      assert.deepEqual(seen, ['outer', 'inner'])
    },
  },
  (() => {
    let order: string[] | undefined
    return {
      id: 'context.effects.reverse-cleanup',
      title: 'effects unwind in reverse order when their owner disposes',
      run: ({ ctx }) => {
        const observed: string[] = []
        order = observed
        ctx.effect(
          () => () => {
            observed.push('first')
          },
          'first',
        )
        ctx.effect(
          () => () => {
            observed.push('second')
          },
          'second',
        )
      },
      afterDispose: () => {
        assert.deepEqual(order, ['second', 'first'])
      },
    }
  })(),
]
