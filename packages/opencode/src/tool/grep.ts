import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"

import DESCRIPTION from "./grep.txt"
import { Instance } from "../project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"

const MAX_LINE_LENGTH = 2000

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    let searchPath = params.path ?? Instance.directory
    searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Instance.directory, searchPath)
    await assertExternalDirectory(ctx, searchPath, { kind: "directory" })

    const rgPath = await Ripgrep.filepath()
    const args = ["-nH", "--hidden", "--no-messages", "--field-match-separator=|", "--regexp", params.pattern]
    if (params.include) {
      args.push("--glob", params.include)
    }
    args.push(searchPath)

    const proc = Bun.spawn([rgPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      signal: ctx.abort,
    })

    const SOFT_LIMIT = 200
    const decoder = new TextDecoder()
    const reader = proc.stdout.getReader()
    let buffer = ""
    let truncated = false

    const rawMatches: Array<{ filePath: string; lineNum: number; lineText: string }> = []
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (!line) continue
          const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
          if (!filePath || !lineNumStr || lineTextParts.length === 0) continue
          rawMatches.push({
            filePath,
            lineNum: Number.parseInt(lineNumStr, 10),
            lineText: lineTextParts.join("|"),
          })
          if (rawMatches.length >= SOFT_LIMIT) {
            truncated = true
            proc.kill()
            break
          }
        }
        if (truncated) break
      }

      if (!truncated && buffer) {
        const [filePath, lineNumStr, ...lineTextParts] = buffer.split("|")
        if (filePath && lineNumStr && lineTextParts.length > 0) {
          rawMatches.push({
            filePath,
            lineNum: Number.parseInt(lineNumStr, 10),
            lineText: lineTextParts.join("|"),
          })
          if (rawMatches.length >= SOFT_LIMIT) {
            truncated = true
            proc.kill()
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const errorOutput = await new Response(proc.stderr).text().catch(() => "")
    const exitCode = await proc.exited

    // Exit codes: 0 = matches found, 1 = no matches, 2 = errors (but may still have matches)
    if (rawMatches.length === 0 && (exitCode === 1 || exitCode === 2)) {
      return {
        title: params.pattern,
        metadata: { matches: 0, displayed: 0, truncated: false },
        output: "No files found matching the pattern.",
      }
    }

    if (!truncated && exitCode !== 0 && exitCode !== 2) {
      throw new Error(`ripgrep failed: ${errorOutput}`)
    }

    const hasErrors = exitCode === 2
    const totalMatches = rawMatches.length
    const finalMatches = rawMatches.slice(0, SOFT_LIMIT)

    if (finalMatches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, displayed: 0, truncated: false },
        output: "No files found matching the pattern.",
      }
    }

    const outputLines: string[] = [`Found ${finalMatches.length} matches`]
    const searchIsBase = searchPath === Instance.worktree

    let currentFile = ""
    for (const match of finalMatches) {
      if (currentFile !== match.filePath) {
        if (currentFile !== "") outputLines.push("")
        currentFile = match.filePath
        const displayPath = searchIsBase 
          ? path.relative(Instance.worktree, match.filePath) 
          : match.filePath
        outputLines.push(`${displayPath}:`)
      }
      
      const truncatedLineText = match.lineText.length > MAX_LINE_LENGTH 
        ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..." 
        : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
    }

    if (truncated) {
      outputLines.push("")
      outputLines.push("... and more matches. Consider using a more specific path or pattern.")
    }

    if (hasErrors) {
      outputLines.push("")
      outputLines.push("(Some paths were inaccessible and skipped)")
    }

    return {
      title: params.pattern,
      metadata: {
        matches: totalMatches,
        displayed: finalMatches.length,
        truncated,
      },
      output: outputLines.join("\n"),
    }
  },
})
