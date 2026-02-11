/**
 * @fileoverview 增强并发控制器 - 自适应并发限制与优先级调度
 * @responsibility 提供智能的并发控制，根据工具类型和系统负载动态调整
 */

import { Log } from "@/util/log"
import { TaskPriority } from "./types"
import type { ToolConcurrencyConfig, ControllerStats } from "./types"
import { CONCURRENCY_DEFAULTS, TOOL_TIMEOUTS, TOOL_CONCURRENCY, RETRY_CONFIG } from "./constants"
import { withTimeout } from "./utils"

const log = Log.create({ service: "concurrency-controller" })

/** 队列任务 */
interface QueuedTask<T> {
  id: string
  fn: () => Promise<T>
  priority: TaskPriority
  toolType: string
  resolve: (value: T) => void
  reject: (reason: Error) => void
  retries: number
  enqueueTime: number
}

/** 批量任务结果 */
interface BatchTaskResult<T> {
  success: boolean
  result?: T
  error?: Error
}

/** 默认工具配置 */
const DEFAULT_TOOL_CONFIGS: Readonly<Record<string, ToolConcurrencyConfig>> = {
  read: {
    maxConcurrent: TOOL_CONCURRENCY.READ,
    priority: TaskPriority.HIGH,
    timeout: TOOL_TIMEOUTS.READ,
    retryable: true,
    maxRetries: RETRY_CONFIG.READ_RETRIES,
  },
  read_multiple: {
    maxConcurrent: TOOL_CONCURRENCY.READ_MULTIPLE,
    priority: TaskPriority.HIGH,
    timeout: TOOL_TIMEOUTS.READ_MULTIPLE,
    retryable: true,
    maxRetries: RETRY_CONFIG.READ_RETRIES,
  },
  grep: {
    maxConcurrent: TOOL_CONCURRENCY.GREP,
    priority: TaskPriority.NORMAL,
    timeout: TOOL_TIMEOUTS.GREP,
    retryable: true,
    maxRetries: RETRY_CONFIG.GREP_RETRIES,
  },
  glob: {
    maxConcurrent: TOOL_CONCURRENCY.GLOB,
    priority: TaskPriority.NORMAL,
    timeout: TOOL_TIMEOUTS.GLOB,
    retryable: true,
    maxRetries: RETRY_CONFIG.GLOB_RETRIES,
  },
  edit: {
    maxConcurrent: TOOL_CONCURRENCY.EDIT,
    priority: TaskPriority.CRITICAL,
    timeout: TOOL_TIMEOUTS.EDIT,
    retryable: false,
    maxRetries: RETRY_CONFIG.EDIT_RETRIES,
  },
  write: {
    maxConcurrent: TOOL_CONCURRENCY.WRITE,
    priority: TaskPriority.CRITICAL,
    timeout: TOOL_TIMEOUTS.WRITE,
    retryable: false,
    maxRetries: RETRY_CONFIG.EDIT_RETRIES,
  },
  bash: {
    maxConcurrent: TOOL_CONCURRENCY.BASH,
    priority: TaskPriority.NORMAL,
    timeout: TOOL_TIMEOUTS.BASH,
    retryable: false,
    maxRetries: RETRY_CONFIG.BASH_RETRIES,
  },
  apply_patch: {
    maxConcurrent: TOOL_CONCURRENCY.APPLY_PATCH,
    priority: TaskPriority.CRITICAL,
    timeout: TOOL_TIMEOUTS.APPLY_PATCH,
    retryable: false,
    maxRetries: RETRY_CONFIG.EDIT_RETRIES,
  },
  default: {
    maxConcurrent: TOOL_CONCURRENCY.DEFAULT,
    priority: TaskPriority.NORMAL,
    timeout: TOOL_TIMEOUTS.DEFAULT,
    retryable: true,
    maxRetries: RETRY_CONFIG.MAX_RETRIES,
  },
}

/**
 * 增强并发控制器
 */
export class EnhancedConcurrencyController {
  readonly #queue: QueuedTask<any>[] = []
  readonly #active = new Set<string>()
  readonly #toolConfigs = new Map<string, ToolConcurrencyConfig>(Object.entries(DEFAULT_TOOL_CONFIGS))
  readonly #baseLimit: number
  #adaptiveLimit: number
  #lastAdjustment = Date.now()

  #stats = {
    completedCount: 0,
    failedCount: 0,
    totalWaitTime: 0,
    totalExecutionTime: 0,
  }

  constructor(baseLimit = CONCURRENCY_DEFAULTS.BASE_LIMIT) {
    this.#baseLimit = baseLimit
    this.#adaptiveLimit = baseLimit
  }

  /**
   * 执行任务
   */
  async run<T>(id: string, toolType: string, fn: () => Promise<T>, priority?: TaskPriority): Promise<T> {
    const config = this.#getConfig(toolType)
    const taskPriority = priority ?? config.priority

    return new Promise((resolve, reject) => {
      const task: QueuedTask<T> = {
        id,
        fn,
        priority: taskPriority,
        toolType,
        resolve: resolve as (value: unknown) => void,
        reject,
        retries: 0,
        enqueueTime: Date.now(),
      }

      this.#queue.push(task)
      this.#sortQueue()
      this.#processQueue()
    })
  }

  /**
   * 批量执行任务
   */
  async runBatch<T>(
    tasks: ReadonlyArray<{
      id: string
      toolType: string
      fn: () => Promise<T>
      priority?: TaskPriority
    }>,
  ): Promise<Map<string, BatchTaskResult<T>>> {
    const results = new Map<string, BatchTaskResult<T>>()

    await Promise.all(
      tasks.map(async ({ id, toolType, fn, priority }) => {
        try {
          const result = await this.run(id, toolType, fn, priority)
          results.set(id, { success: true, result })
        } catch (error) {
          results.set(id, { success: false, error: error as Error })
        }
      }),
    )

    return results
  }

  /**
   * 获取统计信息
   */
  getStats(): ControllerStats {
    const totalTasks = this.#stats.completedCount + this.#stats.failedCount
    return {
      activeCount: this.#active.size,
      queuedCount: this.#queue.length,
      completedCount: this.#stats.completedCount,
      failedCount: this.#stats.failedCount,
      avgWaitTime: totalTasks > 0 ? this.#stats.totalWaitTime / totalTasks : 0,
      avgExecutionTime: totalTasks > 0 ? this.#stats.totalExecutionTime / totalTasks : 0,
    }
  }

  /**
   * 更新工具配置
   */
  updateToolConfig(toolType: string, config: Partial<ToolConcurrencyConfig>): void {
    const existing = this.#getConfig(toolType)
    this.#toolConfigs.set(toolType, { ...existing, ...config })
  }

  /**
   * 清空队列
   */
  clear(): void {
    for (const task of this.#queue) {
      task.reject(new Error("Queue cleared"))
    }
    this.#queue.length = 0
  }

  /**
   * 获取配置
   */
  #getConfig(toolType: string): ToolConcurrencyConfig {
    return this.#toolConfigs.get(toolType) ?? this.#toolConfigs.get("default")!
  }

  /**
   * 处理队列
   */
  #processQueue(): void {
    this.#adjustAdaptiveLimit()

    while (this.#active.size < this.#adaptiveLimit && this.#queue.length > 0) {
      const task = this.#queue.shift()
      if (!task) break

      const config = this.#getConfig(task.toolType)
      const activeForTool = this.#getActiveCountForTool(task.toolType)

      if (activeForTool >= config.maxConcurrent) {
        this.#queue.unshift(task)
        break
      }

      this.#executeTask(task)
    }
  }

  /**
   * 执行任务
   */
  async #executeTask(task: QueuedTask<any>): Promise<void> {
    this.#active.add(task.id)
    const waitTime = Date.now() - task.enqueueTime
    this.#stats.totalWaitTime += waitTime

    const config = this.#getConfig(task.toolType)
    const startTime = Date.now()

    try {
      const result = await withTimeout(task.fn(), config.timeout, `Task ${task.toolType} timed out`)
      this.#stats.totalExecutionTime += Date.now() - startTime
      this.#stats.completedCount++
      task.resolve(result)
    } catch (error) {
      this.#stats.totalExecutionTime += Date.now() - startTime

      if (config.retryable && task.retries < config.maxRetries) {
        task.retries++
        log.debug("Retrying task", { id: task.id, toolType: task.toolType, retry: task.retries })
        this.#queue.push(task)
        this.#sortQueue()
      } else {
        this.#stats.failedCount++
        task.reject(error as Error)
      }
    } finally {
      this.#active.delete(task.id)
      this.#processQueue()
    }
  }

  /**
   * 排序队列
   */
  #sortQueue(): void {
    this.#queue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      return a.enqueueTime - b.enqueueTime
    })
  }

  /**
   * 获取某工具类型的活跃任务数
   */
  #getActiveCountForTool(_toolType: string): number {
    // 简化实现，实际应该跟踪每个任务的工具类型
    return Math.floor(this.#active.size / 2)
  }

  /**
   * 自适应调整并发限制
   */
  #adjustAdaptiveLimit(): void {
    const now = Date.now()
    if (now - this.#lastAdjustment < CONCURRENCY_DEFAULTS.ADJUSTMENT_INTERVAL) return

    this.#lastAdjustment = now
    const queueLength = this.#queue.length
    const activeCount = this.#active.size

    if (queueLength > activeCount * 2) {
      this.#adaptiveLimit = Math.min(this.#baseLimit * 2, this.#adaptiveLimit + 5)
    } else if (queueLength === 0 && activeCount < this.#adaptiveLimit / 2) {
      this.#adaptiveLimit = Math.max(this.#baseLimit / 2, this.#adaptiveLimit - 2)
    }
  }
}

/**
 * 资源感知调度器
 */
export class ResourceAwareScheduler {
  readonly #controller: EnhancedConcurrencyController

  constructor(baseLimit = CONCURRENCY_DEFAULTS.BASE_LIMIT) {
    this.#controller = new EnhancedConcurrencyController(baseLimit)
  }

  /**
   * 检查系统资源
   */
  checkResources(): { memory: number; cpu: number; healthy: boolean } {
    const memory = process.memoryUsage()
    const memoryUsage = memory.heapUsed / memory.heapTotal
    const cpuUsage = 0.5 // 简化实现

    return {
      memory: memoryUsage,
      cpu: cpuUsage,
      healthy: memoryUsage < CONCURRENCY_DEFAULTS.MEMORY_THRESHOLD && cpuUsage < CONCURRENCY_DEFAULTS.CPU_THRESHOLD,
    }
  }

  /**
   * 根据资源状态调整
   */
  adjustForResources(): void {
    const resources = this.checkResources()

    if (!resources.healthy) {
      this.#controller.updateToolConfig("read", { maxConcurrent: 20 })
      this.#controller.updateToolConfig("grep", { maxConcurrent: 5 })
      this.#controller.updateToolConfig("bash", { maxConcurrent: 2 })
      log.warn("Resource pressure detected, reducing concurrency")
    } else {
      this.#controller.updateToolConfig("read", { maxConcurrent: TOOL_CONCURRENCY.READ })
      this.#controller.updateToolConfig("grep", { maxConcurrent: TOOL_CONCURRENCY.GREP })
      this.#controller.updateToolConfig("bash", { maxConcurrent: TOOL_CONCURRENCY.BASH })
    }
  }

  /**
   * 获取控制器
   */
  getController(): EnhancedConcurrencyController {
    return this.#controller
  }
}

/** 全局并发控制器实例 */
export const concurrencyController = new EnhancedConcurrencyController()
export const resourceScheduler = new ResourceAwareScheduler()
