import { expect, test } from '@rstest/core'
import { createMockContext } from '../src/context.js'
import { createMockToolHooks } from '../src/tool-hooks.js'

test('current tool hooks normalize deny, post decisions, and final observation', async () => {
  const ctx = createMockContext({})
  const hooks = createMockToolHooks(ctx)
  hooks.registerFixtureTool({ name: 'echo', execute: () => 'body' })

  const observed: unknown[] = []
  ctx.on('tools/pre-execute', ((_: unknown, next: () => unknown) => next()) as never)
  ctx.on('tools/post-execute', ((_: unknown, _result: unknown, _next: () => unknown) => ({
    kind: 'accept',
    content: [{ type: 'text', text: 'rewritten' }],
  })) as never)
  ctx.on('tools/result', ((_execution: unknown, result: unknown) => {
    observed.push(result)
  }) as never)

  const result = await hooks.execute({ name: 'echo', callId: 'c1' })
  expect(result).toEqual({
    isError: false,
    value: 'body',
    content: [{ type: 'text', text: 'rewritten' }],
  })
  expect(observed).toEqual([result])
  expect(Object.isFrozen(result)).toBe(true)
})

test('deny skips the tool body but remains visible to post-execute', async () => {
  const ctx = createMockContext({})
  const hooks = createMockToolHooks(ctx)
  let bodyRan = false
  let postSawError = false
  hooks.registerFixtureTool({
    name: 'echo',
    execute: () => {
      bodyRan = true
      return 'body'
    },
  })
  ctx.on('tools/pre-execute', (() => ({ kind: 'deny', reason: 'blocked' })) as never)
  ctx.on('tools/post-execute', ((_execution: unknown, result: { isError: boolean }) => {
    postSawError = result.isError
    return { kind: 'accept' }
  }) as never)

  await expect(hooks.execute({ name: 'echo' })).resolves.toMatchObject({
    isError: true,
    error: { code: 'DENIED', message: 'blocked' },
  })
  expect(bodyRan).toBe(false)
  expect(postSawError).toBe(true)
})

test('an aborted call skips pre/execute/post and emits one frozen result', async () => {
  const ctx = createMockContext({})
  const hooks = createMockToolHooks(ctx)
  const controller = new AbortController()
  controller.abort()
  const phases: string[] = []
  ctx.on('tools/pre-execute', (() => {
    phases.push('pre')
  }) as never)
  ctx.on('tools/execute', (() => {
    phases.push('execute')
  }) as never)
  ctx.on('tools/post-execute', (() => {
    phases.push('post')
  }) as never)
  ctx.on('tools/result', (() => {
    phases.push('result')
  }) as never)

  await expect(
    hooks.execute({ name: 'missing', signal: controller.signal }),
  ).resolves.toMatchObject({
    isError: true,
    error: { code: 'ABORTED_BEFORE_DISPATCH' },
  })
  expect(phases).toEqual(['result'])
})

test('ask, unknown tools, fixture disposal, and custom rendering follow the hook contract', async () => {
  const ctx = createMockContext({})
  const hooks = createMockToolHooks(ctx, { answerAsk: () => ({ kind: 'allow' }) })
  const dispose = hooks.registerFixtureTool({
    name: 'value',
    execute: () => ({ n: 1 }),
    render: (value) => [{ type: 'text', text: `n=${String((value as { n: number }).n)}` }],
  })
  expect(() => hooks.registerFixtureTool({ name: 'value', execute: () => 'again' })).toThrow(
    /duplicate/,
  )
  ctx.on('tools/pre-execute', (() => ({ kind: 'ask' })) as never)
  await expect(hooks.execute({ name: 'value' })).resolves.toEqual({
    isError: false,
    value: { n: 1 },
    content: [{ type: 'text', text: 'n=1' }],
  })
  dispose()
  dispose()
  await expect(hooks.execute({ name: 'value' })).resolves.toMatchObject({
    isError: true,
    error: { code: 'UNKNOWN_TOOL' },
  })
})

test('an unanswered ask uses the default denial reason', async () => {
  const ctx = createMockContext({})
  const hooks = createMockToolHooks(ctx)
  hooks.registerFixtureTool({ name: 'echo', execute: () => 'body' })
  ctx.on('tools/pre-execute', (() => ({ kind: 'ask' })) as never)
  await expect(hooks.execute({ name: 'echo' })).resolves.toMatchObject({
    isError: true,
    error: { code: 'DENIED', message: 'approval unavailable' },
  })
})

test('pre, body, and post failures use structured result errors', async () => {
  const preContext = createMockContext({})
  const preHooks = createMockToolHooks(preContext)
  preContext.on('tools/pre-execute', (() => {
    throw 'pre failed'
  }) as never)
  await expect(preHooks.execute({ name: 'missing' })).resolves.toMatchObject({
    error: { code: 'PRE_EXECUTE_ERROR', message: 'pre failed' },
  })

  const bodyContext = createMockContext({})
  const bodyHooks = createMockToolHooks(bodyContext)
  bodyHooks.registerFixtureTool({
    name: 'boom',
    execute: () => {
      throw 'body failed'
    },
  })
  await expect(bodyHooks.execute({ name: 'boom' })).resolves.toMatchObject({
    error: { code: 'TOOL_ERROR', message: 'body failed' },
  })

  const postContext = createMockContext({})
  const postHooks = createMockToolHooks(postContext)
  postHooks.registerFixtureTool({ name: 'echo', execute: () => 'body' })
  postContext.on('tools/post-execute', (() => {
    throw 'post failed'
  }) as never)
  await expect(postHooks.execute({ name: 'echo' })).resolves.toMatchObject({
    error: { code: 'POST_EXECUTE_ERROR', message: 'post failed' },
  })
})

test('execute wrappers and post block/value decisions receive normalized outcomes', async () => {
  const ctx = createMockContext({})
  const hooks = createMockToolHooks(ctx)
  hooks.registerFixtureTool({ name: 'echo', execute: () => 'body' })
  ctx.on('tools/execute', (async (_execution: unknown, next: () => unknown) => next()) as never)
  ctx.on('tools/post-execute', (() => ({ kind: 'accept', value: 'replacement' })) as never)
  await expect(hooks.execute({ name: 'echo' })).resolves.toEqual({
    isError: false,
    value: 'replacement',
    content: [{ type: 'text', text: 'replacement' }],
  })

  const blockedContext = createMockContext({})
  const blockedHooks = createMockToolHooks(blockedContext)
  blockedHooks.registerFixtureTool({ name: 'echo', execute: () => 'body' })
  blockedContext.on('tools/post-execute', (() => ({ kind: 'block', feedback: [] })) as never)
  await expect(blockedHooks.execute({ name: 'echo' })).resolves.toEqual({
    isError: true,
    error: { message: 'tool result blocked' },
    content: [],
  })

  const feedbackContext = createMockContext({})
  const feedbackHooks = createMockToolHooks(feedbackContext)
  feedbackHooks.registerFixtureTool({ name: 'echo', execute: () => 'body' })
  feedbackContext.on('tools/post-execute', (() => ({
    kind: 'block',
    feedback: [{ type: 'text', text: 'correct this' }],
  })) as never)
  await expect(feedbackHooks.execute({ name: 'echo' })).resolves.toMatchObject({
    error: { message: 'correct this' },
  })
})
