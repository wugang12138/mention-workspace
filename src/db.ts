import { DatabaseSync } from "node:sqlite"
import type { AdapterKind, AuthorKind, PublicAgent, PublicMessage, PublicRoom, PublicWakeup, RuntimeStatus, WakeStatus } from "./shared"

export type RoomRow = {
  id: string
  name: string
  goal: string
  scratchpad: string
  created_at: string
}

export type AgentRow = {
  id: string
  room_id: string
  handle: string
  display_name: string
  adapter_kind: AdapterKind
  config_json: string
  secret_id: string | null
  system_prompt: string
  runtime_status: RuntimeStatus
  created_at: string
}

export type MessageRow = {
  id: string
  room_id: string
  author_kind: AuthorKind
  author_id: string
  author_handle: string
  text: string
  wait_human: number
  created_at: string
}

export type WakeupRow = {
  id: string
  room_id: string
  chain_id: string
  message_id: string
  agent_id: string
  handle: string
  parent_wakeup_id: string | null
  hop: number
  status: WakeStatus
  reason: string
  error: string | null
  created_at: string
  finished_at: string | null
}

export type SecretRow = {
  id: string
  ciphertext: string
  fingerprint: string
}

const SCHEMA = `
create table if not exists rooms (
  id text primary key,
  name text not null,
  goal text not null default '',
  scratchpad text not null default '',
  created_at text not null
);
create table if not exists secrets (
  id text primary key,
  ciphertext text not null,
  fingerprint text not null,
  created_at text not null
);
create table if not exists agents (
  id text primary key,
  room_id text not null,
  handle text not null,
  display_name text not null,
  adapter_kind text not null,
  config_json text not null,
  secret_id text,
  system_prompt text not null,
  runtime_status text not null,
  created_at text not null,
  unique(room_id, handle)
);
create table if not exists messages (
  id text primary key,
  room_id text not null,
  author_kind text not null,
  author_id text not null,
  author_handle text not null,
  text text not null,
  wait_human integer not null default 0,
  created_at text not null
);
create table if not exists wakeups (
  id text primary key,
  room_id text not null,
  chain_id text not null,
  message_id text not null,
  agent_id text not null,
  handle text not null,
  parent_wakeup_id text,
  hop integer not null,
  status text not null,
  reason text not null,
  error text,
  created_at text not null,
  finished_at text
);
create table if not exists artifacts (
  id text primary key,
  room_id text not null,
  message_id text not null,
  path text not null,
  content text not null,
  created_at text not null
);
`

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec("pragma foreign_keys = on")
  if (path !== ":memory:") db.exec("pragma journal_mode = wal")
  db.exec(SCHEMA)
  return db
}

export function ensureRoom(db: DatabaseSync): RoomRow {
  const existing = db.prepare("select * from rooms limit 1").get() as RoomRow | undefined
  if (existing) return existing
  const row: RoomRow = {
    id: crypto.randomUUID(),
    name: "工作区",
    goal: "",
    scratchpad: "",
    created_at: new Date().toISOString()
  }
  db.prepare("insert into rooms (id, name, goal, scratchpad, created_at) values (?, ?, ?, ?, ?)").run(
    row.id,
    row.name,
    row.goal,
    row.scratchpad,
    row.created_at
  )
  return row
}

export function getRoom(db: DatabaseSync): RoomRow {
  const row = db.prepare("select * from rooms limit 1").get() as RoomRow | undefined
  if (!row) throw new Error("room missing")
  return row
}

export function updateRoom(db: DatabaseSync, patch: { goal?: string; scratchpad?: string }): RoomRow {
  const room = getRoom(db)
  const goal = patch.goal ?? room.goal
  const scratchpad = patch.scratchpad ?? room.scratchpad
  db.prepare("update rooms set goal = ?, scratchpad = ? where id = ?").run(goal, scratchpad, room.id)
  return getRoom(db)
}

export function listAgents(db: DatabaseSync, roomId: string): AgentRow[] {
  return db.prepare("select * from agents where room_id = ? order by rowid").all(roomId) as unknown as AgentRow[]
}

export function getAgent(db: DatabaseSync, id: string): AgentRow | undefined {
  return db.prepare("select * from agents where id = ?").get(id) as AgentRow | undefined
}

export function getAgentByHandle(db: DatabaseSync, roomId: string, handle: string): AgentRow | undefined {
  return db.prepare("select * from agents where room_id = ? and handle = ?").get(roomId, handle) as AgentRow | undefined
}

export function insertSecret(db: DatabaseSync, row: SecretRow & { created_at: string }): void {
  db.prepare("insert into secrets (id, ciphertext, fingerprint, created_at) values (?, ?, ?, ?)").run(
    row.id,
    row.ciphertext,
    row.fingerprint,
    row.created_at
  )
}

export function getSecret(db: DatabaseSync, id: string): SecretRow | undefined {
  return db.prepare("select id, ciphertext, fingerprint from secrets where id = ?").get(id) as SecretRow | undefined
}

export function updateSecret(db: DatabaseSync, id: string, ciphertext: string, fingerprint: string): void {
  db.prepare("update secrets set ciphertext = ?, fingerprint = ? where id = ?").run(ciphertext, fingerprint, id)
}

export function deleteSecret(db: DatabaseSync, id: string): void {
  db.prepare("delete from secrets where id = ?").run(id)
}

export function insertAgent(db: DatabaseSync, row: AgentRow): void {
  db.prepare(
    `insert into agents
      (id, room_id, handle, display_name, adapter_kind, config_json, secret_id, system_prompt, runtime_status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.room_id,
    row.handle,
    row.display_name,
    row.adapter_kind,
    row.config_json,
    row.secret_id,
    row.system_prompt,
    row.runtime_status,
    row.created_at
  )
}

export function updateAgent(db: DatabaseSync, id: string, patch: Partial<AgentRow>): void {
  const current = getAgent(db, id)
  if (!current) throw new Error("agent missing")
  const next = { ...current, ...patch, id: current.id }
  db.prepare(
    `update agents set display_name = ?, config_json = ?, secret_id = ?, system_prompt = ?, runtime_status = ? where id = ?`
  ).run(next.display_name, next.config_json, next.secret_id, next.system_prompt, next.runtime_status, id)
}

export function deleteAgent(db: DatabaseSync, id: string): void {
  db.prepare("delete from agents where id = ?").run(id)
}

export function insertMessage(db: DatabaseSync, row: MessageRow): void {
  db.prepare(
    `insert into messages
      (id, room_id, author_kind, author_id, author_handle, text, wait_human, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.room_id, row.author_kind, row.author_id, row.author_handle, row.text, row.wait_human, row.created_at)
}

export function listMessages(db: DatabaseSync, roomId: string): MessageRow[] {
  return db.prepare("select * from messages where room_id = ? order by rowid").all(roomId) as unknown as MessageRow[]
}

export function insertWakeup(db: DatabaseSync, row: WakeupRow): void {
  db.prepare(
    `insert into wakeups
      (id, room_id, chain_id, message_id, agent_id, handle, parent_wakeup_id, hop, status, reason, error, created_at, finished_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.room_id,
    row.chain_id,
    row.message_id,
    row.agent_id,
    row.handle,
    row.parent_wakeup_id,
    row.hop,
    row.status,
    row.reason,
    row.error,
    row.created_at,
    row.finished_at
  )
}

export function updateWakeup(db: DatabaseSync, id: string, patch: Partial<Pick<WakeupRow, "status" | "error" | "finished_at">>): WakeupRow {
  const current = getWakeup(db, id)
  if (!current) throw new Error("wakeup missing")
  const next = { ...current, ...patch }
  db.prepare("update wakeups set status = ?, error = ?, finished_at = ? where id = ?").run(next.status, next.error, next.finished_at, id)
  return getWakeup(db, id) as WakeupRow
}

export function getWakeup(db: DatabaseSync, id: string): WakeupRow | undefined {
  return db.prepare("select * from wakeups where id = ?").get(id) as WakeupRow | undefined
}

export function listWakeups(db: DatabaseSync, roomId: string): WakeupRow[] {
  return db.prepare("select * from wakeups where room_id = ? order by rowid").all(roomId) as unknown as WakeupRow[]
}

export function agentConfig(row: AgentRow): { baseURL: string; model: string } {
  const parsed = JSON.parse(row.config_json) as { baseURL?: string; model?: string }
  return { baseURL: parsed.baseURL ?? "", model: parsed.model ?? "" }
}

export function toPublicRoom(row: RoomRow): PublicRoom {
  return { id: row.id, name: row.name, goal: row.goal, scratchpad: row.scratchpad }
}

export function toPublicAgent(row: AgentRow, fingerprint: string): PublicAgent {
  const config = agentConfig(row)
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    adapterKind: row.adapter_kind,
    model: config.model,
    baseURL: config.baseURL,
    hasSecret: Boolean(row.secret_id),
    fingerprint,
    systemPrompt: row.system_prompt,
    runtimeStatus: row.runtime_status
  }
}

export function toPublicMessage(row: MessageRow, displayName: string): PublicMessage {
  return {
    id: row.id,
    authorKind: row.author_kind,
    authorId: row.author_id,
    authorHandle: row.author_handle,
    displayName,
    text: row.text,
    waitHuman: row.wait_human === 1,
    createdAt: row.created_at
  }
}

export function toPublicWakeup(row: WakeupRow): PublicWakeup {
  return {
    id: row.id,
    chainId: row.chain_id,
    messageId: row.message_id,
    agentId: row.agent_id,
    handle: row.handle,
    parentWakeupId: row.parent_wakeup_id,
    hop: row.hop,
    status: row.status,
    reason: row.reason,
    error: row.error ?? "",
    createdAt: row.created_at,
    finishedAt: row.finished_at
  }
}
