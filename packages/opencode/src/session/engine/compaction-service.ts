import { Log } from "@/util/log"
import { type ModelMessage } from "ai"
import { MessageV2 } from "../message-v2"
import { Session } from ".."
import { Identifier } from "../../id/id"
import { Agent } from "@/agent/agent"
import { Provider } from "../../provider/provider"
import { LLM } from "../llm"
import { Config } from "@/config/config"
import { Token } from "@/util/token"
import { Instance } from "../../project/instance"
import { SessionProcessor } from "../processor"
import { Plugin } from "@/plugin"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { fn } from "@/util/fn"
import { SessionPrompt } from "../prompt"

/**
 * 会话压缩服务
 * @responsibility 处理会话层面的持久化压缩逻辑，包括数据库修剪（Pruning）和摘要生成（Checkpointing）。
 * @VertxThreadSafety 该服务通过 Session 模块进行原子化数据库操作。
 */
export class CompactionService {
  private static readonly log = Log.create({ service: "compaction.service" })

  public static readonly Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  private static readonly PRUNE_MINIMUM = 20_000
  private static readonly PRUNE_PROTECT = 40_000
  private static readonly PRUNE_PROTECTED_TOOLS = ["skill"]

  /**
   * 检查当前 Token 是否溢出
   * @param input 包含当前 token 计数和模型信息
   */
  public static async isOverflow(input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }): Promise<boolean> {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false

    const context = input.model.limit.context
    if (context === 0) return false

    const count = input.tokens.input + input.tokens.cache.read + input.tokens.output

    // 优先使用 input limit（如果设置了）
    if (input.model.limit.input && input.model.limit.input > 0) {
      return count > input.model.limit.input
    }

    // 原有逻辑：usable = context - outputLimit
    const outputLimit =
      Math.min(input.model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
    let usable = context - outputLimit

    // 安全检查：如果 usable 太小，使用保守估计
    if (usable < 5000) {
      usable = context * 0.7
    }

    return count > usable
  }

  /**
   * 执行数据库级修剪
   * @description 遍历会话历史，修剪过旧且不相关的工具输出以节省空间。
   */
  public static async prune(input: { sessionID: string }): Promise<void> {
    const config = await Config.get()
    if (config.compaction?.prune === false) return

    this.log.info("Starting session pruning", { sessionID: input.sessionID })
    const msgs = await Session.messages({ sessionID: input.sessionID })

    let total = 0
    let prunedCount = 0
    const toPrune: MessageV2.ToolPart[] = []
    let turns = 0

    // 从后往前遍历，跳过最近的轮次
    loop: for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue

      // 如果遇到已摘要的消息，停止修剪
      if (msg.info.role === "assistant" && (msg.info as MessageV2.Assistant).summary) break loop

      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j]
        if (part.type === "tool" && part.state.status === "completed") {
          if (this.PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop

          const estimate = Token.estimate(part.state.output)
          total += estimate

          if (total > this.PRUNE_PROTECT) {
            prunedCount += estimate
            toPrune.push(part)
          }
        }
      }
    }

    if (prunedCount > this.PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status !== "completed") continue

        const output = part.state.output
        // 如果输出过大，尝试总结而不是直接丢弃
        if (output.length > 5000) {
          const summary = await this.summarize(output)
          part.state.output = `[Summarized Output]: ${summary}`
        }
        part.state.time.compacted = Date.now()
        await Session.updatePart(part)
      }
      this.log.info("Pruning complete", { pruned: prunedCount, parts: toPrune.length })
    }
  }

  /**
   * 使用 LLM 总结文本
   * @param text 需要总结的内容
   */
  public static async summarize(text: string): Promise<string> {
    try {
      const agent = await Agent.get("compaction")
      const model = agent.model ?? (await Provider.defaultModel())

      const result = await LLM.generate({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a tool output summarizer. Summarize the following tool output concisely, preserving key findings, errors, and file paths. Keep it under 200 words.",
          },
          { role: "user", content: text },
        ],
      })
      return result.text
    } catch (e) {
      this.log.error("Summarization failed", { error: e })
      return text.slice(0, 1000) + "... (Summary failed)"
    }
  }

  /**
   * 处理全量压缩（摘要生成）
   */
  public static async process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    abort: AbortSignal
    auto: boolean
  }): Promise<"continue" | "stop"> {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User
    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)

    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: model.id,
      providerID: model.providerID,
      time: { created: Date.now() },
    })) as MessageV2.Assistant

    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })

    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )

    const defaultPrompt =
      "Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next considering new session will not have access to our conversation."
    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
    // 截断消息，避免上下文超限
    const MAX_MESSAGES_FOR_COMPACTION = 20
    const recentMessages = input.messages.slice(-MAX_MESSAGES_FOR_COMPACTION)

    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: [
        ...MessageV2.toModelMessages(recentMessages, model),
        {
          role: "user",
          content: [{ type: "text", text: promptText }],
        },
      ],
      model,
    })
    if (result === "continue" && input.auto) {
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        agent: userMessage.agent,
        model: userMessage.model,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "Continue if you have next steps",
        time: { start: Date.now(), end: Date.now() },
      })
    }

    if (processor.message.error) {
      this.log.error("Compaction failed", {
        sessionID: input.sessionID,
        error: processor.message.error,
        attempt: input.auto ? "auto" : "manual",
      })

      // Clear compaction flag to prevent infinite loop
      // The caller should handle the error and potentially retry with different strategy
      return "stop"
    }

    Bus.publish(this.Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  /**
   * 创建压缩任务
   */
  public static readonly create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      auto: z.boolean(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
      })
    },
  )
}
