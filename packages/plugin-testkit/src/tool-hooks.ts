/**
 * A current-generation, hook-only tools fixture.
 *
 * Unlike the legacy `createMockToolsPipeline`, this models the observable
 * shapes of modern DSH tool hooks: a structured result, an opaque symbol
 * token, and post-execute accept/block decisions. It intentionally does not
 * implement schemas, guards, scopes, PTC, presentation cards, or scheduling.
 */

import { randomBytes } from 'node:crypto'
import type { MockContext } from './context.js'
import { runWaterfall } from './events.js'
import type { Disposer } from './types.js'

/** Minimal model-facing block used by this fixture's probe tools. */
export interface ToolHookContentBlock {
  type: 'text'
  text: string
}

/** Execution identity visible to hook listeners. */
export interface ToolHookExecution {
  callId: string
  rootCallId: string
  name: string
  arguments: unknown
  signal: AbortSignal
  token: symbol
}

export interface ToolHookSuccess {
  isError: false
  value: unknown
  content: ToolHookContentBlock[]
}

export interface ToolHookFailure {
  isError: true
  error: { message: string; code?: string }
  content: ToolHookContentBlock[]
}

/** Normalized outcome exposed after pre/execute/post hooks settle. */
export type ToolHookResult = ToolHookSuccess | ToolHookFailure

export type ToolHookPreDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

export type ToolHookPostDecision =
  | { kind: 'accept'; content?: ToolHookContentBlock[]; value?: never }
  | { kind: 'accept'; value: unknown; content?: never }
  | { kind: 'block'; feedback: ToolHookContentBlock[] }

export interface ToolHookFixture {
  name: string
  execute: (arguments_: unknown, execution: ToolHookExecution) => unknown | Promise<unknown>
  render?: (value: unknown) => ToolHookContentBlock[]
}

export interface ToolHookCall {
  name: string
  arguments?: unknown
  callId?: string
  signal?: AbortSignal
}

export interface MockToolHooksOptions {
  answerAsk?: (
    execution: ToolHookExecution,
    decision: Extract<ToolHookPreDecision, { kind: 'ask' }>,
  ) => ToolHookPreDecision | Promise<ToolHookPreDecision>
}

/** Hook fixture plus operations a test uses to drive it. */
export interface MockToolHooks {
  registerFixtureTool: (fixture: ToolHookFixture) => Disposer
  execute: (call: ToolHookCall) => Promise<ToolHookResult>
}

const PRE = 'tools/pre-execute'
const EXECUTE = 'tools/execute'
const POST = 'tools/post-execute'
const RESULT = 'tools/result'

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function failure(message_: string, code?: string): ToolHookFailure {
  return {
    isError: true,
    error: { message: message_, ...(code === undefined ? {} : { code }) },
    content: [{ type: 'text', text: message_ }],
  }
}

function defaultRender(value: unknown): ToolHookContentBlock[] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function snapshot(result: ToolHookResult): ToolHookResult {
  return freeze(structuredClone(result))
}

/**
 * Create a fixture for plugins that observe or gate the current tool hook
 * lifecycle. The context retains ownership of listeners and tool disposal.
 */
export function createMockToolHooks(
  ctx: MockContext,
  options: MockToolHooksOptions = {},
): MockToolHooks {
  const fixtures = new Map<string, ToolHookFixture>()
  const answerAsk =
    options.answerAsk ??
    ((
      _: ToolHookExecution,
      decision: Extract<ToolHookPreDecision, { kind: 'ask' }>,
    ): ToolHookPreDecision => ({ kind: 'deny', reason: decision.reason ?? 'approval unavailable' }))

  return {
    registerFixtureTool(fixture) {
      if (fixtures.has(fixture.name))
        throw new Error(`mock tool hooks: duplicate tool ${fixture.name}`)
      fixtures.set(fixture.name, fixture)
      let active = true
      return () => {
        if (!active) return
        active = false
        fixtures.delete(fixture.name)
      }
    },
    async execute(call) {
      const callId = call.callId ?? randomBytes(8).toString('hex')
      const execution: ToolHookExecution = {
        callId,
        rootCallId: callId,
        name: call.name,
        arguments: call.arguments ?? {},
        signal: call.signal ?? new AbortController().signal,
        token: Symbol(`tool:${call.name}`),
      }

      if (execution.signal.aborted) {
        const result = snapshot(
          failure('tool call aborted before dispatch', 'ABORTED_BEFORE_DISPATCH'),
        )
        ctx.emit(RESULT, execution, result)
        return result
      }

      const preListeners = ctx.listeners.get(PRE) ?? []
      let pre: ToolHookPreDecision
      try {
        pre = await Promise.resolve(
          runWaterfall(
            preListeners,
            [execution],
            () => ({ kind: 'allow' }) as ToolHookPreDecision,
          ) as ToolHookPreDecision,
        )
      } catch (error) {
        const result = snapshot(failure(message(error), 'PRE_EXECUTE_ERROR'))
        ctx.emit(RESULT, execution, result)
        return result
      }
      if (pre.kind === 'ask') pre = await answerAsk(execution, pre)

      let settled: ToolHookResult
      if (pre.kind === 'deny') {
        settled = failure(pre.reason, 'DENIED')
      } else {
        const fixture = fixtures.get(execution.name)
        if (fixture === undefined) {
          settled = failure(`unknown tool "${execution.name}"`, 'UNKNOWN_TOOL')
        } else {
          try {
            const executeListeners = ctx.listeners.get(EXECUTE) ?? []
            const result = await Promise.resolve(
              runWaterfall(executeListeners, [execution], async () => {
                const value = await fixture.execute(execution.arguments, execution)
                return { isError: false, value, content: (fixture.render ?? defaultRender)(value) }
              }) as ToolHookResult,
            )
            settled = result
          } catch (error) {
            settled = failure(message(error), 'TOOL_ERROR')
          }
        }
      }

      try {
        const postListeners = ctx.listeners.get(POST) ?? []
        const decision = await Promise.resolve(
          runWaterfall(
            postListeners,
            [execution, settled],
            () => ({ kind: 'accept' }) as ToolHookPostDecision,
          ) as ToolHookPostDecision,
        )
        if (decision.kind === 'block') {
          settled = {
            isError: true,
            error: {
              message:
                decision.feedback.map((block) => block.text).join('\n') || 'tool result blocked',
            },
            content: decision.feedback,
          }
        } else if (!settled.isError && 'value' in decision) {
          settled = {
            ...settled,
            value: decision.value,
            content: (fixtures.get(execution.name)?.render ?? defaultRender)(decision.value),
          }
        } else if (decision.kind === 'accept' && decision.content !== undefined) {
          settled = { ...settled, content: decision.content }
        }
      } catch (error) {
        settled = failure(message(error), 'POST_EXECUTE_ERROR')
      }

      const result = snapshot(settled)
      ctx.emit(RESULT, execution, result)
      return result
    },
  }
}
