/**
 * @fileoverview 工具优化模块共享工具函数
 * @responsibility 提取公共逻辑，减少重复代码
 */

import type { ToolInput } from "./types"

/**
 * 稳定的对象哈希
 * 用于生成缓存键，确保相同输入产生相同哈希
 */
export function stableHash(input: Record<string, unknown>): string {
  const sorted = Object.keys(input)
    .sort()
    .reduce(
      (acc, key) => {
        acc[key] = input[key]
        return acc
      },
      {} as Record<string, unknown>,
    )

  return Bun.hash(JSON.stringify(sorted)).toString(36)
}

/**
 * 稳定的字符串序列化
 * 用于比较对象是否相等
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null"
  const t = typeof value
  if (t === "string") return JSON.stringify(value)
  if (t === "number" || t === "boolean") return String(value)
  if (t !== "object") return JSON.stringify(String(value))
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
}

/**
 * 估算对象大小（字节）
 */
export function estimateSize(value: unknown): number {
  if (value === null || value === undefined) return 0

  const type = typeof value
  switch (type) {
    case "boolean":
      return 4
    case "number":
      return 8
    case "string":
      return (value as string).length * 2
    case "object":
      if (Array.isArray(value)) {
        return value.reduce((sum, item) => sum + estimateSize(item), 0)
      }
      return Object.entries(value).reduce((sum, [k, v]) => sum + k.length * 2 + estimateSize(v), 0)
    default:
      return 0
  }
}

/**
 * 检查是否为文件路径
 */
export function isFilePath(input: unknown): input is string {
  if (typeof input !== "string") return false
  return (
    input.startsWith("/") ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    /^[a-zA-Z]:[\\/]/.test(input) ||
    input.startsWith("\\\\")
  )
}

/**
 * 从输入中提取文件路径
 */
export function extractPathsFromInput(input: Record<string, unknown>): Set<string> {
  const paths = new Set<string>()

  function traverse(obj: unknown, key?: string) {
    if (obj === null || obj === undefined) return

    if (typeof obj === "string") {
      if (isFilePath(obj)) {
        paths.add(key === "path" || key === "file" ? obj : obj)
      }
      return
    }

    if (Array.isArray(obj)) {
      obj.forEach((item) => traverse(item))
      return
    }

    if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        traverse(v, k)
      }
    }
  }

  traverse(input)
  return paths
}

/**
 * 计算缓存键
 */
export function generateCacheKey(sessionID: string, tool: string, input: Record<string, unknown>): string {
  const inputHash = stableHash(input)
  return `${sessionID}:${tool}:${inputHash}`
}

/**
 * 计算命中率
 */
export function calculateHitRate(hits: number, misses: number): number {
  const total = hits + misses
  return total === 0 ? 0 : hits / total
}

/**
 * 延迟执行
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 带超时的 Promise
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage?: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(errorMessage || `Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    }),
  ])
}

/**
 * 获取对象路径值
 */
export function getPathValue(obj: unknown, path: string): unknown {
  return path.split(".").reduce((acc: unknown, part) => {
    if (acc === null || acc === undefined) return undefined
    return (acc as Record<string, unknown>)[part]
  }, obj)
}

/**
 * 批量执行异步任务，限制并发数
 */
export async function batchExecute<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = []
  const executing: Promise<void>[] = []

  for (let i = 0; i < items.length; i++) {
    const promise = fn(items[i]!).then((result) => {
      results[i] = result
    })
    executing.push(promise)

    if (executing.length >= concurrency) {
      await Promise.race(executing)
      executing.splice(
        executing.findIndex((p) => p === promise),
        1,
      )
    }
  }

  await Promise.all(executing)
  return results
}

/**
 * 计算序列匹配长度
 */
export function getMatchLength(seq1: string[], seq2: string[]): number {
  let length = 0
  const minLen = Math.min(seq1.length, seq2.length)
  for (let i = 1; i <= minLen; i++) {
    if (seq1[seq1.length - i] === seq2[seq2.length - i]) {
      length++
    } else {
      break
    }
  }
  return length
}
