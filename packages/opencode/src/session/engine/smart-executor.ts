/**
 * @fileoverview 工具预加载与预测系统
 * @responsibility 基于历史调用模式预测下一步工具调用，提前准备资源
 */

import { Log } from "@/util/log"
import type { ToolExecutor } from "./tool-orchestrator"
import type { CallHistory, CallPattern, Prediction } from "./types"
import { PREDICTION_CONFIG } from "./constants"
import { getMatchLength } from "./utils"

const log = Log.create({ service: "tool-predictor" })

/** 上下文预测规则 */
const CONTEXT_RULES: ReadonlyArray<{
  after: string
  predicts: ReadonlyArray<{ tool: string; confidence: number; reason: string }>
}> = [
  {
    after: "read",
    predicts: [
      { tool: "edit", confidence: 0.6, reason: "Read often followed by edit" },
      { tool: "grep", confidence: 0.4, reason: "Read often followed by search in same file" },
    ],
  },
  {
    after: "glob",
    predicts: [{ tool: "read", confidence: 0.7, reason: "Glob often followed by reading found files" }],
  },
  {
    after: "grep",
    predicts: [{ tool: "read", confidence: 0.6, reason: "Grep often followed by reading matched files" }],
  },
]

/**
 * 工具调用预测器
 */
export class ToolCallPredictor {
  readonly #history: CallHistory[] = []
  readonly #patterns = new Map<string, CallPattern>()

  /**
   * 记录工具调用
   */
  record(sessionID: string, toolName: string, input: Record<string, unknown>): void {
    this.#history.push({
      toolName,
      input,
      timestamp: Date.now(),
      sessionID,
    })

    // 限制历史记录大小
    if (this.#history.length > PREDICTION_CONFIG.MAX_HISTORY) {
      this.#history.splice(0, this.#history.length - PREDICTION_CONFIG.MAX_HISTORY)
    }

    this.#updatePatterns()
  }

  /**
   * 预测下一步调用
   */
  predict(sessionID: string, recentCalls: readonly CallHistory[]): Prediction[] {
    const predictions: Prediction[] = []

    // 基于序列模式预测
    predictions.push(...this.#predictFromSequence(recentCalls))

    // 基于上下文预测
    predictions.push(...this.#predictFromContext(recentCalls))

    // 去重并排序
    const unique = new Map<string, Prediction>()
    for (const p of predictions) {
      const existing = unique.get(p.toolName)
      if (!existing || existing.confidence < p.confidence) {
        unique.set(p.toolName, p)
      }
    }

    return Array.from(unique.values())
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, PREDICTION_CONFIG.MAX_PREDICTIONS)
  }

  /**
   * 获取会话历史
   */
  getSessionHistory(sessionID: string): CallHistory[] {
    return this.#history.filter((h) => h.sessionID === sessionID)
  }

  /**
   * 基于序列模式预测
   */
  #predictFromSequence(recentCalls: readonly CallHistory[]): Prediction[] {
    const predictions: Prediction[] = []
    const recentSequence = recentCalls.slice(-PREDICTION_CONFIG.PATTERN_WINDOW).map((c) => c.toolName)

    if (recentSequence.length === 0) return predictions

    for (const pattern of this.#patterns.values()) {
      const matchLength = getMatchLength(recentSequence, pattern.sequence.slice(0, -1))
      if (matchLength >= 2) {
        const nextTool = pattern.sequence[matchLength]
        if (nextTool) {
          const confidence = Math.min(0.9, (matchLength / PREDICTION_CONFIG.PATTERN_WINDOW) * pattern.frequency)
          predictions.push({
            toolName: nextTool,
            confidence,
            reason: `Pattern match: ${recentSequence.slice(-matchLength).join(" → ")} → ${nextTool}`,
          })
        }
      }
    }

    return predictions
  }

  /**
   * 基于上下文预测
   */
  #predictFromContext(recentCalls: readonly CallHistory[]): Prediction[] {
    const lastCall = recentCalls[recentCalls.length - 1]
    if (!lastCall) return []

    const rule = CONTEXT_RULES.find((r) => r.after === lastCall.toolName)
    if (!rule) return []

    return rule.predicts.map((p) => ({
      toolName: p.tool,
      confidence: p.confidence,
      reason: p.reason,
      suggestedInput: lastCall.input.filePath ? { path: lastCall.input.filePath } : undefined,
    }))
  }

  /**
   * 更新模式库
   */
  #updatePatterns(): void {
    if (this.#history.length < PREDICTION_CONFIG.PATTERN_WINDOW * 2) return

    // 滑动窗口提取模式
    for (let i = 0; i <= this.#history.length - PREDICTION_CONFIG.PATTERN_WINDOW; i++) {
      const sequence = this.#history.slice(i, i + PREDICTION_CONFIG.PATTERN_WINDOW).map((h) => h.toolName)
      const key = sequence.join(",")

      const existing = this.#patterns.get(key)
      if (existing) {
        existing.frequency++
        existing.lastSeen = Date.now()
      } else {
        this.#patterns.set(key, {
          sequence,
          frequency: 1,
          avgTimeGap: 0,
          lastSeen: Date.now(),
        })
      }
    }

    // 清理旧模式
    const now = Date.now()
    for (const [key, pattern] of this.#patterns) {
      if (now - pattern.lastSeen > PREDICTION_CONFIG.PATTERN_EXPIRY) {
        this.#patterns.delete(key)
      }
    }
  }
}

/**
 * 资源预加载器
 */
export class ResourcePreloader {
  readonly #preloadedFiles = new Set<string>()
  readonly #preloadedPatterns = new Set<string>()

  /**
   * 预加载文件（标记）
   */
  async preloadFiles(filePaths: readonly string[]): Promise<void> {
    const toLoad = filePaths.filter((p) => !this.#preloadedFiles.has(p))
    if (toLoad.length === 0) return

    log.debug("Preloading files", { count: toLoad.length })
    toLoad.forEach((path) => this.#preloadedFiles.add(path))
  }

  /**
   * 预编译正则模式
   */
  preloadPatterns(patterns: readonly string[]): void {
    for (const pattern of patterns) {
      if (this.#preloadedPatterns.has(pattern)) continue

      try {
        new RegExp(pattern)
        this.#preloadedPatterns.add(pattern)
      } catch {
        // 忽略无效模式
      }
    }
  }

  /**
   * 检查是否已预加载
   */
  isPreloaded(filePath: string): boolean {
    return this.#preloadedFiles.has(filePath)
  }

  /**
   * 清除预加载状态
   */
  clear(): void {
    this.#preloadedFiles.clear()
    this.#preloadedPatterns.clear()
  }
}

/** 准备结果 */
interface PrepareResult {
  executors: ToolExecutor[]
  predictions: Prediction[]
  preloaded: string[]
}

/**
 * 智能执行器 - 结合预测和预加载
 */
export class SmartExecutor {
  readonly #predictor = new ToolCallPredictor()
  readonly #preloader = new ResourcePreloader()

  /**
   * 执行前准备
   */
  async prepare(sessionID: string, executors: readonly ToolExecutor[]): Promise<PrepareResult> {
    // 记录当前调用
    for (const executor of executors) {
      this.#predictor.record(sessionID, executor.toolName, executor.input)
    }

    // 获取历史并预测
    const history = this.#predictor.getSessionHistory(sessionID)
    const predictions = this.#predictor.predict(sessionID, history)

    // 基于预测预加载资源
    const toPreload = predictions
      .filter((p) => p.toolName === "read" && p.suggestedInput?.filePath)
      .map((p) => String(p.suggestedInput!.filePath))

    await this.#preloader.preloadFiles(toPreload)

    return {
      executors: [...executors],
      predictions,
      preloaded: toPreload,
    }
  }

  /**
   * 获取预测器实例
   */
  getPredictor(): ToolCallPredictor {
    return this.#predictor
  }

  /**
   * 获取预加载器实例
   */
  getPreloader(): ResourcePreloader {
    return this.#preloader
  }
}

/** 全局智能执行器实例 */
export const smartExecutor = new SmartExecutor()
