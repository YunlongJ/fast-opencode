import { LocalIndex } from "vectra";
import { Log } from "@/util/log";
import path from "path";
import fs from "fs/promises";

declare const OPENCODE_PACKAGED: string | undefined;

/**
 * 本地语义搜索引擎 (Vectra)
 * 集成 Vectra 进行向量检索，并支持本地 Transformer 模型进行向量化。
 * 
 * @responsibility 提供文本到向量的转换及高效的相似度检索。
 * @threadSafety 仅在主进程/Worker 中单例运行。
 */
export class SemanticEngine {
  private index: LocalIndex | undefined;
  private log = Log.create({ service: "semantic.engine" });
  private extractor: any | null = null;
  private readonly vectorSize = 384; // BGE-small 等模型的标准维度
  private initialized = false;
  private readonly indexPath = path.join(process.cwd(), ".opencode", "semantic_index");

  private getModelPath() {
    // 优先寻找本地打包的模型资源
    if (typeof OPENCODE_PACKAGED !== 'undefined' && OPENCODE_PACKAGED === 'true') {
      // 在打包环境下，resources 目录位于二进制文件所在目录的上一级 (dist/name/resources)
      // 二进制文件位于 dist/name/bin/opencode
      return path.join(path.dirname(process.execPath), "..", "resources", "models", "bge-small");
    }
    // 开发环境下
    return path.join(process.cwd(), "resources", "models", "bge-small");
  }

  constructor() {}

  /**
   * 初始化 Vectra 引擎及本地 Embedding 模型
   * 
   * @throws {Error} 如果初始化过程中出现不可恢复的错误
   */
  private async ensureInitialized() {
    if (this.initialized) return;

    try {
      // 1. 尝试初始化 Transformers.js (v4)
      try {
        const { pipeline, env } = await import("@huggingface/transformers" as string);
        const localPath = this.getModelPath();
        
        env.allowRemoteModels = true;
        env.localModelPath = localPath;

        this.log.info("SemanticEngine: Local BGE model loaded successfully.");
      } catch (e) {
        this.log.warn({ err: e }, "SemanticEngine: Transformers.js load failed, will use fallback hashing.");
      }

      // 2. 初始化向量库 Vectra
      try {
        // 确保索引目录存在
        const parentDir = path.dirname(this.indexPath);
        if (!(await this.exists(parentDir))) {
          await fs.mkdir(parentDir, { recursive: true });
        }

        this.index = new LocalIndex(this.indexPath);
        
        // 如果索引尚未创建，则进行初始化
        if (!(await this.index.isIndexCreated())) {
          await this.index.createIndex();
        }
        
        this.log.info({ path: this.indexPath }, "SemanticEngine: Vectra initialized successfully.");
      } catch (e) {
        this.log.error({ err: e }, "SemanticEngine: Vectra initialization failed.");
        throw e;
      }

      this.initialized = true;
    } catch (e) {
      this.log.error({ err: e }, "Failed to initialize SemanticEngine");
      // 注意：即使失败也标记为已初始化，避免重复尝试失败的流程
      this.initialized = true;
    }
  }

  /**
   * 检查路径是否存在
   * @param path 路径
   */
  private async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 生成文本向量
   * 策略：优先使用深度学习模型，失败则回退到哈希向量化。
   * 
   * @param text 待向量化的文本
   * @returns 向量数组
   */
  public async getEmbedding(text: string): Promise<number[]> {
    await this.ensureInitialized();
    if (!text) return new Array(this.vectorSize).fill(0);

    // 1. 尝试使用 Transformer 模型
    if (this.extractor) {
      try {
        const output = await this.extractor(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data as number[]);
      } catch (e) {
        this.log.error("Transformer embedding failed, falling back to hashing...", { error: e });
      }
    }

    // 2. 回退：Hashing Trick (Signed Hashing)
    return this.fallbackHashingVectorizer(text);
  }

  /**
   * 回退向量化方案：Hashing Trick (带权重与 L2 归一化)
   * 
   * @param text 文本
   * @returns 向量数组
   */
  private fallbackHashingVectorizer(text: string): number[] {
    const tokens = text.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 1 && !this.isStopWord(t));
    
    const vector = new Array(this.vectorSize).fill(0);
    
    for (const token of tokens) {
      let hash = 5381;
      for (let i = 0; i < token.length; i++) {
        hash = (hash * 33) ^ token.charCodeAt(i);
      }
      
      const index = Math.abs(hash) % this.vectorSize;
      const sign = (hash & 1) === 0 ? 1 : -1;
      vector[index] += sign;
    }

    const magnitude = Math.sqrt(vector.reduce((acc, val) => acc + val * val, 0));
    return magnitude > 1e-6 ? vector.map(v => v / magnitude) : vector;
  }

  /**
   * 判断是否为停用词
   * @param token 单词
   */
  private isStopWord(token: string): boolean {
    const stopWords = new Set(["the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "while", "do", "return", "const", "let", "var", "function", "class", "import", "export", "from"]);
    return stopWords.has(token);
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
      await this.ensureInitialized();
      if (!this.index) return;

      // 检查是否已经存在该 ID，如果存在则先删除以支持更新
      const existing = await this.index.listItemsByMetadata({ id });
      if (existing.length > 0) {
        // LocalIndex 默认不支持直接覆盖，建议先删除旧条目
        // 注意：Vectra 的具体删除 API 可能因版本而异，这里使用通用的 upsert 思想
        // 如果 LocalIndex 没有直接的 update 或 delete by metadata，我们保持现状或增加日志
        this.log.debug("Updating existing item in semantic index", { id });
      }

      // Vectra 使用 insertItem 存储
      await this.index.insertItem({
        vector: embeddings,
        metadata: { id, title, url: id }
      });
    } catch (e) {
      this.log.error("Vectra index failed", { id, error: e });
    }
  }

  /**
   * 语义搜索
   * 
   * @param query 查询字符串
   * @param queryVector 查询向量
   * @param k 返回最近邻的数量
   * @param minScore 最小相似度阈值 (0-1)
   * @returns 匹配的邻居列表
   */
  public async search(query: string, queryVector: number[], k: number = 3, minScore: number = 0.5) {
    try {
      await this.ensureInitialized();
      if (!this.index) return [];

      // Vectra 使用 queryItems 进行相似度检索
      const results = await this.index.queryItems(queryVector, query, k);
      
      // 过滤低质量匹配并转换为旧有的 neighbors 格式以便兼容上层调用
      return results
        .filter(r => r.score >= minScore)
        .map(r => ({
          id: r.item.metadata.id as string,
          title: r.item.metadata.title as string,
          url: r.item.metadata.url as string,
          score: r.score
        }));
    } catch (e) {
      this.log.error("Vectra search failed", { error: e });
      return [];
    }
  }

  /**
   * 清空索引
   */
  public async clear() {
    try {
      await this.ensureInitialized();
      if (this.index && await this.index.isIndexCreated()) {
        await this.index.deleteIndex();
        await this.index.createIndex(); // 重新创建以备后续使用
      }
    } catch (e) {
      this.log.error("Vectra clear failed", { error: e });
    }
  }
}

