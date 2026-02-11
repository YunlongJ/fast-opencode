export interface StepMetrics {
  ttftMs: number
  toolCalls: number
  toolOk: number
  toolError: number
  toolDurationMs: number
  textDeltaCount: number
  reasoningDeltaCount: number
  plannedNodes: number
}

export class MetricsCollector {
  private metrics: StepMetrics = {
    ttftMs: -1,
    toolCalls: 0,
    toolOk: 0,
    toolError: 0,
    toolDurationMs: 0,
    textDeltaCount: 0,
    reasoningDeltaCount: 0,
    plannedNodes: 0,
  }

  update(newMetrics: Partial<StepMetrics>) {
    this.metrics = { ...this.metrics, ...newMetrics }
  }

  get current(): StepMetrics {
    return { ...this.metrics }
  }

  reset() {
    this.metrics = {
      ttftMs: -1,
      toolCalls: 0,
      toolOk: 0,
      toolError: 0,
      toolDurationMs: 0,
      textDeltaCount: 0,
      reasoningDeltaCount: 0,
      plannedNodes: 0,
    }
  }
}
