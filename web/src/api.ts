import type { ProbeResult, PublicAgent, PublicRoom, RoomState, ServerEvent } from "@shared"

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error || `请求失败（${response.status}）`
  } catch {
    return `请求失败（${response.status}）`
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  })
  if (!response.ok) throw new Error(await readError(response))
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export function loadState() {
  return request<RoomState>("/api/state")
}

export function saveRoom(patch: { goal?: string; scratchpad?: string }) {
  return request<PublicRoom>("/api/room", { method: "PUT", body: JSON.stringify(patch) })
}

export function createAgent(input: {
  handle: string
  displayName: string
  adapterKind: PublicAgent["adapterKind"]
  baseURL?: string
  model?: string
  apiKey?: string
  systemPrompt?: string
  command?: string
  args?: string
  cwd?: string
  endpoint?: string
  cardUrl?: string
  mcpUrl?: string
}) {
  return request<PublicAgent>("/api/agents", { method: "POST", body: JSON.stringify(input) })
}

export function removeAgent(id: string) {
  return request<void>(`/api/agents/${id}`, { method: "DELETE" })
}

export function probeAgent(id: string) {
  return request<{ result: ProbeResult }>(`/api/agents/${id}/probe`, { method: "POST" })
}

export function createRoom(name: string) {
  return request<RoomState>("/api/rooms", { method: "POST", body: JSON.stringify({ name }) })
}

export function activateRoom(id: string) {
  return request<RoomState>(`/api/rooms/${id}/activate`, { method: "POST" })
}

export function createDemoPair() {
  return request<RoomState>("/api/demo-pair", { method: "POST" })
}

export function postMessage(text: string) {
  return request<{ message: RoomState["messages"][number] }>("/api/messages", {
    method: "POST",
    body: JSON.stringify({ text })
  })
}

export function cancelWakeup(id: string) {
  return request<{ ok: boolean }>(`/api/wakeups/${id}/cancel`, { method: "POST" })
}

export function openEvents(onEvent: (event: ServerEvent) => void) {
  const source = new EventSource("/api/events")
  const types: ServerEvent["type"][] = [
    "message.created",
    "wakeup.upsert",
    "wakeup.delta",
    "wakeup.finished",
    "agent.updated",
    "room.updated"
  ]
  for (const type of types) {
    source.addEventListener(type, (event) => {
      const message = event as MessageEvent<string>
      onEvent(JSON.parse(message.data) as ServerEvent)
    })
  }
  return source
}
