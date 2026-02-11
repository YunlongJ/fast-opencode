import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "../message-v2"
import { CompactionService } from "../engine/compaction-service"

export interface CompactionStatus {
  needsCompaction: boolean
  strategy: "none" | "prune" | "summarize" | "full"
  usageRatio: number
}

/**
 * Governor to manage session memory and compaction strategy.
 */
export class CompactionGovernor {
  private static readonly log = Log.create({ service: "session.processor.compaction-governor" })
  
  private lastUsageRatio = 0

  constructor(
    private sessionID: string,
    private model: Provider.Model
  ) {}

  /**
   * Evaluates current token usage and decides on a compaction strategy.
   */
  async evaluate(tokens: MessageV2.Assistant["tokens"]): Promise<CompactionStatus> {
    const config = await Config.get()
    if (config.compaction?.auto === false) {
      return { needsCompaction: false, strategy: "none", usageRatio: 0 }
    }

    const context = this.model.limit.context
    if (context === 0) {
      return { needsCompaction: false, strategy: "none", usageRatio: 0 }
    }

    const count = tokens.input + tokens.cache.read + tokens.output
    const outputLimit = this.model.limit.output || 4096 // Fallback
    const usableContext = this.model.limit.input || (context - outputLimit)
    
    const usageRatio = count / usableContext
    this.lastUsageRatio = usageRatio

    CompactionGovernor.log.debug({ 
      sessionID: this.sessionID, 
      count, 
      usableContext, 
      usageRatio 
    }, "Evaluating compaction")

    // 1. Hard overflow check
    if (count > usableContext) {
      return { needsCompaction: true, strategy: "full", usageRatio }
    }

    // 2. Proactive check (e.g. 85% full)
    if (usageRatio > 0.85) {
      // Try pruning first if we haven't reached critical mass
      return { needsCompaction: true, strategy: "prune", usageRatio }
    }

    // 3. Trend analysis (optional: if usage grew too fast)
    
    return { needsCompaction: false, strategy: "none", usageRatio }
  }

  /**
   * Executes the chosen compaction strategy.
   * @param status Compaction status from evaluate()
   * @param queryHint Optional user query to guide semantic-aware compaction
   * @returns true if full compaction was performed and processor should restart
   */
  async executeStrategy(status: CompactionStatus, queryHint?: string): Promise<boolean> {
    if (!status.needsCompaction) return false

    CompactionGovernor.log.info({ 
      sessionID: this.sessionID, 
      strategy: status.strategy,
      queryHint: queryHint ? (queryHint.length > 50 ? queryHint.slice(0, 50) + "..." : queryHint) : undefined
    }, "Executing compaction strategy")

    switch (status.strategy) {
      case "prune":
        // 启发式修剪：通过 CompactionService 删除较旧的工具输出
        await CompactionService.prune({ sessionID: this.sessionID })
        return false 
      case "summarize":
        // 语义压缩：触发全量压缩流程生成摘要
        return true
      case "full":
        // 强制全量压缩
        return true
      default:
        return false
    }
  }
}
