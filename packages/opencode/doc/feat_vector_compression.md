# 向量语义压缩 (Vector Semantic Compression)

## 动机

当前的上下文压缩存在以下问题：

1. **Pruning**：简单基于 token 计数，忽略语义相关性
2. **Truncation**：丢失开头或结尾信息，可能破坏上下文连贯性
3. **LLM Summarization**：计算成本高，无法处理超长历史

## 核心思路

利用已有的 `SemanticEngine`，对历史消息进行向量化索引，在压缩时：

1. 检索与当前查询语义最相关的历史消息
2. 保留高相关性的完整消息，压缩低相关性消息
3. 实现"选择性保留"而非"暴力截断"

## 架构设计

```typescript
// src/session/compression/vector-compressor.ts

import { SemanticEngine } from "../engine/semantic"
import { MessageV2 } from "../message-v2"
import { Config } from "@/config/config"

export class VectorCompressor {
  private semanticEngine: SemanticEngine
  private messageIndex: Map<string, MessageV2.WithParts> = new Map()

  constructor() {
    this.semanticEngine = new SemanticEngine()
  }

  /**
   * 索引历史消息（用于语义检索）
   */
  async indexMessages(messages: MessageV2.WithParts[]) {
    for (const msg of messages) {
      if (msg.info.role !== "user") continue

      const content = this.extractMessageContent(msg)
      const embedding = await this.semanticEngine.getEmbedding(content)
      const id = msg.info.id

      await this.semanticEngine.indexItem(id, content.slice(0, 100), embedding)
      this.messageIndex.set(id, msg)
    }
  }

  /**
   * 基于语义相关性的上下文选择
   */
  async selectRelevantContext(
    messages: MessageV2.WithParts[],
    currentQuery: string,
    maxTokens: number,
  ): Promise<MessageV2.WithParts[]> {
    const config = await Config.get()
    const relevanceThreshold = config.compression?.relevanceThreshold ?? 0.6

    // 1. 获取当前查询的向量
    const queryVector = await this.semanticEngine.getEmbedding(currentQuery)

    // 2. 计算每条历史消息的语义相似度
    const scoredMessages = await Promise.all(
      messages
        .filter((m) => m.info.role === "user")
        .map(async (msg) => {
          const content = this.extractMessageContent(msg)
          const embedding = await this.semanticEngine.getEmbedding(content)
          const score = this.cosineSimilarity(queryVector, embedding)

          return { message: msg, score, contentLength: content.length }
        }),
    )

    // 3. 按相关性排序，优先保留高相关消息
    scoredMessages.sort((a, b) => b.score - a.score)

    // 4. 贪心选择：在 token 限制内保留最相关的消息
    const selected: MessageV2.WithParts[] = []
    let usedTokens = 0

    for (const { message, score, contentLength } of scoredMessages) {
      const estimatedTokens = Math.ceil(contentLength / 4) // 粗略估算

      // 高相关性消息完整保留，低相关性消息只保留摘要
      if (score >= relevanceThreshold) {
        if (usedTokens + estimatedTokens <= maxTokens) {
          selected.push(message)
          usedTokens += estimatedTokens
        } else {
          // 超出限制时压缩该消息
          const compressed = await this.compressMessage(message)
          selected.push(compressed)
          usedTokens += Math.ceil(compressedText.length / 4)
        }
      } else {
        // 低相关性消息直接压缩成摘要
        const summary = await this.generateSummary(message)
        selected.push(summary)
      }
    }

    // 保持时间顺序
    return selected.sort((a, b) => new Date(a.info.time.created).getTime() - new Date(b.info.time.created).getTime())
  }

  /**
   * 智能摘要：基于向量检索的上下文感知摘要
   */
  async generateSummary(message: MessageV2.WithParts): Promise<MessageV2.WithParts> {
    const content = this.extractMessageContent(message)

    // 检索最相似的历史消息作为参考
    const embedding = await this.semanticEngine.getEmbedding(content)
    const similar = await this.semanticEngine.search(embedding, 3, 0.7)

    const context = similar
      .map((r) => this.messageIndex.get(r.id))
      .filter(Boolean)
      .map((m) => this.extractMessageContent(m))
      .join("\n---\n")

    // 使用 LLM 生成摘要时提供语义相似的上下文
    const summary = await LLM.generate({
      model: await getSummaryModel(),
      messages: [
        {
          role: "system",
          content: `You are a conversation summarizer. Generate a concise summary (max 200 words) 
            that preserves key information, decisions, and file references.
            Also consider these semantically similar historical context: ${context}`,
        },
        { role: "user", content },
      ],
    })

    return this.createSummaryMessage(message, summary.text)
  }

  private extractMessageContent(msg: MessageV2.WithParts): string {
    return msg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n")
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const dot = a.reduce((acc, v, i) => acc + v * b[i], 0)
    const normA = Math.sqrt(a.reduce((acc, v) => acc + v * v, 0))
    const normB = Math.sqrt(b.reduce((acc, v) => acc + v * b[i], 0))
    return dot / (normA * normB)
  }
}
```

## 配置文件增强

```typescript
// src/config/config.ts (新增)

export const VectorCompression = z.object({
  enabled: z.boolean().optional().describe("Enable vector-based semantic compression"),
  relevanceThreshold: z.number().min(0).max(1).optional().describe("Minimum relevance score to preserve messages"),
  maxHistoricalMessages: z.number().int().positive().optional().describe("Maximum historical messages to index"),
  enableSmartSummary: z.boolean().optional().describe("Use semantic context for summary generation"),
  fallbackToPruning: z.boolean().optional().describe("Fall back to token pruning if vector compression fails"),
})

export const Info = z.object({
  // ... existing fields
  compression: z
    .object({
      auto: z.boolean().optional(),
      prune: z.boolean().optional(),
      vector: VectorCompression.optional(),
    })
    .optional(),
})
```

## 使用示例

```typescript
// 在 compaction.ts 中集成

import { VectorCompressor } from "./compression/vector-compressor"

export async function prune(input: { sessionID: string }) {
  const config = await Config.get()
  const vectorConfig = config.compression?.vector

  if (vectorConfig?.enabled) {
    const compressor = new VectorCompressor()
    const msgs = await Session.messages({ sessionID: input.sessionID })

    // 索引历史消息
    await compressor.indexMessages(msgs)

    // 获取当前待压缩的查询
    const currentQuery = await getCurrentUserQuery(msgs)

    // 语义选择压缩
    const compressed = await compressor.selectRelevantContext(msgs, currentQuery, PRUNE_PROTECT)

    // 应用压缩结果
    await applyCompressedMessages(compressed)
  } else {
    // 回退到原有逻辑
    await traditionalPrune(input)
  }
}
```

## 性能优化

1. **增量索引**：只索引新增消息，避免重复索引
2. **异步向量化**：后台线程生成向量，不阻塞主流程
3. **缓存向量**：将消息向量持久化到磁盘
4. **批量处理**：合并多个消息的向量化请求

## 向量数据库集成点

| 组件                | 职责                           |
| ------------------- | ------------------------------ |
| `SemanticEngine`    | 现有组件，提供向量化和检索能力 |
| `VectorCompressor`  | 新增，负责上下文选择和智能摘要 |
| `MessageIndexer`    | 新增，管理消息的向量化索引     |
| `CompressionConfig` | 新增，配置向量压缩参数         |

## 渐进式迁移策略

1. **Phase 1**：仅用于"智能摘要"生成（利用语义相似历史）
2. **Phase 2**：用于"选择性保留"（相关性评分裁剪）
3. **Phase 3**：完全替代现有 pruning 逻辑

## 风险与缓解

| 风险                 | 缓解措施                    |
| -------------------- | --------------------------- |
| 向量引擎初始化失败   | 回退到传统压缩逻辑          |
| 性能开销过大         | 限制索引消息数量，异步处理  |
| 语义相似但信息不重要 | 保留 token 计数作为二次校验 |
