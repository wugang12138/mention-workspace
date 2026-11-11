import { randomBytes } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import type { DatabaseSync } from "node:sqlite"
import { openDatabase } from "./db"
import { createApp } from "./app"
import { createRuntime, type Runtime } from "./runtime"
import type { TurnInput } from "./openai"

const openDatabases: DatabaseSync[] = []

function setup(script?: (turn: TurnInput) => AsyncIterable<string> | string, timeoutMs = 1000) {
  const db = openDatabase(":memory:")
  openDatabases.push(db)
  const calls: string[] = []
  const runtime = createRuntime(db, {
    masterKey: randomBytes(32),
    timeoutMs,
    resolveAdapter: script
      ? () => ({
          async *complete(turn: TurnInput) {
            calls.push(turn.handle)
            const produced = script(turn)
            if (typeof produced === "string") {
              yield produced
              return
            }
            yield* produced
          }
        })
      : undefined
  })
  return { runtime, calls }
}

async function handles(runtime: Runtime) {
  await runtime.createDemoPair()
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close()
})

describe("runtime", () => {
  it("keeps every agent idle when nobody is mentioned", async () => {
    const { runtime, calls } = setup(() => "不应该被调用")
    await handles(runtime)
    runtime.postHumanMessage("做个登录页")
    await runtime.whenIdle()
    const state = runtime.getState()
    expect(calls).toEqual([])
    expect(state.wakeups.filter((wakeup) => wakeup.status === "done")).toHaveLength(0)
    expect(state.messages.some((message) => message.text.includes("没有点名"))).toBe(true)
  })

  it("wakes only the mentioned agent, then the agent they mention", async () => {
    const { runtime, calls } = setup((turn) => (turn.handle === "grok" ? "结构如下\n@gpt 按这个写" : "界面写好了"))
    await handles(runtime)
    runtime.postHumanMessage("@grok 先给信息架构")
    await runtime.whenIdle()
    expect(calls).toEqual(["grok", "gpt"])
    const done = runtime.getState().wakeups.filter((wakeup) => wakeup.status === "done")
    expect(done.map((wakeup) => wakeup.handle)).toEqual(["grok", "gpt"])
  })

  it("wakes exactly the agents named together", async () => {
    const { runtime, calls } = setup(() => "一个标题")
    await handles(runtime)
    runtime.postHumanMessage("@grok @gpt 各给一个标题")
    await runtime.whenIdle()
    expect(calls.sort()).toEqual(["gpt", "grok"])
    expect(runtime.getState().wakeups.filter((wakeup) => wakeup.status === "done")).toHaveLength(2)
  })

  it("does not follow a mention hidden in a code fence", async () => {
    const { runtime, calls } = setup(() => "```\n@grok\n```")
    await handles(runtime)
    runtime.postHumanMessage("@gpt 给一段示例")
    await runtime.whenIdle()
    expect(calls).toEqual(["gpt"])
    expect(runtime.getState().wakeups.some((wakeup) => wakeup.handle === "grok" && wakeup.status === "done")).toBe(false)
  })

  it("stops a mutual mention chain on the fourth hop", async () => {
    const { runtime, calls } = setup((turn) => (turn.handle === "grok" ? "@gpt 继续" : "@grok 继续"))
    await handles(runtime)
    runtime.postHumanMessage("@grok 开始")
    await runtime.whenIdle()
    expect(calls).toEqual(["grok", "gpt", "grok", "gpt"])
    const state = runtime.getState()
    expect(state.wakeups.some((wakeup) => wakeup.reason === "hop_limit")).toBe(true)
    expect(state.messages.some((message) => message.text.includes("第 4 跳"))).toBe(true)
  })

  it("does not expand @all", async () => {
    const { runtime, calls } = setup(() => "全体回复")
    await handles(runtime)
    runtime.postHumanMessage("@all 看看")
    await runtime.whenIdle()
    expect(calls).toEqual([])
    expect(runtime.getState().messages.some((message) => message.text.includes("@all"))).toBe(true)
  })

  it("stores an OpenAI key outside the public state", async () => {
    const { runtime } = setup()
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response("{}", { status: 200 })
    try {
      await runtime.createAgent({
        handle: "claude",
        displayName: "Claude",
        adapterKind: "openai_compat",
        baseURL: "https://example.test/v1",
        model: "claude-test",
        apiKey: "sk-live-secret"
      })
    } finally {
      globalThis.fetch = original
    }
    const encoded = JSON.stringify(runtime.getState())
    expect(encoded).not.toContain("sk-live-secret")
    expect(runtime.getState().agents[0]?.fingerprint).toHaveLength(4)
  })

  it("does not keep an agent when the probe is rejected", async () => {
    const { runtime } = setup()
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response("no", { status: 401 })
    try {
      await expect(
        runtime.createAgent({
          handle: "claude",
          adapterKind: "openai_compat",
          baseURL: "https://example.test/v1",
          model: "claude-test",
          apiKey: "sk-live-secret"
        })
      ).rejects.toThrow("API Key 未被接受")
    } finally {
      globalThis.fetch = original
    }
    expect(runtime.getState().agents).toHaveLength(0)
  })

  it("keeps a cancelled partial reply and does not route mentions inside it", async () => {
    const { runtime, calls } = setup(async function* (turn) {
      if (turn.handle === "gpt") {
        yield "gpt 不该出现"
        return
      }
      yield "hello @gpt"
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2000)
        turn.signal.addEventListener("abort", () => {
          clearTimeout(timer)
          reject(turn.signal.reason ?? new DOMException("已停止", "AbortError"))
        })
      })
    })
    await runtime.createDemoPair()
    runtime.postHumanMessage("@grok 写一半")
    const running = await waitFor(runtime, (state) => state.drafts.some((draft) => draft.text.includes("@gpt")))
    const wakeup = running.wakeups.find((item) => item.handle === "grok" && item.status === "running")
    expect(wakeup).toBeTruthy()
    runtime.cancelWakeup(wakeup!.id)
    await runtime.whenIdle()
    const state = runtime.getState()
    expect(state.messages.some((message) => message.text.startsWith("hello @gpt"))).toBe(true)
    expect(calls.filter((handle) => handle === "gpt")).toEqual([])
    expect(state.wakeups.some((item) => item.status === "cancelled")).toBe(true)
  })
})

async function waitFor(runtime: Runtime, predicate: (state: ReturnType<Runtime["getState"]>) => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = runtime.getState()
    if (predicate(state)) return state
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for runtime state")
}

describe("http", () => {
  it("hides secrets and records an unmentioned message", async () => {
    const db = openDatabase(":memory:")
    openDatabases.push(db)
    const runtime = createRuntime(db, { masterKey: randomBytes(32) })
    const app = createApp(runtime)
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response("{}", { status: 200 })
    try {
      const created = await app.request("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handle: "grok",
          adapterKind: "openai_compat",
          baseURL: "https://example.test/v1",
          model: "grok-test",
          apiKey: "sk-http-secret"
        })
      })
      expect(created.status).toBe(201)
    } finally {
      globalThis.fetch = original
    }
    const posted = await app.request("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "做个登录页" })
    })
    expect(posted.status).toBe(201)
    await runtime.whenIdle()
    const state = await (await app.request("/api/state")).json()
    expect(JSON.stringify(state)).not.toContain("sk-http-secret")
    expect(state.messages.some((message: { text: string }) => message.text.includes("没有点名"))).toBe(true)
  })
})
