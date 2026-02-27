import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { InstructionPrompt } from "../session/instruction"

// Bun 全局类型声明
declare const Bun: {
  file(path: string): {
    exists(): Promise<boolean>
    stat(): Promise<{ size: number; mtimeMs: number }>
    stream(): ReadableStream<Uint8Array>
    slice(start: number, end: number): ReturnType<typeof Bun.file>
    arrayBuffer(): Promise<ArrayBuffer>
    text(): Promise<string>
    bytes(): Promise<Uint8Array>
    type: string
  }
}

// Bun 文件类型定义 - 避免直接依赖 Bun 命名空间
type BunFile = ReturnType<typeof Bun.file>

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024

/**
 * 文件读取缓存 - 基于 mtime 的 LRU 缓存
 * 用于避免短时间内重复读取同一文件
 */
interface CacheEntry {
  content: string[]
  mtime: number
  size: number
  lastAccessed: number
}

class FileReadCache {
  private cache = new Map<string, CacheEntry>()
  private readonly MAX_ENTRIES = 100
  private readonly MAX_AGE_MS = 30 * 1000 // 30秒过期

  async get(filePath: string): Promise<string[] | null> {
    const entry = this.cache.get(filePath)
    if (!entry) return null

    // 检查文件是否已修改
    try {
      const stat = await fs.promises.stat(filePath)
      if (stat.mtimeMs !== entry.mtime) {
        this.cache.delete(filePath)
        return null
      }
    } catch {
      this.cache.delete(filePath)
      return null
    }

    // 更新访问时间
    entry.lastAccessed = Date.now()
    this.cache.delete(filePath)
    this.cache.set(filePath, entry)
    return entry.content
  }

  set(filePath: string, content: string[], mtime: number, size: number): void {
    // 清理过期条目
    this.evictIfNecessary()

    this.cache.set(filePath, {
      content,
      mtime,
      size,
      lastAccessed: Date.now(),
    })
  }

  private evictIfNecessary(): void {
    const now = Date.now()

    // 首先清理过期条目
    const keysToDelete: string[] = []
    this.cache.forEach((entry, key) => {
      if (now - entry.lastAccessed > this.MAX_AGE_MS) {
        keysToDelete.push(key)
      }
    })
    keysToDelete.forEach((key) => this.cache.delete(key))

    // 然后按 LRU 清理
    while (this.cache.size >= this.MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey) {
        this.cache.delete(oldestKey)
      }
    }
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }
}

const readCache = new FileReadCache()

/**
 * 快速二进制文件扩展名白名单
 * 避免对大文件进行内容采样检测
 */
const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".class", ".jar", ".war", ".ear",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".odt", ".ods", ".odp",
  ".pdf", ".psd", ".ai", ".sketch",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".svg",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv",
  ".wasm", ".pyc", ".pyo", ".o", ".obj", ".a", ".lib",
  ".db", ".sqlite", ".mdb",
])

/**
 * 快速判断是否为二进制文件
 * 优先使用扩展名白名单，避免读取文件内容
 */
function isBinaryByExtension(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to read"),
    offset: z.coerce.number().int().nonnegative().default(0).describe("The line number to start reading from (0-based). Use this for large files to read specific sections."),
    limit: z.coerce.number().int().positive().max(5000).default(DEFAULT_READ_LIMIT).describe("The number of lines to read (defaults to 2000, max 5000)."),
  }),

  /**
   * 并发控制：声明此工具访问的资源
   * 允许并行调度器识别相同文件的并发读取
   */
  getResourceKeys(params) {
    const filepath = path.isAbsolute(params.filePath) 
      ? params.filePath 
      : path.resolve(Instance.directory, params.filePath)
    return new Set([`file:${filepath}`])
  },

  /**
   * 并发控制：声明此工具的依赖
   * read 工具没有依赖其他工具的输出
   */
  getDependencies() {
    return []
  },

  /**
   * 并发控制：设置超时时间
   * 大文件读取可能需要更长时间
   */
  getTimeout(params) {
    // 根据 limit 动态调整超时时间
    const limit = params.limit ?? DEFAULT_READ_LIMIT
    return Math.min(30000, 5000 + limit * 10) // 基础 5s + 每行 10ms，最多 30s
  },

  async execute(params, ctx) {
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      filepath = path.resolve(Instance.directory, filepath)
    }
    const title = path.relative(Instance.worktree, filepath)

    await assertExternalDirectory(ctx, filepath, {
      bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
    })

    await ctx.ask({
      permission: "read",
      patterns: [filepath],
      always: ["*"],
      metadata: {},
    })

    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      const dirEntries = await fs.promises.readdir(dir).catch(() => [])
      const suggestions = dirEntries
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.join(dir, entry))
        .slice(0, 3)

      if (suggestions.length > 0) {
        throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
      }

      throw new Error(`File not found: ${filepath}`)
    }

    const instructions = await InstructionPrompt.resolve(ctx.messages, filepath, ctx.messageID)

    const stat = await file.stat()
    const fileSize = stat.size
    const mtime = (stat as any).mtimeMs || Date.now()

    const isImage =
      file.type.startsWith("image/") && file.type !== "image/svg+xml" && file.type !== "image/vnd.fastbidsheet"
    const isPdf = file.type === "application/pdf"
    if (isImage || isPdf) {
      const mime = file.type
      const msg = `${isImage ? "Image" : "PDF"} read successfully`
      return {
        title,
        output: msg,
        metadata: {
          preview: msg,
          truncated: false,
          size: fileSize,
          sizeHuman: formatSize(fileSize),
          ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
        },
        attachments: [
          {
            type: "file",
            mime,
            url: `data:${mime};base64,${Buffer.from(await file.bytes()).toString("base64")}`,
          },
        ],
      }
    }

    // 快速二进制检测 - 优先使用扩展名白名单
    if (isBinaryByExtension(filepath)) {
      throw new Error(`Cannot read binary file: ${filepath}`)
    }

    const isBinary = await isBinaryFile(filepath, fileSize, file)
    if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset || 0

    // 尝试从缓存读取（仅当读取整个文件或大部分内容时）
    if (offset === 0 && limit >= DEFAULT_READ_LIMIT) {
      const cached = await readCache.get(filepath)
      if (cached) {
        // 从缓存构建输出
        const raw = cached.slice(0, limit)
        const content = raw.map((line, index) => {
          return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
        })
        const preview = raw.slice(0, 20).join("\n")

        let output = `<file path="${title}" size="${formatSize(fileSize)}">\n`
        output += content.join("\n")
        const totalLines = cached.length
        if (raw.length < cached.length) {
          output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${raw.length})`
        } else {
          output += `\n\n(End of file - total ${totalLines} lines)`
        }
        output += "\n</file>"

        if (instructions.length > 0) {
          output += `\n\n<system-reminder>\n${instructions.map((i) => i.content).join("\n\n")}\n</system-reminder>`
        }

        LSP.touchFile(filepath, false)
        FileTime.read(ctx.sessionID, filepath)

        return {
          title,
          output,
          metadata: {
            preview,
            truncated: raw.length < cached.length,
            size: fileSize,
            sizeHuman: formatSize(fileSize),
            cached: true,
            ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
          },
        }
      }
    }

    const raw: string[] = []
    let bytesRead = 0
    let truncatedByBytes = false
    let lineIndex = 0
    let hasMoreLines = false

    const stream = file.stream()
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        
        if (done) {
          buffer += decoder.decode()
          if (buffer) {
            const lines = buffer.split(/\r?\n/)
            for (const line of lines) {
              if (lineIndex >= offset && lineIndex < offset + limit) {
                const processedLine = line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + "..." : line
                const size = Buffer.byteLength(processedLine, "utf-8") + (raw.length > 0 ? 1 : 0)
                if (bytesRead + size > MAX_BYTES) {
                  truncatedByBytes = true
                  break
                }
                raw.push(processedLine)
                bytesRead += size
              } else if (lineIndex >= offset + limit) {
                hasMoreLines = true
                break
              }
              lineIndex++
            }
          }
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ""

        let stop = false
        for (const line of lines) {
          if (lineIndex >= offset && lineIndex < offset + limit) {
            const processedLine = line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + "..." : line
            const size = Buffer.byteLength(processedLine, "utf-8") + (raw.length > 0 ? 1 : 0)
            if (bytesRead + size > MAX_BYTES) {
              truncatedByBytes = true
              stop = true
              break
            }
            raw.push(processedLine)
            bytesRead += size
          } else if (lineIndex >= offset + limit) {
            hasMoreLines = true
            stop = true
            break
          }
          lineIndex++
        }

        if (stop) {
          await reader.cancel()
          break
        }
      }
    } finally {
      reader.releaseLock()
    }

    const content = raw.map((line, index) => {
      return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    let output = `<file path="${title}" size="${formatSize(fileSize)}">\n`
    output += content.join("\n")

    const lastReadLine = offset + raw.length
    const truncated = hasMoreLines || truncatedByBytes

    if (truncatedByBytes) {
      output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else if (hasMoreLines) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else {
      const totalLines = lineIndex + (buffer ? 1 : 0)
      output += `\n\n(End of file - total ${totalLines} lines)`
    }
    output += "\n</file>"

    // 缓存文件内容（仅当读取整个文件或大部分内容时）
    if (offset === 0 && !truncated && raw.length > 0) {
      readCache.set(filepath, raw, mtime, fileSize)
    }

    // just warms the lsp client
    LSP.touchFile(filepath, false)
    FileTime.read(ctx.sessionID, filepath)

    // 索引文件内容到 MemoryContextEngine
    try {
      const { MemoryContextEngine } = await import("../session/engine/context");
      const engine = MemoryContextEngine.getInstance();
      await engine.init();
      // 使用 raw.join('\n') 作为索引内容，因为它是实际读取到的纯文本
      await engine.indexFile(filepath, raw.join("\n"));
    } catch (e) {
      // 索引失败不应阻断工具执行
    }

    if (instructions.length > 0) {
      output += `\n\n<system-reminder>\n${instructions.map((i) => i.content).join("\n\n")}\n</system-reminder>`
    }

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
        size: fileSize,
        sizeHuman: formatSize(fileSize),
        ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
      },
    }
  },
})

/**
 * 检测文件是否为二进制文件
 * 优先使用扩展名白名单，对大文件避免读取内容
 */
async function isBinaryFile(filepath: string, fileSize: number, file: BunFile): Promise<boolean> {
  // 快速路径：通过扩展名判断
  if (isBinaryByExtension(filepath)) {
    return true
  }

  if (fileSize === 0) return false

  // 对于大文件(>1MB)，如果扩展名不在白名单中，直接读取前4KB采样
  const bufferSize = Math.min(4096, fileSize)
  const buffer = await file.slice(0, bufferSize).arrayBuffer()
  if (buffer.byteLength === 0) return false
  const bytes = new Uint8Array(buffer)

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    // NULL byte 是确定的二进制指示器
    if (bytes[i] === 0) return true
    // 常见控制字符 (TAB, LF, CR 允许)
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // 如果 >30% 不可打印字符，认为是二进制
  return nonPrintableCount / bytes.length > 0.3
}
