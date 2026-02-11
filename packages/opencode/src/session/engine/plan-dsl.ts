export type PlanNodeCondition =
  | { type: "always" }
  | { type: "tool-ok"; toolCallId: string }
  | { type: "tool-error"; toolCallId: string }

export type PlanNodeStatus = "pending" | "running" | "completed" | "error" | "skipped"

export type PlanNode = {
  id: string
  toolName: string
  args: Record<string, any>
  dependsOn: string[]
  condition?: PlanNodeCondition
  status: PlanNodeStatus
  retryCount: number
  maxRetries: number
  metadata?: Record<string, any>
}

export type Plan = {
  nodes: PlanNode[]
}

export function planFromToolExecutors(
  executors: Array<{ callId: string; toolName: string; input: Record<string, any>; getDependencies(): string[] }>,
): Plan {
  return {
    nodes: executors.map((e) => ({
      id: e.callId,
      toolName: e.toolName,
      args: e.input,
      dependsOn: e.getDependencies(),
      status: "pending",
      retryCount: 0,
      maxRetries: 1, // Default 1 retry for transient errors
    })),
  }
}
