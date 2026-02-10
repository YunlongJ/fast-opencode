/**
 * @fileoverview 内存上下文引擎，集成 FlexSearch 与 Tree-sitter (WASM) 进行极致的代码索引与检索。
 * @responsibility 提供毫秒级的符号检索、语义增强与 AST 级上下文切分。
 * @threadSafety 线程安全，设计为在主线程或 Worker 线程中单例运行。
 */

import { Index } from "flexsearch";
import { Parser, Language } from "web-tree-sitter";
import { Log } from "@/util/log";
import { ASTSymbolExtractor, type SymbolInfo } from "./ast-extractor";
import { SemanticEngine } from "./semantic";
import { Ripgrep } from "@/file/ripgrep";
import { Instance } from "@/project/instance";
import { Filesystem } from "@/util/filesystem";

/**
 * 内存上下文引擎核心类
 * @responsibility 管理工作区全文检索、AST 符号索引及语义搜索功能。
 * @threadSafety @SingleThreaded 仅在主进程运行。
 */
export class MemoryContextEngine {
  private static instance: MemoryContextEngine;
  private flexIndex: Index;
  private semanticEngine: SemanticEngine;
  private parser: Parser | null = null;
  private lang: Language | null = null;
  private log = Log.create({ service: "memory.context.engine" });
  // 缓存与治理
  private symbolCache: Map<string, SymbolInfo[]> = new Map();
  private contentCache: Map<string, string> = new Map();
  private readonly MAX_CACHE_FILES = 500; 
  
  private initialized = false;
  private workspaceIndexed = false;

  private constructor() {
    // 初始化 FlexSearch 索引
    this.flexIndex = new Index({
      tokenize: "forward",
      resolution: 9,
      cache: true,
    });
    // 初始化 Voy 语义引擎
    this.semanticEngine = new SemanticEngine();
  }

  /**
   * 获取引擎单例
   */
  public static getInstance(): MemoryContextEngine {
    if (!MemoryContextEngine.instance) {
      MemoryContextEngine.instance = new MemoryContextEngine();
    }
    return MemoryContextEngine.instance;
  }

  /**
   * 初始化 Tree-sitter WASM 环境
   * @param wasmPath 语言 WASM 模块路径
   */
  public async init(wasmPath?: string) {
    if (this.initialized && !wasmPath) return;

    try {
      if (!this.parser) {
        const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
          with: { type: "wasm" },
        });
        
        await Parser.init({
          locateFile() {
            return treeWasm as any;
          },
        });
        this.parser = new Parser();
      }
      
      if (wasmPath) {
        this.lang = await Language.load(wasmPath);
        this.parser.setLanguage(this.lang);
      }
      
      this.initialized = true;
      this.log.info("MemoryContextEngine initialized successfully.");

      // 异步启动工作区索引，不阻塞初始化过程
      this.indexWorkspace().catch(e => this.log.error("Background indexing failed", { error: e }));
    } catch (e) {
      this.log.error("Failed to initialize Tree-sitter", { error: e });
    }
  }

  /**
   * 索引整个工作区
   */
  public async indexWorkspace(directory?: string) {
    if (this.workspaceIndexed && !directory) return;

    const root = directory || Instance.directory;
    if (!root) return;

    this.log.info("Indexing workspace", { root });
    
    try {
      const files: string[] = [];
      for await (const file of Ripgrep.files({ cwd: root })) {
        // 忽略一些不必要的文件
        if (file.includes("node_modules") || file.includes(".git")) continue;
        if (file.endsWith(".log") || file.endsWith(".lock")) continue;
        
        files.push(path.join(root, file));
      }

      this.log.info(`Found ${files.length} files to index`);

      // 并行索引文件，但限制并发量
      const CONCURRENCY = 10;
      for (let i = 0; i < files.length; i += CONCURRENCY) {
        const chunk = files.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(async (f) => {
          const content = await this.getFileContent(f);
          if (content) {
            await this.indexFile(f, content);
          }
        }));
      }
      
      this.workspaceIndexed = true;
      this.log.info("Workspace indexing completed");
    } catch (e) {
      this.log.error("Failed to index workspace", { error: e });
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
      this.touch(filePath);
      this.evictIfNecessary();

      // 2. 缓存内容
      this.contentCache.set(filePath, content);

      // 3. 全文检索索引
      this.flexIndex.add(filePath, content);

      // 4. AST 符号提取
      if (this.parser && this.lang) {
        const languageId = this.getLanguageId(filePath);
        const symbols = await ASTSymbolExtractor.extract(this.parser, this.lang, content, languageId);
        this.symbolCache.set(filePath, symbols);
        
        // 符号增强索引
        for (const sym of symbols) {
          this.flexIndex.add(`${filePath}#${sym.name}`, sym.name);
          
          // 5. 语义索引 (集成 SemanticEngine)
          const embedding = await this.getEmbedding(sym.content);
          if (embedding) {
            await this.semanticEngine.index(`${filePath}#${sym.name}`, sym.name, embedding);
          }
        }
      }
    } catch (e) {
      this.log.error("Failed to index file", { filePath, error: e });
    }
  }

  /**
   * 维护 LRU 顺序
   * 使用 Map 的特性：迭代顺序即为插入顺序。重新 set 会将其移至末尾。
   */
  private touch(filePath: string) {
    const content = this.contentCache.get(filePath);
    if (content !== undefined) {
      this.contentCache.delete(filePath);
      this.contentCache.set(filePath, content);
    }
  }

  /**
   * 执行淘汰策略
   */
  private evictIfNecessary() {
    while (this.contentCache.size > this.MAX_CACHE_FILES) {
      const oldestKey = this.contentCache.keys().next().value;
      if (oldestKey) {
        this.log.debug("LRU Evicting file", { filePath: oldestKey });
        this.contentCache.delete(oldestKey);
        this.symbolCache.delete(oldestKey);
        this.flexIndex.remove(oldestKey);
      }
    }
  }

  /**
   * 根据文件后缀获取语言 ID
   */
  private getLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case ".ts":
      case ".tsx":
        return "typescript";
      case ".js":
      case ".jsx":
        return "javascript";
      case ".java":
        return "java";
      case ".py":
        return "python";
      default:
        return "typescript";
    }
  }

  /**
   * 综合搜索 (FTS + 语义)
   * 策略：优先 FTS，如果结果不足或匹配度低，则使用语义搜索补充。
   */
  public async search(query: string, limit: number = 3): Promise<string[]> {
    if (!this.initialized) return [];
    
    this.log.info("Performing hybrid search", { query });
    
    // 1. 尝试全文检索 (命中率高且快)
    const ftsResults = await this.searchFTS(query, limit);
    if (ftsResults.length >= limit) return ftsResults;

    // 2. 补充语义检索
    const semanticResults = await this.searchSemantic(query, limit);
    
    // 合并结果并去重，保持 FTS 结果在前（精确匹配优先）
    const combined = [...new Set([...ftsResults, ...semanticResults])];
    return combined.slice(0, limit);
  }

  /**
   * 全文检索 (FlexSearch)
   */
  public async searchFTS(query: string, limit: number = 3): Promise<string[]> {
    const results = this.flexIndex.search(query, { limit });
    const fragments: string[] = [];

    for (const id of results) {
      const idStr = id.toString();
      if (idStr.includes('#')) {
        // 命中具体符号
        const [path, symName] = idStr.split('#');
        const symbols = this.symbolCache.get(path);
        const sym = symbols?.find(s => s.name === symName);
        if (sym) {
          // 架构要求：AST 级切分，确保注入 LLM 的片段具有完整的语义上下文
          fragments.push(`File: ${path}\nSymbol: ${sym.name} (${sym.type})\nContent:\n${sym.content}`);
        }
      } else {
        // 命中文件，基于关键字进行智能切片
        const content = await this.getFileContent(idStr);
        if (content) {
          const snippet = this.extractRelevantSnippet(content, query);
          fragments.push(`File: ${idStr}\nRelevant Snippet:\n${snippet}`);
        }
      }
    }

    return fragments;
  }

  /**
   * 获取文件内容（优先从内存缓存，其次从磁盘）
   */
  private async getFileContent(filePath: string): Promise<string | null> {
    // 1. 优先从内存缓存获取
    if (this.contentCache.has(filePath)) {
      return this.contentCache.get(filePath)!;
    }

    try {
      // 2. 确保路径为绝对路径
      const absolutePath = path.isAbsolute(filePath) 
        ? filePath 
        : path.join(Instance.directory, filePath);

      // 3. 尝试读取磁盘
      const content = await fs.readFile(absolutePath, "utf-8");
      
      // 读取成功后加入缓存
      this.contentCache.set(filePath, content);
      return content;
    } catch (e) {
      // 如果 fs 失败，尝试 Bun.file (如果存在)
      try {
        const absolutePath = path.isAbsolute(filePath) 
          ? filePath 
          : path.join(Instance.directory, filePath);
          
        const file = (globalThis as any).Bun?.file(absolutePath);
        if (file && await file.exists()) {
          const content = await file.text();
          this.contentCache.set(filePath, content);
          return content;
        }
      } catch (bunErr) {
        // 忽略 Bun 错误
      }
      this.log.error("Failed to read file", { filePath, error: e });
      return null;
    }
  }

  /**
   * 提取相关代码片段
   */
  private extractRelevantSnippet(content: string, query: string): string {
    const index = content.toLowerCase().indexOf(query.toLowerCase());
    if (index === -1) return content.slice(0, 500) + "...";
    
    const start = Math.max(0, index - 200);
    const end = Math.min(content.length, index + 300);
    return (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : "");
  }

  /**
   * 语义搜索 (SemanticEngine)
   */
  public async searchSemantic(query: string, limit: number = 3): Promise<string[]> {
    const queryVector = await this.getEmbedding(query);
    if (!queryVector) return [];

    const results = await this.semanticEngine.search(queryVector, limit);
    const snippets: string[] = [];
    
    for (const res of results) {
      // res 包含 id (filePath), title 等
      const filePath = res.id;
      const content = await this.getFileContent(filePath);
      if (content) {
        // 对于语义搜索，我们可能需要一个不同的片段提取逻辑，或者直接复用
        const snippet = this.extractRelevantSnippet(content, query);
        snippets.push(`[Semantic Match: ${filePath}]\n${snippet}`);
      }
    }
    return snippets;
  }

  /**
   * 获取文本向量 (集成 SemanticEngine 的本地 Embedding)
   */
  private async getEmbedding(text: string): Promise<number[] | null> {
    try {
      return await this.semanticEngine.getEmbedding(text);
    } catch (e) {
      this.log.error("Failed to get embedding", { error: e });
      return null;
    }
  }
}
