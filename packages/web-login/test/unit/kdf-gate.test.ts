import { expect, test } from '@rstest/core'
import { createKdfGate } from '../../src/kdf-gate.js'

/** A task whose completion the test controls. */
interface Deferred {
  promise: Promise<string>
  resolve: (value: string) => void
}

/** @returns a promise plus the handle that settles it. */
function deferred(): Deferred {
  let resolve!: (value: string) => void
  const promise = new Promise<string>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('work beyond the concurrency limit waits rather than running', async () => {
  const gate = createKdfGate({ concurrency: 2, queueDepth: 4 })
  const gates = [deferred(), deferred(), deferred()]
  let started = 0

  const runs = gates.map((g) =>
    gate.run(async () => {
      started += 1
      return await g.promise
    }),
  )

  await Promise.resolve()
  expect(started, 'only the concurrency limit may be in flight').toBe(2)
  expect(gate.active).toBe(2)
  expect(gate.queued).toBe(1)

  gates[0]?.resolve('a')
  await runs[0]
  expect(started, 'the freed slot admits the waiter').toBe(3)

  gates[1]?.resolve('b')
  gates[2]?.resolve('c')
  expect(await Promise.all(runs)).toEqual(['a', 'b', 'c'])
  expect(gate.active).toBe(0)
  expect(gate.queued).toBe(0)
})

test('work beyond the queue is refused rather than queued', async () => {
  const gate = createKdfGate({ concurrency: 1, queueDepth: 1 })
  const held = deferred()

  const running = gate.run(() => held.promise)
  const queued = gate.run(() => Promise.resolve('queued'))
  await Promise.resolve()

  // The point of the refusal: an unauthenticated caller must not be able to
  // grow this process's memory or its latency without limit.
  expect(await gate.run(() => Promise.resolve('rejected'))).toBeNull()

  held.resolve('running')
  expect(await running).toBe('running')
  expect(await queued).toBe('queued')
})

test('a queue depth of zero admits only the running slots', async () => {
  const gate = createKdfGate({ concurrency: 1, queueDepth: 0 })
  const held = deferred()
  const running = gate.run(() => held.promise)
  await Promise.resolve()

  expect(await gate.run(() => Promise.resolve('second'))).toBeNull()

  held.resolve('first')
  expect(await running).toBe('first')
  expect(await gate.run(() => Promise.resolve('later'))).toBe('later')
})

test('a failing task frees its slot', async () => {
  const gate = createKdfGate({ concurrency: 1, queueDepth: 1 })

  await expect(gate.run(() => Promise.reject(new Error('scrypt failed')))).rejects.toThrow(
    /scrypt failed/,
  )

  // A slot leaked on the error path would wedge sign-in permanently, and the
  // symptom — logins that hang after some unrelated failure — would be nearly
  // impossible to trace back to here.
  expect(gate.active).toBe(0)
  expect(await gate.run(() => Promise.resolve('ok'))).toBe('ok')
})

test('waiters are admitted in arrival order', async () => {
  const gate = createKdfGate({ concurrency: 1, queueDepth: 4 })
  const held = deferred()
  const order: string[] = []

  const running = gate.run(() => held.promise)
  const waiters = ['first', 'second', 'third'].map((name) =>
    gate.run(() => {
      order.push(name)
      return Promise.resolve(name)
    }),
  )

  held.resolve('running')
  await running
  await Promise.all(waiters)

  // FIFO, so a steady arrival of new callers cannot starve one that has already
  // waited — under load, LIFO would turn the queue into a lottery.
  expect(order).toEqual(['first', 'second', 'third'])
})
