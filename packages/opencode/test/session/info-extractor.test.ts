import { describe, expect, test, beforeEach } from "bun:test"
import { InfoExtractor } from "../../src/session/engine/info-extractor"
import { MemoryStore } from "../../src/session/engine/memory-store"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

Log.init({ print: false })

describe("info.extractor", () => {
  test("should extract decision from user confirmation", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const store = new MemoryStore()
        await store.init()

        InfoExtractor.extract(
          "好的，就用JWT认证",
          "好的，我将使用JWT认证方案",
          [],
          store
        )

        const context = await store.buildContext("auth")
        expect(context).toContain("JWT")
      },
    })
  })

  test("should extract decision from AI response", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const store = new MemoryStore()
        await store.init()

        InfoExtractor.extract(
          "ok",
          "我决定采用Redis缓存方案",
          [],
          store
        )

        const context = await store.buildContext("cache")
        expect(context).toContain("Redis")
      },
    })
  })

  test("should not extract decision when user rejects", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const store = new MemoryStore()
        await store.init()

        InfoExtractor.extract(
          "不行，这个方案不好",
          "好的，那我用OAuth方案",
          [],
          store
        )

        const context = await store.buildContext("auth")
        // Should not contain OAuth because user rejected
        expect(context).not.toContain("OAuth")
      },
    })
  })

  test("should extract todo from user message", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const store = new MemoryStore()
        await store.init()

        InfoExtractor.extract(
          "还要记得做性能测试",
          "好的，我记下了",
          [],
          store
        )

        const context = await store.buildContext("test")
        expect(context).toContain("性能测试")
      },
    })
  })

  test("should extract changes from tool results", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const store = new MemoryStore()
        await store.init()

        InfoExtractor.extract(
          "修改auth.ts",
          "好的，我来修改",
          [
            {
              toolName: "edit",
              toolCallId: "1",
              ok: true,
              input: { file: "auth.ts", oldString: "", newString: "const jwt = {}" },
            },
          ],
          store
        )

        const context = await store.buildContext("auth")
        expect(context).toContain("auth.ts")
      },
    })
  })
})
