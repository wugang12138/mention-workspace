import type { ProbeResult } from "./shared"
import { normalizeHttpUrl } from "./mcp"

type JsonRecord = Record<string, unknown>

export async function probeA2A(input: { cardUrl: string; token?: string; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<ProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const card = await loadCard(input.cardUrl, input.token, input.signal, fetchImpl)
    return typeof card.url === "string" || typeof card.name === "string" ? "ok" : "unreachable"
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message.includes("401") || message.includes("403")) return "unauthorized"
    return "unreachable"
  }
}

export async function completeA2A(input: {
  cardUrl: string
  token?: string
  text: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch
  const card = await loadCard(input.cardUrl, input.token, input.signal, fetchImpl)
  const endpoint = typeof card.url === "string" ? card.url : input.cardUrl
  const response = await fetchImpl(normalizeHttpUrl(endpoint), {
    method: "POST",
    headers: headers(input.token),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message: {
          role: "user",
          messageId: crypto.randomUUID(),
          parts: [{ kind: "text", text: input.text }]
        }
      }
    }),
    signal: input.signal
  })
  if (response.status === 401 || response.status === 403) throw new Error("认证未被接受")
  if (!response.ok) throw new Error(`A2A 返回 ${response.status}`)
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } }
  if (body.error) throw new Error(body.error.message || "A2A 调用失败")
  const text = textFromA2A(body.result)
  if (!text) throw new Error("A2A 没有返回文本")
  return text
}

export function textFromA2A(result: unknown): string {
  const record = result as JsonRecord | undefined
  if (!record) return ""
  const direct = partsText(record.parts)
  if (direct) return direct
  const status = record.status as JsonRecord | undefined
  const statusMessage = status?.message as JsonRecord | undefined
  const fromStatus = partsText(statusMessage?.parts)
  if (fromStatus) return fromStatus
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : []
  const fromArtifacts = artifacts.map((artifact) => partsText((artifact as JsonRecord).parts)).filter(Boolean).join("\n")
  if (fromArtifacts) return fromArtifacts
  const history = Array.isArray(record.history) ? record.history : []
  for (const item of [...history].reverse()) {
    const message = item as JsonRecord
    if (message.role === "agent") {
      const text = partsText(message.parts)
      if (text) return text
    }
  }
  return ""
}

async function loadCard(cardUrl: string, token: string | undefined, signal: AbortSignal | undefined, fetchImpl: typeof fetch): Promise<JsonRecord> {
  const response = await fetchImpl(normalizeHttpUrl(cardUrl), { headers: token ? { authorization: `Bearer ${token}` } : {}, signal })
  if (response.status === 401 || response.status === 403) throw new Error(String(response.status))
  if (!response.ok) throw new Error(`Agent Card 返回 ${response.status}`)
  const card = (await response.json()) as JsonRecord
  if (!card || typeof card !== "object") throw new Error("Agent Card 无法解析")
  return card
}

function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .map((part) => {
      const record = part as JsonRecord
      return typeof record.text === "string" ? record.text : ""
    })
    .filter(Boolean)
    .join("")
}

function headers(token?: string): Record<string, string> {
  const result: Record<string, string> = { "content-type": "application/json" }
  if (token) result.authorization = `Bearer ${token}`
  return result
}
