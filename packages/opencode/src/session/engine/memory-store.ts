import { SemanticEngine } from "./semantic"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import path from "path"

// LanceDB types
interface LanceVectorRecord {
  id: string
  vector: number[]
  content: string
  type: string
  timestamp: number
  metadata: string
}

interface MemoryEntry {
  id: string
  type: "message" | "decision" | "change" | "todo"
  content: string
  timestamp: number
  metadata: Record<string, any>
  vector?: number[]
}

export class MemoryStore {
  private static readonly log = Log.create({ service: "memory.store" })
  private static readonly MAX_HOT_MESSAGES = 20
  private static readonly MAX_HOT_CHANGES = 50
  private static readonly VECTOR_DIM = 384

  // Singleton instance
  private static instance: MemoryStore | null = null

  // Hot Memory
  private messages: MemoryEntry[] = []
  private decisions: MemoryEntry[] = []
  private changes: MemoryEntry[] = []
  private todos: MemoryEntry[] = []

  // LanceDB
  private semanticEngine: SemanticEngine
  private db: any = null
  private table: any = null
  private initialized = false

  // Private constructor to prevent direct instantiation
  private constructor() {
    this.semanticEngine = new SemanticEngine()
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): MemoryStore {
    if (!MemoryStore.instance) {
      MemoryStore.instance = new MemoryStore()
    }
    return MemoryStore.instance
  }

  async init(): Promise<void> {
    if (this.initialized) return

    try {
      const lancedb = await import("@lancedb/lancedb")
      const dbPath = path.join(Instance.directory || process.cwd(), ".opencode", "memory.lance")
      this.db = await lancedb.connect(dbPath)

      // Create or open table
      try {
        this.table = await this.db.openTable("memories")
      } catch {
        // Table doesn't exist, create it
        this.table = await this.db.createTable("memories", [
          {
            id: "init",
            vector: new Array(MemoryStore.VECTOR_DIM).fill(0),
            content: "",
            type: "init",
            timestamp: Date.now(),
            metadata: "{}",
          },
        ])
      }

      this.initialized = true
      MemoryStore.log.info("LanceDB initialized", { path: dbPath })
    } catch (error) {
      MemoryStore.log.error("Failed to initialize LanceDB", { error })
      // Continue without vector store
      this.initialized = false
    }
  }

  async addMessage(role: string, content: string, metadata?: any): Promise<void> {
    await this.init()

    const entry: MemoryEntry = {
      id: this.generateId(),
      type: "message",
      content,
      timestamp: Date.now(),
      metadata: { role, ...metadata },
    }

    // Generate vector
    entry.vector = await this.semanticEngine.getEmbedding(content)

    // Save to LanceDB
    if (this.initialized && this.table) {
      await this.saveToVectorStore(entry)
    }

    // Add to hot memory
    this.messages.push(entry)
    if (this.messages.length > MemoryStore.MAX_HOT_MESSAGES) {
      this.messages.shift()
    }
  }

  addDecision(content: string, keywords: string[]): void {
    // 检查是否已存在相同的决策
    const existing = this.decisions.find((d) => d.content === content && d.metadata.status === "active")
    if (existing) return

    const entry: MemoryEntry = {
      id: this.generateId(),
      type: "decision",
      content,
      timestamp: Date.now(),
      metadata: { keywords, status: "active" },
    }

    // Mark old decisions as overwritten
    this.decisions.forEach((d) => {
      if (keywords.some((k) => d.metadata.keywords?.includes(k))) {
        d.metadata.status = "overwritten"
      }
    })

    this.decisions.push(entry)
  }

  addChange(file: string, action: string, description: string): void {
    const entry: MemoryEntry = {
      id: this.generateId(),
      type: "change",
      content: `${file}: ${description}`,
      timestamp: Date.now(),
      metadata: { file, action },
    }

    this.changes.push(entry)
    if (this.changes.length > MemoryStore.MAX_HOT_CHANGES) {
      this.changes.shift()
    }
  }

  addTodo(content: string): void {
    const existing = this.todos.find((t) => t.content === content && t.metadata.status === "pending")
    if (existing) return

    this.todos.push({
      id: this.generateId(),
      type: "todo",
      content,
      timestamp: Date.now(),
      metadata: { status: "pending" },
    })
  }

  completeTodo(content: string): void {
    const todo = this.todos.find((t) => t.content === content && t.metadata.status === "pending")
    if (todo) {
      todo.metadata.status = "done"
      todo.metadata.completedAt = Date.now()
    }
  }

  async retrieve(query: string, limit: number = 10): Promise<MemoryEntry[]> {
    await this.init()

    const results: MemoryEntry[] = []
    const queryLower = query.toLowerCase()

    // 1. Exact match from hot memory
    const matchingDecisions = this.decisions.filter(
      (d) =>
        d.metadata.status === "active" &&
        d.metadata.keywords?.some((k: string) => queryLower.includes(k.toLowerCase())),
    )
    results.push(...matchingDecisions)

    const matchingChanges = this.changes.filter((c) => queryLower.includes(c.metadata.file?.toLowerCase()))
    results.push(...matchingChanges)

    // 2. Vector similarity search from LanceDB
    if (this.initialized && this.table) {
      try {
        const queryVector = await this.semanticEngine.getEmbedding(query)
        const vectorResults = await this.searchVectorStore(queryVector, limit)
        results.push(...vectorResults)
      } catch (error) {
        MemoryStore.log.warn("Vector search failed", { error })
      }
    }

    return this.deduplicateAndRank(results, query)
  }

  async buildContext(query: string): Promise<string> {
    const relevant = await this.retrieve(query, 10)
    const parts: string[] = []

    // Recent messages
    parts.push("【最近对话】")
    this.messages.slice(-10).forEach((m) => {
      parts.push(`${m.metadata.role}: ${m.content.substring(0, 200)}`)
    })

    // Active decisions
    const activeDecisions = this.decisions.filter((d) => d.metadata.status === "active")
    if (activeDecisions.length > 0) {
      parts.push("\n【已做决策】")
      activeDecisions.forEach((d) => parts.push(`- ${d.content}`))
    }

    // Recent changes
    if (this.changes.length > 0) {
      parts.push("\n【最近修改】")
      this.changes.slice(-5).forEach((c) => parts.push(`- ${c.content}`))
    }

    // Pending todos
    const pendingTodos = this.todos.filter((t) => t.metadata.status === "pending")
    if (pendingTodos.length > 0) {
      parts.push("\n【待办事项】")
      pendingTodos.forEach((t) => parts.push(`- [待完成] ${t.content}`))
    }

    // Relevant history from vector search
    if (relevant.length > 0) {
      parts.push("\n【相关历史】")
      relevant.forEach((r) => {
        if (r.type === "message") {
          parts.push(`- ${r.metadata.role}: ${r.content.substring(0, 150)}`)
        }
      })
    }

    return parts.join("\n")
  }

  private generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private async saveToVectorStore(entry: MemoryEntry): Promise<void> {
    if (!this.table || !entry.vector) return

    const record: LanceVectorRecord = {
      id: entry.id,
      vector: entry.vector,
      content: entry.content,
      type: entry.type,
      timestamp: entry.timestamp,
      metadata: JSON.stringify(entry.metadata),
    }

    await this.table.add([record])
  }

  private async searchVectorStore(queryVector: number[], limit: number): Promise<MemoryEntry[]> {
    if (!this.table) return []

    const results = await this.table.search(queryVector).limit(limit).execute()

    return results.map((r: LanceVectorRecord) => ({
      id: r.id,
      type: r.type as MemoryEntry["type"],
      content: r.content,
      timestamp: r.timestamp,
      metadata: JSON.parse(r.metadata),
      vector: r.vector,
    }))
  }

  private deduplicateAndRank(results: MemoryEntry[], query: string): MemoryEntry[] {
    const seen = new Set<string>()
    return results
      .filter((r) => {
        if (seen.has(r.id)) return false
        seen.add(r.id)
        return true
      })
      .slice(0, 10)
  }
}
