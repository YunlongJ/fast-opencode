import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { lazy } from "../util/lazy"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import { Database } from "bun:sqlite"
import * as sqliteVec from "sqlite-vec"
import { $ } from "bun"

// ==================== 类型定义 ====================

const NotFoundErrorDef = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const StorageErrorDef = NamedError.create(
  "StorageError",
  z.object({
    message: z.string(),
    cause: z.string().optional(),
  }),
)

export interface VectorDocument {
  id: string
  content: string
  embedding: number[]
  metadata?: Record<string, any>
}

export interface VectorSearchResult {
  id: string
  content: string
  score: number
  metadata?: Record<string, any>
}

export interface CompactionRecord {
  sessionID: string
  messageID: string
  operation: "prune" | "summarize" | "checkpoint"
  originalTokens: number
  compactedTokens: number
  createdAt: number
}

export interface CompactionStats {
  compactionCount: number
  totalTokensSaved: number
  lastCompactedAt: number | null
}

// ==================== 数据库管理 ====================

class StorageDatabase {
  private static instance: StorageDatabase
  private db: Database | null = null
  private log = Log.create({ service: "storage.db" })
  private initialized = false
  private collections = new Set<string>()

  static getInstance(): StorageDatabase {
    if (!this.instance) {
      this.instance = new StorageDatabase()
    }
    return this.instance
  }

  async init(): Promise<Database> {
    if (this.db && this.initialized) return this.db

    const dbPath = path.join(Global.Path.data, "storage", "data.db")
    await fs.mkdir(path.dirname(dbPath), { recursive: true })

    // macOS 可能需要设置自定义 SQLite 路径以支持扩展
    // 尝试常见路径，失败则使用默认
    if (process.platform === "darwin") {
      const possiblePaths = [
        "/usr/local/opt/sqlite3/lib/libsqlite3.dylib",
        "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib",
        "/usr/lib/libsqlite3.dylib",
      ]

      let sqlitePathSet = false
      for (const sqlitePath of possiblePaths) {
        try {
          if (
            await fs
              .access(sqlitePath)
              .then(() => true)
              .catch(() => false)
          ) {
            Database.setCustomSQLite(sqlitePath)
            sqlitePathSet = true
            this.log.info("Using custom SQLite path", { path: sqlitePath })
            break
          }
        } catch {
          // 继续尝试下一个路径
        }
      }

      if (!sqlitePathSet) {
        this.log.warn("Could not find custom SQLite library, using system default. Extension loading may fail.")
      }
    }

    this.db = new Database(dbPath)

    // 启用 WAL 模式提高并发性能
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA foreign_keys = ON")

    // 加载 sqlite-vec 扩展
    sqliteVec.load(this.db)

    // 初始化表结构
    this.createTables()

    // 迁移旧数据
    await this.migrateFromFiles()

    this.initialized = true
    this.log.info("Storage database initialized", { path: dbPath })

    return this.db
  }

  private createTables(): void {
    if (!this.db) throw new Error("Database not initialized")

    // 1. KV 存储表
    this.db.run(`
      CREATE TABLE IF NOT EXISTS storage_kv (
        key_path TEXT PRIMARY KEY,
        json_data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_storage_kv_key ON storage_kv(key_path)
    `)

    // 2. 压缩状态表
    this.db.run(`
      CREATE TABLE IF NOT EXISTS compaction_state (
        session_id TEXT PRIMARY KEY,
        last_compacted_at INTEGER,
        compaction_count INTEGER DEFAULT 0,
        total_tokens_saved INTEGER DEFAULT 0,
        metadata TEXT
      )
    `)

    // 3. 压缩日志表
    this.db.run(`
      CREATE TABLE IF NOT EXISTS compaction_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        original_tokens INTEGER,
        compacted_tokens INTEGER,
        created_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES compaction_state(session_id)
      )
    `)

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_compaction_log_session ON compaction_log(session_id)
    `)

    // 4. 向量集合元数据表
    this.db.run(`
      CREATE TABLE IF NOT EXISTS vec_collections (
        name TEXT PRIMARY KEY,
        dimension INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
  }

  private async migrateFromFiles(): Promise<void> {
    const migrationFile = path.join(Global.Path.data, "storage", "migration")
    const currentVersion = await Bun.file(migrationFile)
      .text()
      .then((x) => parseInt(x))
      .catch(() => 0)

    // 版本 1: 从 JSON 文件迁移到 SQLite
    if (currentVersion < 1) {
      await this.migrateJsonFiles()
      await Bun.write(migrationFile, "1")
    }
  }

  private async migrateJsonFiles(): Promise<void> {
    const oldDir = path.join(Global.Path.data, "storage")

    // 运行旧的 migrations（如果有）
    await this.runLegacyMigrations(oldDir)

    // 扫描并迁移所有 JSON 文件
    const glob = new Bun.Glob("**/*.json")

    try {
      for await (const file of glob.scan({
        cwd: oldDir,
        onlyFiles: true,
      })) {
        if (file === "migration" || file === "data.db") continue

        const filePath = path.join(oldDir, file)
        const keyPath = file.replace(/\.json$/, "").split(path.sep)

        try {
          const content = await Bun.file(filePath).json()
          this.insertKV(keyPath.join("/"), content)
          this.log.debug("Migrated file to SQLite", { file, keyPath })

          // 可选：删除已迁移的文件
          await fs.unlink(filePath).catch(() => {})
        } catch (e) {
          this.log.error("Failed to migrate file", { file, error: e })
        }
      }
    } catch {
      // 目录可能不存在
    }
  }

  private async runLegacyMigrations(dir: string): Promise<void> {
    // 保留原有的 migrations 逻辑
    type Migration = (dir: string) => Promise<void>

    const migrations: Migration[] = [
      async (dir) => {
        const project = path.resolve(dir, "../project")
        if (!(await Filesystem.isDir(project))) return
        for await (const projectDir of new Bun.Glob("*").scan({
          cwd: project,
          onlyFiles: false,
        })) {
          this.log.info(`migrating project ${projectDir}`)
          let projectID = projectDir
          const fullProjectDir = path.join(project, projectDir)
          let worktree = "/"

          if (projectID !== "global") {
            for await (const msgFile of new Bun.Glob("storage/session/message/*/*.json").scan({
              cwd: path.join(project, projectDir),
              absolute: true,
            })) {
              const json = await Bun.file(msgFile).json()
              worktree = json.path?.root
              if (worktree) break
            }
            if (!worktree) return
            if (!(await Filesystem.isDir(worktree))) return
            const [id] = await $`git rev-list --max-parents=0 --all`
              .quiet()
              .nothrow()
              .cwd(worktree)
              .text()
              .then((x) =>
                x
                  .split("\n")
                  .filter(Boolean)
                  .map((x) => x.trim())
                  .toSorted(),
              )
            if (!id) return
            projectID = id

            await this.insertKV(`project/${projectID}`, {
              id,
              vcs: "git",
              worktree,
              time: {
                created: Date.now(),
                initialized: Date.now(),
              },
            })

            this.log.info(`migrating sessions for project ${projectID}`)
            for await (const sessionFile of new Bun.Glob("storage/session/info/*.json").scan({
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const session = await Bun.file(sessionFile).json()
              await this.insertKV(`session/${projectID}/${path.basename(sessionFile, ".json")}`, session)

              this.log.info(`migrating messages for session ${session.id}`)
              for await (const msgFile of new Bun.Glob(`storage/session/message/${session.id}/*.json`).scan({
                cwd: fullProjectDir,
                absolute: true,
              })) {
                const message = await Bun.file(msgFile).json()
                await this.insertKV(`message/${session.id}/${path.basename(msgFile, ".json")}`, message)

                this.log.info(`migrating parts for message ${message.id}`)
                for await (const partFile of new Bun.Glob(
                  `storage/session/part/${session.id}/${message.id}/*.json`,
                ).scan({
                  cwd: fullProjectDir,
                  absolute: true,
                })) {
                  const part = await Bun.file(partFile).json()
                  await this.insertKV(`part/${message.id}/${path.basename(partFile, ".json")}`, part)
                }
              }
            }
          }
        }
      },
      async (dir) => {
        for await (const item of new Bun.Glob("session/*/*.json").scan({
          cwd: dir,
          absolute: true,
        })) {
          const session = await Bun.file(item).json()
          if (!session.projectID) continue
          if (!session.summary?.diffs) continue
          const { diffs } = session.summary
          await this.insertKV(`session_diff/${session.id}`, diffs)
          await this.insertKV(`session/${session.projectID}/${session.id}`, {
            ...session,
            summary: {
              additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
              deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
            },
          })
        }
      },
    ]

    const migrationVersion = await Bun.file(path.join(dir, "migration"))
      .json()
      .then((x) => parseInt(x))
      .catch(() => 0)

    for (let index = migrationVersion; index < migrations.length; index++) {
      this.log.info("running legacy migration", { index })
      const migration = migrations[index]
      await migration(dir).catch(() => this.log.error("failed to run migration", { index }))
    }
  }

  private insertKV(keyPath: string, data: any): void {
    if (!this.db) throw new Error("Database not initialized")

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO storage_kv (key_path, json_data, updated_at)
      VALUES (?, ?, ?)
    `)
    stmt.run(keyPath, JSON.stringify(data), Date.now())
  }

  getDB(): Database {
    if (!this.db) throw new Error("Database not initialized")
    return this.db
  }

  hasCollection(name: string): boolean {
    return this.collections.has(name)
  }

  addCollection(name: string): void {
    this.collections.add(name)
  }
}

// ==================== 主 Storage 命名空间 ====================

export namespace Storage {
  const log = Log.create({ service: "storage" })
  const dbManager = StorageDatabase.getInstance()

  // 导出 NotFoundError
  export const NotFoundError = NotFoundErrorDef

  // 导出 StorageError
  export const StorageError = StorageErrorDef

  // ============ KV 存储 API（原有接口） ============

  export async function read<T>(key: string[], schema?: z.ZodType<T>): Promise<T> {
    const db = await dbManager.init()
    const keyPath = key.join("/")

    const stmt = db.prepare("SELECT json_data FROM storage_kv WHERE key_path = ?")
    const result = stmt.get(keyPath) as { json_data: string } | undefined

    if (!result) {
      throw new NotFoundError({ message: `Resource not found: ${keyPath}` })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(result.json_data)
    } catch (e) {
      throw new StorageErrorDef({
        message: `Invalid JSON data at key: ${keyPath}`,
        cause: e instanceof Error ? e.message : String(e),
      })
    }

    // 如果提供了 schema，进行运行时验证
    if (schema) {
      const validation = schema.safeParse(parsed)
      if (!validation.success) {
        throw new StorageErrorDef({
          message: `Data validation failed at key: ${keyPath}`,
          cause: validation.error.message,
        })
      }
      return validation.data
    }

    return parsed as T
  }

  export async function write<T>(key: string[], content: T): Promise<void> {
    const db = await dbManager.init()
    const keyPath = key.join("/")

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO storage_kv (key_path, json_data, updated_at)
      VALUES (?, ?, ?)
    `)
    stmt.run(keyPath, JSON.stringify(content), Date.now())
  }

  export async function update<T>(key: string[], fn: (draft: T) => void, schema?: z.ZodType<T>): Promise<T> {
    const db = await dbManager.init()
    const keyPath = key.join("/")

    // 读取现有数据
    const readStmt = db.prepare("SELECT json_data FROM storage_kv WHERE key_path = ?")
    const result = readStmt.get(keyPath) as { json_data: string } | undefined

    if (!result) {
      throw new NotFoundError({ message: `Resource not found: ${keyPath}` })
    }

    let content: T
    try {
      content = JSON.parse(result.json_data)
    } catch (e) {
      throw new StorageErrorDef({
        message: `Invalid JSON data at key: ${keyPath}`,
        cause: e instanceof Error ? e.message : String(e),
      })
    }

    // 如果提供了 schema，进行运行时验证
    if (schema) {
      const validation = schema.safeParse(content)
      if (!validation.success) {
        throw new StorageErrorDef({
          message: `Data validation failed at key: ${keyPath}`,
          cause: validation.error.message,
        })
      }
      content = validation.data
    }

    fn(content)

    // 写回更新后的数据
    const writeStmt = db.prepare(`
      INSERT OR REPLACE INTO storage_kv (key_path, json_data, updated_at)
      VALUES (?, ?, ?)
    `)
    writeStmt.run(keyPath, JSON.stringify(content), Date.now())

    return content
  }

  export async function remove(key: string[]): Promise<void> {
    const db = await dbManager.init()
    const keyPath = key.join("/")

    const stmt = db.prepare("DELETE FROM storage_kv WHERE key_path = ?")
    stmt.run(keyPath)
  }

  export async function list(prefix: string[]): Promise<string[][]> {
    const db = await dbManager.init()
    const prefixPath = prefix.join("/") + "/"

    const stmt = db.prepare("SELECT key_path FROM storage_kv WHERE key_path LIKE ?")
    const results = stmt.all(`${prefixPath}%`) as Array<{ key_path: string }>

    return results.map((r) => r.key_path.split("/")).sort()
  }

  /**
   * 批量读取多个 key
   * 性能优于多次调用 read()，使用单个 SQL 查询
   */
  export async function readMany<T>(
    keys: string[][],
    schema?: z.ZodType<T>,
  ): Promise<Array<{ key: string[]; data: T | null; error?: Error }>> {
    const db = await dbManager.init()

    if (keys.length === 0) return []

    // 构建 IN 子句
    const keyPaths = keys.map((k) => k.join("/"))
    const placeholders = keyPaths.map(() => "?").join(",")

    const stmt = db.prepare(`
      SELECT key_path, json_data FROM storage_kv 
      WHERE key_path IN (${placeholders})
    `)

    const results = stmt.all(...keyPaths) as Array<{ key_path: string; json_data: string }>
    const resultMap = new Map(results.map((r) => [r.key_path, r.json_data]))

    return keys.map((key) => {
      const keyPath = key.join("/")
      const jsonData = resultMap.get(keyPath)

      if (!jsonData) {
        return { key, data: null, error: new NotFoundError({ message: `Resource not found: ${keyPath}` }) }
      }

      try {
        const parsed = JSON.parse(jsonData)

        if (schema) {
          const validation = schema.safeParse(parsed)
          if (!validation.success) {
            return {
              key,
              data: null,
              error: new StorageErrorDef({
                message: `Data validation failed at key: ${keyPath}`,
                cause: validation.error.message,
              }),
            }
          }
          return { key, data: validation.data }
        }

        return { key, data: parsed as T }
      } catch (e) {
        return {
          key,
          data: null,
          error: new StorageErrorDef({
            message: `Invalid JSON data at key: ${keyPath}`,
            cause: e instanceof Error ? e.message : String(e),
          }),
        }
      }
    })
  }

  /**
   * 带前缀的批量读取
   * 一次性读取所有匹配前缀的数据
   */
  export async function readByPrefix<T>(
    prefix: string[],
    schema?: z.ZodType<T>,
  ): Promise<Array<{ key: string[]; data: T }>> {
    const db = await dbManager.init()
    const prefixPath = prefix.join("/") + "/"

    const stmt = db.prepare(`
      SELECT key_path, json_data FROM storage_kv 
      WHERE key_path LIKE ?
    `)

    const results = stmt.all(`${prefixPath}%`) as Array<{ key_path: string; json_data: string }>

    const validResults: Array<{ key: string[]; data: T }> = []

    for (const result of results) {
      try {
        const parsed = JSON.parse(result.json_data)

        if (schema) {
          const validation = schema.safeParse(parsed)
          if (validation.success) {
            validResults.push({
              key: result.key_path.split("/"),
              data: validation.data,
            })
          }
        } else {
          validResults.push({
            key: result.key_path.split("/"),
            data: parsed as T,
          })
        }
      } catch {
        // 跳过解析失败的数据
      }
    }

    return validResults
  }

  // ============ 向量存储 API ============

  export namespace Vector {
    async function ensureDB(): Promise<Database> {
      return dbManager.init()
    }

    export async function createCollection(name: string, dimension: number = 384): Promise<void> {
      const db = await ensureDB()

      if (dbManager.hasCollection(name)) return

      // 创建虚拟表
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_${name} USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[${dimension}],
          content TEXT,
          metadata JSON
        )
      `)

      // 记录集合元数据
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO vec_collections (name, dimension, created_at)
        VALUES (?, ?, ?)
      `)
      stmt.run(name, dimension, Date.now())

      dbManager.addCollection(name)
      log.info("Created vector collection", { name, dimension })
    }

    export async function upsert(collection: string, doc: VectorDocument): Promise<void> {
      await createCollection(collection, doc.embedding.length)
      const db = await ensureDB()

      const tableName = `vec_${collection}`

      // 检查是否已存在
      const checkStmt = db.prepare(`SELECT id FROM ${tableName} WHERE id = ?`)
      const existing = checkStmt.get(doc.id)

      if (existing) {
        // 删除旧记录
        const deleteStmt = db.prepare(`DELETE FROM ${tableName} WHERE id = ?`)
        deleteStmt.run(doc.id)
      }

      // 插入新记录
      const insertStmt = db.prepare(`
        INSERT INTO ${tableName} (id, embedding, content, metadata)
        VALUES (?, ?, ?, ?)
      `)

      const embeddingBuffer = new Float32Array(doc.embedding)
      insertStmt.run(doc.id, embeddingBuffer, doc.content, JSON.stringify(doc.metadata || {}))
    }

    export async function remove(collection: string, id: string): Promise<void> {
      const db = await ensureDB()
      const tableName = `vec_${collection}`

      const stmt = db.prepare(`DELETE FROM ${tableName} WHERE id = ?`)
      stmt.run(id)
    }

    export async function search(
      collection: string,
      queryEmbedding: number[],
      options: { limit?: number; minScore?: number } = {},
    ): Promise<VectorSearchResult[]> {
      const { limit = 10, minScore = 0.25 } = options
      const db = await ensureDB()

      if (!dbManager.hasCollection(collection)) {
        return []
      }

      const tableName = `vec_${collection}`
      const queryVec = new Float32Array(queryEmbedding)

      // 使用 sqlite-vec 的向量搜索
      const stmt = db.prepare(`
        SELECT id, content, metadata, distance
        FROM ${tableName}
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `)

      const results = stmt.all(queryVec, limit) as Array<{
        id: string
        content: string
        metadata: string
        distance: number
      }>

      return results
        .map((r) => ({
          id: r.id,
          content: r.content,
          score: 1 - r.distance, // 转换距离为相似度分数
          metadata: JSON.parse(r.metadata || "{}"),
        }))
        .filter((r) => r.score >= minScore)
    }

    export async function searchByContent(
      collection: string,
      query: string,
      options: { limit?: number } = {},
    ): Promise<VectorSearchResult[]> {
      const { limit = 10 } = options
      const db = await ensureDB()

      if (!dbManager.hasCollection(collection)) {
        return []
      }

      const tableName = `vec_${collection}`

      // 简单的 LIKE 搜索
      const stmt = db.prepare(`
        SELECT id, content, metadata, 1.0 as score
        FROM ${tableName}
        WHERE content LIKE ?
        LIMIT ?
      `)

      const results = stmt.all(`%${query}%`, limit) as Array<{
        id: string
        content: string
        metadata: string
        score: number
      }>

      return results.map((r) => ({
        id: r.id,
        content: r.content,
        score: r.score,
        metadata: JSON.parse(r.metadata || "{}"),
      }))
    }
  }

  // ============ 压缩状态 API ============

  export namespace Compaction {
    async function ensureDB(): Promise<Database> {
      return dbManager.init()
    }

    export async function recordCompaction(input: {
      sessionID: string
      messageID: string
      operation: "prune" | "summarize" | "checkpoint"
      originalTokens: number
      compactedTokens: number
    }): Promise<void> {
      const db = await ensureDB()
      const now = Date.now()
      const savedTokens = input.originalTokens - input.compactedTokens

      // 插入日志
      const logStmt = db.prepare(`
        INSERT INTO compaction_log (session_id, message_id, operation, original_tokens, compacted_tokens, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      logStmt.run(input.sessionID, input.messageID, input.operation, input.originalTokens, input.compactedTokens, now)

      // 更新状态
      const stateStmt = db.prepare(`
        INSERT INTO compaction_state (session_id, last_compacted_at, compaction_count, total_tokens_saved)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          last_compacted_at = excluded.last_compacted_at,
          compaction_count = compaction_count + 1,
          total_tokens_saved = total_tokens_saved + excluded.total_tokens_saved
      `)
      stateStmt.run(input.sessionID, now, savedTokens)
    }

    export async function getCompactionHistory(sessionID: string): Promise<CompactionRecord[]> {
      const db = await ensureDB()

      const stmt = db.prepare(`
        SELECT session_id, message_id, operation, original_tokens, compacted_tokens, created_at
        FROM compaction_log
        WHERE session_id = ?
        ORDER BY created_at DESC
      `)

      const results = stmt.all(sessionID) as Array<{
        session_id: string
        message_id: string
        operation: "prune" | "summarize" | "checkpoint"
        original_tokens: number
        compacted_tokens: number
        created_at: number
      }>

      return results.map((r) => ({
        sessionID: r.session_id,
        messageID: r.message_id,
        operation: r.operation,
        originalTokens: r.original_tokens,
        compactedTokens: r.compacted_tokens,
        createdAt: r.created_at,
      }))
    }

    export async function getLastCompaction(sessionID: string): Promise<number | null> {
      const db = await ensureDB()

      const stmt = db.prepare("SELECT last_compacted_at FROM compaction_state WHERE session_id = ?")
      const result = stmt.get(sessionID) as { last_compacted_at: number } | undefined

      return result?.last_compacted_at || null
    }

    export async function getStats(sessionID: string): Promise<CompactionStats> {
      const db = await ensureDB()

      const stmt = db.prepare(`
        SELECT compaction_count, total_tokens_saved, last_compacted_at
        FROM compaction_state
        WHERE session_id = ?
      `)

      const result = stmt.get(sessionID) as
        | {
            compaction_count: number
            total_tokens_saved: number
            last_compacted_at: number
          }
        | undefined

      if (!result) {
        return {
          compactionCount: 0,
          totalTokensSaved: 0,
          lastCompactedAt: null,
        }
      }

      return {
        compactionCount: result.compaction_count,
        totalTokensSaved: result.total_tokens_saved,
        lastCompactedAt: result.last_compacted_at,
      }
    }

    export async function cleanup(sessionID: string, keepCount: number = 100): Promise<void> {
      const db = await ensureDB()

      // 删除旧记录，保留最新的 keepCount 条
      const stmt = db.prepare(`
        DELETE FROM compaction_log
        WHERE session_id = ?
        AND id NOT IN (
          SELECT id FROM compaction_log
          WHERE session_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        )
      `)
      stmt.run(sessionID, sessionID, keepCount)
    }
  }
}
