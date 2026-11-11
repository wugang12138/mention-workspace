import type { ProbeResult } from "./shared"
import { forEachSseData } from "./sse"
import type { TurnInput } from "./openai"
import { workspaceSystemPrompt } from "./prompt"
import type { ToolCatalog } from "./tools"

export async function probeAnthropic(input: {
  baseURL?: string
  apiKey: string
  model: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<ProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(`${root(input.baseURL)}/v1/messages`, {
      method: "POST",
      headers: headers(input.apiKey),
      body: JSON.stringify({
        model: input.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }]
      }),
      signal: input.signal
    })
    if (response.status === 401 || response.status === 403) return "unauthorized"
    return response.ok ? "ok" : "unreachable"
  } catch {
    return "unreachable"
  }
}

export async function* completeAnthropic(turn: TurnInput, fetchImpl: typeof fetch = fetch, catalog?: ToolCatalog): AsyncGenerator<string> {
  const messages = toAnthropicMessages(turn)
  for (let round = 0; round < 4; round += 1) {
    const blocks = await streamAnthropic(turn, messages, fetchImpl, catalog)
    if (blocks.text) yield blocks.text
    if (!catalog || blocks.tools.length === 0) return
    messages.push({ role: "assistant", content: blocks.raw })
    messages.push({
      role: "user",
      content: await Promise.all(blocks.tools.map(async (tool) => ({
        type: "tool_result",
        tool_use_id: tool.id,
        content: await catalog.call(tool.name, parseJson(tool.input), turn.signal)
      })))
    })
  }
}

function toAnthropicMessages(turn: TurnInput): { role: "user" | "assistant"; content: unknown }[] {
  const messages: { role: "user" | "assistant"; content: unknown }[] = []
  for (const item of turn.history.slice(-30)) {
    const role = item.authorKind === "agent" && item.authorHandle === turn.handle ? "assistant" : "user"
    const content = role === "assistant" ? item.text : `[${item.authorHandle}]\n${item.text}`
    const previous = messages.at(-1)
    if (previous && previous.role === role && typeof previous.content === "string") previous.content += `\n\n${content}`
    else messages.push({ role, content })
  }
  if (messages[0]?.role === "assistant") messages.unshift({ role: "user", content: "以下是已经发生的对话。" })
  if (messages.at(-1)?.role !== "user") messages.push({ role: "user", content: "请回复。" })
  return messages
}

async function streamAnthropic(turn: TurnInput, messages: { role: string; content: unknown }[], fetchImpl: typeof fetch, catalog?: ToolCatalog) {
  const response = await fetchImpl(`${root(turn.baseURL)}/v1/messages`, {
    method: "POST",
    headers: headers(turn.apiKey),
    body: JSON.stringify({
      model: turn.model,
      max_tokens: 4096,
      stream: true,
      system: workspaceSystemPrompt(turn),
      messages,
      tools: catalog?.definitions.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
    }),
    signal: turn.signal
  })
  if (response.status === 401 || response.status === 403) throw new Error("API Key 未被接受")
  if (!response.ok || !response.body) throw new Error(`模型接口返回 ${response.status}`)
  let text = ""
  const tools: { id: string; name: string; input: string }[] = []
  const raw: unknown[] = []
  await forEachSseData(response.body, (data) => {
    const event = JSON.parse(data) as {
      type?: string
      content_block?: { type?: string; id?: string; name?: string; text?: string }
      delta?: { type?: string; text?: string; partial_json?: string }
    }
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      tools.push({ id: event.content_block.id ?? crypto.randomUUID(), name: event.content_block.name ?? "", input: "" })
      raw.push({ type: "tool_use", id: tools.at(-1)?.id, name: tools.at(-1)?.name, input: {} })
    } else if (event.type === "content_block_start" && event.content_block?.type === "text") {
      raw.push({ type: "text", text: "" })
    } else if (event.delta?.type === "text_delta" && event.delta.text) {
      text += event.delta.text
      const block = raw.at(-1) as { text?: string } | undefined
      if (block) block.text = `${block.text ?? ""}${event.delta.text}`
    } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
      const tool = tools.at(-1)
      if (tool) tool.input += event.delta.partial_json
    }
  })
  for (const tool of tools) {
    const block = [...raw].reverse().find((item) => (item as { id?: string }).id === tool.id) as { input?: unknown } | undefined
    if (block) block.input = parseJson(tool.input)
  }
  return { text, tools, raw }
}

function headers(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  }
}

function root(baseURL?: string): string {
  return (baseURL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "").replace(/\/v1$/, "")
}

function parseJson(input: string): unknown {
  try {
    return input ? JSON.parse(input) : {}
  } catch {
    return {}
  }
}
