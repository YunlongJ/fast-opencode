import { ToolResultCache } from "@/session/tool-result-cache"
import type { MessageV2 } from "@/session/message-v2"

export type BlackboardToolResult = {
  toolCallId: string
  toolName: string
  input: Record<string, any>
  output?: string
  title?: string
  metadata?: Record<string, any>
  attachments?: MessageV2.FilePart[]
  ok: boolean
  time: { start: number; end: number }
}

export class ToolBlackboard {
  private results = new Map<string, BlackboardToolResult>()
  private grepFiles = new Map<string, string[]>()

  put(result: BlackboardToolResult) {
    this.results.set(result.toolCallId, result)
    if (result.ok && result.toolName === "grep" && typeof result.output === "string") {
      this.grepFiles.set(result.toolCallId, parseGrepFiles(result.output))
    }
  }

  get(toolCallId: string): BlackboardToolResult | undefined {
    return this.results.get(toolCallId)
  }

  list(): BlackboardToolResult[] {
    return Array.from(this.results.values())
  }

  getGrepFiles(toolCallId: string): string[] {
    return this.grepFiles.get(toolCallId) ?? []
  }

  getCached(sessionID: string, toolName: string, input: Record<string, any>) {
    return ToolResultCache.getBySignature(sessionID, toolName, input)
  }
}

function parseGrepFiles(output: string): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd()
    if (!line) continue
    if (line.startsWith("Found ")) continue
    if (line.startsWith("...")) continue
    if (line.startsWith("(")) continue
    if (line.startsWith("Line ")) continue
    if (line.startsWith("Line\t")) continue
    if (line.startsWith("Line:")) continue
    if (line.startsWith("Line")) continue
    if (!line.endsWith(":")) continue
    const file = line.slice(0, -1).trim()
    if (!file) continue
    if (seen.has(file)) continue
    seen.add(file)
    files.push(file)
  }
  return files
}
