import { Session } from "@/session"
import { Identifier } from "@/id/id"
import { ToolRegistry } from "@/tool/registry"
import { ToolDependency } from "@/session/tool-dependency"
import { ToolResultCache } from "@/session/tool-result-cache"
import { MessageV2 } from "@/session/message-v2"
import { Log } from "@/util/log"
import type { Agent } from "@/agent/agent"
import type { Tool } from "ai"
import { WriteOnceGuard } from "./write-once-guard"
import { Instance } from "@/project/instance"
import path from "path"

const log = Log.create({ service: "session.tool-orchestrator" })

export type ToolExecutionResult = {
  ok: boolean
  durationMs: number
  toolCallId: string
  toolName: string
  input: Record<string, any>
  output?: {
    output: string
    title: string
    metadata: Record<string, any>
    attachments?: MessageV2.FilePart[]
  }
  error?: string
}

export type ToolExecutor = {
  toolId: string
  toolName: string
  input: Record<string, any>
  partId: string
  callId: string
  abort: AbortSignal
  execute(ctx: { sessionID: string; assistantMessage: MessageV2.Assistant; agent: Agent.Info; tools: Record<string, Tool> }): Promise<ToolExecutionResult>
  getTimeout(): number
  getResourceKeys(): Set<string>
  getDependencies(): string[]
}

export type ResourceLockMode = "shared" | "exclusive"

export type Limiter = {
  run<T>(fn: () => Promise<T>): Promise<T>
  notify?: () => void
}

export type ResourceLockManager = { acquire(keys: Set<string>, mode: ResourceLockMode): Promise<() => void> }

export function toolLockMode(toolName: string): ResourceLockMode {
  if (toolName === "read" || toolName === "read_multiple" || toolName === "grep" || toolName === "list" || toolName === "glob")
    return "shared"
  return "exclusive"
}

export function createResourceLockManager(): ResourceLockManager {
  type QueueItem = {
    mode: ResourceLockMode
    resolve: (release: () => void) => void
  }
  type LockState = {
    readers: number
    writer: boolean
    queue: QueueItem[]
  }

  const locks = new Map<string, LockState>()

  const ensureState = (key: string): LockState => {
    let state = locks.get(key)
    if (!state) {
      state = { readers: 0, writer: false, queue: [] }
      locks.set(key, state)
    }
    return state
  }

  const drain = (key: string, state: LockState) => {
    if (state.writer) return
    if (state.readers > 0) return
    if (state.queue.length === 0) return

    const head = state.queue[0]
    if (!head) return

    if (head.mode === "exclusive") {
      const next = state.queue.shift()!
      state.writer = true
      next.resolve(() => {
        state.writer = false
        drain(key, state)
      })
      return
    }

    while (state.queue.length > 0 && state.queue[0]!.mode === "shared" && !state.writer) {
      const next = state.queue.shift()!
      state.readers++
      next.resolve(() => {
        state.readers = Math.max(0, state.readers - 1)
        if (state.readers === 0) {
          drain(key, state)
        }
      })
    }
  }

  const acquireKey = (key: string, mode: ResourceLockMode): Promise<() => void> => {
    const state = ensureState(key)

    const canAcquireNow = () => {
      if (mode === "shared") {
        if (state.writer) return false
        if (state.queue.length > 0) return false
        return true
      }
      if (state.writer) return false
      if (state.readers > 0) return false
      if (state.queue.length > 0) return false
      return true
    }

    if (canAcquireNow()) {
      if (mode === "shared") {
        state.readers++
        return Promise.resolve(() => {
          state.readers = Math.max(0, state.readers - 1)
          if (state.readers === 0) {
            drain(key, state)
          }
        })
      }
      state.writer = true
      return Promise.resolve(() => {
        state.writer = false
        drain(key, state)
      })
    }

    return new Promise<() => void>((resolve) => {
      state.queue.push({ mode, resolve })
      drain(key, state)
    })
  }

  const acquire = async (keys: Set<string>, mode: ResourceLockMode): Promise<() => void> => {
    const sortedKeys = Array.from(keys).sort()
    const releases: Array<() => void> = []
    try {
      for (const key of sortedKeys) {
        const release = await acquireKey(key, mode)
        releases.push(release)
      }
    } catch (e) {
      for (const r of releases) r()
      throw e
    }

    return () => {
      for (let i = releases.length - 1; i >= 0; i--) {
        releases[i]!()
      }
    }
  }

  return { acquire }
}

export function createLimiter(limit: number): Limiter {
  let active = 0
  const queue: Array<() => void> = []
  const notify = () => {
    while (active < limit && queue.length > 0) {
      const next = queue.shift()
      if (next) {
        active++
        next()
      }
    }
  }
  async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve))
    } else {
      active++
    }
    try {
      return await fn()
    } finally {
      active--
      notify()
    }
  }
  return { run, notify }
}

export class ToolOrchestrator {
  private writeOnce = new WriteOnceGuard()

  constructor(
    private input: { sessionID: string; assistantMessage: MessageV2.Assistant; agent: Agent.Info },
    private tools: Record<string, Tool>,
    private shared: { limiter: Limiter; resourceLockManager: ResourceLockManager; onToolExecuted?: (r: ToolExecutionResult, e: ToolExecutor) => void },
  ) {}

  clear() {
    this.writeOnce.clearSession(this.input.sessionID)
  }

  async execute(executors: ToolExecutor[]): Promise<ToolExecutionResult[]> {
    if (executors.length === 0) return []

    const toolNameAndInputKey = (e: ToolExecutor) => `${e.toolName}:${JSON.stringify(e.input)}`
    const duplicateOf = new Map<string, string>()
    const firstByKey = new Map<string, string>()
    for (const e of executors) {
      const key = toolNameAndInputKey(e)
      const first = firstByKey.get(key)
      if (!first) firstByKey.set(key, e.callId)
      else if (first !== e.callId) duplicateOf.set(e.callId, first)
    }

    const executorById = new Map<string, ToolExecutor>(executors.map((e) => [e.callId, e]))
    const pending = new Set<string>(executors.map((e) => e.callId))
    const completed = new Set<string>()
    const results = new Map<string, ToolExecutionResult>()

    const remainingDeps = new Map<string, Set<string>>()
    const dependents = new Map<string, Set<string>>()
    const readyQueue: string[] = []

    for (const e of executors) {
      const deps = new Set(e.getDependencies())
      const orig = duplicateOf.get(e.callId)
      if (orig) deps.add(orig)
      remainingDeps.set(e.callId, deps)
      if (deps.size === 0) readyQueue.push(e.callId)
      for (const d of deps) {
        const set = dependents.get(d) ?? new Set<string>()
        set.add(e.callId)
        dependents.set(d, set)
      }
    }

    let resolveDone: (() => void) | undefined
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const runningPromises = new Set<Promise<void>>()

    const kick = () => {
      while (readyQueue.length > 0) {
        if (this.canBatchRead(readyQueue, pending, executorById)) {
          const batchIds: string[] = []
          for (const id of readyQueue) {
            if (batchIds.length >= 50) break
            if (!pending.has(id)) continue
            const e = executorById.get(id)
            if (!e) continue
            if (e.toolName !== "read") continue
            batchIds.push(id)
          }
          if (batchIds.length >= 2) {
            const batchIdSet = new Set(batchIds)
            for (const id of batchIds) pending.delete(id)
            for (let i = readyQueue.length - 1; i >= 0; i--) {
              const id = readyQueue[i]!
              if (batchIdSet.has(id)) readyQueue.splice(i, 1)
            }

            const p = (async () => {
              const readExecutors: ToolExecutor[] = batchIds.map((id) => executorById.get(id)!).filter(Boolean)
              await this.executeReadMultipleBatch(readExecutors, results)
              for (const id of batchIds) {
                completed.add(id)
                const nexts = dependents.get(id)
                if (nexts) {
                  for (const depId of nexts) {
                    const deps = remainingDeps.get(depId)
                    if (!deps) continue
                    deps.delete(id)
                    if (deps.size === 0) readyQueue.push(depId)
                  }
                }
              }
            })()
            runningPromises.add(p)
            p.finally(() => {
              runningPromises.delete(p)
              if (completed.size >= executors.length) {
                resolveDone?.()
                return
              }
              if (runningPromises.size === 0 && readyQueue.length === 0 && pending.size > 0) {
                log.error("Deadlock detected in tool dependencies", {
                  pending: Array.from(pending),
                  completed: Array.from(completed),
                })
                resolveDone?.()
                return
              }
              kick()
            })
            continue
          }
        }

        const id = readyQueue.shift()
        if (!id) continue
        if (!pending.has(id)) continue
        const executor = executorById.get(id)
        if (!executor) continue

        pending.delete(id)

        const p = (async () => {
          try {
            const orig = duplicateOf.get(executor.callId)
            if (orig && completed.has(orig)) {
              const base = results.get(orig)
              if (base) {
                const dup: ToolExecutionResult = {
                  ok: base.ok,
                  durationMs: base.durationMs,
                  toolCallId: executor.callId,
                  toolName: executor.toolName,
                  input: executor.input,
                  output: base.output,
                  error: base.error,
                }
                await this.writeToolPart(executor, dup)
                results.set(executor.callId, dup)
                this.shared.onToolExecuted?.(dup, executor)
              }
              return
            }

            const isWriteTool =
              executor.toolName === "apply_patch" ||
              executor.toolName === "edit" ||
              executor.toolName === "write" ||
              executor.toolName === "bash" ||
              executor.toolName === "multiedit"

            if (isWriteTool && !this.writeOnce.tryMark(this.input.sessionID, executor.callId)) {
              const errText = `Tool '${executor.toolName}' callID '${executor.callId}' already executed`
              const r: ToolExecutionResult = {
                ok: false,
                durationMs: 0,
                toolCallId: executor.callId,
                toolName: executor.toolName,
                input: executor.input,
                error: errText,
              }
              await this.writeToolPart(executor, r)
              results.set(executor.callId, r)
              this.shared.onToolExecuted?.(r, executor)
              return
            }

            const cachedRead =
              executor.toolName === "read" ||
              executor.toolName === "read_multiple" ||
              executor.toolName === "grep" ||
              executor.toolName === "list" ||
              executor.toolName === "glob"
                ? ToolResultCache.getBySignature(this.input.sessionID, executor.toolName, executor.input)
                : undefined
            if (cachedRead) {
              const r: ToolExecutionResult = {
                ok: true,
                durationMs: 0,
                toolCallId: executor.callId,
                toolName: executor.toolName,
                input: executor.input,
                output: {
                  output: cachedRead.output,
                  title: cachedRead.title,
                  metadata: cachedRead.metadata ?? {},
                  attachments: cachedRead.attachments,
                },
              }
              await this.writeToolPart(executor, r)
              results.set(executor.callId, r)
              this.shared.onToolExecuted?.(r, executor)
              return
            }

            await this.shared.limiter.run(async () => {
              const keys = executor.getResourceKeys()
              const mode = toolLockMode(executor.toolName)
              const release = await this.shared.resourceLockManager.acquire(keys, mode)
              try {
                const timeout = executor.getTimeout()
                const resultPromise = executor.execute({ ...this.input, tools: this.tools })
                let result: ToolExecutionResult
                if (timeout > 0) {
                  const timeoutPromise = new Promise<ToolExecutionResult>((_, reject) =>
                    setTimeout(() => reject(new Error(`Tool ${executor.toolName} timed out after ${timeout}ms`)), timeout),
                  )
                  result = await Promise.race([resultPromise, timeoutPromise])
                } else {
                  result = await resultPromise
                }
                results.set(executor.callId, result)
                this.shared.onToolExecuted?.(result, executor)
              } finally {
                release()
              }
            })
          } catch (error) {
            log.error("tool execution failed", {
              sessionID: this.input.sessionID,
              tool: executor.toolName,
              callId: executor.callId,
              error,
            })
            const errText = error instanceof Error ? error.message : String(error)
            const r: ToolExecutionResult = {
              ok: false,
              durationMs: 0,
              toolCallId: executor.callId,
              toolName: executor.toolName,
              input: executor.input,
              error: errText,
            }
            await this.writeToolPart(executor, r)
            results.set(executor.callId, r)
            this.shared.onToolExecuted?.(r, executor)
          } finally {
            completed.add(executor.callId)

            const nexts = dependents.get(executor.callId)
            if (nexts) {
              for (const depId of nexts) {
                const deps = remainingDeps.get(depId)
                if (!deps) continue
                deps.delete(executor.callId)
                if (deps.size === 0) {
                  readyQueue.push(depId)
                }
              }
            }
          }
        })()

        runningPromises.add(p)
        p.finally(() => {
          runningPromises.delete(p)
          if (completed.size >= executors.length) {
            resolveDone?.()
            return
          }
          if (runningPromises.size === 0 && readyQueue.length === 0 && pending.size > 0) {
            log.error("Deadlock detected in tool dependencies", {
              pending: Array.from(pending),
              completed: Array.from(completed),
            })
            resolveDone?.()
            return
          }
          kick()
        })
      }
    }

    kick()
    await done

    return executors.map((e) => {
      const r = results.get(e.callId)
      return (
        r ?? {
          ok: false,
          durationMs: 0,
          toolCallId: e.callId,
          toolName: e.toolName,
          input: e.input,
          error: "Tool execution result missing",
        }
      )
    })
  }

  private async writeToolPart(executor: ToolExecutor, result: ToolExecutionResult) {
    await Session.updatePart({
      id: executor.partId,
      messageID: this.input.assistantMessage.id,
      sessionID: this.input.sessionID,
      type: "tool",
      tool: executor.toolName,
      callID: executor.callId,
      state: result.ok
        ? {
            status: "completed",
            input: executor.input,
            output: result.output?.output ?? "",
            title: result.output?.title,
            metadata: result.output?.metadata,
            attachments: result.output?.attachments,
            time: { start: Date.now(), end: Date.now() },
          }
        : {
            status: "error",
            input: executor.input,
            error: result.error ?? "Tool execution failed",
            time: { start: Date.now(), end: Date.now() },
          },
    })
  }

  private canBatchRead(readyQueue: string[], pending: Set<string>, executorById: Map<string, ToolExecutor>): boolean {
    const tool = this.tools["read_multiple"]
    if (!tool?.execute) return false
    let readyReads = 0
    for (const id of readyQueue) {
      if (!pending.has(id)) continue
      const e = executorById.get(id)
      if (!e) continue
      if (e.toolName === "read") readyReads++
      if (readyReads >= 2) return true
    }
    return false
  }

  private async executeReadMultipleBatch(
    readExecutors: ToolExecutor[],
    results: Map<string, ToolExecutionResult>,
  ): Promise<void> {
    const tool = this.tools["read_multiple"]
    if (!tool?.execute) return
    const start = Date.now()
    const files = readExecutors.map((e) => ({
      filePath: e.input.filePath,
      offset: e.input.offset ?? 0,
      limit: e.input.limit ?? 2000,
    }))
    const toolCallId = `read_multiple:${Date.now()}:${Math.random().toString(16).slice(2)}`
    const batch = await tool.execute({ files }, { toolCallId, abortSignal: readExecutors[0]!.abort, messages: [] })

    const errorByTitle = new Map<string, string>()
    const metaFiles = (batch.metadata as any)?.files as Array<{ title?: string; error?: string }> | undefined
    if (Array.isArray(metaFiles)) {
      for (const f of metaFiles) {
        if (f.title && f.error) errorByTitle.set(f.title, f.error)
      }
    }

    const blocks = new Map<string, string>()
    const re = /<file path="([^"]+)"[^>]*>[\s\S]*?<\/file>/g
    for (const m of String(batch.output ?? "").matchAll(re)) {
      blocks.set(m[1]!, m[0]!)
    }

    const durationMs = Date.now() - start
    for (const e of readExecutors) {
      const cached = ToolResultCache.getBySignature(this.input.sessionID, "read", e.input)
      if (cached) {
        const r: ToolExecutionResult = {
          ok: true,
          durationMs,
          toolCallId: e.callId,
          toolName: e.toolName,
          input: e.input,
          output: {
            output: cached.output,
            title: cached.title,
            metadata: cached.metadata ?? {},
            attachments: cached.attachments,
          },
        }
        await this.writeToolPart(e, r)
        results.set(e.callId, r)
        this.shared.onToolExecuted?.(r, e)
        continue
      }

      const filePath = e.input.filePath
      const abs = path.isAbsolute(filePath) ? filePath : path.resolve(Instance.directory, filePath)
      const title = path.relative(Instance.worktree, abs)
      const err = errorByTitle.get(title)
      const output = blocks.get(title) ?? ""
      if (err) {
        const r: ToolExecutionResult = {
          ok: false,
          durationMs,
          toolCallId: e.callId,
          toolName: e.toolName,
          input: e.input,
          error: err,
        }
        await this.writeToolPart(e, r)
        results.set(e.callId, r)
        this.shared.onToolExecuted?.(r, e)
        continue
      }
      if (!output) {
        const r: ToolExecutionResult = {
          ok: false,
          durationMs,
          toolCallId: e.callId,
          toolName: e.toolName,
          input: e.input,
          error: `Batched read did not include content for '${title}'`,
        }
        await this.writeToolPart(e, r)
        results.set(e.callId, r)
        this.shared.onToolExecuted?.(r, e)
        continue
      }

      const r: ToolExecutionResult = {
        ok: true,
        durationMs,
        toolCallId: e.callId,
        toolName: e.toolName,
        input: e.input,
        output: {
          output,
          title,
          metadata: { batched: true },
          attachments: [],
        },
      }
      await this.writeToolPart(e, r)
      results.set(e.callId, r)
      this.shared.onToolExecuted?.(r, e)
      ToolResultCache.set({
        sessionID: this.input.sessionID,
        callID: e.callId,
        tool: "read",
        input: e.input,
        output,
        title,
        metadata: { batched: true },
        attachments: [],
      })
    }
  }
}

export function createToolExecutor(input: {
  toolName: string
  toolInput: Record<string, any>
  partId: string
  callId: string
  abort: AbortSignal
  toolPart: MessageV2.ToolPart
}): ToolExecutor {
  const toolName = input.toolName
  const toolPart = input.toolPart
  return {
    toolId: toolName,
    toolName,
    input: input.toolInput,
    partId: input.partId,
    callId: input.callId,
    abort: input.abort,
    async execute(ctx) {
      return executeTool({
        executor: this,
        tools: ctx.tools,
        input: { sessionID: ctx.sessionID, assistantMessage: ctx.assistantMessage, agent: ctx.agent },
      })
    },
    getTimeout() {
      const tool = ToolRegistry.getToolSync?.(this.toolName)
      if (tool?.getTimeout) return tool.getTimeout(this.input)
      return 60_000
    },
    getResourceKeys() {
      const tool = ToolRegistry.getToolSync?.(this.toolName)
      if (tool?.getResourceKeys) return tool.getResourceKeys(this.input)
      return ToolDependency.resourceKeys(toolPart)
    },
    getDependencies() {
      const tool = ToolRegistry.getToolSync?.(this.toolName)
      if (tool?.getDependencies) return tool.getDependencies(this.input)
      const result = ToolDependency.analyze([toolPart])
      return Array.from(result.dependencies.get(this.callId) ?? [])
    },
  }
}

async function executeTool(args: {
  executor: ToolExecutor
  tools: Record<string, Tool>
  input: { sessionID: string; assistantMessage: MessageV2.Assistant; agent: Agent.Info }
}): Promise<ToolExecutionResult> {
  const start = Date.now()
  const executor = args.executor
  const tool = args.tools[executor.toolName]
  if (!tool) {
    await Session.updatePart({
      id: executor.partId,
      messageID: args.input.assistantMessage.id,
      sessionID: args.input.sessionID,
      type: "tool",
      tool: executor.toolName,
      callID: executor.callId,
      state: {
        status: "error",
        input: executor.input,
        error: `Tool '${executor.toolName}' not found`,
        time: { start, end: Date.now() },
      },
    })
    return {
      ok: false,
      durationMs: Date.now() - start,
      toolCallId: executor.callId,
      toolName: executor.toolName,
      input: executor.input,
      error: `Tool '${executor.toolName}' not found`,
    }
  }

  const executeFn = tool.execute
  if (!executeFn) {
    const errText = `Tool '${executor.toolName}' has no execute function`
    await Session.updatePart({
      id: executor.partId,
      messageID: args.input.assistantMessage.id,
      sessionID: args.input.sessionID,
      type: "tool",
      tool: executor.toolName,
      callID: executor.callId,
      state: {
        status: "error",
        input: executor.input,
        error: errText,
        time: { start, end: Date.now() },
      },
    })
    return {
      ok: false,
      durationMs: Date.now() - start,
      toolCallId: executor.callId,
      toolName: executor.toolName,
      input: executor.input,
      error: errText,
    }
  }

  try {
    const result = await executeFn(executor.input, { toolCallId: executor.callId, abortSignal: executor.abort, messages: [] })
    const attachments = result.attachments?.map((attachment) => ({
      ...attachment,
      id: Identifier.ascending("part"),
      messageID: args.input.assistantMessage.id,
      sessionID: args.input.sessionID,
    }))
    await Session.updatePart({
      id: executor.partId,
      messageID: args.input.assistantMessage.id,
      sessionID: args.input.sessionID,
      type: "tool",
      tool: executor.toolName,
      callID: executor.callId,
      state: {
        status: "completed",
        input: executor.input,
        output: result.output,
        title: result.title,
        metadata: result.metadata,
        attachments,
        time: { start, end: Date.now() },
      },
    })
    ToolResultCache.set({
      sessionID: args.input.sessionID,
      callID: executor.callId,
      tool: executor.toolName,
      input: executor.input,
      output: result.output,
      title: result.title,
      metadata: result.metadata ?? {},
      attachments: attachments ?? [],
    })
    return {
      ok: true,
      durationMs: Date.now() - start,
      toolCallId: executor.callId,
      toolName: executor.toolName,
      input: executor.input,
      output: { output: result.output, title: result.title, metadata: result.metadata ?? {}, attachments },
    }
  } catch (error) {
    const errText = error instanceof Error ? error.message : String(error)
    await Session.updatePart({
      id: executor.partId,
      messageID: args.input.assistantMessage.id,
      sessionID: args.input.sessionID,
      type: "tool",
      tool: executor.toolName,
      callID: executor.callId,
      state: {
        status: "error",
        input: executor.input,
        error: errText,
        time: { start, end: Date.now() },
      },
    })
    return {
      ok: false,
      durationMs: Date.now() - start,
      toolCallId: executor.callId,
      toolName: executor.toolName,
      input: executor.input,
      error: errText,
    }
  }
}
