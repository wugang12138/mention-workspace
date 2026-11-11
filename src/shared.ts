export type AuthorKind = "human" | "agent" | "system"
export type AdapterKind = "openai_compat" | "echo"
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
  hasSecret: boolean
  fingerprint: string
  systemPrompt: string
  runtimeStatus: RuntimeStatus
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
  agents: PublicAgent[]
  messages: PublicMessage[]
  wakeups: PublicWakeup[]
  drafts: PublicDraft[]
}

export type ServerEvent =
  | { type: "message.created"; message: PublicMessage }
  | { type: "wakeup.upsert"; wakeup: PublicWakeup }
  | { type: "wakeup.delta"; wakeupId: string; text: string }
  | { type: "wakeup.finished"; wakeup: PublicWakeup; message: PublicMessage | null }
  | { type: "agent.updated"; agent: PublicAgent }
  | { type: "room.updated"; room: PublicRoom }

export const MAX_HOP = 4
export const RESERVED_HANDLES = ["human", "all", "system", "me"] as const
