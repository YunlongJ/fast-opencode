import { Log } from "@/util/log";
import { MessageV2 } from "../message-v2";
import { type ModelMessage } from "ai";

/**
 * 上下文治理器
 * 负责 Token 压缩、重要信息提取与长短期记忆管理
 */
export class ContextGovernor {
  private log = Log.create({ service: "context.governor" });
  private maxTokens = 128000; // 提升阈值以适配 200K 上下文模型

  /**
   * 压缩历史消息
   * 采用启发式压缩策略：保留系统提示词、最近 N 条消息、所有用户消息以及关键工具执行结果。
   */
  public async govern(messages: ModelMessage[]): Promise<ModelMessage[]> {
    const totalTokens = this.estimateTokens(messages);
    
    // 如果 Token 超过阈值，启动治理
    if (totalTokens <= this.maxTokens) {
      return messages;
    }

    this.log.info("Token limit exceeded, performing compaction...", { totalTokens, threshold: this.maxTokens });

    const governed: ModelMessage[] = [];
    const systemPrompt = messages.find(m => m.role === "system");
    if (systemPrompt) governed.push(systemPrompt);

    // 1. 保留最近 15 条消息（包含 Tool 调用和结果），确保对话连贯性
    const recentCount = 15;
    const recentMessages = messages.slice(-recentCount);
    const recentIds = new Set(recentMessages);
    
    // 2. 遍历中间消息，保留关键内容
    const intermediateMessages = messages.slice(systemPrompt ? 1 : 0, -recentCount);
    
    for (const msg of intermediateMessages) {
      if (recentIds.has(msg)) continue;

      if (msg.role === "user") {
        // 强制保留 User 的原始意图，但如果包含冗长的内存上下文，可以适当精简
        const contentStr = typeof msg.content === "string" ? msg.content : "";
        if (contentStr.includes("[Memory Context Engine]") && contentStr.length > 5000) {
           // 如果内存上下文过长，且不是最近的消息，可以进行压缩
           // 注意：这里只处理中间消息，recentMessages 不受影响
           const parts = contentStr.split("[Memory Context Engine]");
           const truncatedContent = parts[0] + "[Memory Context Engine]\n... [Old Context Truncated by Governor] ...\n";
           governed.push({ ...msg, content: truncatedContent });
        } else {
           governed.push(msg);
        }
      } else if (msg.role === "tool") {
        // 保留工具执行结果，但如果内容过长则进行截断
        const truncatedMsg = { ...msg } as any;
        if (Array.isArray(truncatedMsg.content)) {
          for (const part of truncatedMsg.content) {
            if (part.type === "tool-result" && typeof part.result === "string" && part.result.length > 2000) {
              part.result = part.result.slice(0, 1000) + "\n... [Content Truncated by Governor] ...\n" + part.result.slice(-500);
            }
          }
        } else if (typeof truncatedMsg.content === "string" && truncatedMsg.content.length > 2000) {
          truncatedMsg.content = truncatedMsg.content.slice(0, 1000) + "\n... [Content Truncated by Governor] ...\n" + truncatedMsg.content.slice(-500);
        }
        governed.push(truncatedMsg);
      } else if (msg.role === "assistant") {
        // 助手消息：保留包含工具调用的消息，或者较短的纯文本回复
        const hasToolCalls = (msg as any).tool_calls && (msg as any).tool_calls.length > 0;
        const contentStr = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? JSON.stringify(msg.content) : "";
        const isShortText = contentStr.length < 1000;
        
        if (hasToolCalls || isShortText) {
          governed.push(msg);
        }
      }
    }

    governed.push(...recentMessages);

    this.log.info("Compaction finished", { 
      before: messages.length, 
      after: governed.length,
      oldEstimate: totalTokens,
      newEstimate: this.estimateTokens(governed)
    });

    return governed;
  }

  /**
   * 估算 Token (针对代码和中文优化：平均字符数 / 3)
   */
  private estimateTokens(messages: ModelMessage[]): number {
    return messages.reduce((acc, m) => {
      let contentLen = 0;
      if (typeof m.content === "string") {
        contentLen = m.content.length;
      } else if (Array.isArray(m.content)) {
        for (const part of (m.content as any[])) {
          if (part.type === "text") contentLen += part.text.length;
          else if (part.type === "tool-call") contentLen += JSON.stringify(part.args || {}).length;
          else if (part.type === "tool-result") contentLen += JSON.stringify(part.result || "").length;
          else if (part.type === "image") contentLen += 1000; // 估算图片 Token
        }
      }
      // 考虑 tool_calls 的开销
      if ((m as any).tool_calls) {
        contentLen += JSON.stringify((m as any).tool_calls).length;
      }
      return acc + Math.ceil(contentLen / 3);
    }, 0);
  }
}
