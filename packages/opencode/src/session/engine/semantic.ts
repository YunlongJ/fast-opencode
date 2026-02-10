import { Voy } from "voy-search";
import { Log } from "@/util/log";

/**
 * 本地语义搜索引擎 (WASM)
 * @VertxThreadSafety
 */
export class SemanticEngine {
  private voy: Voy | undefined;
  private log = Log.create({ service: "semantic.engine" });

  constructor() {}

  /**
   * 初始化 Voy 引擎
   */
  private async ensureInitialized() {
    if (!this.voy) {
      try {
        // Voy 在 Node 环境下可能需要动态初始化
        this.voy = new Voy();
      } catch (e) {
        this.log.error("Failed to initialize Voy", { error: e });
        throw e;
      }
    }
  }

  /**
   * 索引代码片段
   * @param id 唯一标识
   * @param title 标题
   * @param embeddings 向量数据
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
   * @param queryVector 查询向量
   * @param k 返回结果数量
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
