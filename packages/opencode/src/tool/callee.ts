import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"
import DESCRIPTION from "./callee.txt"
import { Instance } from "../project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"
import { Log } from "@/util/log"

const log = Log.create({ service: "tool.callee" })

// 预定义关键字字节集合，用于极速过滤 (ASCII)
const KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "return", "throw", "try", "catch", "finally", 
  "new", "delete", "typeof", "instanceof", "void", "yield", "await", "function", "class", "import", "export", "default", 
  "as", "from", "static", "get", "set", "constructor", "super", "this", "debugger",
  "synchronized", "volatile", "transient", "native", "strictfp", "assert", "enum", "interface", "package", "extends", 
  "implements", "public", "protected", "private", "final", "abstract", "boolean", "byte", "char", "short", "int", "long", 
  "float", "double", "elif", "except", "raise", "with", "global", "nonlocal", "def", "lambda", "pass", "del", "in", "is", 
  "and", "or", "not", "func", "chan", "go", "select", "defer", "range", "type", "var", "const", "map", "struct",
  "using", "namespace", "template", "typename", "virtual", "inline", "explicit", "operator", "friend", "mutable", "sizeof"
])

const SOFT_LIMIT = 500
const FILE_LIMIT_PER_SYMBOL = 3

export const CalleeSearchTool = Tool.define("callee-search", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().optional().describe("The path to a specific file."),
    directory: z.string().optional().describe("The directory for global analysis."),
    include: z.string().optional().describe('File pattern (e.g. "*.ts").'),
    startLine: z.number().int().min(1).optional().describe("Start line (1-based)."),
    endLine: z.number().int().min(1).optional().describe("End line (1-based)."),
    pattern: z.string().optional().describe("Custom regex pattern. Defaults to 'identifier('."),
  }),
  async execute(params, ctx) {
    const callPattern = params.pattern || "([a-zA-Z_][a-zA-Z0-9_.]*)\\s*\\("
    
    if (params.filePath) {
      const file = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(Instance.directory, params.filePath)
      await assertExternalDirectory(ctx, file)
      if (!(await Bun.file(file).exists())) throw new Error(`File not found: ${file}`)

      await ctx.ask({
        permission: "read",
        patterns: [file],
        always: [file],
        metadata: { filePath: params.filePath },
      })

      const content = await Bun.file(file).text()
      const lines = content.split(/\r?\n/)
      const start = (params.startLine ?? 1) - 1
      const end = params.endLine ?? lines.length
      const rangeLines = lines.slice(start, end)
      
      const callees = new Map<string, { count: number; lines: number[] }>()
      const regex = new RegExp(callPattern, "g")
      rangeLines.forEach((line, i) => {
        let m
        regex.lastIndex = 0
        while ((m = regex.exec(line)) !== null) {
          const s = m[1]
          if (s && !KEYWORDS.has(s) && s !== ".") {
            const data = callees.get(s) || { count: 0, lines: [] }
            data.count++
            if (data.lines.length < 5) data.lines.push(i + (params.startLine ?? 1))
            callees.set(s, data)
          }
        }
      })

      const sorted = Array.from(callees.entries()).sort((a, b) => b[1].count - a[1].count)
      return {
        title: `Callee Search: ${path.basename(file)}`,
        metadata: { calleeCount: callees.size },
        output: sorted.length ? `Found ${callees.size} callees:\n` + sorted.map(([s, info]) => `- ${s} (${info.count} times, lines: ${info.lines.join(", ")})`).join("\n") : "No calls found."
      }

    } else {
      let searchPath = params.directory ?? Instance.directory
      searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Instance.directory, searchPath)
      await assertExternalDirectory(ctx, searchPath, { kind: "directory" })

      await ctx.ask({ permission: "grep", patterns: [callPattern], always: ["*"], metadata: { directory: params.directory } })

      const rgPath = await Ripgrep.filepath()
      
      const fs = require("fs")
      let shards: string[] = []
      try {
        if (fs.existsSync(searchPath)) {
          const stats = fs.statSync(searchPath)
          if (stats.isDirectory()) {
            const entries = fs.readdirSync(searchPath, { withFileTypes: true })
            shards = entries
              .filter((e: any) => !e.name.startsWith("."))
              .map((e: any) => path.join(searchPath, e.name))
          }
        }
      } catch (e: any) {
        log.error("Failed to readdir for sharding", e)
      }

      const MAX_CONCURRENCY = 4
      const callees = new Map<string, { count: number; files: Map<string, number[]> }>()
      const pathCache = new Map<string, string>()
      const decoder = new TextDecoder()
      const PIPE_CHAR = 124 // '|'
      const LF_CHAR = 10    // '\n'

      const runShard = async (shardPath: string) => {
        const args = [
          "--mmap",
          "--threads", "2",
          "--no-config",
          "-nH",
          "--field-match-separator=|",
          "--only-matching",
          "--replace", "$1",
          "--regexp", callPattern,
          shardPath
        ]
        if (params.include) args.splice(args.length - 1, 0, "--glob", params.include)

        const proc = Bun.spawn([rgPath, ...args], { stdout: "pipe", stderr: "pipe", signal: ctx.abort })
        const reader = proc.stdout.getReader()
        let leftover = new Uint8Array(0)

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            
            const chunk = new Uint8Array(leftover.length + value.length)
            chunk.set(leftover)
            chunk.set(value, leftover.length)
            
            let start = 0
            while (true) {
              const end = chunk.indexOf(LF_CHAR, start)
              if (end === -1) {
                leftover = chunk.slice(start)
                break
              }
              
              const line = chunk.subarray(start, end)
              start = end + 1
              
              const p1 = line.indexOf(PIPE_CHAR)
              if (p1 === -1) continue
              const p2 = line.indexOf(PIPE_CHAR, p1 + 1)
              if (p2 === -1) continue
              
              const rawPath = decoder.decode(line.subarray(0, p1))
              let relFile = pathCache.get(rawPath)
              if (relFile === undefined) {
                relFile = path.relative(Instance.worktree, rawPath)
                pathCache.set(rawPath, relFile)
              }
              
              const lineNum = parseInt(decoder.decode(line.subarray(p1 + 1, p2)), 10)
              const symbol = decoder.decode(line.subarray(p2 + 1))

              if (symbol && !KEYWORDS.has(symbol) && symbol !== ".") {
                let data = callees.get(symbol)
                if (!data) {
                  data = { count: 0, files: new Map() }
                  callees.set(symbol, data)
                }
                data.count++
                let fLines = data.files.get(relFile)
                if (!fLines) {
                  fLines = []
                  data.files.set(relFile, fLines)
                }
                if (fLines.length < 3) fLines.push(lineNum)
              }
            }
          }
        } finally {
          reader.releaseLock()
          proc.kill()
        }
      }

      const allShards = shards.length > 0 ? shards : [searchPath]
      for (let i = 0; i < allShards.length; i += MAX_CONCURRENCY) {
        const batch = allShards.slice(i, i + MAX_CONCURRENCY)
        await Promise.all(batch.map(shard => runShard(shard)))
        if (callees.size >= SOFT_LIMIT * 10) break
      }

      if (callees.size === 0) return { title: "Global Search", metadata: { calleeCount: 0 }, output: "No calls found." }

      const sorted = Array.from(callees.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, SOFT_LIMIT)
      const outLines = [
        `Global Analysis for ${path.relative(Instance.worktree, searchPath) || "root"} (Optimized):`,
        `Unique Symbols: ${callees.size}`,
        ""
      ]
      for (const [s, d] of sorted) {
        const locs = Array.from(d.files.entries()).slice(0, FILE_LIMIT_PER_SYMBOL).map(([f, l]) => `${f}:${l.join(",")}`).join("; ")
        outLines.push(`- ${s} (${d.count} calls)  Locations: ${locs}${d.files.size > FILE_LIMIT_PER_SYMBOL ? " ..." : ""}`)
      }
      return { title: "Global Search", metadata: { calleeCount: callees.size }, output: outLines.join("\n") }
    }
  },
})
