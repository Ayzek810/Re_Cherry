/**
 * Proxy Stream Service
 *
 * Routes API-gateway requests through the fork kernel's `ctx.llm.stream` public
 * seam (`./engine/llmEngine`) as a one-shot non-persisting prompt stream. The
 * engine translates dsh `StreamChunk`s into `UIMessageChunk`s; the resulting
 * stream is translated into each API's SSE / JSON shape by the adapter system,
 * driven from the listener via the adapter's push API.
 *
 * The gateway is assistant-agnostic: per-request sampling, client tools, and
 * provider options are passed as first-class overrides on the engine call.
 *
 * Output is a Web-standard `Response`: streaming requests return a
 * `text/event-stream` `ReadableStream`; non-streaming requests return a JSON
 * `Response`. The Elysia route handlers return this `Response` directly.
 */

import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages'
import type { UIMessageChunk } from 'ai'
import { v4 as uuidv4 } from 'uuid'

import { loggerService } from '@logger'
import type { KernelProviderInput } from '@main/kernel/providers'

import type { InputFormat, InputParamsMap, ISseFormatter, IStreamAdapter, OutputFormat } from './adapters'
import { MessageConverterFactory, StreamAdapterFactory } from './adapters'
import type { CherryUIMessage } from './adapters/interfaces'
import { apiGatewayService } from './ApiGatewayService'
import { googleReasoningCache, openRouterReasoningCache } from './core/reasoningCache'
import { streamPrompt, resolveEndpointType, type GatewayStreamOverrides } from './engine/llmEngine'
import { buildStreamErrorFrame } from './errors'
import { appendInternalAgentContinuation } from './utils/agentContinuation'
import { normalizeAnthropicToolHistory } from './utils/anthropicToolHistory'
import { positionInlineSystemMessages } from './utils/inlineSystemMessages'
import { resolveGatewayModelAddress } from './utils/models'

const logger = loggerService.withContext('ProxyStreamService')

const GATEWAY_STREAM_IDLE_TIMEOUT_MS = 20 * 60_000

type StartupState = 'pending' | 'committed' | 'abandoned' | 'failed'

const STARTUP_COMMIT_CHUNK_TYPES: ReadonlySet<UIMessageChunk['type']> = new Set([
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
  'tool-input-available',
  'finish'
])

function isStartupCommitChunk(chunk: UIMessageChunk): boolean {
  return STARTUP_COMMIT_CHUNK_TYPES.has(chunk.type)
}

/**
 * Terminal error for a stream that paused without finishing — the 20-minute idle
 * timeout firing, or a mid-stream abort. The fork engine surfaces both as a
 * silent stream end (or an `error` chunk on explicit abort), so the gateway must
 * synthesize a failure: a 504 for the non-streaming path and a dialect error
 * frame for the streaming path. Without this, a truncated reply is
 * indistinguishable from a real completion.
 */
function streamInterruptedError(): Error & { status: number } {
  const error = new Error('Upstream stream ended before completion (idle timeout or abort)') as Error & {
    status: number
  }
  error.status = 504
  return error
}

/** Union of all supported input params. */
type InputParams = InputParamsMap[InputFormat]

/**
 * Configuration for a gateway message request (streaming or non-streaming).
 * Routes pass `{ params, inputFormat, outputFormat, signal }`.
 */
export interface MessageConfig {
  provider?: KernelProviderInput
  modelId?: string
  /** Internal Agent-session hint carried by the Claude Code SDK gateway route. */
  fastMode?: boolean
  /**
   * The loosely-validated gateway request body. Routes validate only the fields
   * the gateway needs (`model`, `messages`/`input`, …) and pass the rest through,
   * so this is `unknown` at the boundary and narrowed to the format's SDK type
   * below — the converters parse the full payload defensively.
   */
  params: unknown
  /**
   * Explicit `"providerId:modelId"` addressing. The OpenAI/Anthropic dialects
   * carry the model in the body (`params.model`); Gemini carries it in the URL
   * path, so its route passes it here to override the body lookup.
   */
  modelString?: string
  /**
   * Explicit streaming flag. The OpenAI/Anthropic dialects signal streaming via
   * `params.stream`; Gemini signals it via the `:streamGenerateContent` method,
   * so its route passes the resolved flag here.
   */
  streaming?: boolean
  inputFormat?: InputFormat
  outputFormat?: OutputFormat
  /** Request abort signal (`context.request.signal`); aborts the upstream stream on client disconnect. */
  signal?: AbortSignal
  /** Raw request headers used only to validate Cherry-internal usage correlation. */
  requestHeaders?: Headers
  onError?: (error: unknown) => void
  onComplete?: () => void
}

/** fork 缝：泵的回调面（V2 为 AiStreamManager 的 StreamListener 契约）。 */
interface GatewayStreamCallbacks {
  onChunk: (chunk: UIMessageChunk) => void
  onDone: () => void
  onPaused: () => void
  onError: (error: unknown) => void
}

interface GatewayStreamRunOptions {
  provider: KernelProviderInput
  modelId: string
  messages: CherryUIMessage[]
  overrides: GatewayStreamOverrides
  idleTimeoutMs: number
  /** Owned per-request cancel channel; fired on idle timeout and client disconnect. */
  abort: AbortController
}

/**
 * Drive one engine stream to a terminal state. fork 缝（原创）：替代 V2 的
 * AiStreamManager 调度——相邻 chunk 间隔超过 `idleTimeoutMs` 视为上游挂起，
 * abort 上游并按 paused 收口（V2 空闲超时 → paused 的语义）；迭代耗尽而无
 * finish、上游 error chunk、引擎同步抛错同样收敛到唯一一个终态回调。
 */
async function runGatewayStream(options: GatewayStreamRunOptions, callbacks: GatewayStreamCallbacks): Promise<void> {
  const { provider, modelId, messages, overrides, idleTimeoutMs, abort } = options
  let settled = false
  try {
    const iterator = streamPrompt(provider, modelId, messages, { ...overrides, signal: abort.signal })[
      Symbol.asyncIterator
    ]()
    for (;;) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let result: { kind: 'chunk'; chunk: UIMessageChunk } | { kind: 'idle' } | { kind: 'exhausted' }
      try {
        const race = await Promise.race([
          iterator.next().then(
            (r): { kind: 'chunk'; chunk: UIMessageChunk } | { kind: 'exhausted' } =>
              r.done ? { kind: 'exhausted' } : { kind: 'chunk', chunk: r.value }
          ),
          new Promise<{ kind: 'idle' }>((resolve) => {
            idleTimer = setTimeout(() => resolve({ kind: 'idle' }), idleTimeoutMs)
            idleTimer.unref?.()
          })
        ])
        result = race
      } finally {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
      }

      if (result.kind === 'idle') {
        // 空闲超时：先断上游（不再为死请求计费），再按 truncated 504 收口。
        abort.abort()
        settled = true
        callbacks.onPaused()
        return
      }
      if (result.kind === 'exhausted') {
        // 迭代耗尽而无 finish：与 V2 的 paused 同类（LlmRuntime 正常会把错误归一成
        // 终态 finish，这里只是防御）。
        settled = true
        callbacks.onPaused()
        return
      }

      const chunk = result.chunk
      if (chunk.type === 'error') {
        settled = true
        callbacks.onError(new Error(chunk.errorText))
        return
      }
      if (chunk.type === 'finish') settled = true
      callbacks.onChunk(chunk)
      if (chunk.type === 'finish') {
        callbacks.onDone()
        return
      }
    }
  } catch (error) {
    if (!settled) callbacks.onError(error)
  }
}

/**
 * Process a gateway message request — auto-detects streaming from `params.stream`.
 * Returns a Web `Response` (SSE stream or JSON) to be returned from the route.
 */
export async function processMessage(config: MessageConfig): Promise<Response> {
  const { inputFormat = 'anthropic', outputFormat = 'anthropic', onError, onComplete, signal } = config
  // Trust boundary: narrow the loosely-validated body to the format's SDK type once.
  const params = config.params as InputParams

  // Client-addressing mistakes are 400s, not 500s. Notably gemini-cli's internal
  // utility calls (chat compression, classification) hardcode bare `gemini-*-flash-lite`
  // model names that can never carry the gateway's providerId prefix — those requests
  // fail here by design (gemini-cli swallows them silently) and must not read as
  // gateway server errors in the logs.
  const asClientError = (error: unknown): Error & { status: number } => {
    const err = (error instanceof Error ? error : new Error(String(error))) as Error & { status: number }
    err.status = 400
    return err
  }

  // 1. Resolve the external "providerId:apiModelId" address from Gemini's URL-path
  // override or the request body, then map it to the internal model id.
  const modelString = config.modelString ?? ('model' in params ? (params as { model?: string }).model : undefined)
  if (!modelString || typeof modelString !== 'string') {
    throw asClientError(new Error('Request is missing a "model" field'))
  }
  const isInternalAgentRequest =
    config.requestHeaders !== undefined && apiGatewayService.isInternalAgentRequest(config.requestHeaders)
  let resolvedAddress: ReturnType<typeof resolveGatewayModelAddress>
  try {
    resolvedAddress = resolveGatewayModelAddress(modelString, isInternalAgentRequest)
  } catch (error) {
    throw asClientError(error)
  }
  const { providerId, apiModelId: modelId, provider: resolvedProvider } = resolvedAddress

  const isStreaming = config.streaming ?? ('stream' in params && (params as { stream?: boolean }).stream === true)

  logger.info(`Starting ${isStreaming ? 'streaming' : 'non-streaming'} message`, {
    providerId,
    modelId,
    inputFormat,
    outputFormat
  })

  const provider: KernelProviderInput = config.provider ?? resolvedProvider
  const isInternalAnthropicAgentRequest = inputFormat === 'anthropic' && isInternalAgentRequest
  let effectiveParams = params

  if (isInternalAnthropicAgentRequest) {
    const anthropicParams = params as MessageCreateParams
    const normalization = normalizeAnthropicToolHistory(anthropicParams.messages)

    if (normalization.status === 'conflict') {
      logger.warn('Rejected conflicting tool history in internal Agent request', {
        providerId,
        modelId,
        toolUseId: normalization.toolUseId,
        reason: normalization.reason,
        firstLocation: normalization.firstLocation,
        duplicateLocation: normalization.duplicateLocation
      })
      throw asClientError(new Error('Invalid Anthropic tool history: tool_use ids must be unique'))
    }

    if (normalization.status === 'repaired') {
      effectiveParams = { ...anthropicParams, messages: normalization.messages }
      logger.warn('Repaired duplicate tool history in internal Agent request', {
        providerId,
        modelId,
        duplicateToolUseCount: normalization.duplicateToolUseCount,
        duplicateToolResultCount: normalization.duplicateToolResultCount
      })
    }
  }

  // 2. Build converter and extract messages / tools / sampling / provider options.
  const converter = MessageConverterFactory.create(inputFormat, {
    googleReasoningCache,
    openRouterReasoningCache
  })

  const convertedMessages = converter.toUIMessages(effectiveParams)
  // Leaving inline system messages in place is what keeps the prompt prefix cacheable
  // across turns; targets that reject them get a downgrade 400 or a fold.
  const positionedMessages = positionInlineSystemMessages(
    convertedMessages,
    resolveEndpointType(provider),
    config.requestHeaders
  )
  const messages = isInternalAnthropicAgentRequest
    ? appendInternalAgentContinuation(positionedMessages)
    : positionedMessages
  const tools = converter.toAiSdkTools?.(effectiveParams)
  const streamOptions = converter.extractStreamOptions(effectiveParams)

  // fork 缝：V2 的 providerOptions 面（reasoning/thinking、fast-mode、agent
  // prompt-cache-key、usage-context 归因）在 fork 引擎（ctx.llm.stream + pi-ai 路由
  // 配置）下无消费者——converters 的 providerOptionsMapper 已是 passthrough 缝，
  // 这里只收敛 GenerateOptions 认的采样字段（topP/topK 无对应字段，裁掉）。
  const callOverrides: GatewayStreamOverrides = {
    ...(streamOptions.temperature === undefined ? {} : { temperature: streamOptions.temperature }),
    ...(streamOptions.maxOutputTokens === undefined ? {} : { maxTokens: streamOptions.maxOutputTokens }),
    ...(streamOptions.stopSequences === undefined ? {} : { stop: streamOptions.stopSequences }),
    ...(tools ? { tools } : {})
  }

  // 3. Adapter + formatter translate UIMessageChunk → output format.
  const adapter: IStreamAdapter = StreamAdapterFactory.createAdapter(outputFormat, {
    model: `${providerId}:${modelId}`,
    ...(converter.toClientToolName ? { toClientToolName: converter.toClientToolName.bind(converter) } : {})
  })
  const formatter: ISseFormatter = StreamAdapterFactory.getFormatter(outputFormat)

  const streamId = `gateway-${uuidv4()}`
  if (messages !== convertedMessages) {
    logger.info('Appended assistant-tail continuation for internal agent request', { providerId, modelId, streamId })
  }

  // fork 缝：每请求一个取消通道——客户端断连与空闲超时都经由它传给引擎
  // （ctx.llm.stream 的原生 AbortSignal 语义）。
  const abortController = new AbortController()

  if (isStreaming) {
    // Do not commit the HTTP response until the provider has produced a meaningful
    // chunk. Adapters can emit protocol scaffolding for AI SDK `start` chunks.
    const encoder = new TextEncoder()
    let startupState: StartupState = 'pending'
    let resolveStartup!: () => void
    let rejectStartup!: (error: unknown) => void
    const startup = new Promise<void>((resolve, reject) => {
      resolveStartup = resolve
      rejectStartup = reject
    })
    const bufferedFrames: Uint8Array[] = []
    let abortStream: (() => void) | undefined

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false

        const commit = () => {
          if (startupState !== 'pending') return
          startupState = 'committed'
          for (const frame of bufferedFrames) controller.enqueue(frame)
          bufferedFrames.length = 0
          resolveStartup()
        }
        const fail = (error: unknown) => {
          if (startupState !== 'pending') return
          startupState = 'failed'
          bufferedFrames.length = 0
          rejectStartup(error)
        }
        const abandon = () => {
          if (startupState !== 'pending') return
          startupState = 'abandoned'
          bufferedFrames.length = 0
          resolveStartup()
        }
        const safeClose = () => {
          if (closed) return
          closed = true
          signal?.removeEventListener('abort', onAbort)
          try {
            controller.close()
          } catch {
            // already closed
          }
        }
        const complete = () => {
          commit()
          safeClose()
          logger.info('Message completed', { providerId, modelId, streaming: true })
          onComplete?.()
        }
        const write = (data: string) => {
          if (closed) return
          const frame = encoder.encode(data)
          if (startupState === 'pending') bufferedFrames.push(frame)
          else if (startupState === 'committed') controller.enqueue(frame)
        }

        const onAbort = () => {
          abandon()
          abortController.abort()
          safeClose()
        }
        abortStream = onAbort

        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }

        // fork 缝：回调面等价于 V2 的 SseListener + StreamListener 组合。
        const callbacks: GatewayStreamCallbacks = {
          onChunk: (chunk) => {
            if (closed) return
            if (isStartupCommitChunk(chunk)) commit()
            for (const event of adapter.transformChunk(chunk)) {
              const frame = formatter.formatEvent(event)
              if (frame) write(frame)
            }
          },
          onDone: () => {
            if (closed) return
            write(
              adapter
                .finalizeEvents()
                .map((event) => formatter.formatEvent(event))
                .join('') + formatter.formatDone()
            )
            complete()
          },
          onPaused: () => {
            if (startupState === 'pending') {
              fail(streamInterruptedError())
              complete()
              return
            }
            if (closed) return
            logger.warn('Gateway stream paused before completion; emitting truncation error frame', {
              providerId,
              modelId,
              streamId
            })
            write(buildStreamErrorFrame(outputFormat, streamInterruptedError()))
            complete()
          },
          onError: (error) => {
            if (startupState === 'pending') {
              fail(error)
              try {
                onError?.(error)
              } finally {
                complete()
              }
              return
            }
            if (closed) return
            onError?.(error)
            write(buildStreamErrorFrame(outputFormat, error))
            complete()
          }
        }

        if (closed) return
        void runGatewayStream(
          {
            provider,
            modelId,
            messages,
            overrides: callOverrides,
            idleTimeoutMs: GATEWAY_STREAM_IDLE_TIMEOUT_MS,
            abort: abortController
          },
          callbacks
        )
      },
      cancel() {
        abortStream?.()
      }
    })

    const response = new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    })
    await startup
    return response
  }

  // Non-streaming: drive the adapter to accumulate state; respond with JSON at the end.
  // Terminal barrier: resolved on done/paused, rejected on error.
  let resolveDone!: () => void
  let rejectDone!: (error: unknown) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  let aborted = false
  const onAbort = () => {
    aborted = true
    abortController.abort()
    resolveDone()
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  const callbacks: GatewayStreamCallbacks = {
    onChunk: (chunk) => {
      // fork 缝：V2 的 manager 以 listener.isAlive()（!aborted）跳过向已断连
      // 消费者的派发；这里等价地停喂 adapter，防 finalize 后再进块。
      if (aborted) return
      adapter.transformChunk(chunk)
    },
    onDone: () => resolveDone(),
    onPaused: () => {
      // Pause = idle-timeout / abort, not a clean completion. If the client
      // disconnected (`aborted`), the response is moot and `done` is already
      // resolved by `onAbort`; otherwise surface a 504 so a truncated reply is
      // not returned as a successful 200.
      if (aborted) {
        resolveDone()
        return
      }
      logger.warn('Gateway non-streaming request paused before completion (idle timeout)', {
        providerId,
        modelId,
        streamId
      })
      rejectDone(streamInterruptedError())
    },
    onError: (error) => rejectDone(error)
  }

  try {
    await runGatewayStream(
      {
        provider,
        modelId,
        messages,
        overrides: callOverrides,
        idleTimeoutMs: GATEWAY_STREAM_IDLE_TIMEOUT_MS,
        abort: abortController
      },
      callbacks
    )

    await done

    // Flush the adapter's finalize step, then emit the accumulated response.
    adapter.finalizeEvents()

    logger.info('Message completed', { providerId, modelId, streaming: false })
    onComplete?.()

    return new Response(JSON.stringify(adapter.buildNonStreamingResponse()), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    logger.error('Error in message processing', error as Error, { providerId, modelId })
    onError?.(error)
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
