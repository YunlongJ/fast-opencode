export class WriteOnceGuard {
  private executed = new Map<string, Set<string>>()

  tryMark(sessionID: string, callID: string): boolean {
    let set = this.executed.get(sessionID)
    if (!set) {
      set = new Set()
      this.executed.set(sessionID, set)
    }
    if (set.has(callID)) return false
    set.add(callID)
    return true
  }

  clearSession(sessionID: string): void {
    this.executed.delete(sessionID)
  }
}

