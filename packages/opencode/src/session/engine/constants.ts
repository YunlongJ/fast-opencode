/**
 * @fileoverview 工具优化模块共享常量
 * @responsibility 统一管理常量，避免魔法数字
 */

/** 缓存默认配置 */
export const CACHE_DEFAULTS = {
  MAX_SIZE: 1000,
  MAX_MEMORY_MB: 100,
  DEFAULT_TTL: 3600000, // 1小时
  CLEANUP_INTERVAL: 60000, // 1分钟
} as const

/** 批处理默认配置 */
export const BATCH_DEFAULTS = {
  READ_MIN: 2,
  READ_MAX: 100,
  GREP_MIN: 2,
  GREP_MAX: 20,
  GLOB_MIN: 2,
  GLOB_MAX: 10,
  SEMANTIC_READ_MIN: 2,
  SEMANTIC_READ_MAX: 50,
} as const

/** 并发控制默认配置 */
export const CONCURRENCY_DEFAULTS = {
  BASE_LIMIT: 50,
  ADJUSTMENT_INTERVAL: 5000, // 5秒
  MEMORY_THRESHOLD: 0.8, // 80%
  CPU_THRESHOLD: 0.9, // 90%
} as const

/** 工具超时配置（毫秒） */
export const TOOL_TIMEOUTS = {
  READ: 30000,
  READ_MULTIPLE: 60000,
  GREP: 30000,
  GLOB: 30000,
  EDIT: 30000,
  WRITE: 30000,
  BASH: 120000,
  APPLY_PATCH: 30000,
  DEFAULT: 60000,
} as const

/** 工具并发限制 */
export const TOOL_CONCURRENCY = {
  READ: 50,
  READ_MULTIPLE: 20,
  GREP: 10,
  GLOB: 5,
  EDIT: 10,
  WRITE: 10,
  BASH: 5,
  APPLY_PATCH: 5,
  DEFAULT: 10,
} as const

/** 重试配置 */
export const RETRY_CONFIG = {
  MAX_RETRIES: 2,
  READ_RETRIES: 2,
  GREP_RETRIES: 1,
  GLOB_RETRIES: 1,
  EDIT_RETRIES: 0,
  BASH_RETRIES: 0,
} as const

/** 预测配置 */
export const PREDICTION_CONFIG = {
  MAX_HISTORY: 1000,
  PATTERN_WINDOW: 5,
  PATTERN_EXPIRY: 86400000, // 24小时
  MAX_PREDICTIONS: 5,
} as const

/** 性能监控配置 */
export const MONITORING_CONFIG = {
  SLOW_TOOL_THRESHOLD: 5000, // 5秒
  HIGH_ERROR_RATE: 0.1, // 10%
  LOW_CACHE_HIT_RATE: 0.3, // 30%
} as const

/** 注册表缓存配置 */
export const REGISTRY_CONFIG = {
  CACHE_TTL: 300000, // 5分钟
} as const
