import { Log } from "@/util/log"
import { Storage } from "@/storage/storage"

interface ToolResult {
  toolName: string
  toolCallId: string
  ok: boolean
  input: any
  output?: any
  error?: string
}

interface MemoryEntry {
  id: string
  type: "decision" | "change" | "todo"
  content: string
  timestamp: number
  metadata: Record<string, any>
}

/**
 * 信息提取器
 * 从对话中自动提取决策、修改、待办，存储到 Storage.Vector
 */
export class InfoExtractor {
  private static readonly log = Log.create({ service: "info.extractor" })
  private static readonly COLLECTION = "memories"

  // 决策信号词 - 更严格的匹配
  private static readonly DECISION_SIGNALS = [
    // 明确的决策动词 + 方案
    /(?:决定|选择|采用|使用)\s*[:：]?\s*(.+?)(?:\n|$|。)/i,
    // 确认 + 动作
    /(?:就|那就)\s*(?:用|选|采用)\s*(.+?)(?:\n|$|。)/i,
    // 简单确认后需要跟具体方案，不能单独"好的"
    /(?:好的|行|可以|ok|没问题)[，,。\s]+(?:用|选|采用)?\s*([A-Za-z\u4e00-\u9fa5]+(?:方案|策略|方法|技术|框架|库|工具)?)/i,
  ]

  // 拒绝信号词
  private static readonly REJECT_SIGNALS = [/(?:不行|不对|不好|不合适|换|不要|别用)/i]

  // 待办信号词
  private static readonly TODO_SIGNALS = [
    /(?:还要|记得|别忘了|之后|待会儿|稍后|下次|todo|TODO)[：:]?\s*(.+?)(?:\n|$|。)/i,
    /(?:需要|应该|得|要)\s*(?:做|写|加|改|优化|测试|检查)\s*(.+?)(?:\n|$|。)/i,
  ]

  // 完成信号词
  private static readonly COMPLETE_SIGNALS = [/(?:做好了|完成了|搞定了|ok了|可以了|已实现)/i]

  /**
   * 从对话中提取信息并存入 Storage
   */
  static async extract(userMessage: string, assistantMessage: string, toolResults: ToolResult[]): Promise<void> {
    // 1. 提取决策
    await this.extractDecision(userMessage, assistantMessage)

    // 2. 提取修改
    await this.extractChanges(toolResults)

    // 3. 提取待办
    await this.extractTodos(userMessage, assistantMessage)

    // 4. 检查待办完成
    await this.checkTodoCompletion(userMessage, assistantMessage, toolResults)
  }

  /**
   * 提取决策
   */
  private static async extractDecision(userMessage: string, assistantMessage: string): Promise<void> {
    // 检查是否有拒绝信号
    const hasReject = this.REJECT_SIGNALS.some((pattern) => pattern.test(userMessage))

    if (hasReject) {
      // 用户拒绝了之前的建议，不提取新决策
      return
    }

    // 检查是否有决策信号
    for (const pattern of this.DECISION_SIGNALS) {
      const match = userMessage.match(pattern)
      if (match && match[1]) {
        const decision = match[1].trim()
        // 提取关键词（简单实现：提取技术术语、方案名称）
        const keywords = this.extractKeywords(decision)

        await this.addToStorage({
          id: `decision_${Date.now()}`,
          type: "decision",
          content: decision,
          timestamp: Date.now(),
          metadata: { keywords, source: "user" },
        })

        this.log.info("Decision extracted", { decision, keywords })
        return
      }
    }

    // 检查AI回复中是否有明确决策
    const aiDecisionPattern = /(?:我决定|选择|采用)\s*[:：]?\s*(.+?)(?:\n|$|。)/i
    const aiMatch = assistantMessage.match(aiDecisionPattern)
    if (aiMatch && aiMatch[1]) {
      const decision = aiMatch[1].trim()
      const keywords = this.extractKeywords(decision)

      await this.addToStorage({
        id: `decision_${Date.now()}`,
        type: "decision",
        content: decision,
        timestamp: Date.now(),
        metadata: { keywords, source: "assistant" },
      })

      this.log.info("Decision extracted from AI", { decision, keywords })
    }
  }

  /**
   * 提取修改
   */
  private static async extractChanges(toolResults: ToolResult[]): Promise<void> {
    for (const result of toolResults) {
      if (result.toolName === "edit" || result.toolName === "write") {
        const file = result.input?.file || "unknown"
        const action = result.toolName === "write" && result.input?.create ? "add" : "modify"

        // 生成修改描述
        const description = this.generateChangeDescription(result)

        await this.addToStorage({
          id: `change_${Date.now()}_${file}`,
          type: "change",
          content: `${file}: ${description}`,
          timestamp: Date.now(),
          metadata: { file, action, description },
        })

        this.log.info("Change extracted", { file, action, description })
      } else if (result.toolName === "bash" && result.input?.command?.includes("rm ")) {
        // 删除文件
        const match = result.input.command.match(/rm\s+(.+)/)
        if (match) {
          const file = match[1].trim()

          await this.addToStorage({
            id: `change_${Date.now()}_${file}`,
            type: "change",
            content: `${file}: 删除文件`,
            timestamp: Date.now(),
            metadata: { file, action: "delete" },
          })

          this.log.info("Change extracted", { file, action: "delete" })
        }
      }
    }
  }

  /**
   * 提取待办
   */
  private static async extractTodos(userMessage: string, assistantMessage: string): Promise<void> {
    const combinedText = userMessage + " " + assistantMessage

    for (const pattern of this.TODO_SIGNALS) {
      const matches = combinedText.matchAll(new RegExp(pattern, "gi"))
      for (const match of matches) {
        if (match[1]) {
          const todo = match[1].trim()
          // 过滤掉太短的
          if (todo.length > 5) {
            await this.addToStorage({
              id: `todo_${Date.now()}`,
              type: "todo",
              content: todo,
              timestamp: Date.now(),
              metadata: { status: "pending" },
            })

            this.log.info("Todo extracted", { todo })
          }
        }
      }
    }
  }

  /**
   * 检查待办完成
   */
  private static async checkTodoCompletion(
    userMessage: string,
    assistantMessage: string,
    toolResults: ToolResult[],
  ): Promise<void> {
    const combinedText = userMessage + " " + assistantMessage

    // 检查完成信号
    const hasCompleteSignal = this.COMPLETE_SIGNALS.some((pattern) => pattern.test(combinedText))

    if (hasCompleteSignal) {
      // 尝试匹配待办内容
      // 简单实现：检查最近的修改是否对应某个待办
      for (const result of toolResults) {
        if (result.toolName === "edit" || result.toolName === "write") {
          const file = result.input?.file || ""
          // 尝试完成与文件相关的待办
          await this.completeTodoByPattern(`修改${file}`)
          await this.completeTodoByPattern(`更新${file}`)
          await this.completeTodoByPattern(`测试${file}`)
        }
      }
    }
  }

  /**
   * 添加到存储
   */
  private static async addToStorage(entry: MemoryEntry): Promise<void> {
    try {
      // 使用简单的哈希向量作为 fallback
      const embedding = this.generateSimpleEmbedding(entry.content)

      await Storage.Vector.upsert(this.COLLECTION, {
        id: entry.id,
        content: entry.content,
        embedding,
        metadata: { ...entry.metadata, type: entry.type, timestamp: entry.timestamp },
      })
    } catch (e) {
      this.log.error("Failed to add to storage", { entry, error: e })
    }
  }

  /**
   * 根据模式完成待办
   */
  private static async completeTodoByPattern(pattern: string): Promise<void> {
    try {
      // 搜索匹配的待办
      const results = await Storage.Vector.searchByContent(this.COLLECTION, pattern, { limit: 5 })

      for (const result of results) {
        if (result.metadata?.type === "todo" && result.metadata?.status === "pending") {
          // 更新为已完成
          await Storage.Vector.upsert(this.COLLECTION, {
            id: result.id,
            content: result.content,
            embedding: [], // 保持原有向量，这里简化处理
            metadata: { ...result.metadata, status: "done", completedAt: Date.now() },
          })

          this.log.info("Todo marked as done", { content: result.content })
        }
      }
    } catch (e) {
      this.log.error("Failed to complete todo", { pattern, error: e })
    }
  }

  /**
   * 生成简单的哈希向量（fallback）
   */
  private static generateSimpleEmbedding(text: string): number[] {
    const vectorSize = 384
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1)

    const vector = new Array(vectorSize).fill(0)

    for (const token of tokens) {
      let hash = 5381
      for (let i = 0; i < token.length; i++) {
        hash = (hash * 33) ^ token.charCodeAt(i)
      }

      const index = Math.abs(hash) % vectorSize
      const sign = (hash & 1) === 0 ? 1 : -1
      vector[index] += sign
    }

    const magnitude = Math.sqrt(vector.reduce((acc, val) => acc + val * val, 0))
    return magnitude > 1e-6 ? vector.map((v) => v / magnitude) : vector
  }

  /**
   * 提取关键词
   */
  private static extractKeywords(text: string): string[] {
    // 简单实现：提取技术术语、驼峰命名、大写缩写
    const keywords: string[] = []

    // 驼峰命名（如：JwtAuth, RedisCache）
    const camelMatches = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)*\b/g)
    if (camelMatches) keywords.push(...camelMatches)

    // 大写缩写（如：JWT, Redis, API）
    const upperMatches = text.match(/\b[A-Z]{2,}\b/g)
    if (upperMatches) keywords.push(...upperMatches)

    // 技术术语（简单列表）
    const techTerms = [
      "jwt",
      "redis",
      "cache",
      "oauth",
      "session",
      "token",
      "auth",
      "login",
      "database",
      "api",
      "rest",
      "graphql",
      "typescript",
      "javascript",
      "python",
      "react",
      "vue",
      "angular",
    ]

    const lowerText = text.toLowerCase()
    for (const term of techTerms) {
      if (lowerText.includes(term)) {
        keywords.push(term)
      }
    }

    // 去重
    return [...new Set(keywords)]
  }

  /**
   * 生成修改描述
   */
  private static generateChangeDescription(result: ToolResult): string {
    const file = result.input?.file || "unknown"

    if (result.toolName === "write" && result.input?.create) {
      return `创建文件 ${file}`
    }

    // 尝试从oldString/newString提取关键信息
    const newStr = result.input?.newString || ""

    // 提取函数名、类名等
    const funcMatch = newStr.match(/(?:function|const|let|var)\s+(\w+)/)
    if (funcMatch) {
      return `修改 ${file} 中的 ${funcMatch[1]} 函数`
    }

    const classMatch = newStr.match(/class\s+(\w+)/)
    if (classMatch) {
      return `修改 ${file} 中的 ${classMatch[1]} 类`
    }

    // 默认描述
    const lineCount = newStr.split("\n").length
    return `修改 ${file}（${lineCount} 行）`
  }
}
