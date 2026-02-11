import { MessageV2 } from "../message-v2"
import { SessionRetry } from "../retry"
import { SessionStatus } from "../status"
import { Bus } from "@/bus"
import { Session } from ".."
import { Log } from "@/util/log"

export class RetryHandler {
  private static readonly log = Log.create({ service: "session.processor.retry-handler" })
  private attempt = 0

  constructor(
    private sessionID: string,
    private providerID: string,
    private abort: AbortSignal,
  ) {}

  async handleError(e: any, assistantMessage: MessageV2.Assistant, stopTimers: () => void): Promise<{ shouldContinue: boolean }> {
    RetryHandler.log.error("Handling error", {
      error: e,
      stack: e.stack,
      sessionID: this.sessionID
    })

    const error = MessageV2.fromError(e, { providerID: this.providerID })
    const retry = SessionRetry.retryable(error)

    if (retry !== undefined) {
      this.attempt++
      const delay = SessionRetry.delay(this.attempt, error.name === "APIError" ? error : undefined)
      
      SessionStatus.set(this.sessionID, {
        type: "retry",
        attempt: this.attempt,
        message: retry,
        next: Date.now() + delay,
      })

      await SessionRetry.sleep(delay, this.abort).catch(() => {})
      stopTimers()
      return { shouldContinue: true }
    }

    assistantMessage.error = error
    Bus.publish(Session.Event.Error, {
      sessionID: this.sessionID,
      error: assistantMessage.error,
    })
    SessionStatus.set(this.sessionID, { type: "idle" })
    
    return { shouldContinue: false }
  }

  reset() {
    this.attempt = 0
  }
}
