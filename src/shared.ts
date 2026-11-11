export type AuthorKind = "human" | "agent" | "system"
export type AdapterKind = "openai_compat" | "anthropic" | "gemini" | "process" | "http" | "a2a" | "echo"
export type RuntimeStatus = "idle" | "running" | "failed" | "unavailable"
export type WakeStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "skipped"
export type ProbeResult = "ok" | "unauthorized" | "unreachable"

export type PublicRoom = {
  id: string
  name: string
  goal: string
  scratchpad: string
}

export type PublicAgent = {
  id: string
  handle: string
  displayName: string
  adapterKind: AdapterKind
  model: string
  baseURL: string
  command: string
  args: string
  cwd: string
  endpoint: string
  cardUrl: string
  mcpUrl: string
  hasSecret: boolean
  fingerprint: string
  systemPrompt: string
  runtimeStatus: RuntimeStatus
}

export type PublicArtifact = {
  id: string
  messageId: string
  path: string
  content: string
  createdAt: string
}

export type RoomSummary = {
  id: string
  name: string
}

export type PublicMessage = {
  id: string
  authorKind: AuthorKind
  authorId: string
  authorHandle: string
  displayName: string
  text: string
  waitHuman: boolean
  createdAt: string
}

export type PublicWakeup = {
  id: string
  chainId: string
  messageId: string
  agentId: string
  handle: string
  parentWakeupId: string | null
  hop: number
  status: WakeStatus
  reason: string
  error: string
  createdAt: string
  finishedAt: string | null
}

export type PublicDraft = {
  wakeupId: string
  text: string
}

export type RoomState = {
  room: PublicRoom
  rooms: RoomSummary[]
  agents: PublicAgent[]
  messages: PublicMessage[]
  wakeups: PublicWakeup[]
  drafts: PublicDraft[]
  artifacts: PublicArtifact[]
}

export type ServerEvent =
  | { type: "message.created"; roomId: string; message: PublicMessage }
  | { type: "wakeup.upsert"; roomId: string; wakeup: PublicWakeup }
  | { type: "wakeup.delta"; roomId: string; wakeupId: string; text: string }
  | { type: "wakeup.finished"; roomId: string; wakeup: PublicWakeup; message: PublicMessage | null }
  | { type: "agent.updated"; roomId: string; agent: PublicAgent }
  | { type: "room.updated"; roomId: string; room: PublicRoom }
  | { type: "artifact.created"; roomId: string; artifact: PublicArtifact }

export const MAX_HOP = 4
export const RESERVED_HANDLES = ["human", "all", "system", "me"] as const
