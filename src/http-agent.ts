import type { ProbeResult } from "./shared"
import { normalizeHttpUrl } from "./mcp"

export async function probeHttp(input: { endpoint: string; token?: string; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<ProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(normalizeHttpUrl(input.endpoint), {
      method: "POST",
      headers: headers(input.token),
      body: JSON.stringify({ probe: true }),
      signal: input.signal
    })
    if (response.status === 401 || response.status === 403) return "unauthorized"
    return response.ok ? "ok" : "unreachable"
  } catch {
    return "unreachable"
  }
}

export async function completeHttp(input: {
  endpoint: string
  token?: string
  payload: unknown
  signal: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch
  const response = await fetchImpl(normalizeHttpUrl(input.endpoint), {
    method: "POST",
    headers: headers(input.token),
    body: JSON.stringify(input.payload),
    signal: input.signal
  })
  if (response.status === 401 || response.status === 403) throw new Error("认证未被接受")
  if (!response.ok) throw new Error(`HTTP agent 返回 ${response.status}`)
  const json = (await response.json()) as { text?: string }
  if (typeof json.text !== "string") throw new Error("HTTP agent 没有返回 text")
  return json.text
}

function headers(token?: string): Record<string, string> {
  const result: Record<string, string> = { "content-type": "application/json" }
  if (token) result.authorization = `Bearer ${token}`
  return result
}
