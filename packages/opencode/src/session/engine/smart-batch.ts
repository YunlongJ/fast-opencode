/**
 * @fileoverview 智能批处理系统 - 优化工具调用性能
 * @responsibility 自动识别可批量执行的工具调用，减少 I/O 开销
 */

import type { ToolExecutor } from "./tool-orchestrator"
import { Log } from "@/util/log"
import type { BatchType, BatchConfig, BatchGroup, BatchResult } from "./types"
import { BATCH_DEFAULTS } from "./constants"
import { extractPathsFromInput } from "./utils"

const log = Log.create({ service: "smart-batch" })

/** 批处理配置映射 */
const BATCH_CONFIGS: Readonly<Map<BatchType, BatchConfig>> = new Map([
  ["read", { type: "read", minBatchSize: BATCH_DEFAULTS.READ_MIN, maxBatchSize: BATCH_DEFAULTS.READ_MAX, priority: 1 }],
  ["grep", { type: "grep", minBatchSize: BATCH_DEFAULTS.GREP_MIN, maxBatchSize: BATCH_DEFAULTS.GREP_MAX, priority: 2 }],
  ["glob", { type: "glob", minBatchSize: BATCH_DEFAULTS.GLOB_MIN, maxBatchSize: BATCH_DEFAULTS.GLOB_MAX, priority: 3 }],
  [
    "semantic_read",
    {
      type: "semantic_read",
      minBatchSize: BATCH_DEFAULTS.SEMANTIC_READ_MIN,
      maxBatchSize: BATCH_DEFAULTS.SEMANTIC_READ_MAX,
      priority: 1,
    },
  ],
])

/** 执行计划结果 */
interface ExecutionPlan {
  batches: BatchGroup[]
  singles: ToolExecutor[]
}

/**
 * 智能批处理器
 */
export class SmartBatchProcessor {
  /**
   * 分析执行器列表，识别可批量处理的组
   */
  analyze(executors: readonly ToolExecutor[]): BatchGroup[] {
    const groups = new Map<string, BatchGroup>()

    for (const executor of executors) {
      const batchType = this.detectBatchType(executor)
      if (batchType === "none") continue

      const config = BATCH_CONFIGS.get(batchType)!
      const groupKey = this.getGroupKey(executor, batchType)

      const existing = groups.get(groupKey)
      if (existing) {
        existing.executors.push(executor)
      } else {
        groups.set(groupKey, { type: batchType, executors: [executor], key: groupKey })
      }
    }

    return Array.from(groups.values())
      .filter((g) => g.executors.length >= BATCH_CONFIGS.get(g.type)!.minBatchSize)
      .sort((a, b) => BATCH_CONFIGS.get(a.type)!.priority - BATCH_CONFIGS.get(b.type)!.priority)
  }

  /**
   * 检测执行器的批处理类型
   */
  private detectBatchType(executor: ToolExecutor): BatchType {
    const { toolName, input } = executor

    switch (toolName) {
      case "read":
        return !input.offset && (!input.limit || input.limit >= 2000) ? "read" : "semantic_read"
      case "grep":
        return input.path ? "grep" : "none"
      case "glob":
        return input.path ? "glob" : "none"
      default:
        return "none"
    }
  }

  /**
   * 获取批处理组键
   */
  private getGroupKey(executor: ToolExecutor, batchType: BatchType): string {
    const { toolName, input } = executor
    const paths = extractPathsFromInput(input)
    const firstPath = paths.values().next().value

    switch (batchType) {
      case "read":
      case "semantic_read": {
        const filePath = String(firstPath || input.filePath || input.path || "")
        const dir = filePath.split("/").slice(0, -1).join("/") || "."
        return `${batchType}:${dir}`
      }
      case "grep":
      case "glob":
        return `${batchType}:${input.path || "."}`
      default:
        return `${batchType}:${toolName}`
    }
  }

  /**
   * 创建优化的批处理执行计划
   */
  createExecutionPlan(executors: readonly ToolExecutor[]): ExecutionPlan {
    const batches = this.analyze(executors)
    const batchedIds = new Set(batches.flatMap((b) => b.executors.map((e) => e.callId)))
    const singles = executors.filter((e) => !batchedIds.has(e.callId))

    log.debug("Created execution plan", {
      batchCount: batches.length,
      singleCount: singles.length,
      batchTypes: batches.map((b) => b.type),
    })

    return { batches, singles }
  }

  /**
   * 合并批处理结果到单个结果映射
   */
  mergeResults(batches: readonly BatchResult[], singles: readonly Map<string, unknown>[]): Map<string, unknown> {
    const merged = new Map<string, unknown>()

    for (const batch of batches) {
      for (const [callId, result] of batch.results) {
        merged.set(callId, result)
      }
    }

    for (const single of singles) {
      for (const [callId, result] of single) {
        merged.set(callId, result)
      }
    }

    return merged
  }
}

/** 全局批处理器实例 */
export const smartBatchProcessor = new SmartBatchProcessor()

/**
 * 快速路径检测 - 检测是否可以使用快速批处理路径
 */
export function canUseFastPath(executors: readonly ToolExecutor[]): boolean {
  if (executors.length < 2) return false

  const first = executors[0]
  if (first?.toolName !== "read") return false

  return executors.every((e) => e.toolName === "read" && !e.input.offset && (!e.input.limit || e.input.limit >= 2000))
}

/**
 * 动态批处理大小计算 - 根据系统负载调整
 */
export function calculateOptimalBatchSize(toolType: string, pendingCount: number, systemLoad = 0.5): number {
  const baseSizes: Record<string, number> = {
    read: BATCH_DEFAULTS.READ_MAX,
    grep: BATCH_DEFAULTS.GREP_MAX,
    glob: BATCH_DEFAULTS.GLOB_MAX,
  }

  const base = baseSizes[toolType] || 10
  const loadFactor = Math.max(0.3, 1 - systemLoad)
  const pendingFactor = Math.min(2, 1 + pendingCount / 100)

  return Math.floor(base * loadFactor * pendingFactor)
}
