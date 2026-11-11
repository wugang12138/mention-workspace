import type { AuthorKind, ProbeResult } from "./shared"

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
  const system = [
    turn.systemPrompt.trim() || `你是 ${turn.handle}。`,
    turn.roomGoal.trim() ? `房间目标：${turn.roomGoal.trim()}` : "",
    turn.scratchpad.trim() ? `共享备忘：\n${turn.scratchpad.trim()}` : "",
    [
      "你只有在被 @ 到时才会被调用。",
      "需要其他成员继续时，在回复正文里写 @handle。",
      "不需要别人时不要写 @。",
      "不要写 @all。代码块和 <thinking> 里的 @ 不会叫醒任何人。",
      "把事情交还给人时写 @human。",
      `你被 ${turn.triggerAuthor} 点名。请只回复这件事。`
    ].join("")
  ]
    .filter(Boolean)
    .join("\n\n")

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

export async function* completeOpenAI(turn: TurnInput, fetchImpl: typeof fetch = fetch): AsyncGenerator<string> {
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
      messages: buildChatMessages(turn)
    }),
    signal: turn.signal
  })

  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error("API Key 未被接受"), { probe: "unauthorized" })
  }
  if (!response.ok) {
    throw Object.assign(new Error(`模型接口返回 ${response.status}`), { probe: "unreachable" })
  }
  if (!response.body) throw Object.assign(new Error("模型接口没有返回内容"), { probe: "unreachable" })

  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as { choices?: { message?: { content?: string } }[] }
    const text = json.choices?.[0]?.message?.content ?? ""
    if (text) yield text
    return
  }

  yield* readContentStream(response.body)
}

async function* readContentStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const piece = contentFromSseLine(line)
        if (piece === null) return
        if (piece) yield piece
        newline = buffer.indexOf("\n")
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function contentFromSseLine(line: string): string | null | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) return undefined
  const data = trimmed.slice(5).trim()
  if (data === "[DONE]") return null
  try {
    const json = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }
    return json.choices?.[0]?.delta?.content ?? ""
  } catch {
    return undefined
  }
}
