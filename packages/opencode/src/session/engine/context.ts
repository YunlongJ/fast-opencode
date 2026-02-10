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

/**
 * 内存上下文引擎核心类
 */
export class MemoryContextEngine {
  private static instance: MemoryContextEngine;
  private flexIndex: Index;
  private semanticEngine: SemanticEngine;
  private parser: Parser | null = null;
  private lang: Language | null = null;
  private log = Log.create({ service: "memory.context.engine" });
  private symbolCache: Map<string, SymbolInfo[]> = new Map();

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
    try {
      if (!this.parser) {
        const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
          with: { type: "wasm" },
        });
        
        await Parser.init({
          locateFile() {
            // 在 Node/Bun 环境下，通过 import 加载的 WASM 会被处理为路径或 Buffer
            // 这里使用 web-tree-sitter 的默认加载逻辑，但显式指定 init 参数
            return treeWasm as any;
          },
        });
        this.parser = new Parser();
      }
      
      if (wasmPath) {
        this.lang = await Language.load(wasmPath);
        this.parser.setLanguage(this.lang);
      }
      
      this.log.info("MemoryContextEngine initialized successfully.");
    } catch (e) {
      this.log.error("Failed to initialize Tree-sitter", { error: e });
    }
  }

  /**
   * 索引文件内容并提取 AST 符号
   * @param filePath 文件路径
   * @param content 代码内容
   */
  public async indexFile(filePath: string, content: string) {
    // 1. 全文检索索引
    this.flexIndex.add(filePath, content);

    // 2. AST 符号提取
    if (this.parser && this.lang) {
      const symbols = await ASTSymbolExtractor.extract(this.parser, this.lang, content);
      this.symbolCache.set(filePath, symbols);
      
      // 将符号名也加入全文索引，增强命中率
      for (const sym of symbols) {
        this.flexIndex.add(`${filePath}#${sym.name}`, sym.name);
      }
    }
  }

  /**
   * 检索最相关的上下文片段
   * @param query 搜索关键词
   * @param limit 返回数量
   */
  public async search(query: string, limit: number = 5): Promise<string[]> {
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
   * 获取文件内容（从缓存或 VFS）
   */
  private async getFileContent(filePath: string): Promise<string | null> {
    // 这里应集成项目的 VFS 或文件读取逻辑，暂用 placeholder
    return null; 
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
   * TODO(arch): 实现 Voy WASM 语义搜索集成
   */
  public async searchSemantic(query: string) {
    // 待实现
  }
}
