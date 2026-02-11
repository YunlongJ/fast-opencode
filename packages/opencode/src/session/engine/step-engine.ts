import { Identifier } from "@/id/id"
import type { Agent } from "@/agent/agent"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { Plugin } from "@/plugin"
import { Session } from "@/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionStatus } from "@/session/status"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "@/session/summary"
import type { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import type { ModelMessage, Tool } from "ai"
import type { ToolBlackboard } from "./tool-blackboard"
import type { StreamRenderer } from "./stream-renderer"
import type { ToolExecutor as EngineToolExecutor, ToolOrchestrator } from "./tool-orchestrator"
import { planFromToolExecutors, type Plan, type PlanNode } from "./plan-dsl"
import { RecoveryAgent } from "./recovery-agent"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { Truncate } from "@/tool/truncation"
import { MemoryContextEngine } from "./context"
import { ContextGovernor } from "./governor"

type Ref<T> = { value: T }

export type StepEngineResult = {
  blocked: boolean
  needsCompaction: boolean
  metrics: {
    ttftMs: number
    toolCalls: number
    toolOk: number
    toolError: number
    toolDurationMs: number
    textDeltaCount: number
    reasoningDeltaCount: number
    plannedNodes: number
  }
}

export class StepEngine {
  constructor(
    private input: {
      sessionID: string
      assistantMessage: MessageV2.Assistant
      model: Provider.Model
      agent: Agent.Info
      abort: AbortSignal
      config: Config.Info
      shouldBreak: boolean
      parallelEnabled: boolean
    },
    private deps: {
      renderer: StreamRenderer
      orchestrator: ToolOrchestrator
      blackboard: ToolBlackboard
      toolcalls: Record<string, MessageV2.ToolPart>
      snapshot: Ref<string | undefined>
      stripExecute(tools: Record<string, Tool>): Record<string, Tool>
      getResponseMessages(result: any): Promise<ModelMessage[]>
      createToolExecutor(input: {
        toolName: string
        toolInput: Record<string, any>
        partId: string
        callId: string
        abort: AbortSignal
        toolPart: MessageV2.ToolPart
      }): EngineToolExecutor
    },
  ) {}

  async run(streamInput: LLM.StreamInput): Promise<StepEngineResult> {
    const metrics = {
      ttftMs: -1,
      toolCalls: 0,
      toolOk: 0,
      toolError: 0,
      toolDurationMs: 0,
      textDeltaCount: 0,
      reasoningDeltaCount: 0,
      plannedNodes: 0,
    }

    let blocked = false
    let needsCompaction = false

    let currentText: MessageV2.TextPart | undefined
    const reasoningMap: Record<string, MessageV2.ReasoningPart> = {}

    let llmMessages = streamInput.messages
    const maxToolSteps = 25
    const governor = new ContextGovernor();
    let contextInjected = false; // 确保每个 User 消息仅注入一次上下文

    try {
      for (let toolStep = 0; toolStep < maxToolSteps; toolStep++) {
        // --- 上下文治理 (Governance) ---
        llmMessages = await governor.govern(llmMessages);
      
      const stepExecutors: EngineToolExecutor[] = []
      const toolsForLLM = this.input.parallelEnabled ? this.deps.stripExecute(streamInput.tools) : streamInput.tools

      // --- 极致上下文注入 (In-Memory Context Injection) ---
      if (!contextInjected) {
        const lastMessageIndex = llmMessages.length - 1;
        const lastMessage = llmMessages[lastMessageIndex];
        if (lastMessage && lastMessage.role === "user") {
          const query = typeof lastMessage.content === "string" ? lastMessage.content : "";
          if (query) {
            const engine = MemoryContextEngine.getInstance();
            await engine.init(); // 确保引擎已初始化
            const relevantSnippets = await engine.search(query, 3);
            contextInjected = true; // 标记已尝试注入，避免重复搜索
            if (relevantSnippets.length > 0) {
              const contextPrompt = `\n\n[Memory Context Engine]: 检索到相关代码片段，请参考：\n${relevantSnippets.join("\n---\n")}`;
              if (typeof lastMessage.content === "string") {
                const newLastMessage = {
                  ...lastMessage,
                  content: lastMessage.content + contextPrompt
                };
                llmMessages = [...llmMessages.slice(0, lastMessageIndex), newLastMessage];
              }
            }
          }
        }
      }
      // --------------------------------------------------

      const stream = await LLM.stream({
        ...streamInput,
        messages: llmMessages,
        tools: toolsForLLM,
        config: this.input.config,
      })
      const llmStart = Date.now()

      for await (const value of stream.fullStream) {
        this.input.abort.throwIfAborted()
        switch (value.type) {
          case "start":
            SessionStatus.set(this.input.sessionID, { type: "busy" })
            break
          case "reasoning-start":
            if (value.id in reasoningMap) break
            reasoningMap[value.id] = {
              id: Identifier.ascending("part"),
              messageID: this.input.assistantMessage.id,
              sessionID: this.input.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            break
          case "reasoning-delta":
            if (value.id in reasoningMap) {
              const part = reasoningMap[value.id]
              part.text += value.text
              if (value.providerMetadata) part.metadata = value.providerMetadata
              if (value.text) this.deps.renderer.onReasoningDelta(value.id, part, value.text)
              metrics.reasoningDeltaCount++
              if (metrics.ttftMs < 0) metrics.ttftMs = Date.now() - llmStart
            }
            break
          case "reasoning-end":
            if (value.id in reasoningMap) {
              const part = reasoningMap[value.id]
              part.text = part.text.trimEnd()
              part.time = { ...part.time, end: Date.now() }
              if (value.providerMetadata) part.metadata = value.providerMetadata
              await this.deps.renderer.flushAll()
              await Session.updatePart(part)
              delete reasoningMap[value.id]
            }
            break
          case "tool-input-start":
          case "tool-input-delta":
          case "tool-input-end":
            break
          case "tool-call": {
            const match = this.deps.toolcalls[value.toolCallId]
            const part = (await Session.updatePart({
              id: match?.id ?? Identifier.ascending("part"),
              messageID: this.input.assistantMessage.id,
              sessionID: this.input.assistantMessage.sessionID,
              type: "tool",
              tool: value.toolName,
              callID: value.toolCallId,
              state: this.input.parallelEnabled
                ? { status: "pending" as const, input: value.input, raw: "" }
                : { status: "running" as const, input: value.input, time: { start: Date.now() } },
              metadata: value.providerMetadata,
            })) as MessageV2.ToolPart
            this.deps.toolcalls[value.toolCallId] = part

            if (this.input.parallelEnabled) {
              stepExecutors.push(
                this.deps.createToolExecutor({
                  toolName: value.toolName,
                  toolInput: value.input,
                  partId: part.id,
                  callId: value.toolCallId,
                  abort: this.input.abort,
                  toolPart: part,
                }),
              )
            }

            if (!this.input.parallelEnabled) {
              const parts = await MessageV2.parts(this.input.assistantMessage.id)
              const lastThree = parts.slice(-3)
              if (
                lastThree.length === 3 &&
                lastThree.every(
                  (p) =>
                    p.type === "tool" &&
                    p.tool === value.toolName &&
                    p.state.status !== "pending" &&
                    JSON.stringify(p.state.input) === JSON.stringify(value.input),
                )
              ) {
                await PermissionNext.ask({
                  permission: "doom_loop",
                  patterns: [value.toolName],
                  sessionID: this.input.assistantMessage.sessionID,
                  metadata: { tool: value.toolName, input: value.input },
                  always: [value.toolName],
                  ruleset: this.input.agent.permission,
                })
              }
            }
            break
          }
          case "tool-result": {
            const match = this.deps.toolcalls[value.toolCallId]
            if (match && (match.state.status === "running" || match.state.status === "pending")) {
              const attachments = value.output.attachments?.map(
                (attachment: Omit<MessageV2.FilePart, "id" | "messageID" | "sessionID">) => ({
                  ...attachment,
                  id: Identifier.ascending("part"),
                  messageID: match.messageID,
                  sessionID: match.sessionID,
                }),
              )
              await Session.updatePart({
                ...match,
                state: {
                  status: "completed",
                  input: value.input ?? match.state.input,
                  output: value.output.output,
                  metadata: value.output.metadata,
                  title: value.output.title,
                  time: { start: (match.state as any).time?.start ?? Date.now(), end: Date.now() },
                  attachments,
                },
              })
              delete this.deps.toolcalls[value.toolCallId]
            }
            break
          }
          case "tool-error": {
            const match = this.deps.toolcalls[value.toolCallId]
            if (match && (match.state.status === "running" || match.state.status === "pending")) {
              await Session.updatePart({
                ...match,
                state: {
                  status: "error",
                  input: value.input ?? match.state.input,
                  error: (value.error as any).toString(),
                  time: { start: (match.state as any).time?.start ?? Date.now(), end: Date.now() },
                },
              })
              if (value.error instanceof PermissionNext.RejectedError || value.error instanceof Question.RejectedError) {
                blocked = this.input.shouldBreak
              }
              delete this.deps.toolcalls[value.toolCallId]
            }
            break
          }
          case "error":
            throw value.error
          case "start-step":
            this.deps.snapshot.value = await Snapshot.track()
            await Session.updatePart({
              id: Identifier.ascending("part"),
              messageID: this.input.assistantMessage.id,
              sessionID: this.input.sessionID,
              snapshot: this.deps.snapshot.value,
              type: "step-start",
            })
            break
          case "finish-step": {
            const usage = Session.getUsage({
              model: this.input.model,
              usage: value.usage,
              metadata: value.providerMetadata,
            })
            this.input.assistantMessage.finish = value.finishReason
            this.input.assistantMessage.cost += usage.cost
            this.input.assistantMessage.tokens = usage.tokens
            await Session.updatePart({
              id: Identifier.ascending("part"),
              reason: value.finishReason,
              snapshot: await Snapshot.track(),
              messageID: this.input.assistantMessage.id,
              sessionID: this.input.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            await Session.updateMessage(this.input.assistantMessage)
            if (this.deps.snapshot.value) {
              const patch = await Snapshot.patch(this.deps.snapshot.value)
              if (patch.files.length) {
                await Session.updatePart({
                  id: Identifier.ascending("part"),
                  messageID: this.input.assistantMessage.id,
                  sessionID: this.input.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              this.deps.snapshot.value = undefined
            }
            SessionSummary.summarize({ sessionID: this.input.sessionID, messageID: this.input.assistantMessage.parentID })
            if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: this.input.model })) {
              needsCompaction = true
            }
            break
          }
          case "text-start":
            currentText = {
              id: Identifier.ascending("part"),
              messageID: this.input.assistantMessage.id,
              sessionID: this.input.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            break
          case "text-delta":
            if (currentText) {
              currentText.text += value.text
              if (value.providerMetadata) currentText.metadata = value.providerMetadata
              if (value.text) this.deps.renderer.onTextDelta(currentText, value.text)
              metrics.textDeltaCount++
              if (metrics.ttftMs < 0) metrics.ttftMs = Date.now() - llmStart
            }
            break
          case "text-end":
            if (currentText) {
              await this.deps.renderer.flushAll()
              currentText.text = currentText.text.trimEnd()
              const textOutput = await Plugin.trigger(
                "experimental.text.complete",
                {
                  sessionID: this.input.sessionID,
                  messageID: this.input.assistantMessage.id,
                  partID: currentText.id,
                },
                { text: currentText.text },
              )
              currentText.text = textOutput.text
              currentText.time = { start: Date.now(), end: Date.now() }
              if (value.providerMetadata) currentText.metadata = value.providerMetadata
              await Session.updatePart(currentText)
              currentText = undefined
            }
            break
          case "finish":
            break
          default:
            break
        }
      }

      await this.deps.renderer.flushAll()

      const responseMessages = await this.deps.getResponseMessages(stream)
      if (responseMessages.length > 0) {
        llmMessages = [...llmMessages, ...responseMessages]
      }

      if (stepExecutors.length === 0) break
      if (!this.input.parallelEnabled) break
      if (needsCompaction) break

      const plan = planFromToolExecutors(stepExecutors)
      metrics.plannedNodes += plan.nodes.length

      const executorMap = new Map<string, EngineToolExecutor>()
      for (const e of stepExecutors) executorMap.set(e.callId, e)

      const finalResults: any[] = []
      const executedIds = new Set<string>()

      while (executedIds.size < plan.nodes.length) {
        const readyNodes = plan.nodes.filter((node) => {
          if (node.status !== "pending") return false
          
          // Check dependencies
          const depsMet = node.dependsOn.every((depId) => {
            const depNode = plan.nodes.find((n) => n.id === depId)
            return depNode?.status === "completed" || depNode?.status === "error" || depNode?.status === "skipped"
          })
          if (!depsMet) return false

          // Check conditions
          if (node.condition) {
            if (node.condition.type === "tool-ok") {
              const dep = plan.nodes.find((n) => n.id === (node.condition as any).toolCallId)
              if (dep?.status !== "completed") {
                node.status = "skipped"
                return false
              }
            } else if (node.condition.type === "tool-error") {
              const dep = plan.nodes.find((n) => n.id === (node.condition as any).toolCallId)
              if (dep?.status !== "error") {
                node.status = "skipped"
                return false
              }
            }
          }

          return true
        })

        if (readyNodes.length === 0) {
          // Check if we are stuck
          const hasPending = plan.nodes.some(n => n.status === "pending")
          if (hasPending) {
             // Mark remaining as skipped if they have dependencies that will never be met
             for (const n of plan.nodes) {
               if (n.status === "pending") n.status = "skipped"
             }
          }
          break
        }

        const currentExecutors = readyNodes
          .map((node) => executorMap.get(node.id))
          .filter((e): e is EngineToolExecutor => !!e)

        if (currentExecutors.length === 0) break

        for (const node of readyNodes) node.status = "running"
        const results = await this.deps.orchestrator.execute(currentExecutors)

        for (const r of results) {
          const node = plan.nodes.find((n) => n.id === r.toolCallId)!
          
          // Recovery check
          const recovery = RecoveryAgent.suggest(r, node)
          if (recovery) {
            if (recovery.type === "retry") {
              node.status = "pending"
              node.retryCount++
              continue // Will be picked up in next iteration, NOT added to executedIds
            } else if (recovery.type === "add-nodes") {
              // Add new nodes to plan and create executors for them
              for (const newNode of recovery.nodes) {
                plan.nodes.push(newNode)
                // We need to create a tool part and executor for the recovery node
                const part = (await Session.updatePart({
                  id: Identifier.ascending("part"),
                  messageID: this.input.assistantMessage.id,
                  sessionID: this.input.assistantMessage.sessionID,
                  type: "tool",
                  tool: newNode.toolName,
                  callID: newNode.id,
                  state: { status: "pending", input: newNode.args, raw: "" },
                })) as MessageV2.ToolPart
                this.deps.toolcalls[newNode.id] = part
                
                executorMap.set(newNode.id, this.deps.createToolExecutor({
                  toolName: newNode.toolName,
                  toolInput: newNode.args,
                  partId: part.id,
                  callId: newNode.id,
                  abort: this.input.abort,
                  toolPart: part
                }))
              }
              // Mark original as error but continue
              node.status = "error"
            }
          } else {
            node.status = r.ok ? "completed" : "error"
            if (!r.ok && (r.error?.includes("RejectedError") || r.error?.includes("Permission denied"))) {
              blocked = this.input.shouldBreak
            }
          }

          let toolOutput = r.ok ? (r.output?.output ?? "") : (r.error ?? "Tool execution failed")
          
          // Apply truncation if needed (both for success and error outputs to prevent token overflow/leaks)
          if (toolOutput.length > Truncate.MAX_BYTES) {
            const truncated = await Truncate.output(toolOutput, {}, this.input.agent)
            toolOutput = truncated.content
          }

          executedIds.add(node.id)
          finalResults.push({ ...r, toolOutput }) // Store truncated output for message content
          delete this.deps.toolcalls[r.toolCallId]

          this.deps.blackboard.put({
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            input: r.input,
            ok: r.ok,
            output: r.ok ? r.output?.output : undefined,
            title: r.ok ? r.output?.title : undefined,
            metadata: r.ok ? r.output?.metadata : undefined,
            attachments: r.ok ? r.output?.attachments : undefined,
            time: { start: 0, end: 0 },
          })

          metrics.toolCalls++
          if (r.ok) metrics.toolOk++
          else metrics.toolError++
          metrics.toolDurationMs += r.durationMs
        }
      }

      llmMessages = [
        ...llmMessages,
        {
          role: "tool" as const,
          content: finalResults.map((r) => {
            return {
              type: "tool-result" as const,
              toolCallId: r.toolCallId,
              toolName: r.toolName,
              args: r.input,
              output: {
                type: "content" as const,
                value: [{ type: "text" as const, text: r.toolOutput }],
              },
            }
          }),
        },
      ]
      
      // 检查是否所有计划中的节点都已执行完毕
      const allDone = plan.nodes.every(n => n.status === "completed" || n.status === "error" || n.status === "skipped")
      if (allDone) break
    }
  } finally {
      // 避免 Reasoning Map 内存泄漏，确保清理所有未完成的推理节点
      for (const id in reasoningMap) {
        delete reasoningMap[id]
      }
    }

    await this.deps.renderer.flushAll()
    return { blocked, needsCompaction, metrics }
  }
}
