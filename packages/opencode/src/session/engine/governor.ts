import { Log } from "@/util/log";
import { type ModelMessage } from "ai";
import { MemoryContextEngine } from "./context";
import { Token } from "@/util/token";

/**
 * 压缩策略接口
 */
export interface CompactionStrategy {
  compact(messages: ModelMessage[], threshold: number, query?: string): Promise<ModelMessage[]>;
}

/**
 * 高级压缩策略：集成语义相关性评分与 AST 级结构压缩
 * @responsibility 通过语义分析保留关键历史，通过 AST 压缩非核心代码块。
 */
export class AdvancedCompactionStrategy implements CompactionStrategy {
  private log = Log.create({ service: "compaction.advanced" });
  private contextEngine = MemoryContextEngine.getInstance();

  public async compact(messages: ModelMessage[], threshold: number, query?: string): Promise<ModelMessage[]> {
    const systemPrompt = messages.find(m => m.role === "system");
    const result: ModelMessage[] = systemPrompt ? [systemPrompt] : [];
    
    // 1. 保留最近的 5 轮对话（强制保留，确保短期记忆连贯）
    const RECENT_WINDOW = 10;
    const recentMessages = messages.slice(-RECENT_WINDOW);
    const recentIds = new Set(recentMessages);
    
    // 2. 对中间消息进行语义相关性评分
    const intermediateMessages = messages.slice(systemPrompt ? 1 : 0, -RECENT_WINDOW);
    const scoredMessages = await Promise.all(intermediateMessages.map(async (msg) => {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      let score = 0;
      
      if (query) {
        // 简单的语义相关性评分（实际可集成更复杂的向量余弦相似度）
        const keywords = query.toLowerCase().split(/\s+/);
        const matches = keywords.filter(k => content.toLowerCase().includes(k)).length;
        score = matches / keywords.length;
      }
      
      // 辅助消息（包含 tool_calls）权重增加
      if ((msg as any).tool_calls?.length > 0) score += 0.3;
      // User 消息权重增加
      if (msg.role === "user") score += 0.2;

      return { msg, score };
    }));

    // 3. 排序并按需保留高相关性消息
    scoredMessages.sort((a, b) => b.score - a.score);
    
    let currentTokens = TokenCounter.estimate([...result, ...recentMessages]);
    const budget = threshold * 0.8; // 留出 20% 余量

    for (const { msg, score } of scoredMessages) {
      if (currentTokens >= budget) break;

      // 对选中的中间消息进行结构化压缩
      const compactedMsg = await this.structurallyCompact(msg, score);
      const msgTokens = TokenCounter.estimate([compactedMsg]);
      
      if (currentTokens + msgTokens <= budget) {
        result.push(compactedMsg);
        currentTokens += msgTokens;
      }
    }

    // 保持原始顺序
    const finalMessages = messages.filter(m => result.includes(m) || recentIds.has(m));
    return finalMessages;
  }

  /**
   * 结构化压缩：利用正则或 AST 思想简化代码块
   */
  private async structurallyCompact(msg: ModelMessage, relevance: number): Promise<ModelMessage> {
    if (typeof msg.content !== "string") return msg;

    let content = msg.content;

    // 如果相关性较低且包含代码块，尝试压缩代码块
    if (relevance < 0.5) {
      // 匹配 Markdown 代码块
      content = content.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
        if (code.length < 500) return match;
        
        // 提取前 5 行和后 5 行，中间省略
        const lines = code.split("\n");
        if (lines.length <= 15) return match;
        
        return "```" + (lang || "") + "\n" + 
               lines.slice(0, 5).join("\n") + 
               "\n... [Code Block Compressed (Lines: " + lines.length + ")] ...\n" + 
               lines.slice(-5).join("\n") + 
               "\n```";
      });
    }

    // 压缩超长工具输出
    if (msg.role === "tool") {
      const toolContent = msg.content as any[];
      if (Array.isArray(toolContent)) {
        const compressedContent = toolContent.map(part => {
          if (typeof part.result === "string" && part.result.length > 2000) {
            return {
              ...part,
              result: part.result.slice(0, 800) + "\n... [Long Output Truncated] ...\n" + part.result.slice(-400)
            };
          }
          return part;
        });
        return { ...msg, content: compressedContent } as ModelMessage;
      }
      return msg;
    }

    return { ...msg, content } as ModelMessage;
  }
}

/**
 * 基础压缩策略：基于最近消息保留和长度截断
 */
export class HeuristicCompactionStrategy implements CompactionStrategy {
  private log = Log.create({ service: "compaction.heuristic" });

  public async compact(messages: ModelMessage[], threshold: number): Promise<ModelMessage[]> {
    const governed: ModelMessage[] = [];
    const systemPrompt = messages.find(m => m.role === "system");
    if (systemPrompt) governed.push(systemPrompt);

    // 保留最近 15 条消息
    const recentCount = 15;
    const recentMessages = messages.slice(-recentCount);
    const recentIds = new Set(recentMessages);
    
    const intermediateMessages = messages.slice(systemPrompt ? 1 : 0, -recentCount);
    
    for (const msg of intermediateMessages) {
      if (recentIds.has(msg)) continue;

      if (msg.role === "user") {
        const contentStr = typeof msg.content === "string" ? msg.content : "";
        if (contentStr.includes("[Memory Context Engine]") && contentStr.length > 5000) {
           const parts = contentStr.split("[Memory Context Engine]");
           const truncatedContent = parts[0] + "[Memory Context Engine]\n... [Context Truncated] ...\n";
           governed.push({ ...msg, content: truncatedContent });
        } else {
           governed.push(msg);
        }
      } else if (msg.role === "tool") {
        governed.push(this.compactToolMessage(msg));
      } else if (msg.role === "assistant") {
        if (this.shouldKeepAssistantMessage(msg)) {
          governed.push(msg);
        }
      }
    }

    governed.push(...recentMessages);
    return governed;
  }

  private compactToolMessage(msg: ModelMessage): ModelMessage {
    const truncatedMsg = { ...msg } as any;
    if (Array.isArray(truncatedMsg.content)) {
      for (const part of truncatedMsg.content) {
        if (part.type === "tool-result" && typeof part.result === "string" && part.result.length > 2000) {
          part.result = part.result.slice(0, 1000) + "\n... [Truncated] ...\n" + part.result.slice(-500);
        }
      }
    } else if (typeof truncatedMsg.content === "string" && truncatedMsg.content.length > 2000) {
      truncatedMsg.content = truncatedMsg.content.slice(0, 1000) + "\n... [Truncated] ...\n" + truncatedMsg.content.slice(-500);
    }
    return truncatedMsg;
  }

  private shouldKeepAssistantMessage(msg: ModelMessage): boolean {
    const hasToolCalls = (msg as any).tool_calls && (msg as any).tool_calls.length > 0;
    const contentStr = typeof msg.content === "string" ? msg.content : "";
    return hasToolCalls || contentStr.length < 1000;
  }
}

/**
 * Token 计数器类
 */
export class TokenCounter {
  public static estimate(messages: ModelMessage[]): number {
    return messages.reduce((acc, m) => {
      let contentLen = 0;
      if (typeof m.content === "string") {
        contentLen = m.content.length;
      } else if (Array.isArray(m.content)) {
        for (const part of (m.content as any[])) {
          if (part.type === "text") contentLen += part.text.length;
          else if (part.type === "tool-call") contentLen += JSON.stringify(part.args || {}).length;
          else if (part.type === "tool-result") contentLen += JSON.stringify(part.result || "").length;
          else if (part.type === "image") contentLen += 1000;
        }
      }
      if ((m as any).tool_calls) {
        contentLen += JSON.stringify((m as any).tool_calls).length;
      }
      return acc + Math.ceil(contentLen / 3);
    }, 0);
  }
}

/**
 * QMD (Query-aware Message Distillation) 压缩策略
 * @responsibility 实现基于当前查询语义的消息蒸馏，确保最相关的上下文被保留，同时极大减少非核心信息的 Token 占用。
 * @lightweight 采用分级蒸馏机制，避免全量 LLM 总结，提升处理速度。
 */
export class QMDCompactionStrategy implements CompactionStrategy {
  private log = Log.create({ service: "compaction.qmd" });
  private contextEngine = MemoryContextEngine.getInstance();

  public async compact(messages: ModelMessage[], threshold: number, query?: string): Promise<ModelMessage[]> {
    const systemPrompt = messages.find(m => m.role === "system");
    const result: ModelMessage[] = systemPrompt ? [systemPrompt] : [];
    
    // 1. 窗口保护：保留最近 8 条消息（4 轮对话），比之前稍多以保持短期连贯
    const PROTECT_WINDOW = 8;
    const protectedMessages = messages.slice(-PROTECT_WINDOW);
    const protectedIds = new Set(protectedMessages);
    
    const candidates = messages.slice(systemPrompt ? 1 : 0, -PROTECT_WINDOW);
    if (candidates.length === 0) return messages;

    // 2. 增强型语义蒸馏 (Enhanced QMD)
    // 自动扩展查询：结合最近一条消息和之前的部分上下文提取关键词
    const expandedQuery = await this.expandQueryLightweight(query, protectedMessages);
    const queryVector = expandedQuery ? await this.contextEngine["getEmbedding"](expandedQuery) : null;
    
    const scoredCandidates = await Promise.all(candidates.map(async (msg, index) => {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      let semanticScore = 0;
      
      if (queryVector) {
        const msgVector = await this.contextEngine["getEmbedding"](content);
        if (msgVector) {
          semanticScore = this.cosineSimilarity(queryVector, msgVector);
        }
      }

      // 关键词增强分 (FTS-like)
      let keywordScore = 0;
      if (expandedQuery) {
        const keywords = expandedQuery.toLowerCase().split(/\s+/).filter(k => k.length > 2);
        const matches = keywords.filter(k => content.toLowerCase().includes(k)).length;
        keywordScore = matches / (keywords.length || 1);
      }

      // 综合评分：语义 (0.4) + 关键词 (0.2) + 类型权重 (0.1) + 时效性 (0.3)
      const recencyScore = index / candidates.length;
      const typeWeight = msg.role === "user" ? 0.3 : (msg.role === "assistant" ? 0.2 : 0.1);
      const totalScore = (semanticScore * 0.4) + (keywordScore * 0.2) + (typeWeight * 0.1) + (recencyScore * 0.3);

      return { msg, score: totalScore, semanticScore, keywordScore };
    }));

    // 3. 分级处理
    // 排序：高分在前
    scoredCandidates.sort((a, b) => b.score - a.score);

    const budget = threshold * 0.75; // 预留更多空间给新消息
    let currentTokens = TokenCounter.estimate([...result, ...protectedMessages]);

    for (const { msg, score, semanticScore } of scoredCandidates) {
      if (currentTokens >= budget) break;

      let distilledMsg = msg;
      
      // 核心蒸馏逻辑
      if (score < 0.4 && semanticScore < 0.3) {
        // 低相关性：仅保留元数据，蒸馏掉内容
        distilledMsg = this.distillMetadata(msg);
      } else if (score < 0.6) {
        // 中相关性：执行轻量级结构压缩
        distilledMsg = this.lightweightCompress(msg);
      }

      const msgTokens = TokenCounter.estimate([distilledMsg]);
      if (currentTokens + msgTokens <= budget) {
        result.push(distilledMsg);
        currentTokens += msgTokens;
      }
    }

    // 4. 按原始时间线重组
    const finalMessages = messages.filter(m => result.includes(m) || protectedIds.has(m));
    
    this.log.info("QMD Distillation complete", {
      original: messages.length,
      compacted: finalMessages.length,
      ratio: (TokenCounter.estimate(finalMessages) / TokenCounter.estimate(messages)).toFixed(2)
    });

    return finalMessages;
  }

  /**
   * 轻量级查询扩展：从原始查询和最近对话中提取关键词
   */
  private async expandQueryLightweight(query: string | undefined, protectedMessages: ModelMessage[]): Promise<string> {
    if (!query) return "";

    let expanded = query;

    // 提取最近 User 消息的关键片段
    const lastUserMsg = [...protectedMessages].reverse().find(m => m.role === "user");
    if (lastUserMsg && typeof lastUserMsg.content === "string") {
      // 提取名词、函数名或带有符号的标识符 (简单正则模拟)
      const matches = lastUserMsg.content.match(/\b([A-Z][a-z0-9]+|[a-z0-9]+[A-Z][a-z0-9]+|\w+\.\w+|#\w+)\b/g);
      if (matches) {
        const uniqueKeywords = Array.from(new Set(matches)).slice(0, 5);
        expanded += " " + uniqueKeywords.join(" ");
      }
    }

    return expanded.trim();
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * 仅保留元数据的蒸馏
   */
  private distillMetadata(msg: ModelMessage): ModelMessage {
    const rolePrefix = `[Distilled ${msg.role.toUpperCase()}]`;
    let summary = "";
    
    if (msg.role === "tool") {
      summary = `${rolePrefix} Tool result omitted due to low relevance.`;
      const toolContent = msg.content as any[];
      if (Array.isArray(toolContent)) {
        return {
          ...msg,
          content: toolContent.map(part => ({ ...part, result: summary }))
        } as ModelMessage;
      }
      return msg;
    } else if ((msg as any).tool_calls?.length > 0) {
      const toolNames = (msg as any).tool_calls.map((tc: any) => tc.function?.name || tc.type).join(", ");
      summary = `${rolePrefix} Called tools: ${toolNames}. Content distilled.`;
    } else {
      summary = `${rolePrefix} Historical context distilled (Low relevance).`;
    }

    return { ...msg, content: summary } as ModelMessage;
  }

  /**
   * 轻量级结构压缩 (非 LLM 依赖)
   */
  private lightweightCompress(msg: ModelMessage): ModelMessage {
    if (msg.role === "tool") return msg;
    if (typeof msg.content !== "string") return msg;

    let content = msg.content;
    // 压缩代码块，仅保留关键的头尾信息
    content = content.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
      const lines = code.trim().split("\n");
      if (lines.length <= 8) return match;
      return `\`\`\`${lang || ""}\n${lines[0]}\n// ... [${lines.length - 2} lines distilled] ...\n${lines[lines.length - 1]}\n\`\`\``;
    });

    // 压缩超长文本
    if (content.length > 1000) {
      content = content.slice(0, 400) + "\n\n[... Content Distilled ...]\n\n" + content.slice(-200);
    }

    return { ...msg, content } as ModelMessage;
  }
}

/**
 * 改进后的上下文治理器
 * @responsibility 协调 Token 计数与压缩策略，确保上下文不溢出。
 */
export class ContextGovernor {
  private log = Log.create({ service: "context.governor" });
  private maxTokens = 128000;
  private strategy: CompactionStrategy;

  constructor(strategy?: CompactionStrategy) {
    // 默认使用最新的 QMD 蒸馏方案
    this.strategy = strategy || new QMDCompactionStrategy();
  }

  public async govern(messages: ModelMessage[], query?: string): Promise<ModelMessage[]> {
    const totalTokens = TokenCounter.estimate(messages);
    
    if (totalTokens <= this.maxTokens) {
      return messages;
    }

    this.log.info("Token limit exceeded, performing compaction...", { totalTokens, threshold: this.maxTokens });

    const governed = await this.strategy.compact(messages, this.maxTokens, query);

    this.log.info("Compaction finished", { 
      before: messages.length, 
      after: governed.length,
      newEstimate: TokenCounter.estimate(governed)
    });

    return governed;
  }
}

