import { describe, expect, test, beforeEach } from "bun:test"
import { MemoryStore } from "../../src/session/engine/memory-store"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

Log.init({ print: false })

describe("memory.store", () => {
  let store: MemoryStore

  beforeEach(async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        store = new MemoryStore()
        await store.init()
      },
    })
  })

  test("should add and retrieve messages", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const store = new MemoryStore()

        await store.addMessage("user", "How to optimize login?")
        await store.addMessage("assistant", "Use Redis cache for session storage")

        const context = await store.buildContext("login optimization")
        expect(context).toContain("How to optimize login")
        expect(context).toContain("Redis cache")
      },
    })
  })

  test("should add decisions", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const store = new MemoryStore()

        store.addDecision("Use JWT authentication", ["JWT", "authentication"])

        const context = await store.buildContext("auth")
        expect(context).toContain("Use JWT authentication")
      },
    })
  })

  test("should add changes", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const store = new MemoryStore()

        store.addChange("auth.ts", "modify", "Add JWT validation")

        const context = await store.buildContext("auth")
        expect(context).toContain("auth.ts")
        expect(context).toContain("Add JWT validation")
      },
    })
  })

  test("should add and complete todos", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const store = new MemoryStore()

        store.addTodo("Add performance tests")

        let context = await store.buildContext("test")
        expect(context).toContain("Add performance tests")

        store.completeTodo("Add performance tests")

        context = await store.buildContext("test")
        expect(context).not.toContain("Add performance tests")
      },
    })
  })

  test("should limit hot memory size", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const store = new MemoryStore()

        // Add more than MAX_HOT_MESSAGES
        for (let i = 0; i < 25; i++) {
          await store.addMessage("user", `Message ${i}`)
        }

        const context = await store.buildContext("test")
        // Should only contain recent messages
        expect(context).toContain("Message 24")
        expect(context).not.toContain("Message 0")
      },
    })
  })
})
