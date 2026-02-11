import { Log } from "@/util/log"

/**
 * Adaptive concurrency limiter for tool execution.
 * Adjusts concurrency based on tool execution duration and error rate.
 */
export class AdaptiveLimiter {
  private static readonly log = Log.create({ service: "session.processor.limiter" })
  
  private active = 0
  private queue: Array<() => void> = []
  private concurrency: number
  private maxParallelTools: number

  private toolSampleCount = 0
  private toolErrorCount = 0
  private toolDurationSum = 0
  private toolAdjustAt = Date.now()

  constructor(maxParallelTools: number) {
    this.maxParallelTools = maxParallelTools
    this.concurrency = Math.max(1, maxParallelTools)
  }

  get currentConcurrency() {
    return this.concurrency
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    } else {
      this.active++
    }
    try {
      return await fn()
    } finally {
      this.active--
      this.notify()
    }
  }

  notify() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift()
      if (next) {
        this.active++
        next()
      }
    }
  }

  recordExecution(r: { durationMs: number; ok: boolean }) {
    this.toolSampleCount++
    this.toolDurationSum += r.durationMs
    if (!r.ok) this.toolErrorCount++

    const now = Date.now()
    const shouldAdjust = this.toolSampleCount >= 12 || now - this.toolAdjustAt >= 10_000
    if (!shouldAdjust) return

    const avg = this.toolSampleCount > 0 ? this.toolDurationSum / this.toolSampleCount : 0
    const errRate = this.toolSampleCount > 0 ? this.toolErrorCount / this.toolSampleCount : 0
    const prev = this.concurrency
    let next = prev

    if (errRate >= 0.25) {
      next = Math.max(1, Math.floor(prev * 0.7))
    } else if (avg >= 2_500) {
      next = Math.max(1, prev - 1)
    } else if (avg <= 600) {
      next = Math.min(this.maxParallelTools, prev + 1)
    }

    if (next !== prev) {
      AdaptiveLimiter.log.info("Adjusting tool concurrency", { prev, next, avg, errRate })
      this.concurrency = next
      this.notify()
    }

    this.toolSampleCount = 0
    this.toolErrorCount = 0
    this.toolDurationSum = 0
    this.toolAdjustAt = now
  }
}
