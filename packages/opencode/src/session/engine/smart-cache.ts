/**
 * @fileoverview 智能缓存系统 - 多级缓存策略优化
 * @responsibility 提供 L1(内存) 缓存，支持 LRU+LFU 混合策略
 */

import { Log } from "@/util/log"
import type { CacheConfig, CacheStats } from "./types"
import { CACHE_DEFAULTS } from "./constants"
import { estimateSize, generateCacheKey, calculateHitRate } from "./utils"

const log = Log.create({ service: "smart-cache" })

/** 缓存项元数据 */
interface CacheEntry<T> {
  value: T
  timestamp: number
  accessCount: number
  lastAccess: number
  size: number
  ttl: number
}

/**
 * 智能缓存 - 支持 LRU、LFU 混合策略
 */
export class SmartCache<K extends string | number, V> {
  readonly #cache = new Map<K, CacheEntry<V>>()
  readonly #config: CacheConfig
  #stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    size: 0,
    memoryUsage: 0,
  }
  #cleanupTimer?: Timer

  constructor(config: Partial<CacheConfig> = {}) {
    this.#config = {
      maxSize: config.maxSize ?? CACHE_DEFAULTS.MAX_SIZE,
      maxMemoryMB: config.maxMemoryMB ?? CACHE_DEFAULTS.MAX_MEMORY_MB,
      defaultTTL: config.defaultTTL ?? CACHE_DEFAULTS.DEFAULT_TTL,
      cleanupInterval: config.cleanupInterval ?? CACHE_DEFAULTS.CLEANUP_INTERVAL,
    }
    this.#startCleanup()
  }

  /**
   * 获取缓存项
   */
  get(key: K): V | undefined {
    const entry = this.#cache.get(key)

    if (!entry || this.#isExpired(entry)) {
      if (entry) this.#cache.delete(key)
      this.#stats.misses++
      return undefined
    }

    this.#updateAccessStats(entry)
    this.#stats.hits++
    return entry.value
  }

  /**
   * 设置缓存项
   */
  set(key: K, value: V, ttl?: number): void {
    const size = estimateSize(value)
    const maxBytes = this.#config.maxMemoryMB * 1024 * 1024

    if (size > maxBytes) {
      log.warn("Cache item too large, skipping", { key, size })
      return
    }

    this.#makeSpace(size, maxBytes)

    const entry: CacheEntry<V> = {
      value,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccess: Date.now(),
      size,
      ttl: ttl ?? this.#config.defaultTTL,
    }

    this.#cache.set(key, entry)
    this.#updateStats()
  }

  /**
   * 批量获取
   */
  getMany(keys: readonly K[]): Map<K, V> {
    return keys.reduce((result, key) => {
      const value = this.get(key)
      if (value !== undefined) result.set(key, value)
      return result
    }, new Map<K, V>())
  }

  /**
   * 批量设置
   */
  setMany(entries: ReadonlyArray<{ key: K; value: V; ttl?: number }>): void {
    for (const { key, value, ttl } of entries) {
      this.set(key, value, ttl)
    }
  }

  /**
   * 检查是否存在（未过期）
   */
  has(key: K): boolean {
    const entry = this.#cache.get(key)
    if (!entry) return false
    if (this.#isExpired(entry)) {
      this.#cache.delete(key)
      return false
    }
    return true
  }

  /**
   * 删除缓存项
   */
  delete(key: K): boolean {
    const entry = this.#cache.get(key)
    if (!entry) return false

    this.#stats.memoryUsage -= entry.size
    this.#cache.delete(key)
    this.#updateStats()
    return true
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.#cache.clear()
    this.#stats = { hits: 0, misses: 0, evictions: 0, size: 0, memoryUsage: 0 }
  }

  /**
   * 获取统计信息
   */
  getStats(): Readonly<CacheStats> {
    return { ...this.#stats }
  }

  /**
   * 获取命中率
   */
  getHitRate(): number {
    return calculateHitRate(this.#stats.hits, this.#stats.misses)
  }

  /**
   * 销毁缓存，清理定时器
   */
  destroy(): void {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer)
    }
  }

  /** 检查是否过期 */
  #isExpired(entry: CacheEntry<V>): boolean {
    return Date.now() - entry.timestamp > entry.ttl
  }

  /** 更新访问统计 */
  #updateAccessStats(entry: CacheEntry<V>): void {
    entry.accessCount++
    entry.lastAccess = Date.now()
  }

  /** 更新统计信息 */
  #updateStats(): void {
    this.#stats.size = this.#cache.size
  }

  /** 清理空间 */
  #makeSpace(size: number, maxBytes: number): void {
    while (this.#stats.memoryUsage + size > maxBytes) {
      this.#evict()
    }
  }

  /** 淘汰策略 - LRU + LFU 混合 */
  #evict(): void {
    if (this.#cache.size === 0) return

    let candidate: K | undefined
    let minScore = Infinity

    for (const [key, entry] of this.#cache) {
      const timeDecay = (Date.now() - entry.lastAccess) / 1000
      const freqScore = Math.log(entry.accessCount + 1)
      const score = timeDecay / (freqScore + 1)

      if (score < minScore) {
        minScore = score
        candidate = key
      }
    }

    if (candidate !== undefined) {
      const entry = this.#cache.get(candidate)!
      this.#stats.memoryUsage -= entry.size
      this.#cache.delete(candidate)
      this.#stats.evictions++
      this.#updateStats()
    }
  }

  /** 启动定期清理 */
  #startCleanup(): void {
    this.#cleanupTimer = setInterval(() => this.#cleanup(), this.#config.cleanupInterval)
  }

  /** 清理过期项 */
  #cleanup(): void {
    const now = Date.now()
    let cleaned = 0

    for (const [key, entry] of this.#cache) {
      if (now - entry.timestamp > entry.ttl) {
        this.#stats.memoryUsage -= entry.size
        this.#cache.delete(key)
        cleaned++
      }
    }

    if (cleaned > 0) {
      this.#updateStats()
      log.debug("Cache cleanup completed", { cleaned, remaining: this.#cache.size })
    }
  }
}

/**
 * 工具结果缓存 - 专门优化工具调用结果缓存
 */
export class ToolResultSmartCache {
  readonly #cache: SmartCache<string, unknown>

  constructor() {
    this.#cache = new SmartCache({
      maxSize: CACHE_DEFAULTS.MAX_SIZE,
      maxMemoryMB: CACHE_DEFAULTS.MAX_MEMORY_MB,
      defaultTTL: CACHE_DEFAULTS.DEFAULT_TTL,
      cleanupInterval: CACHE_DEFAULTS.CLEANUP_INTERVAL,
    })
  }

  /**
   * 获取缓存结果
   */
  get(sessionID: string, tool: string, input: Record<string, unknown>): unknown | undefined {
    const key = generateCacheKey(sessionID, tool, input)
    return this.#cache.get(key)
  }

  /**
   * 设置缓存结果
   */
  set(sessionID: string, tool: string, input: Record<string, unknown>, result: unknown, ttl?: number): void {
    const key = generateCacheKey(sessionID, tool, input)
    this.#cache.set(key, result, ttl)
  }

  /**
   * 批量获取
   */
  getMany(
    sessionID: string,
    items: ReadonlyArray<{ tool: string; input: Record<string, unknown> }>,
  ): Map<string, unknown> {
    return items.reduce((results, { tool, input }) => {
      const result = this.get(sessionID, tool, input)
      if (result !== undefined) {
        results.set(generateCacheKey(sessionID, tool, input), result)
      }
      return results
    }, new Map<string, unknown>())
  }

  /**
   * 清除会话缓存
   */
  clearSession(sessionID: string): void {
    log.debug("Session cache marked for cleanup", { sessionID })
    // 由于使用组合键，需要遍历清理
    // 注意：这里使用类型断言访问私有字段，实际应用中应该添加一个迭代器方法
    const cacheMap = (this.#cache as unknown as { cache?: Map<string, CacheEntry<unknown>> }).cache
    if (cacheMap) {
      for (const key of cacheMap.keys()) {
        if (key.startsWith(`${sessionID}:`)) {
          this.#cache.delete(key)
        }
      }
    }
  }

  /**
   * 获取缓存统计
   */
  getStats(): Readonly<CacheStats> {
    return this.#cache.getStats()
  }

  /**
   * 获取命中率
   */
  getHitRate(): number {
    return this.#cache.getHitRate()
  }
}

/** 全局工具结果缓存实例 */
export const toolResultSmartCache = new ToolResultSmartCache()
