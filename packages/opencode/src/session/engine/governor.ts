import { Log } from "@/util/log";
import { type ModelMessage } from "ai";

/**
 * 压缩策略接口
 */
export interface CompactionStrategy {
  compact(messages: ModelMessage[], threshold: number): Promise<ModelMessage[]>;
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
 * 改进后的上下文治理器
 * @responsibility 协调 Token 计数与压缩策略，确保上下文不溢出。
 */
export class ContextGovernor {
  private log = Log.create({ service: "context.governor" });
  private maxTokens = 128000;
  private strategy: CompactionStrategy;

  constructor(strategy?: CompactionStrategy) {
    this.strategy = strategy || new HeuristicCompactionStrategy();
  }

  public async govern(messages: ModelMessage[]): Promise<ModelMessage[]> {
    const totalTokens = TokenCounter.estimate(messages);
    
    if (totalTokens <= this.maxTokens) {
      return messages;
    }

    this.log.info("Token limit exceeded, performing compaction...", { totalTokens, threshold: this.maxTokens });

    const governed = await this.strategy.compact(messages, this.maxTokens);

    this.log.info("Compaction finished", { 
      before: messages.length, 
      after: governed.length,
      newEstimate: TokenCounter.estimate(governed)
    });

    return governed;
  }
}
