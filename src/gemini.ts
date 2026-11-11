import type { ProbeResult } from "./shared"
import { forEachSseData } from "./sse"
import type { TurnInput } from "./openai"
import { workspaceSystemPrompt } from "./prompt"
import type { ToolCatalog } from "./tools"

export async function probeGemini(input: {
  baseURL?: string
  apiKey: string
  model: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<ProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(`${root(input.baseURL)}/v1beta/models/${encodeURIComponent(input.model)}`, {
      headers: { "x-goog-api-key": input.apiKey },
      signal: input.signal
    })
    if (response.status === 401 || response.status === 403 || response.status === 400) return "unauthorized"
    return response.ok ? "ok" : "unreachable"
  } catch {
    return "unreachable"
  }
}

export async function* completeGemini(turn: TurnInput, fetchImpl: typeof fetch = fetch, catalog?: ToolCatalog): AsyncGenerator<string> {
  const contents = toGeminiContents(turn)
  for (let round = 0; round < 4; round += 1) {
    const step = await streamGemini(turn, contents, fetchImpl, catalog)
    if (step.text) yield step.text
    if (!catalog || step.calls.length === 0) return
    contents.push({ role: "model", parts: step.parts })
    contents.push({
      role: "user",
      parts: await Promise.all(step.calls.map(async (call) => ({
        functionResponse: { name: call.name, response: { result: await catalog.call(call.name, call.args, turn.signal) } }
      })))
    })
  }
}

function toGeminiContents(turn: TurnInput): { role: "user" | "model"; parts: unknown[] }[] {
  const contents: { role: "user" | "model"; parts: unknown[] }[] = []
  for (const item of turn.history.slice(-30)) {
    const role = item.authorKind === "agent" && item.authorHandle === turn.handle ? "model" : "user"
    const text = role === "model" ? item.text : `[${item.authorHandle}]\n${item.text}`
    const previous = contents.at(-1)
    if (previous && previous.role === role) previous.parts.push({ text })
    else contents.push({ role, parts: [{ text }] })
  }
  if (contents[0]?.role === "model") contents.unshift({ role: "user", parts: [{ text: "以下是已经发生的对话。" }] })
  if (contents.at(-1)?.role !== "user") contents.push({ role: "user", parts: [{ text: "请回复。" }] })
  return contents
}

async function streamGemini(turn: TurnInput, contents: { role: string; parts: unknown[] }[], fetchImpl: typeof fetch, catalog?: ToolCatalog) {
  const response = await fetchImpl(`${root(turn.baseURL)}/v1beta/models/${encodeURIComponent(turn.model)}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": turn.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: workspaceSystemPrompt(turn) }] },
      contents,
      tools: catalog ? [{ functionDeclarations: catalog.definitions.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] : undefined
    }),
    signal: turn.signal
  })
  if (response.status === 401 || response.status === 403) throw new Error("API Key 未被接受")
  if (!response.ok || !response.body) throw new Error(`模型接口返回 ${response.status}`)
  let text = ""
  const calls: { name: string; args: unknown }[] = []
  const parts: unknown[] = []
  await forEachSseData(response.body, (data) => {
    const json = JSON.parse(data) as { candidates?: { content?: { parts?: { text?: string; functionCall?: { name?: string; args?: unknown } }[] } }[] }
    for (const part of json.candidates?.[0]?.content?.parts ?? []) {
      if (part.text) {
        text += part.text
        parts.push({ text: part.text })
      }
      if (part.functionCall?.name) {
        calls.push({ name: part.functionCall.name, args: part.functionCall.args ?? {} })
        parts.push({ functionCall: part.functionCall })
      }
    }
  })
  return { text, calls, parts }
}

function root(baseURL?: string): string {
  return (baseURL?.trim() || "https://generativelanguage.googleapis.com").replace(/\/+$/, "")
}
