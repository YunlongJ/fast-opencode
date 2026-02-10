import { Voy } from "voy-search";
import { Log } from "@/util/log";

/**
 * 本地语义搜索引擎 (WASM)
 * 集成 Voy 进行向量检索，并预留 Embedding 模型接口
 */
export class SemanticEngine {
  private voy: Voy | undefined;
  private log = Log.create({ service: "semantic.engine" });
  private readonly vectorSize = 384; // 固定向量维度，适配 Voy

  constructor() {}

  /**
   * 初始化 Voy 引擎
   */
  private async ensureInitialized() {
    if (!this.voy) {
      try {
        this.voy = new Voy();
        this.log.info("Voy engine initialized with simple hashing vectorizer.");
      } catch (e) {
        this.log.error("Failed to initialize Voy", { error: e });
        throw e;
      }
    }
  }

  /**
   * 生成文本向量 (使用简单哈希特征向量化 - Hashing Trick)
   * TODO(Agent): 建议替换为 @xenova/transformers (Transformers.js) 以支持本地 BERT/BGE 模型。
   * 理由：Hashing Trick 无法捕捉语义相似性（如 "refactor" 和 "restructure"），而小型 BERT 模型 (约 30MB) 可在 WASM 环境下提供真正的语义召回。
   */
  public async getEmbedding(text: string): Promise<number[]> {
    if (!text) return new Array(this.vectorSize).fill(0);

    // 预处理：转小写，分词，去停用词
    const tokens = text.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length > 1 && !this.isStopWord(t));
    
    const vector = new Array(this.vectorSize).fill(0);
    
    for (const token of tokens) {
      // 简单的哈希函数 (DJB2 变体)
      let hash = 5381;
      for (let i = 0; i < token.length; i++) {
        hash = (hash * 33) ^ token.charCodeAt(i);
      }
      
      const index = Math.abs(hash) % this.vectorSize;
      // 使用 +1/-1 来减少哈希碰撞的影响 (Signed Hashing)
      const sign = (hash & 1) === 0 ? 1 : -1;
      vector[index] += sign;
    }

    // L2 归一化
    const magnitude = Math.sqrt(vector.reduce((acc, val) => acc + val * val, 0));
    if (magnitude > 1e-6) {
      return vector.map(v => v / magnitude);
    }
    return vector;
  }

  private isStopWord(token: string): boolean {
    const stopWords = new Set(["the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "while", "do", "return", "const", "let", "var", "function", "class", "import", "export", "from"]);
    return stopWords.has(token);
  }

  /**
   * 索引代码片段
   */
  public async index(id: string, title: string, embeddings: number[]) {
    try {
      await this.ensureInitialized();
      this.voy?.add({
        embeddings: [{
          id,
          title,
          url: id,
          embeddings
        }]
      });
    } catch (e) {
      this.log.error("Voy index failed", { error: e });
    }
  }

  /**
   * 语义搜索
   */
  public async search(queryVector: number[], k: number = 3) {
    try {
      await this.ensureInitialized();
      const results = this.voy?.search(new Float32Array(queryVector), k);
      return results?.neighbors ?? [];
    } catch (e) {
      this.log.error("Voy search failed", { error: e });
      return [];
    }
  }

  /**
   * 清空索引
   */
  public async clear() {
    await this.ensureInitialized();
    this.voy?.clear();
  }
}
