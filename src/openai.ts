import type { AuthorKind, ProbeResult } from "./shared"
import { workspaceSystemPrompt } from "./prompt"
import type { ToolCatalog } from "./tools"
import { forEachSseData } from "./sse"

export type ChatMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export type TurnInput = {
  handle: string
  systemPrompt: string
  model: string
  baseURL: string
  apiKey: string
  roomGoal: string
  scratchpad: string
  history: { authorKind: AuthorKind; authorHandle: string; text: string }[]
  triggerAuthor: string
  signal: AbortSignal
}

export function normalizeBaseURL(input: string): string {
  let url = input.trim().replace(/\/+$/, "")
  url = url.replace(/\/chat\/completions$/i, "")
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("baseURL 需要以 http:// 或 https:// 开头")
  }
  return url
}

export function buildChatMessages(turn: TurnInput): ChatMessage[] {
  const system = workspaceSystemPrompt(turn)

  const messages: ChatMessage[] = [{ role: "system", content: system }]
  for (const item of turn.history.slice(-30)) {
    if (item.authorKind === "agent" && item.authorHandle === turn.handle) {
      messages.push({ role: "assistant", content: item.text })
    } else {
      messages.push({ role: "user", content: `[${item.authorHandle}]\n${item.text}` })
    }
  }
  if (messages.at(-1)?.role !== "user") {
    messages.push({ role: "user", content: `[${turn.triggerAuthor}] 请回复。` })
  }
  return messages
}

export async function probeOpenAI(input: {
  baseURL: string
  apiKey: string
  model: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<ProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const root = normalizeBaseURL(input.baseURL)
  try {
    const listed = await fetchImpl(`${root}/models`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: input.signal
    })
    if (listed.status === 401 || listed.status === 403) return "unauthorized"
    if (listed.ok) return "ok"
    if (listed.status !== 404 && listed.status !== 405) return "unreachable"
    const chat = await fetchImpl(`${root}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }]
      }),
      signal: input.signal
    })
    if (chat.status === 401 || chat.status === 403) return "unauthorized"
    return chat.ok ? "ok" : "unreachable"
  } catch {
    return "unreachable"
  }
}

type ToolCall = { id: string; name: string; arguments: string }

export async function* completeOpenAI(turn: TurnInput, fetchImpl: typeof fetch = fetch, catalog?: ToolCatalog): AsyncGenerator<string> {
  const messages: Array<ChatMessage | { role: "tool"; tool_call_id: string; content: string }> = buildChatMessages(turn)
  for (let round = 0; round < 4; round += 1) {
    const queue = createTextQueue()
    const stepPromise = streamOpenAI(turn, messages, fetchImpl, catalog, (chunk) => queue.push(chunk)).finally(() => queue.finish())
    for await (const chunk of queue.iterate()) yield chunk
    const step = await stepPromise
    if (!catalog || step.toolCalls.length === 0) return
    messages.push({
      role: "assistant",
      content: step.text,
      tool_calls: step.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }))
    } as ChatMessage)
    for (const call of step.toolCalls) {
      let args: unknown = {}
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {}
      } catch {
        args = {}
      }
      const result = await catalog.call(call.name, args, turn.signal)
      messages.push({ role: "tool", tool_call_id: call.id, content: result })
    }
  }
}

async function streamOpenAI(
  turn: TurnInput,
  messages: unknown[],
  fetchImpl: typeof fetch,
  catalog: ToolCatalog | undefined,
  onText: (chunk: string) => void
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const root = normalizeBaseURL(turn.baseURL)
  const response = await fetchImpl(`${root}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${turn.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: turn.model,
      stream: true,
      messages,
      tools: catalog?.definitions.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      }))
    }),
    signal: turn.signal
  })
  if (response.status === 401 || response.status === 403) throw new Error("API Key 未被接受")
  if (!response.ok || !response.body) throw new Error(`模型接口返回 ${response.status}`)
  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as { choices?: { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[] }
    const message = json.choices?.[0]?.message
    if (message?.content) onText(message.content)
    return {
      text: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).map((call) => ({
        id: call.id ?? crypto.randomUUID(),
        name: call.function?.name ?? "",
        arguments: call.function?.arguments ?? ""
      }))
    }
  }
  let text = ""
  const toolCalls: ToolCall[] = []
  await forEachSseData(response.body, (data) => {
    const json = JSON.parse(data) as {
      choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]
    }
    const delta = json.choices?.[0]?.delta
    if (delta?.content) {
      text += delta.content
      onText(delta.content)
    }
    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0
      const current = toolCalls[index] ?? { id: "", name: "", arguments: "" }
      if (call.id) current.id = call.id
      if (call.function?.name) current.name += call.function.name
      if (call.function?.arguments) current.arguments += call.function.arguments
      toolCalls[index] = current
    }
  })
  return { text, toolCalls: toolCalls.filter((call) => call.name) }
}

function createTextQueue() {
  const items: string[] = []
  let finished = false
  let waiter: (() => void) | null = null
  const wake = () => {
    waiter?.()
    waiter = null
  }
  return {
    push(text: string) {
      if (!text) return
      items.push(text)
      wake()
    },
    finish() {
      finished = true
      wake()
    },
    async *iterate() {
      while (true) {
        const next = items.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (finished) return
        await new Promise<void>((resolve) => {
          waiter = resolve
        })
      }
    }
  }
}

