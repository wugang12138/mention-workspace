import { describe, expect, it } from "vitest"
import { buildChatMessages, completeOpenAI, normalizeBaseURL, probeOpenAI, type TurnInput } from "./openai"

function turn(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    handle: "grok",
    systemPrompt: "你负责结构。",
    model: "grok-test",
    baseURL: "https://example.test/v1",
    apiKey: "sk-secret",
    roomGoal: "做登录页",
    scratchpad: "",
    history: [{ authorKind: "human", authorHandle: "human", text: "@grok 先给结构" }],
    triggerAuthor: "human",
    signal: new AbortController().signal,
    ...overrides
  }
}

describe("openai adapter", () => {
  it("normalizes a completions URL", () => {
    expect(normalizeBaseURL("https://example.test/v1/chat/completions/")).toBe("https://example.test/v1")
  })

  it("labels other authors and keeps the agent's own turns as assistant", () => {
    const messages = buildChatMessages(
      turn({
        history: [
          { authorKind: "human", authorHandle: "human", text: "@grok 开始" },
          { authorKind: "agent", authorHandle: "grok", text: "先这样" }
        ]
      })
    )
    expect(messages[0]?.role).toBe("system")
    expect(messages[0]?.content).toContain("做登录页")
    expect(messages[1]).toEqual({ role: "user", content: "[human]\n@grok 开始" })
    expect(messages[2]).toEqual({ role: "assistant", content: "先这样" })
    expect(messages.at(-1)?.role).toBe("user")
    expect(JSON.stringify(messages)).not.toContain("sk-secret")
  })

  it("classifies probe responses", async () => {
    const ok = await probeOpenAI({
      baseURL: "https://example.test/v1",
      apiKey: "sk-secret",
      model: "m",
      fetchImpl: async () => new Response("{}", { status: 200 })
    })
    const denied = await probeOpenAI({
      baseURL: "https://example.test/v1",
      apiKey: "sk-secret",
      model: "m",
      fetchImpl: async () => new Response("no", { status: 401 })
    })
    const down = await probeOpenAI({
      baseURL: "https://example.test/v1",
      apiKey: "sk-secret",
      model: "m",
      fetchImpl: async () => {
        throw new Error("offline")
      }
    })
    expect(ok).toBe("ok")
    expect(denied).toBe("unauthorized")
    expect(down).toBe("unreachable")
  })

  it("reads streamed content and ignores the key", async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      }
    })
    let sawKey = false
    const fetchImpl: typeof fetch = async (_url, init) => {
      const headers = new Headers(init?.headers)
      sawKey = headers.get("authorization") === "Bearer sk-secret"
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const parts: string[] = []
    for await (const part of completeOpenAI(turn(), fetchImpl)) parts.push(part)
    expect(parts.join("")).toBe("你好")
    expect(sawKey).toBe(true)
  })
})
