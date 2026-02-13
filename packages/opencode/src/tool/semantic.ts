import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./semantic.txt"
import { MemoryContextEngine } from "../session/engine/context"

/**
 * 语义搜索工具
 * 允许 LLM 通过自然语言查询工作区中的代码片段。
 */
export const SemanticTool = Tool.define("search_codebase", {
  description: DESCRIPTION,
  parameters: z.object({
    query: z.string().describe("Natural language query to search for code snippets in the local codebase (e.g., 'authentication flow', 'how are errors handled')"),
    limit: z.number().optional().default(10).describe("Maximum number of results to return"),
    minScore: z.number().optional().default(0.25).describe("Minimum similarity score (0.0 to 1.0) to filter results. Lowering this increases recall but may include less relevant results."),
  }),
  async execute(params, ctx) {
    // 自动优化 query，如果 query 太短或太简单，可以引导 LLM 提供更多上下文
    const enhancedQuery = params.query.length < 5 ? `code implementation of ${params.query}` : params.query;

    await ctx.ask({
      permission: "search_codebase",
      patterns: [enhancedQuery],
      always: ["*"],
      metadata: {
        query: enhancedQuery,
        limit: params.limit,
        minScore: params.minScore,
      },
    })

    const engine = MemoryContextEngine.getInstance()
    
    // 确保引擎已初始化
    await engine.init()

    try {
      // 使用混合搜索 (FTS + 符号 + 语义)，提供更强大的召回能力
      const results = await engine.search(enhancedQuery, params.limit, params.minScore)
      
      if (results.length === 0) {
        return {
          title: `Search: ${params.query}`,
          metadata: { results: 0 },
          output: "No relevant code snippets found in the codebase. Try using different keywords or lowering the minScore."
        }
      }

      return {
        title: `Done ${results.length} results`,
        metadata: { results: results.length },
        output: results.join("\n\n---\n\n")
      }
    } catch (error) {
      throw new Error(`Codebase search failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
})
