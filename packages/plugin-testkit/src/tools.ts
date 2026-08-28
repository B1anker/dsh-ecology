/**
 * A minimal stand-in for the dsh tools execution pipeline.
 *
 * Enough to test a hook plugin on `tools/pre-execute`, `tools/execute`, and
 * `tools/post-execute` without a real tools registry, schema validation, or
 * approval UI. Decisions match the cookbook permission-gate shape: allow by
 * calling `next()`, or return `{ kind: 'deny' }` / `{ kind: 'ask' }`.
 *
 * This is not `@deepseek-ai/dsh-tools`. Identity freezing, guards, PTC mode,
 * and card presentation are out of scope.
 *
 * @module @seaveyon/dsh-plugin-testkit/tools
 */

import { randomBytes } from 'node:crypto'
import type { MockContext } from './context.js'
import { runWaterfall } from './events.js'
import type { PreToolDecision, ToolBody, ToolExecution, ToolResult, ToolsService } from './types.js'

/** How an unanswered `ask` decision is resolved. Defaults to deny. */
export type AskAnswerer = (
  exec: ToolExecution,
  decision: Extract<PreToolDecision, { kind: 'ask' }>,
) => PreToolDecision | Promise<PreToolDecision>

/** Options for {@link createMockToolsPipeline}. */
export interface MockToolsPipelineOptions {
  /** Resolve `ask` decisions. Default: deny with a fixed reason. */
  answerAsk?: AskAnswerer
}

/** A call the test drives through the pipeline. */
export interface ToolCallInput {
  name: string
  arguments?: unknown
  callId?: string
  signal?: AbortSignal
}

/** The mock pipeline plus the service a plugin `get`s as `tools`. */
export interface MockToolsPipeline {
  service: ToolsService
  /** Drive one call through pre → body → post. */
  run: (call: ToolCallInput) => Promise<ToolResult>
}

const PRE = 'tools/pre-execute'
const EXECUTE = 'tools/execute'
const POST = 'tools/post-execute'

/**
 * Default ask handler: treat an unanswered prompt as a denial.
 * @param _exec - the pending execution.
 * @param decision - the ask decision from pre-execute.
 * @returns a deny decision.
 */
const defaultAnswerAsk: AskAnswerer = (_exec, decision) => ({
  kind: 'deny',
  reason: decision.reason ?? 'approval unavailable',
})

/**
 * Create a tools pipeline bound to a mock context's event bus.
 * @param ctx - context whose listeners the hooks use.
 * @param options - ask resolution and similar knobs.
 * @returns the service and a `run` entry for tests.
 */
export function createMockToolsPipeline(
  ctx: MockContext,
  options: MockToolsPipelineOptions = {},
): MockToolsPipeline {
  const tools = new Map<string, ToolBody>()
  const answerAsk = options.answerAsk ?? defaultAnswerAsk

  const service: ToolsService = {
    register(name, execute) {
      if (tools.has(name)) throw new Error(`mock: duplicate tool ${name}`)
      tools.set(name, execute)
      return () => {
        tools.delete(name)
      }
    },
  }

  ctx.set('tools', service)

  return {
    service,
    async run(call) {
      const body = tools.get(call.name)
      if (body === undefined) {
        return { content: `unknown tool: ${call.name}`, isError: true }
      }

      const exec: ToolExecution = {
        callId: call.callId ?? randomBytes(8).toString('hex'),
        name: call.name,
        arguments: call.arguments ?? {},
        signal: call.signal ?? new AbortController().signal,
        token: randomBytes(16).toString('hex'),
      }

      const preListeners = ctx.listeners.get(PRE) ?? []
      let decision = (await Promise.resolve(
        runWaterfall(preListeners, [exec], () => ({ kind: 'allow' }) as PreToolDecision),
      )) as PreToolDecision

      if (decision.kind === 'ask') {
        decision = await answerAsk(exec, decision)
      }

      let result: ToolResult

      if (decision.kind === 'deny') {
        result = { content: decision.reason, isError: true }
      } else {
        try {
          const executeListeners = ctx.listeners.get(EXECUTE) ?? []
          const settled = await Promise.resolve(
            runWaterfall(executeListeners, [exec], () => body(exec)),
          )
          result = { content: settled, isError: false }
        } catch (error) {
          result = {
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          }
        }
      }

      const postListeners = ctx.listeners.get(POST) ?? []
      const post = await Promise.resolve(
        runWaterfall(postListeners, [exec, result], () => result) as ToolResult,
      )
      return post
    },
  }
}
