import { Log } from "@/util/log"
import { Storage } from "@/storage/storage"

declare const OPENCODE_PACKAGED: string | undefined

/**
 * 本地语义搜索引擎
 * 统一使用 Storage 模块的 LanceDB 向量存储。
 *
 * @responsibility 提供文本到向量的转换及高效的相似度检索。
 * @threadSafety 通过 Storage 模块的 LanceDB 单例保证线程安全。
 */
export class SemanticEngine {
  private log = Log.create({ service: "semantic.engine" })
  private readonly vectorSize = 384 // BGE-small 等模型的标准维度
  private initialized = false

  constructor() {}

  /**
   * 初始化引擎（现在只是标记已初始化，实际初始化由 Storage 模块处理）
   */
  private async ensureInitialized() {
    if (this.initialized) return
    this.initialized = true
    this.log.info("SemanticEngine initialized with unified Storage (LanceDB)")
  }

  /**
   * 生成文本向量
   * 策略：优先使用深度学习模型，失败则回退到哈希向量化。
   *
   * @param text 待向量化的文本
   * @returns 向量数组
   */
  public async getEmbedding(text: string): Promise<number[]> {
    await this.ensureInitialized()
    if (!text) return new Array(this.vectorSize).fill(0)

    // 1. 尝试使用 Transformer 模型
    if (this.extractor) {
      try {
        const output = await this.extractor(text, { pooling: "mean", normalize: true })
        return Array.from(output.data as number[])
      } catch (e) {
        this.log.error("Transformer embedding failed, falling back to hashing...", { error: e })
      }
    }

    // 2. 回退：Hashing Trick (Signed Hashing)
    return this.fallbackHashingVectorizer(text)
  }

  /**
   * 尝试初始化 Transformer 模型（延迟加载）
   */
  private async initTransformer() {
    if (this.extractor) return true

    try {
      const { pipeline, env } = await import("@huggingface/transformers" as string)
      const localPath = this.getModelPath()

      env.allowRemoteModels = true
      env.localModelPath = localPath

      this.extractor = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
        quantized: false,
      })

      this.log.info("SemanticEngine: Local BGE model loaded successfully.")
      return true
    } catch (e) {
      this.log.warn({ err: e }, "SemanticEngine: Transformers.js load failed, will use fallback hashing.")
      return false
    }
  }

  private getModelPath() {
    // 优先寻找本地打包的模型资源
    if (typeof OPENCODE_PACKAGED !== "undefined" && OPENCODE_PACKAGED === "true") {
      // 在打包环境下，resources 目录位于二进制文件所在目录的上一级 (dist/name/resources)
      // 二进制文件位于 dist/name/bin/opencode
      return path.join(path.dirname(process.execPath), "..", "resources", "models", "bge-small")
    }
    // 开发环境下
    return path.join(process.cwd(), "resources", "models", "bge-small")
  }

  private extractor: any | null = null

  /**
   * 回退向量化方案：Hashing Trick (带权重与 L2 归一化)
   *
   * @param text 文本
   * @returns 向量数组
   */
  private fallbackHashingVectorizer(text: string): number[] {
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !this.isStopWord(t))

    const vector = new Array(this.vectorSize).fill(0)

    for (const token of tokens) {
      let hash = 5381
      for (let i = 0; i < token.length; i++) {
        hash = (hash * 33) ^ token.charCodeAt(i)
      }

      const index = Math.abs(hash) % this.vectorSize
      const sign = (hash & 1) === 0 ? 1 : -1
      vector[index] += sign
    }

    const magnitude = Math.sqrt(vector.reduce((acc, val) => acc + val * val, 0))
    return magnitude > 1e-6 ? vector.map((v) => v / magnitude) : vector
  }

  /**
   * 判断是否为停用词
   * @param token 单词
   */
  private isStopWord(token: string): boolean {
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "if",
      "then",
      "else",
      "for",
      "while",
      "do",
      "return",
      "const",
      "let",
      "var",
      "function",
      "class",
      "import",
      "export",
      "from",
    ])
    return stopWords.has(token)
  }

  /**
   * 索引代码片段
   *
   * @param id 唯一标识符 (通常是文件路径或 URL)
   * @param title 标题或摘要
   * @param embeddings 向量数据
   */
  public async indexItem(id: string, title: string, embeddings: number[]) {
    try {
      // 延迟初始化 Transformer
      await this.initTransformer()

      // 使用统一的 Storage 模块进行向量存储
      await Storage.SemanticIndex.indexItem(id, title, embeddings)
    } catch (e) {
      this.log.error("Failed to index item", { id, error: e })
    }
  }

  /**
   * 语义搜索
   *
   * @param query 查询字符串（用于日志）
   * @param queryVector 查询向量
   * @param k 返回最近邻的数量
   * @param minScore 最小相似度阈值 (0-1)
   * @returns 匹配的邻居列表
   */
  public async search(query: string, queryVector: number[], k: number = 3, minScore: number = 0.5) {
    try {
      // 延迟初始化 Transformer
      await this.initTransformer()

      // 使用统一的 Storage 模块进行向量搜索
      const results = await Storage.SemanticIndex.search(queryVector, k, minScore)

      return results.map((r: { id: string; title: string; url: string; score: number }) => ({
        id: r.id,
        title: r.title,
        url: r.url,
        score: r.score,
      }))
    } catch (e) {
      this.log.error("Semantic search failed", { error: e })
      return []
    }
  }

  /**
   * 清空索引
   */
  public async clear() {
    try {
      await Storage.SemanticIndex.clear()
      this.log.info("Semantic index cleared")
    } catch (e) {
      this.log.error("Failed to clear semantic index", { error: e })
    }
  }
}

import path from "path"
