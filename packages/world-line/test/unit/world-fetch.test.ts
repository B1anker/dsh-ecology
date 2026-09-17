import { describe, expect, test } from '@rstest/core'
import { createWorldReader, untilAborted } from '../../src/client/world-fetch.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A fetch whose every call parks until the test releases it, in order. */
function parkedFetch(answers: unknown[]) {
  const urls: string[] = []
  const releases: (() => void)[] = []
  const fetchImpl = ((input: RequestInfo | URL) => {
    urls.push(String(input))
    const answer = answers.shift()
    return new Promise<Response>((resolve) => {
      releases.push(() => resolve(jsonResponse(answer)))
    })
  }) as typeof fetch
  return { fetchImpl, urls, release: () => releases.shift()?.() }
}

const world = { revision: 'r1', lines: [{ id: 'a' }], events: [] }

describe('world reader', () => {
  test('two pollers overlapping share one request and both get the world', async () => {
    const { fetchImpl, urls, release } = parkedFetch([world])
    const reader = createWorldReader(fetchImpl)
    const canvas = reader.read()
    const entry = reader.read()
    expect(urls).toEqual(['/api/world-line'])
    release()
    const [a, b] = await Promise.all([canvas, entry])
    expect(a).toBe(b)
    expect(a.revision).toBe('r1')
    expect(reader.current()).toBe(a)
  })

  test('a later read asks for the delta since the cached revision and merges it', async () => {
    const { fetchImpl, urls, release } = parkedFetch([
      world,
      {
        revision: 'r2',
        delta: { lines: { remove: [], upsert: [{ id: 'b' }] }, events: { remove: [], upsert: [] } },
      },
    ])
    const reader = createWorldReader(fetchImpl)
    const first = reader.read()
    release()
    await first
    const second = reader.read()
    release()
    const merged = await second
    expect(urls[1]).toBe('/api/world-line?since=r1')
    expect(merged.revision).toBe('r2')
    expect(merged.lines.map((line: { id: string }) => line.id)).toEqual(['a', 'b'])
  })

  test('sequential polls never see the "expired" refusal the racing pair used to', async () => {
    // The old shape: entry captured baseline r1, canvas fetched and advanced
    // the cache to r2, then entry's answer was refused. With one request in
    // flight at a time each poll merges onto the baseline it asked about.
    const empty = { lines: { remove: [], upsert: [] }, events: { remove: [], upsert: [] } }
    const { fetchImpl, release } = parkedFetch([
      world,
      { revision: 'r2', delta: empty },
      { revision: 'r3', delta: empty },
    ])
    const reader = createWorldReader(fetchImpl)
    const boot = reader.read()
    release()
    await boot
    const canvas = reader.read()
    const entry = reader.read() // joins canvas's request
    release()
    await expect(Promise.all([canvas, entry])).resolves.toHaveLength(2)
    const next = reader.read()
    release()
    await expect(next).resolves.toMatchObject({ revision: 'r3' })
  })

  test("aborting one caller detaches it without cancelling the other's request", async () => {
    const { fetchImpl, release } = parkedFetch([world])
    const reader = createWorldReader(fetchImpl)
    const controller = new AbortController()
    const dropped = reader.read(controller.signal)
    const kept = reader.read()
    controller.abort()
    await expect(dropped).rejects.toMatchObject({ name: 'AbortError' })
    release()
    await expect(kept).resolves.toMatchObject({ revision: 'r1' })
    expect(reader.current()).not.toBeNull()
  })

  test('a failed request frees the flight and keeps the cache', async () => {
    let calls = 0
    const reader = createWorldReader((async () => {
      calls += 1
      if (calls === 1) return jsonResponse(world)
      if (calls === 2) return new Response('<html>', { status: 200 })
      if (calls === 3) return jsonResponse({ error: 'nope' }, 500)
      return new Response('', { status: 401 })
    }) as typeof fetch)
    await reader.read()
    await expect(reader.read()).rejects.toThrow('未收到管理服务响应')
    await expect(reader.read()).rejects.toThrow('nope')
    await expect(reader.read()).rejects.toThrow('登录已失效')
    expect(reader.current()).toMatchObject({ revision: 'r1' })
    expect(calls).toBe(4)
  })

  test('untilAborted rejects at once on an aborted signal and passes results through', async () => {
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    await expect(untilAborted(Promise.resolve(1), controller.signal)).rejects.toThrow('gone')
    await expect(untilAborted(Promise.resolve(2), new AbortController().signal)).resolves.toBe(2)
    await expect(untilAborted(Promise.reject(new Error('inner')))).rejects.toThrow('inner')
  })
})
