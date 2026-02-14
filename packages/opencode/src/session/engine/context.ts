/**
 * @fileoverview 内存上下文引擎，集成 FlexSearch 与 Tree-sitter (WASM) 进行极致的代码索引与检索。
 * @responsibility 提供毫秒级的符号检索、语义增强与 AST 级上下文切分。
 * @threadSafety 线程安全，设计为在主线程或 Worker 线程中单例运行。
 */

import { Index } from "flexsearch"
import { Parser, Language } from "web-tree-sitter"
import path from "path"
import { Log } from "@/util/log"
import { ASTSymbolExtractor, type SymbolInfo } from "./ast-extractor"
import { Storage } from "@/storage/storage"
import { Ripgrep } from "@/file/ripgrep"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"

/**
 * 内存上下文引擎核心类
 * @responsibility 管理工作区全文检索、AST 符号索引及语义搜索功能。
 * @threadSafety @SingleThreaded 仅在主进程运行。
 */
export class MemoryContextEngine {
  private static instance: MemoryContextEngine
  private flexIndex: Index
  private parser: Parser | null = null
  private lang: Language | null = null
  private log = Log.create({ service: "memory.context.engine" })
  // 缓存与治理
  private symbolCache: Map<string, SymbolInfo[]> = new Map()
  private contentCache: Map<string, string> = new Map()
  private symbolMap: Map<string, { filePath: string; symbol: SymbolInfo }> = new Map() // 全局符号映射
  private readonly MAX_CACHE_FILES = 500
  private readonly VECTOR_COLLECTION = "code_snippets"

  private initialized = false
  private workspaceIndexed = false

  private constructor() {
    // 初始化 FlexSearch 索引
    this.flexIndex = new Index({
      tokenize: "forward",
      resolution: 9,
      cache: true,
    })
  }

  /**
   * 获取引擎单例
   */
  public static getInstance(): MemoryContextEngine {
    if (!MemoryContextEngine.instance) {
      MemoryContextEngine.instance = new MemoryContextEngine()
    }
    return MemoryContextEngine.instance
  }

  /**
   * 初始化 Tree-sitter WASM 环境
   * @param wasmPath 语言 WASM 模块路径
   */
  public async init(wasmPath?: string) {
    if (this.initialized && !wasmPath) {
      // 如果已经初始化但没有提供新的 wasmPath，且工作区还没索引，尝试索引
      if (!this.workspaceIndexed) {
        this.indexWorkspace().catch((e) => this.log.error("Background indexing failed", { error: e }))
      }
      return
    }

    try {
      if (!this.parser) {
        const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
          with: { type: "wasm" },
        })

        await Parser.init({
          locateFile() {
            return treeWasm as any
          },
        })
        this.parser = new Parser()
      }

      if (wasmPath) {
        this.lang = await Language.load(wasmPath)
        this.parser.setLanguage(this.lang)
      }

      this.initialized = true
      this.log.info("MemoryContextEngine initialized successfully.")

      // 异步启动工作区索引，不阻塞初始化过程
      this.indexWorkspace().catch((e) => this.log.error("Background indexing failed", { error: e }))
    } catch (e) {
      this.log.error("Failed to initialize Tree-sitter", { error: e })
    }
  }

  /**
   * 索引整个工作区
   */
  public async indexWorkspace(directory?: string) {
    if (this.workspaceIndexed && !directory) return

    const root = directory || Instance.directory
    if (!root) return

    this.log.info("Indexing workspace", { root })

    try {
      const files: string[] = []
      for await (const file of Ripgrep.files({ cwd: root })) {
        // 忽略一些不必要的文件
        if (file.includes("node_modules") || file.includes(".git")) continue
        if (file.endsWith(".log") || file.endsWith(".lock")) continue

        files.push(path.join(root, file))
      }

      this.log.info(`Found ${files.length} files to index`)

      // 并行索引文件，但限制并发量
      const CONCURRENCY = 5 // 降低并发量，避免嵌入模型过载
      for (let i = 0; i < files.length; i += CONCURRENCY) {
        const chunk = files.slice(i, i + CONCURRENCY)
        await Promise.all(
          chunk.map(async (f) => {
            try {
              const content = await this.getFileContent(f)
              if (content) {
                await this.indexFile(f, content)
              }
            } catch (err) {
              this.log.error("Failed to index individual file during workspace crawl", { file: f, error: err })
            }
          }),
        )
      }

      this.workspaceIndexed = true
      this.log.info("Workspace indexing completed")
    } catch (e) {
      this.log.error("Failed to index workspace", { error: e })
    }
  }

  /**
   * 索引文件内容并提取 AST 符号
   * @param filePath 文件路径
   * @param content 代码内容
   */
  public async indexFile(filePath: string, content: string) {
    try {
      // 1. LRU 治理
      this.touch(filePath)
      this.evictIfNecessary()

      // 2. 缓存内容
      this.contentCache.set(filePath, content)

      // 3. 全文检索索引
      this.flexIndex.add(filePath, content)

      // 4. AST 符号提取
      if (this.parser && this.lang) {
        const languageId = this.getLanguageId(filePath)
        const symbols = await ASTSymbolExtractor.extract(this.parser, this.lang, content, languageId)
        this.symbolCache.set(filePath, symbols)

        // 符号增强索引
        for (const sym of symbols) {
          // 更新全局符号映射，用于跨文件关联
          this.symbolMap.set(sym.name, { filePath, symbol: sym })

          this.flexIndex.add(`${filePath}#${sym.name}`, sym.name)

          // 5. 语义索引 (使用 Storage.Vector)
          const embedding = await this.getEmbedding(sym.content)
          if (embedding) {
            await Storage.Vector.upsert(this.VECTOR_COLLECTION, {
              id: `${filePath}#${sym.name}`,
              content: sym.content,
              embedding,
              metadata: { filePath, symbolName: sym.name, symbolType: sym.type },
            })
          }
        }
      }
    } catch (e) {
      this.log.error("Failed to index file", { filePath, error: e })
    }
  }

  /**
   * 维护 LRU 顺序
   * 使用 Map 的特性：迭代顺序即为插入顺序。重新 set 会将其移至末尾。
   */
  private touch(filePath: string) {
    const content = this.contentCache.get(filePath)
    if (content !== undefined) {
      this.contentCache.delete(filePath)
      this.contentCache.set(filePath, content)
    }
  }

  /**
   * 执行淘汰策略
   */
  private evictIfNecessary() {
    while (this.contentCache.size > this.MAX_CACHE_FILES) {
      const oldestKey = this.contentCache.keys().next().value
      if (oldestKey) {
        this.log.debug("LRU Evicting file", { filePath: oldestKey })

        // 清理 symbolMap 中的关联
        const symbols = this.symbolCache.get(oldestKey)
        if (symbols) {
          for (const sym of symbols) {
            const entry = this.symbolMap.get(sym.name)
            if (entry && entry.filePath === oldestKey) {
              this.symbolMap.delete(sym.name)
            }
          }
        }

        this.contentCache.delete(oldestKey)
        this.symbolCache.delete(oldestKey)
        this.flexIndex.remove(oldestKey)
      }
    }
  }

  /**
   * 根据文件后缀获取语言 ID
   */
  private getLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    switch (ext) {
      case ".ts":
      case ".tsx":
        return "typescript"
      case ".js":
      case ".jsx":
        return "javascript"
      case ".java":
        return "java"
      case ".py":
        return "python"
      default:
        return "typescript"
    }
  }

  /**
   * 综合搜索 (FTS + 语义 + 符号关联)
   * 策略：优先 FTS，如果命中符号，则自动拉取其引用的定义。
   */
  public async search(query: string, limit: number = 3, minScore: number = 0.4): Promise<string[]> {
    if (!this.initialized) return []

    this.log.info("Performing hybrid search", { query, minScore })

    // 1. 尝试全文检索 (命中率高且快)
    const ftsResults = await this.searchFTS(query, limit)

    // 2. 跨文件符号关联拉取 (Symbol-based Navigation)
    const relatedFragments: string[] = []
    for (const res of ftsResults) {
      // 简单启发式：从结果中寻找可能的符号名（大写字母开头或驼峰）
      const possibleSymbols = res.match(/[A-Z][a-zA-Z0-9]+/g) || []
      for (const symName of possibleSymbols) {
        const entry = this.symbolMap.get(symName)
        if (entry && !ftsResults.some((r) => r.includes(entry.filePath) && r.includes(symName))) {
          relatedFragments.push(
            `[Related Definition] File: ${entry.filePath}\nSymbol: ${entry.symbol.name} (${entry.symbol.type})\nContent:\n${entry.symbol.content}`,
          )
        }
      }
    }

    // 3. 补充语义检索
    const semanticResults =
      ftsResults.length + relatedFragments.length < limit ? await this.searchSemantic(query, limit, minScore) : []

    // 合并结果并去重
    const combined = [...new Set([...ftsResults, ...relatedFragments, ...semanticResults])]
    return combined.slice(0, limit + 2) // 允许稍微多一点，因为关联定义很重要
  }

  /**
   * 全文检索 (FlexSearch)
   */
  public async searchFTS(query: string, limit: number = 3): Promise<string[]> {
    const results = this.flexIndex.search(query, { limit })
    const fragments: string[] = []

    for (const id of results) {
      const idStr = id.toString()
      if (idStr.includes("#")) {
        // 命中具体符号
        const [fPath, symName] = idStr.split("#")
        const symbols = this.symbolCache.get(fPath)
        const sym = symbols?.find((s) => s.name === symName)
        if (sym) {
          // 架构要求：AST 级切分，确保注入 LLM 的片段具有完整的语义上下文
          fragments.push(`File: ${fPath}\nSymbol: ${sym.name} (${sym.type})\nContent:\n${sym.content}`)
        }
      } else {
        // 命中文件，基于关键字进行智能切片
        const content = await this.getFileContent(idStr)
        if (content) {
          const snippet = this.extractRelevantSnippet(content, query)
          fragments.push(`File: ${idStr}\nRelevant Snippet:\n${snippet}`)
        }
      }
    }

    return fragments
  }

  /**
   * 获取文件内容（优先从内存缓存，其次从磁盘）
   */
  private async getFileContent(filePath: string): Promise<string | null> {
    // 1. 优先从内存缓存获取
    if (this.contentCache.has(filePath)) {
      this.touch(filePath) // 命中时更新活跃度
      return this.contentCache.get(filePath)!
    }

    try {
      // 2. 统一使用适配器读取
      const content = await Filesystem.readFile(filePath)

      // 读取成功后加入缓存并处理淘汰
      this.contentCache.set(filePath, content)
      this.evictIfNecessary()
      return content
    } catch (e) {
      this.log.error("Failed to read file", { filePath, error: e })
      return null
    }
  }

  /**
   * 提取相关代码片段
   */
  private extractRelevantSnippet(content: string, query: string): string {
    const index = content.toLowerCase().indexOf(query.toLowerCase())
    if (index === -1) return content.slice(0, 500) + "..."

    const start = Math.max(0, index - 200)
    const end = Math.min(content.length, index + 300)
    return (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : "")
  }

  /**
   * 语义搜索 (使用 Storage.Vector)
   */
  public async searchSemantic(query: string, limit: number = 3, minScore: number = 0.4): Promise<string[]> {
    const queryVector = await this.getEmbedding(query)
    if (!queryVector) return []

    const results = await Storage.Vector.search(this.VECTOR_COLLECTION, queryVector, { limit, minScore })
    const snippets: string[] = []

    for (const res of results) {
      const filePath = res.metadata?.filePath || res.id
      const score = res.score.toFixed(3)
      const content = await this.getFileContent(filePath)
      if (content) {
        // 对于语义搜索，我们使用基于 query 的相关性切片，并标注相似度
        const snippet = this.extractRelevantSnippet(content, query)
        snippets.push(`[Semantic Match (Score: ${score}): ${filePath}]\n${snippet}`)
      }
    }
    return snippets
  }

  /**
   * 获取文本向量 (使用本地 BGE 模型)
   * 如果本地模型不可用，返回 null
   */
  private async getEmbedding(text: string): Promise<number[] | null> {
    try {
      const { pipeline, env } = await import("@huggingface/transformers")

      // 配置本地模型路径
      const modelPath = path.join(process.cwd(), "resources", "models", "bge-small")
      env.localModelPath = modelPath
      env.allowRemoteModels = true

      // 创建特征提取器
      const extractor = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
        device: "cpu",
      })

      const output = await extractor(text, { pooling: "mean", normalize: true })
      return Array.from(output.data as number[])
    } catch (e) {
      this.log.warn("Failed to generate embedding, semantic search disabled", { error: e })
      return null
    }
  }
}
