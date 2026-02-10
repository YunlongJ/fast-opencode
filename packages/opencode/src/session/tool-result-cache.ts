import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"

export namespace ToolResultCache {
  const log = Log.create({ service: "tool.result-cache" })

  interface CachedResult {
    tool: string
    input: Record<string, any>
    output: string
    title: string
    metadata: Record<string, any>
    attachments: MessageV2.FilePart[]
    timestamp: number
  }

  const sessionCache = new Map<string, Map<string, CachedResult>>()
  const sessionSignatureCache = new Map<string, Map<string, string>>()

  const MAX_CACHE_SIZE = 100
  const MAX_CACHE_AGE = 3600000

  function getSessionCache(sessionID: string): Map<string, CachedResult> {
    if (!sessionCache.has(sessionID)) {
      sessionCache.set(sessionID, new Map())
    }
    return sessionCache.get(sessionID)!
  }

  function getSessionSignatureCache(sessionID: string): Map<string, string> {
    if (!sessionSignatureCache.has(sessionID)) {
      sessionSignatureCache.set(sessionID, new Map())
    }
    return sessionSignatureCache.get(sessionID)!
  }

  function stableStringify(value: unknown): string {
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

  function signature(tool: string, input: Record<string, any>): string {
    return `${tool}:${stableStringify(input)}`
  }

  function cleanup(sessionID: string): void {
    const cache = getSessionCache(sessionID)
    const sigCache = getSessionSignatureCache(sessionID)
    const now = Date.now()

    const expiredKeys: string[] = []
    for (const [key, value] of cache.entries()) {
      if (now - value.timestamp > MAX_CACHE_AGE) {
        expiredKeys.push(key)
      }
    }

    for (const key of expiredKeys) {
      cache.delete(key)
    }
    if (expiredKeys.length > 0) {
      for (const [sig, callID] of sigCache.entries()) {
        if (expiredKeys.includes(callID)) {
          sigCache.delete(sig)
        }
      }
    }

    if (cache.size > MAX_CACHE_SIZE) {
      const entries = Array.from(cache.entries())
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
      const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE)
      for (const [key] of toRemove) {
        cache.delete(key)
      }
      if (toRemove.length > 0) {
        const removed = new Set(toRemove.map(([k]) => k))
        for (const [sig, callID] of sigCache.entries()) {
          if (removed.has(callID)) {
            sigCache.delete(sig)
          }
        }
      }
    }
  }

  export function set(input: {
    sessionID: string
    callID: string
    tool: string
    input: Record<string, any>
    output: string
    title: string
    metadata: Record<string, any>
    attachments?: MessageV2.FilePart[]
  }): void {
    const cache = getSessionCache(input.sessionID)
    const sigCache = getSessionSignatureCache(input.sessionID)
    cleanup(input.sessionID)

    cache.set(input.callID, {
      tool: input.tool,
      input: input.input,
      output: input.output,
      title: input.title,
      metadata: input.metadata,
      attachments: input.attachments ?? [],
      timestamp: Date.now(),
    })
    sigCache.set(signature(input.tool, input.input), input.callID)

    log.debug("cached tool result", {
      sessionID: input.sessionID,
      callID: input.callID,
      tool: input.tool,
    })
  }

  export function get(sessionID: string, callID: string): CachedResult | undefined {
    const cache = getSessionCache(sessionID)
    return cache.get(callID)
  }

  export function getBySignature(
    sessionID: string,
    tool: string,
    input: Record<string, any>,
  ): CachedResult | undefined {
    const sigCache = getSessionSignatureCache(sessionID)
    const callID = sigCache.get(signature(tool, input))
    if (!callID) return undefined
    return get(sessionID, callID)
  }

  export function getMultiple(sessionID: string, callIDs: string[]): Map<string, CachedResult> {
    const cache = getSessionCache(sessionID)
    const results = new Map<string, CachedResult>()

    for (const id of callIDs) {
      const result = cache.get(id)
      if (result) {
        results.set(id, result)
      }
    }

    return results
  }

  export function getAllForSession(sessionID: string): Map<string, CachedResult> {
    return getSessionCache(sessionID)
  }

  export function has(sessionID: string, callID: string): boolean {
    const cache = getSessionCache(sessionID)
    return cache.has(callID)
  }

  export function delete_(sessionID: string, callID: string): boolean {
    const cache = getSessionCache(sessionID)
    return cache.delete(callID)
  }

  export function clear(sessionID: string): void {
    sessionCache.delete(sessionID)
    log.debug("cleared tool result cache", { sessionID })
  }

  export function clearAll(): void {
    sessionCache.clear()
    log.debug("cleared all tool result caches")
  }

  export function getStats(sessionID: string): {
    size: number
    oldestTimestamp: number | null
    newestTimestamp: number | null
  } {
    const cache = getSessionCache(sessionID)
    if (cache.size === 0) {
      return { size: 0, oldestTimestamp: null, newestTimestamp: null }
    }

    let oldest = Infinity
    let newest = -Infinity

    for (const value of cache.values()) {
      if (value.timestamp < oldest) oldest = value.timestamp
      if (value.timestamp > newest) newest = value.timestamp
    }

    return {
      size: cache.size,
      oldestTimestamp: oldest === Infinity ? null : oldest,
      newestTimestamp: newest === -Infinity ? null : newest,
    }
  }
}
