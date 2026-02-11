import { Session } from "@/session"
import type { MessageV2 } from "@/session/message-v2"

export class StreamRenderer {
  private textBuffer = ""
  private textTimer: any | null = null
  private textPartRef: MessageV2.TextPart | undefined
  private reasoningBuffers: Record<string, { part: MessageV2.ReasoningPart; buffer: string; timer: any | null }> = {}
  private deltaEvents = 0
  private deltaAdjustTimer: any | null = null
  private deltaThrottleMs = 100

  constructor(private opts: { deltaThrottleMs?: number }) {
    if (typeof opts.deltaThrottleMs === "number") {
      this.deltaThrottleMs = opts.deltaThrottleMs
    } else {
      this.deltaAdjustTimer = setInterval(() => {
        const perSecond = this.deltaEvents
        this.deltaEvents = 0
        if (typeof this.opts.deltaThrottleMs === "number") return
        if (perSecond >= 300) this.deltaThrottleMs = 220
        else if (perSecond >= 180) this.deltaThrottleMs = 160
        else if (perSecond >= 90) this.deltaThrottleMs = 120
        else if (perSecond <= 25) this.deltaThrottleMs = 80
        else this.deltaThrottleMs = 100
      }, 1_000)
    }
  }

  onTextDelta(part: MessageV2.TextPart, delta: string) {
    this.textPartRef = part
    this.textBuffer += delta
    this.deltaEvents++
    if (!this.textTimer) {
      this.textTimer = setTimeout(() => {
        this.flushText().catch(() => {})
      }, this.deltaThrottleMs)
    }
  }

  onReasoningDelta(id: string, part: MessageV2.ReasoningPart, delta: string) {
    if (!this.reasoningBuffers[id]) {
      this.reasoningBuffers[id] = { part, buffer: "", timer: null }
    }
    this.reasoningBuffers[id].part = part
    this.reasoningBuffers[id].buffer += delta
    this.deltaEvents++
    if (!this.reasoningBuffers[id].timer) {
      this.reasoningBuffers[id].timer = setTimeout(() => {
        this.flushReasoning(id).catch(() => {})
      }, this.deltaThrottleMs)
    }
  }

  async flushAll() {
    await this.flushText()
    for (const id of Object.keys(this.reasoningBuffers)) {
      await this.flushReasoning(id)
    }
  }

  stopTimers() {
    if (this.textTimer) {
      clearTimeout(this.textTimer)
      this.textTimer = null
    }
    for (const entry of Object.values(this.reasoningBuffers)) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
    }
    if (this.deltaAdjustTimer) {
      clearInterval(this.deltaAdjustTimer)
      this.deltaAdjustTimer = null
    }
  }

  private async flushText() {
    if (!this.textPartRef || !this.textBuffer) {
      this.textTimer = null
      return
    }
    const delta = this.textBuffer
    this.textBuffer = ""
    await Session.updatePart({ part: this.textPartRef, delta })
    this.textTimer = null
  }

  private async flushReasoning(id: string) {
    const entry = this.reasoningBuffers[id]
    if (!entry || !entry.buffer) {
      entry && (entry.timer = null)
      return
    }
    const delta = entry.buffer
    entry.buffer = ""
    await Session.updatePart({ part: entry.part, delta })
    entry.timer = null
  }
}

