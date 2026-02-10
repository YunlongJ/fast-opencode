import type { ToolExecutionResult } from "./tool-orchestrator"
import type { PlanNode } from "./plan-dsl"
import { Identifier } from "@/id/id"

export type RecoveryAction = {
  type: "retry"
  nodeId: string
  newArgs?: Record<string, any>
} | {
  type: "add-nodes"
  nodes: PlanNode[]
}

export class RecoveryAgent {
  static suggest(result: ToolExecutionResult, node: PlanNode): RecoveryAction | undefined {
    if (result.ok) return undefined

    const error = result.error?.toLowerCase() ?? ""

    // Strategy 1: File not found for 'read' or 'read_multiple'
    if ((node.toolName === "read" || node.toolName === "read_multiple") && 
        (error.includes("no such file") || error.includes("not found") || error.includes("enoent"))) {
      
      const pathStr = node.args.path || (node.args.files?.[0]?.path)
      if (pathStr) {
        // Suggest searching for the file
        return {
          type: "add-nodes",
          nodes: [{
            id: Identifier.ascending("tool"),
            toolName: "glob",
            args: { pattern: `**/${pathStr.split(/[/\\]/).pop()}` },
            dependsOn: [],
            status: "pending",
            retryCount: 0,
            maxRetries: 0,
            metadata: { recoveryFor: node.id, reason: "file_not_found" }
          }]
        }
      }
    }

    // Strategy 2: grep found nothing (sometimes grep fails if the file doesn't exist or pattern is wrong)
    if (node.toolName === "grep" && (error.includes("no matches") || error.includes("exit code 1"))) {
       // Maybe suggest a simpler search or glob
       // For now, let's just let the LLM handle it unless it's a very common case
    }

    // Strategy 3: Transient errors (retryable)
    const isTransient = error.includes("timeout") || error.includes("connection reset") || error.includes("busy")
    if (isTransient && node.retryCount < node.maxRetries) {
      return { type: "retry", nodeId: node.id }
    }

    return undefined
  }
}
