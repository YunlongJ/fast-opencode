import { Log } from "../util/log"
import path from "path"
import { Global } from "../global"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"

// Import LanceDB for vector storage capabilities
import type { Table, Connection } from "@lancedb/lancedb"
import { LRUCache } from "lru-cache"

export namespace Storage {
  const log = Log.create({ service: "storage" })

  type Migration = (dir: string) => Promise<void>

  // Define the schema for LanceDB records
  interface LanceDBRecord {
    id: string
    key: string // The storage key path joined with '/', e.g. "session/user/message123"
    value: string // JSON string of the stored value
    vector?: number[] // Optional vector embedding for similarity search
    createdAt: number
    updatedAt: number
  }

  // Internal LanceDB manager
  class LanceDBManager {
    private static instance: LanceDBManager | null = null
    private db: any | null = null
    private table: any | null = null
    private lancedbModule: any = null
    private initialized = false
    private initializingPromise: Promise<void> | null = null

    private constructor() {}

    public static getInstance(): LanceDBManager {
      if (!LanceDBManager.instance) {
        LanceDBManager.instance = new LanceDBManager()
      }
      return LanceDBManager.instance
    }

    async init(): Promise<void> {
      if (this.initialized) return

      // Prevent concurrent initialization
      if (this.initializingPromise) {
        await this.initializingPromise
        return
      }

      this.initializingPromise = this.performInit()
      await this.initializingPromise
    }

    private async performInit(): Promise<void> {
      try {
        log.info("Starting LanceDB initialization", { dataPath: Global.Path.data })
        const lancedb = await import("@lancedb/lancedb")
        this.lancedbModule = lancedb
        log.info("LanceDB module imported successfully")

        const dbPath = path.join(Global.Path.data, "storage.lance")
        log.info("Connecting to LanceDB", { dbPath })

        this.db = await lancedb.connect(dbPath)
        log.info("LanceDB connection established")

        // Create or open the main storage table
        let tableExists = true
        try {
          log.info("Attempting to open existing table")
          this.table = await this.db.openTable("storage")
          log.info("Opened existing table")
        } catch (e) {
          log.info("Table doesn't exist, creating new one", { error: (e as Error).message })
          tableExists = false
        }

        if (!tableExists) {
          // Create table with initial data - LanceDB will infer schema from data
          // Include vector field with actual data so it can be inferred
          const initialData = [
            {
              id: "init",
              key: "init",
              value: JSON.stringify({}),
              createdAt: Date.now(),
              updatedAt: Date.now(),
              vector: new Float32Array(1536), // 1536-dim zero vector for schema inference
            },
          ]

          this.table = await this.db.createTable("storage", initialData)
          log.info("Created new table with inferred schema")
        }

        // Create indexes for frequently queried fields
        await this.createIndexes()

        this.initialized = true
        log.info("LanceDB initialized successfully", { path: dbPath })
      } catch (error) {
        log.error("Failed to initialize LanceDB", {
          error,
          stack: (error as Error).stack,
          message: (error as Error).message,
        })
        // Don't mark as initialized so it will retry on next call
        this.initialized = false
        throw error // Re-throw to propagate the error
      } finally {
        this.initializingPromise = null
      }
    }

    private async createIndexes(): Promise<void> {
      if (!this.table || !this.db || !this.lancedbModule) return

      try {
        // Create index on 'key' field for efficient WHERE queries
        log.info("Creating index on 'key' field")
        await this.table.createIndex("key", { config: this.lancedbModule.indexText() })

        // Create index on 'createdAt' field for sorting
        log.info("Creating index on 'createdAt' field")
        await this.table.createIndex("createdAt")

        // Create index on 'updatedAt' field for sorting
        log.info("Creating index on 'updatedAt' field")
        await this.table.createIndex("updatedAt")

        log.info("All indexes created successfully")
      } catch (error) {
        // Index might already exist, which is fine
        log.info("Index creation info", { error: (error as Error).message })
      }
    }

    async getTable(): Promise<any> {
      if (!this.initialized) {
        await this.init()
        if (!this.table) {
          throw new Error("LanceDB is not available after initialization attempt")
        }
      }
      if (!this.table) {
        throw new Error("LanceDB table is not available")
      }
      return this.table
    }

    isAvailable(): boolean {
      return this.initialized && this.table !== null
    }
  }

  // Helper to convert key array to string
  function keyToString(key: string[]): string {
    return key.join("/")
  }

  // Vector-related functions
  export async function writeWithVector<T>(key: string[], content: T, vector: number[]): Promise<void> {
    const table = await LanceDBManager.getInstance().getTable()
    const keyStr = keyToString(key)
    const value = JSON.stringify(content)
    const now = Date.now()

    // 清除读缓存
    readCache.delete(keyStr)

    try {
      // First, try to delete existing record if it exists
      await table.delete(`key = '${keyStr}'`)
    } catch (error) {
      // It's OK if the record doesn't exist to delete
    }

    // Insert the new record with vector
    const record: LanceDBRecord = {
      id: generateId(keyStr, now),
      key: keyStr,
      value,
      vector,
      createdAt: now,
      updatedAt: now,
    }

    await table.add([record])
  }

  export async function searchByVector(
    queryVector: number[],
    limit: number = 10,
  ): Promise<Array<{ key: string[]; value: any; score: number }>> {
    const table = await LanceDBManager.getInstance().getTable()

    try {
      // Perform vector search
      const results = await table.query().nearestTo(queryVector).limit(limit).toArray()

      return results.map((r: any) => ({
        key: stringToKey(r.key),
        value: JSON.parse(r.value),
        score: r._distance || 0, // Distance metric from LanceDB
      }))
    } catch (error) {
      log.error("Vector search failed", { error })
      return []
    }
  }

  // Helper to generate ID
  function generateId(key: string, timestamp: number): string {
    return `${key}_${timestamp}`
  }

  // Helper to convert string key back to array
  function stringToKey(keyStr: string): string[] {
    return keyStr.split("/")
  }

  // Search functionality - placeholder for future implementation
  // This would integrate with the vector search capabilities
  export async function search<T = any>(
    prefix: string[],
    query?: string,
    options?: { limit?: number },
  ): Promise<Array<{ key: string[]; value: T; score?: number }>> {
    // This is a basic implementation that lists items under a prefix
    // Actual vector-based search is done through searchByVector
    const keys = await list(prefix)
    const results = []

    for (const key of keys) {
      try {
        const value = await read<T>(key)
        if (value !== undefined) {
          // For now, return all items under the prefix
          // In a real implementation, this would involve semantic matching
          results.push({ key, value })
        }
      } catch (e) {
        // Skip unreadable entries
        continue
      }
    }

    // Sort by key and apply limit if specified
    results.sort((a, b) => a.key.join("/").localeCompare(b.key.join("/")))

    if (options?.limit) {
      return results.slice(0, options.limit)
    }

    return results
  }

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  // Migrations and legacy file system state management removed - using pure LanceDB storage

  // ============================================
  // 读缓存层：防止缓存穿透 + LRU 淘汰
  // ============================================
  interface CacheEntry<T> {
    value: T
    isNull: boolean // 标记 null/undefined，用于缓存穿透防护
    expire: number
  }

  class ReadCache {
    private cache = new LRUCache<string, CacheEntry<any>>({
      max: 500, // 最多缓存 500 个 key
      ttl: 60 * 1000, // 默认 60s 过期
    })

    private readonly NULL_CACHE_TTL = 30 * 1000 // 空值缓存 30s（较短）

    get<T>(key: string): T | undefined {
      const entry = this.cache.get(key)
      if (!entry) return undefined

      if (entry.expire < Date.now()) {
        this.cache.delete(key)
        return undefined
      }

      // 如果是空值缓存，返回 undefined 表示不存在
      if (entry.isNull) return undefined as any
      return entry.value
    }

    set<T>(key: string, value: T | null, isNull: boolean = false): void {
      const ttl = isNull ? this.NULL_CACHE_TTL : this.cache.ttl
      this.cache.set(key, {
        value,
        isNull,
        expire: Date.now() + ttl,
      })
    }

    delete(key: string): void {
      this.cache.delete(key)
    }

    clear(): void {
      this.cache.clear()
    }
  }

  const readCache = new ReadCache()

  export async function remove(key: string[]) {
    const keyStr = keyToString(key)

    // 清除读缓存
    readCache.delete(keyStr)

    const table = await LanceDBManager.getInstance().getTable()

    try {
      await table.delete(`key = '${keyStr}'`)
    } catch (error) {
      log.error("Failed to remove from LanceDB storage", { key: keyStr, error })
      throw error
    }
  }

  export async function read<T>(key: string[]) {
    const keyStr = keyToString(key)

    // 0. 先检查读缓存（LRU + 防穿透）
    const cached = readCache.get<T>(keyStr)
    if (cached !== undefined) {
      return cached
    }

    // 1. 从 LanceDB 读取
    const table = await LanceDBManager.getInstance().getTable()

    try {
      const result = await table.query().where(`key = '${keyStr}'`).select(["value"]).toArray()

      if (result.length === 0) {
        // 缓存空值，防止缓存穿透
        readCache.set(keyStr, null, true)
        throw new NotFoundError({ message: `Resource not found: ${keyStr}` })
      }

      const value = JSON.parse(result[0].value) as T
      readCache.set(keyStr, value) // 缓存结果
      return value
    } catch (error) {
      if ((error as Error).message.includes("not found") || (error as Error).message.includes("Resource not found")) {
        throw new NotFoundError({ message: `Resource not found: ${keyStr}` })
      }
      log.error("Failed to read from LanceDB storage", { key: keyStr, error })
      throw error
    }
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    // Read the current value (read will throw NotFoundError if not found)
    const currentValue = await read<T>(key)

    // Apply the update function
    fn(currentValue)

    // Write the updated value back
    await write(key, currentValue)
    return currentValue
  }

    export async function write<T>(key: string[], content: T) {
    const keyStr = keyToString(key)
    const value = JSON.stringify(content)

    // 清除读缓存
    readCache.delete(keyStr)

    // 直接写入 LanceDB
    const table = await LanceDBManager.getInstance().getTable()
    const now = Date.now()
    try {
      await table.delete(`key = '${keyStr}'`)
    } catch (e) {
      /* ignore */
    }
    await table.add([{
      id: generateId(keyStr, now),
      key: keyStr,
      value,
      createdAt: now,
      updatedAt: now,
    }])
  }

  export async function list(prefix: string[]) {
    try {
      const table = await LanceDBManager.getInstance().getTable()
      const prefixStr = keyToString(prefix)

      // Get all records that start with the prefix
      let whereClause
      if (prefixStr === "") {
        // If prefix is empty, return all top-level keys (those that don't contain '/')
        whereClause = "key NOT LIKE '%/%'"
      } else {
        // Get all records that start with the prefix followed by a slash
        whereClause = `key LIKE '${prefixStr}/%'`
      }

      const results = await table.query().where(whereClause).select(["key"]).toArray()

      // Filter to ensure we only get immediate children (one level deeper than prefix)
      const filteredResults = results.filter((r: any) => {
        const keySegments = r.key.split("/")
        const prefixSegments = prefixStr === "" ? [] : prefixStr.split("/")
        // Only include if the key has exactly one more segment than the prefix
        return keySegments.length === prefixSegments.length + 1
      })

      // Convert keys back to string arrays and sort them
      return filteredResults
        .map((r: any) => stringToKey(r.key))
        .sort((a: string[], b: string[]) => a.join("/").localeCompare(b.join("/")))
    } catch (error) {
      log.error("Failed to list from LanceDB storage", { prefix: keyToString(prefix), error })
      return []
    }
  }

  // Semantic Index namespace for vector-based semantic search
  export namespace SemanticIndex {
    const semanticPrefix = ["semantic"]

    /**
     * Index an item with its vector embedding
     */
    export async function indexItem(id: string, title: string, vector: number[]): Promise<void> {
      const content = { id, title }
      await writeWithVector([...semanticPrefix, id], content, vector)
    }

    /**
     * Search for similar items by vector
     */
    export async function search(
      queryVector: number[],
      k: number = 3,
      _minScore: number = 0.5,
    ): Promise<Array<{ id: string; title: string; url: string; score: number }>> {
      const results = await searchByVector(queryVector, k)
      return results.map((r) => ({
        id: r.value.id || "",
        title: r.value.title || "",
        url: "",
        score: 1 - r.score, // Convert distance to similarity score
      }))
    }

    /**
     * Clear all semantic index entries
     */
    export async function clear(): Promise<void> {
      const keys = await list(semanticPrefix)
      for (const key of keys) {
        await remove(key)
      }
    }
  }
}
