import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { expect, test } from '@rstest/core'
import { openJobStream } from '../../src/web/job-stream.js'

class Response extends EventEmitter {
  destroyed = false
  writableEnded = false
  writableFinished = false
  chunks: string[] = []
  pressure = false
  write(chunk: string) {
    if (this.writableEnded) throw Error('write after end')
    this.chunks.push(chunk)
    return !this.pressure
  }
  end() {
    this.writableEnded = true
    this.writableFinished = true
    this.emit('finish')
  }
}
function fixture(res: Response) {
  let publish = () => {},
    subscribed = false
  const cleanup = openJobStream(
    res as unknown as ServerResponse,
    () => [{ id: '1', data: 'snapshot' }],
    (fn) => {
      publish = fn
      subscribed = true
      return () => {
        subscribed = false
      }
    },
    () => false,
  )
  return { publish: () => publish(), subscribed: () => subscribed, cleanup }
}
test('initial snapshot backpressure ends once without connected or heartbeat writes', () => {
  const res = new Response()
  res.pressure = true
  const f = fixture(res)
  expect(res.chunks.length).toBe(1)
  expect(res.writableEnded).toBe(true)
  expect(f.subscribed()).toBe(false)
  f.publish()
  expect(res.chunks.length).toBe(1)
  expect(() => res.emit('error', new Error('asynchronous stream error'))).not.toThrow()
})
test('response ended by middleware cannot be written by later job notifications', () => {
  const res = new Response()
  const f = fixture(res)
  res.end()
  const count = res.chunks.length
  f.publish()
  expect(res.chunks.length).toBe(count)
  expect(f.subscribed()).toBe(false)
})
test('client disconnect and asynchronous response errors unsubscribe immediately', () => {
  for (const event of ['close', 'error']) {
    const res = new Response()
    const f = fixture(res)
    res.emit(event, new Error('disconnected'))
    const count = res.chunks.length
    f.publish()
    expect(res.chunks.length).toBe(count)
    expect(f.subscribed()).toBe(false)
  }
})
test('healthy subscribers receive subsequent phases until disposed', () => {
  const res = new Response()
  const f = fixture(res)
  f.publish()
  expect(res.chunks.length).toBe(3)
  f.cleanup()
  f.publish()
  expect(res.chunks.length).toBe(3)
})
