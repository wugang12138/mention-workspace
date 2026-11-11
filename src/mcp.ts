import type { ProbeResult } from "./shared"
import { forEachSseData } from "./sse"

export type McpTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

type RpcResponse = {
  result?: { tools?: { name?: string; description?: string; inputSchema?: Record<string, unknown> }[]; content?: { type?: string; text?: string }[]; isError?: boolean }
  error?: { message?: string }
}

export async function probeMcp(url: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    normalizeHttpUrl(url)
    await listMcpTools(url, new AbortController().signal, fetchImpl)
    return "ok"
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message.includes("401") || message.includes("403")) return "unauthorized"
    return "unreachable"
  }
}

export async function listMcpTools(url: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<McpTool[]> {
  const session = await openSession(url, signal, fetchImpl)
  const listed = await rpc(url, session, "tools/list", {}, signal, fetchImpl)
  return (listed.result?.tools ?? []).flatMap((tool) => {
    if (!tool.name) return []
    return [{ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? { type: "object", properties: {} } }]
  })
}

export async function callMcpTool(url: string, name: string, args: unknown, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<string> {
  const session = await openSession(url, signal, fetchImpl)
  const called = await rpc(url, session, "tools/call", { name, arguments: args ?? {} }, signal, fetchImpl)
  if (called.error) throw new Error(called.error.message || "MCP 工具调用失败")
  const text = (called.result?.content ?? []).map((part) => part.text ?? "").join("")
  if (called.result?.isError) throw new Error(text || "MCP 工具返回错误")
  return text || "工具没有返回文本"
}

export function normalizeHttpUrl(input: string): string {
  const url = input.trim()
  if (!/^https?:\/\//i.test(url)) throw new Error("地址需要以 http:// 或 https:// 开头")
  return url.replace(/\/+$/, "")
}

async function openSession(url: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  const response = await rpcRaw(url, "", "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mention-workspace", version: "0.2.0" }
  }, signal, fetchImpl)
  const session = response.headers.get("mcp-session-id") ?? ""
  await rpcRaw(url, session, "notifications/initialized", {}, signal, fetchImpl, true)
  return session
}

async function rpc(url: string, session: string, method: string, params: unknown, signal: AbortSignal, fetchImpl: typeof fetch): Promise<RpcResponse> {
  const response = await rpcRaw(url, session, method, params, signal, fetchImpl)
  return readRpc(response)
}

async function rpcRaw(url: string, session: string, method: string, params: unknown, signal: AbortSignal, fetchImpl: typeof fetch, notification = false): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  }
  if (session) headers["mcp-session-id"] = session
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params }
  if (!notification) body.id = crypto.randomUUID()
  const response = await fetchImpl(normalizeHttpUrl(url), { method: "POST", headers, body: JSON.stringify(body), signal })
  if (response.status === 401 || response.status === 403) throw new Error(String(response.status))
  if (!response.ok) throw new Error(`MCP 返回 ${response.status}`)
  return response
}

async function readRpc(response: Response): Promise<RpcResponse> {
  const type = response.headers.get("content-type") ?? ""
  if (!type.includes("text/event-stream") || !response.body) return (await response.json()) as RpcResponse
  let parsed: RpcResponse | null = null
  await forEachSseData(response.body, (data) => {
    parsed = JSON.parse(data) as RpcResponse
  })
  if (!parsed) throw new Error("MCP 没有返回结果")
  return parsed
}
