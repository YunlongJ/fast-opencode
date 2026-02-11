/**
 * @fileoverview 工具优化模块共享类型定义
 * @responsibility 统一类型定义，避免重复
 */

import type { ToolExecutor } from "./tool-orchestrator"

/** 工具名称类型 */
export type ToolName =
  | "read"
  | "read_multiple"
  | "grep"
  | "glob"
  | "edit"
  | "write"
  | "bash"
  | "apply_patch"
  | "list"
  | string

/** 任务优先级 */
export enum TaskPriority {
  CRITICAL = 0,
  HIGH = 1,
  NORMAL = 2,
  LOW = 3,
  BACKGROUND = 4,
}

/** 批处理类型 */
export type BatchType = "read" | "grep" | "glob" | "semantic_read" | "none"

/** 批处理配置 */
export interface BatchConfig {
  type: BatchType
  minBatchSize: number
  maxBatchSize: number
  priority: number
}

/** 批处理组 */
export interface BatchGroup {
  type: BatchType
  executors: ToolExecutor[]
  key: string
}

/** 批处理结果 */
export interface BatchResult {
  success: boolean
  results: Map<string, unknown>
  errors: Map<string, Error>
}

/** 缓存配置 */
export interface CacheConfig {
  maxSize: number
  maxMemoryMB: number
  defaultTTL: number
  cleanupInterval: number
}

/** 缓存统计 */
export interface CacheStats {
  hits: number
  misses: number
  evictions: number
  size: number
  memoryUsage: number
}

/** 工具并发配置 */
export interface ToolConcurrencyConfig {
  maxConcurrent: number
  priority: TaskPriority
  timeout: number
  retryable: boolean
  maxRetries: number
}

/** 并发控制器统计 */
export interface ControllerStats {
  activeCount: number
  queuedCount: number
  completedCount: number
  failedCount: number
  avgWaitTime: number
  avgExecutionTime: number
}

/** 调用历史记录 */
export interface CallHistory {
  toolName: string
  input: Record<string, unknown>
  timestamp: number
  sessionID: string
}

/** 调用模式 */
export interface CallPattern {
  sequence: string[]
  frequency: number
  avgTimeGap: number
  lastSeen: number
}

/** 预测结果 */
export interface Prediction {
  toolName: string
  confidence: number
  suggestedInput?: Record<string, unknown>
  reason: string
}

/** 性能指标 */
export interface PerformanceMetrics {
  toolName: string
  callCount: number
  totalDuration: number
  avgDuration: number
  minDuration: number
  maxDuration: number
  cacheHitRate: number
  errorRate: number
}

/** 会话性能报告 */
export interface SessionPerformanceReport {
  sessionID: string
  totalCalls: number
  totalDuration: number
  avgCallDuration: number
  toolBreakdown: PerformanceMetrics[]
  bottlenecks: string[]
  recommendations: string[]
}

/** 工具执行输入 */
export interface ToolInput {
  [key: string]: unknown
  filePath?: string
  path?: string
  offset?: number
  limit?: number
}

/** 工具执行结果 */
export interface ToolExecutionOutput {
  output: string
  title: string
  metadata: Record<string, unknown>
  attachments?: unknown[]
}
