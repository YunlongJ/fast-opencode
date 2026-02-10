import { Log } from "@/util/log";
import { MessageV2 } from "../message-v2";
import { type ModelMessage } from "ai";

/**
 * 上下文治理器
 * 负责 Token 压缩、重要信息提取与长短期记忆管理
 */
export class ContextGovernor {
  private log = Log.create({ service: "context.governor" });
  private maxTokens = 4096; // 默认阈值

  /**
   * 压缩历史消息
   */
  public async govern(messages: ModelMessage[]): Promise<ModelMessage[]> {
    const totalTokens = this.estimateTokens(messages);
    
    // 如果 Token 超过阈值，启动治理
    if (totalTokens <= this.maxTokens) {
      return messages;
    }

    this.log.info("Token limit exceeded, performing compaction...", { totalTokens });

    const governed: ModelMessage[] = [];
    const systemPrompt = messages.find(m => m.role === "system");
    if (systemPrompt) governed.push(systemPrompt);

    // 1. 保留最近 8 条消息
    const recentMessages = messages.slice(-8);
    
    // 2. 对中间的消息进行压缩
    const intermediateMessages = messages.slice(systemPrompt ? 1 : 0, -8);
    for (const msg of intermediateMessages) {
      if (msg.role === "assistant") {
        // 对于助手消息，如果是纯文本且较短，保留
        if (typeof msg.content === "string" && msg.content.length < 500) {
          governed.push(msg);
        }
      } else if (msg.role === "user") {
        // 保留 User 的原始意图
        governed.push(msg);
      }
    }

    governed.push(...recentMessages);

    this.log.info("Compaction finished", { 
      before: messages.length, 
      after: governed.length,
      newEstimate: this.estimateTokens(governed)
    });

    return governed;
  }

  /**
   * 估算 Token (简单估算：字符数 / 4)
   */
  private estimateTokens(messages: ModelMessage[]): number {
    return messages.reduce((acc, m) => {
      let contentLen = 0;
      if (typeof m.content === "string") {
        contentLen = m.content.length;
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === "text") contentLen += part.text.length;
        }
      }
      return acc + (contentLen / 4);
    }, 0);
  }
}
