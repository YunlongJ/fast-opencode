import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import type { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { LLM } from "./llm"
import { type ModelMessage, type Tool } from "ai"
import { BackgroundTaskHandler, type WorkQueueIntegrationConfig } from "./work-queue/integration"
import { StreamRenderer } from "./engine/stream-renderer"
import { ToolBlackboard } from "./engine/tool-blackboard"
import { StepEngine } from "./engine/step-engine"
import {
  ToolOrchestrator,
  createResourceLockManager as createEngineResourceLockManager,
  createToolExecutor as createEngineToolExecutor,
} from "./engine/tool-orchestrator"
import { MemoryContextEngine } from "./engine/context"
import { CompactionService } from "./engine/compaction-service"

/**
 * SessionProcessor 负责处理会话的核心逻辑，包括工具调度、上下文管理和步骤执行。
 * @responsibility 协调 LLM 流、工具执行、快照管理及上下文压缩。
 */
export namespace SessionProcessor {
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  /**
   * 创建 SessionProcessor 实例
   * @param input 初始化参数，包含会话 ID、模型信息等。
   */
  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false
    let compactionAttemptCount = 0
    const MAX_COMPACTION_ATTEMPTS = 3
    let backgroundHandler: BackgroundTaskHandler | null = null

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      /**
       * 执行会话处理循环
       * @param streamInput LLM 输入流配置
       * @returns 处理结果状态 ("continue" | "stop" | "compact")
       * @throws 可能会抛出 LLM 调用或工具执行相关的异常，由内部 try-catch 统一处理并进行重试。
       */
      async process(
        streamInput: LLM.StreamInput,
      ): Promise<"continue" | "stop" | "compact" | { status: "error"; error: string; needsCompaction: boolean }> {
        log.info("process", { sessionID: input.sessionID })
        needsCompaction = false
        const blackboard = new ToolBlackboard()

        // --- 极致上下文引擎初始化 (FlexSearch + Tree-sitter) ---
        // @VertxThreadSafety: MemoryContextEngine 内部管理单例和并发索引
        const contextEngine = MemoryContextEngine.getInstance()
        try {
          await contextEngine.init()
          // 触发工作区索引 (后台异步执行，不阻塞主流程)
          contextEngine.indexWorkspace().catch((err) => {
            log.error({ err }, "Background workspace indexing failed")
          })
        } catch (err) {
          log.error({ err }, "Failed to initialize MemoryContextEngine")
        }

        const config = await Config.get()
        const shouldBreak = config.experimental?.continue_loop_on_deny !== true
        const parallelEnabled = config.experimental?.parallel_execution !== false
        const maxParallelTools = config.experimental?.max_parallel_tools ?? 16
        const agentInfo = await Agent.get(input.assistantMessage.agent)
        const exp = (config.experimental ?? {}) as { delta_throttle_ms?: number; deltaThrottleMs?: number }
        const resourceLockManager = createEngineResourceLockManager()
        const concurrencyRef = { value: Math.max(1, maxParallelTools) }
        let toolSampleCount = 0
        let toolErrorCount = 0
        let toolDurationSum = 0
        let toolAdjustAt = Date.now()

        const limiter = (() => {
          let active = 0
          const queue: Array<() => void> = []
          const notify = () => {
            while (active < concurrencyRef.value && queue.length > 0) {
              const next = queue.shift()
              if (next) {
                active++
                next()
              }
            }
          }
          async function run<T>(fn: () => Promise<T>): Promise<T> {
            if (active >= concurrencyRef.value) {
              await new Promise<void>((resolve) => queue.push(resolve))
            } else {
              active++
            }
            try {
              return await fn()
            } finally {
              active--
              notify()
            }
          }
          return { run, notify }
        })()

        const onToolExecuted = (r: { durationMs: number; ok: boolean }) => {
          toolSampleCount++
          toolDurationSum += r.durationMs
          if (!r.ok) toolErrorCount++
          const now = Date.now()
          const shouldAdjust = toolSampleCount >= 12 || now - toolAdjustAt >= 10_000
          if (!shouldAdjust) return
          const avg = toolSampleCount > 0 ? toolDurationSum / toolSampleCount : 0
          const errRate = toolSampleCount > 0 ? toolErrorCount / toolSampleCount : 0
          const prev = concurrencyRef.value
          let next = prev
          if (errRate >= 0.25) next = Math.max(1, Math.floor(prev * 0.7))
          else if (avg >= 2_500) next = Math.max(1, prev - 1)
          else if (avg <= 600) next = Math.min(maxParallelTools, prev + 1)

          if (next !== prev) {
            concurrencyRef.value = next
            limiter.notify()
          }

          toolSampleCount = 0
          toolErrorCount = 0
          toolDurationSum = 0
          toolAdjustAt = now
        }

        const stripExecute = (tools: Record<string, Tool>): Record<string, Tool> => {
          return Object.fromEntries(
            Object.entries(tools).map(([id, t]) => {
              if (!t.execute) return [id, t]
              return [id, { ...t, execute: undefined }]
            }),
          )
        }

        const getResponseMessages = async (result: any): Promise<ModelMessage[]> => {
          if (!result) return []
          try {
            const resp = await (result?.response?.then ? result.response : Promise.resolve(result?.response))
            return resp?.messages ?? []
          } catch (e) {
            log.error("Failed to get response messages from stream result", { error: e })
            return []
          }
        }

        let metrics = {
          ttftMs: -1,
          toolCalls: 0,
          toolOk: 0,
          toolError: 0,
          toolDurationMs: 0,
          textDeltaCount: 0,
          reasoningDeltaCount: 0,
          plannedNodes: 0,
        }

        const renderer = new StreamRenderer({
          deltaThrottleMs: exp.delta_throttle_ms ?? exp.deltaThrottleMs,
        })

        const orchestrator = new ToolOrchestrator(
          { sessionID: input.sessionID, assistantMessage: input.assistantMessage, agent: agentInfo },
          streamInput.tools,
          { limiter, resourceLockManager, onToolExecuted: (r) => onToolExecuted(r) },
        )

        const snapshotRef = { value: snapshot as string | undefined }

        const stepEngine = new StepEngine(
          {
            sessionID: input.sessionID,
            assistantMessage: input.assistantMessage,
            model: input.model,
            agent: agentInfo,
            abort: input.abort,
            config,
            shouldBreak,
            parallelEnabled,
          },
          {
            renderer,
            orchestrator,
            blackboard,
            toolcalls,
            snapshot: snapshotRef,
            stripExecute,
            getResponseMessages,
            createToolExecutor: createEngineToolExecutor,
          },
        )

        const stopTimers = () => renderer.stopTimers()

        while (true) {
          try {
            // --- 执行步骤引擎 ---
            const stepResult = await stepEngine.run(streamInput)
            blocked = stepResult.blocked
            metrics = stepResult.metrics
            snapshot = snapshotRef.value
            stopTimers()

            // --- 动态上下文治理评估 ---
            // 根据当前 token 使用情况，评估是否需要执行压缩策略
            const tokenCount =
              input.assistantMessage.tokens.input +
              input.assistantMessage.tokens.cache.read +
              input.assistantMessage.tokens.output

            const outputLimit = Math.min(input.model.limit.output, 4096)
            const usableContext = input.model.limit.context - outputLimit

            // 避免除以零
            if (usableContext <= 0) {
              log.warn("Invalid context limit", {
                context: input.model.limit.context,
                output: input.model.limit.output,
              })
            } else {
              const usageRatio = tokenCount / usableContext

              if (usageRatio > 0.95) {
                compactionAttemptCount++

                if (compactionAttemptCount > MAX_COMPACTION_ATTEMPTS) {
                  log.error("Max compaction attempts reached, forcing continue", {
                    sessionID: input.sessionID,
                    attempts: compactionAttemptCount,
                    usageRatio: usageRatio.toFixed(2),
                  })
                  // Force continue to break the infinite loop
                  // This is a safety measure to prevent session lock
                  needsCompaction = false
                  return "continue"
                }

                log.warn("Full compaction triggered", {
                  sessionID: input.sessionID,
                  usageRatio: usageRatio.toFixed(2),
                  attempt: compactionAttemptCount,
                })
                needsCompaction = true
                return "compact"
              } else if (usageRatio > 0.85) {
                log.info("Pruning recommended", { usageRatio: usageRatio.toFixed(2) })
                try {
                  await CompactionService.prune({ sessionID: input.sessionID })
                } catch (pruneError) {
                  log.error("Pruning failed", { error: pruneError, sessionID: input.sessionID })
                  // Continue even if pruning fails, don't block the session
                }
              }
            }

            log.info("metrics", {
              sessionID: input.sessionID,
              ttftMs: metrics.ttftMs,
              toolCalls: metrics.toolCalls,
              toolOk: metrics.toolOk,
              toolError: metrics.toolError,
              toolDurationMs: metrics.toolDurationMs,
              textDeltaCount: metrics.textDeltaCount,
              reasoningDeltaCount: metrics.reasoningDeltaCount,
              plannedNodes: metrics.plannedNodes,
            })
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              stopTimers()
              continue
            }
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
            SessionStatus.set(input.sessionID, { type: "idle" })
          }
          stopTimers()
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          orchestrator.clear()
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },

      async enableBackgroundTasks(config?: WorkQueueIntegrationConfig) {
        if (backgroundHandler) {
          await backgroundHandler.stop()
        }
        backgroundHandler = new BackgroundTaskHandler(input.sessionID, config)
        await backgroundHandler.initialize()
        backgroundHandler.setContext(await Agent.get(input.assistantMessage.agent), input.model)
        return backgroundHandler
      },
      async disableBackgroundTasks() {
        if (backgroundHandler) {
          await backgroundHandler.stop()
          backgroundHandler = null
        }
      },
      getWorkQueue() {
        return backgroundHandler
      },
    }
    return result
  }
}
