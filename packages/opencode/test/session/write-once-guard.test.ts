import { describe, expect, test } from "bun:test"
import { WriteOnceGuard } from "../../src/session/engine/write-once-guard"

describe("WriteOnceGuard", () => {
  test("marks callIDs only once per session", () => {
    const g = new WriteOnceGuard()
    expect(g.tryMark("s1", "c1")).toBe(true)
    expect(g.tryMark("s1", "c1")).toBe(false)
    expect(g.tryMark("s1", "c2")).toBe(true)
    expect(g.tryMark("s2", "c1")).toBe(true)
  })

  test("clears per session", () => {
    const g = new WriteOnceGuard()
    expect(g.tryMark("s1", "c1")).toBe(true)
    g.clearSession("s1")
    expect(g.tryMark("s1", "c1")).toBe(true)
  })
})

