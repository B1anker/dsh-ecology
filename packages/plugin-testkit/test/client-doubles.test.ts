import { expect, test } from '@rstest/core'
import {
  createMockClientRuntime,
  createMockModuleLoader,
  createMockObservable,
  createMockSlots,
} from '../src/client.js'

test('an observable notifies subscribers on set and stops after dispose', () => {
  const cell = createMockObservable(0)
  const seen: number[] = []
  const off = cell.subscribe(() => seen.push(cell.getSnapshot()))
  cell.set(1)
  cell.set(2)
  off()
  cell.set(3)
  expect(seen).toEqual([1, 2])
  expect(cell.listeners.size).toBe(0)
})

test('slots record registrations per slot name and the disposer removes them', () => {
  const slots = createMockSlots()
  slots.inject('shell.overlay', () =>
    slots.register({ name: 'shell.overlay', id: 'a', order: 1 }, 'overlay-component'),
  )
  const dispose = slots.register({ name: 'settings.section', id: 'b' }, 'settings-component')

  expect(slots.registrations.get('shell.overlay')?.[0]?.component).toBe('overlay-component')
  expect(slots.registrations.get('settings.section')).toHaveLength(1)
  dispose()
  expect(slots.registrations.get('settings.section')).toHaveLength(0)
})

test('sessions publish drives the two-level provide shape', () => {
  const runtime = createMockClientRuntime<{ running: boolean }>()
  const seen: Array<boolean> = []
  const info = runtime.sessions.currentProvideInfo.getSnapshot()
  expect(info).not.toBeNull()
  info?.hooks.session.subscribe(() => {
    const snap = info.hooks.session.getSnapshot()
    if (snap !== null) seen.push(snap.running)
  })

  runtime.sessions.publish({ running: true })
  runtime.sessions.publish({ running: false })
  expect(seen).toEqual([true, false])

  // A session switch replaces the whole bundle, not the snapshot inside it.
  runtime.sessions.select(null)
  expect(runtime.sessions.currentProvideInfo.getSnapshot()).toBeNull()
})

test('settingsScope namespaces are independent and writes notify', async () => {
  const runtime = createMockClientRuntime()
  const a = runtime.settingsScope.bind({ namespace: 'a' })
  const b = runtime.settingsScope.bind({ namespace: 'b' })
  let notified = 0
  a.subscribe(() => {
    notified += 1
  })

  await a.set('scale', 1.5)
  await b.set('name', 'x')
  await a.unset('scale')

  expect(notified).toBe(2)
  expect(runtime.settingsScope.bound.get('a')).toEqual({})
  expect(runtime.settingsScope.bound.get('b')).toEqual({ name: 'x' })
})

test('the module loader captures load, runs the factory, and fails loud on undeclared requires', () => {
  const loader = createMockModuleLoader({ react: 'the-shell-react' })
  const target: Record<string, unknown> = {}
  const uninstall = loader.install(target)

  const moduleLoader = target['__ModuleLoader__'] as {
    load(entry: { id: string; factory: (require: (s: string) => unknown) => unknown }): void
  }
  moduleLoader.load({
    id: 'demo',
    factory: (require) => ({
      name: 'demo',
      inject: [],
      apply: () => require('react'),
    }),
  })

  expect(loader.loaded?.id).toBe('demo')
  const exports = loader.invokeFactory()
  expect(exports.apply?.({})).toBe('the-shell-react')

  moduleLoader.load({ id: 'bad', factory: (require) => require('not-a-module') })
  expect(() => loader.invokeFactory()).toThrow(/not in the static table/)

  uninstall()
  expect('__ModuleLoader__' in target).toBe(false)
})

test('a bundle round trip: load, invoke, apply, and the slot is registered', () => {
  const runtime = createMockClientRuntime()
  const loader = runtime.loader
  const target: Record<string, unknown> = {}
  loader.install(target)
  ;(target['__ModuleLoader__'] as { load(entry: unknown): void }).load({
    id: 'dsh-pet',
    factory: () => ({
      name: 'dsh-pet',
      inject: ['slots'],
      apply(ctx: {
        get(name: string): {
          inject(slot: string, fn: () => void): void
          register(descriptor: Record<string, unknown>, component: unknown): void
        }
      }) {
        const slots = ctx.get('slots')
        slots.inject('shell.overlay', () =>
          slots.register({ name: 'shell.overlay', id: 'dsh-pet' }, 'pet-overlay'),
        )
      },
    }),
  })

  const exports = loader.invokeFactory()
  expect(exports.name).toBe('dsh-pet')
  exports.apply?.(runtime.context)

  const overlays = runtime.slots.registrations.get('shell.overlay')
  expect(overlays).toHaveLength(1)
  expect(overlays?.[0]?.component).toBe('pet-overlay')
})
