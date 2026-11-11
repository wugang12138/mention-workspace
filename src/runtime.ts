import type { DatabaseSync } from "node:sqlite"
import { completeA2A, probeA2A } from "./a2a"
import { extractArtifacts } from "./artifacts"
import { completeAnthropic, probeAnthropic } from "./anthropic"
import {
  agentConfig,
  deleteAgent as deleteAgentRow,
  deleteSecret,
  ensureRoom,
  getAgent,
  getAgentByHandle,
  getRoomById,
  getSecret,
  getWakeup,
  insertAgent,
  insertArtifact,
  insertMessage,
  insertRoom,
  insertSecret,
  insertWakeup,
  listAgents,
  listArtifacts,
  listMessages,
  listRooms,
  listWakeups,
  readSetting,
  toPublicAgent,
  toPublicArtifact,
  toPublicMessage,
  toPublicRoom,
  toPublicWakeup,
  toRoomSummary,
  updateAgent as updateAgentRow,
  updateRoomById,
  updateWakeup,
  writeSetting,
  type AgentRow,
  type MessageRow,
  type StoredConfig,
  type WakeupRow
} from "./db"
import { ProbeRejected, RequestError } from "./errors"
import { planWakeups } from "./gate"
import { parseMentions } from "./mention"
import { completeGemini, probeGemini } from "./gemini"
import { completeHttp, probeHttp } from "./http-agent"
import { listMcpTools, normalizeHttpUrl, probeMcp, callMcpTool } from "./mcp"
import { completeOpenAI, normalizeBaseURL, probeOpenAI, type TurnInput } from "./openai"
import { completeProcess, probeProcess, splitArgs } from "./process-agent"
import type { ToolCatalog } from "./tools"
import { decryptSecret, encryptSecret, fingerprintSecret } from "./secrets"
import { RESERVED_HANDLES, type AdapterKind, type PublicAgent, type PublicMessage, type RoomState, type RuntimeStatus, type ServerEvent } from "./shared"

type Listener = (event: ServerEvent) => void

type AgentRunner = {
  complete(turn: TurnInput): AsyncIterable<string>
}

export type CreateAgentInput = {
  handle: string
  displayName?: string
  adapterKind: AdapterKind
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
}

export type UpdateAgentInput = {
  displayName?: string
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
}

type RuntimeOptions = {
  masterKey: Buffer
  timeoutMs?: number
  resolveAdapter?: (agent: AgentRow, apiKey: string) => AgentRunner
}

export function createRuntime(db: DatabaseSync, options: RuntimeOptions) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const firstRoom = ensureRoom(db)
  let activeRoomId = readSetting(db, "active_room") ?? firstRoom.id
  if (!getRoomById(db, activeRoomId)) activeRoomId = firstRoom.id
  writeSetting(db, "active_room", activeRoomId)
  const listeners = new Set<Listener>()
  const drafts = new Map<string, string>()
  const controllers = new Map<string, AbortController>()
  const agentLocks = new Map<string, Promise<unknown>>()
  const chainLocks = new Map<string, Promise<unknown>>()
  let inFlight = 0
  const idleWaiters: Array<() => void> = []

  function emit(event: ServerEvent) {
    for (const listener of listeners) listener(event)
  }

  function subscribe(listener: Listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function withLock<T>(locks: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    locks.set(key, run)
    return run
  }

  function track(work: Promise<void>) {
    inFlight += 1
    void work.finally(() => {
      inFlight -= 1
      if (inFlight === 0) {
        const waiters = idleWaiters.splice(0)
        for (const waiter of waiters) waiter()
      }
    })
  }

  function whenIdle(): Promise<void> {
    if (inFlight === 0) return Promise.resolve()
    return new Promise((resolve) => idleWaiters.push(resolve))
  }

  function presentAgent(row: AgentRow): PublicAgent {
    const secret = row.secret_id ? getSecret(db, row.secret_id) : undefined
    return toPublicAgent(row, secret?.fingerprint ?? "")
  }

  function presentMessage(row: MessageRow): PublicMessage {
    return toPublicMessage(row, displayNameFor(row))
  }

  function displayNameFor(row: MessageRow): string {
    if (row.author_kind === "human") return "我"
    if (row.author_kind === "system") return "工作区"
    return getAgent(db, row.author_id)?.display_name ?? row.author_handle
  }

  function getState(): RoomState {
    const room = requireRoom(activeRoomId)
    const artifacts = latestArtifacts(room.id)
    return {
      room: toPublicRoom(room),
      rooms: listRooms(db).map(toRoomSummary),
      agents: listAgents(db, room.id).map(presentAgent),
      messages: listMessages(db, room.id).map(presentMessage),
      wakeups: listWakeups(db, room.id).map(toPublicWakeup),
      drafts: Array.from(drafts, ([wakeupId, text]) => ({ wakeupId, text })),
      artifacts
    }
  }

  function requireRoom(id: string) {
    const room = getRoomById(db, id)
    if (!room) throw new Error("room missing")
    return room
  }

  function latestArtifacts(room: string) {
    const byPath = new Map<string, ReturnType<typeof toPublicArtifact>>()
    for (const row of listArtifacts(db, room)) byPath.set(row.path, toPublicArtifact(row))
    return Array.from(byPath.values())
  }

  function setStatus(agentId: string, runtimeStatus: RuntimeStatus) {
    const agent = getAgent(db, agentId)
    if (!agent) return
    updateAgentRow(db, agentId, { runtime_status: runtimeStatus })
    const next = getAgent(db, agentId)
    if (next) emit({ type: "agent.updated", roomId: next.room_id, agent: presentAgent(next) })
  }

  function addMessage(row: MessageRow): PublicMessage {
    insertMessage(db, row)
    const message = presentMessage(row)
    emit({ type: "message.created", roomId: row.room_id, message })
    return message
  }

  function systemNote(scope: string, text: string) {
    addMessage({
      id: crypto.randomUUID(),
      room_id: scope,
      author_kind: "system",
      author_id: "system",
      author_handle: "system",
      text,
      wait_human: 0,
      created_at: new Date().toISOString()
    })
  }

  function materialize(planned: ReturnType<typeof planWakeups>, source: MessageRow, parentWakeupId: string | null): WakeupRow[] {
    const rows: WakeupRow[] = []
    for (const item of planned) {
      const agent = getAgentByHandle(db, source.room_id, item.handle)
      if (!agent) continue
      const row: WakeupRow = {
        id: crypto.randomUUID(),
        room_id: source.room_id,
        chain_id: source.author_kind === "human" ? source.id : sourceChainId(source.room_id, source.id, parentWakeupId),
        message_id: source.id,
        agent_id: agent.id,
        handle: agent.handle,
        parent_wakeup_id: parentWakeupId,
        hop: item.hop,
        status: item.status,
        reason: item.reason,
        error: null,
        created_at: new Date().toISOString(),
        finished_at: item.status === "skipped" ? new Date().toISOString() : null
      }
      insertWakeup(db, row)
      emit({ type: "wakeup.upsert", roomId: row.room_id, wakeup: toPublicWakeup(row) })
      rows.push(row)
    }
    return rows
  }

  function sourceChainId(scope: string, messageId: string, parentWakeupId: string | null): string {
    if (parentWakeupId) return getWakeup(db, parentWakeupId)?.chain_id ?? messageId
    const parent = listWakeups(db, scope).find((wakeup) => wakeup.message_id === messageId && wakeup.status === "done")
    return parent?.chain_id ?? messageId
  }

  function noteUnansweredHuman(scope: string, parsed: ReturnType<typeof parseMentions>, queued: number) {
    if (parsed.hasAll) systemNote(scope, "@all 不会叫醒所有人。请逐个写 @handle。")
    if (queued > 0 || parsed.addressedHuman) return
    if (parsed.hasAll && parsed.actionable.length === 0 && parsed.ignored.length === 0) return
    if (parsed.actionable.length === 0 && parsed.ignored.length === 0) {
      systemNote(scope, "没有点名，没有人回复。")
      return
    }
    if (parsed.actionable.length === 0 && parsed.ignored.length > 0) {
      systemNote(scope, "点名写在代码块或思考块里，没有 agent 被叫醒。")
    }
  }

  function resolveRunner(agent: AgentRow, apiKey: string): AgentRunner {
    if (options.resolveAdapter) return options.resolveAdapter(agent, apiKey)
    const config = agentConfig(agent)
    return {
      async *complete(turn) {
        const catalog = await catalogFor(config, turn.signal)
        if (agent.adapter_kind === "echo") {
          const from = turn.triggerAuthor === "human" ? "你" : turn.triggerAuthor
          const text = `收到。我是 ${turn.handle}，这条回复只因为被${from}点名。`
          for (let index = 0; index < text.length; index += 12) {
            if (turn.signal.aborted) throw turn.signal.reason ?? new DOMException("已停止", "AbortError")
            yield text.slice(index, index + 12)
          }
          return
        }
        if (agent.adapter_kind === "openai_compat") {
          yield* completeOpenAI({ ...turn, baseURL: config.baseURL, model: config.model, apiKey }, fetch, catalog)
          return
        }
        if (agent.adapter_kind === "anthropic") {
          yield* completeAnthropic({ ...turn, baseURL: config.baseURL, model: config.model, apiKey }, fetch, catalog)
          return
        }
        if (agent.adapter_kind === "gemini") {
          yield* completeGemini({ ...turn, baseURL: config.baseURL, model: config.model, apiKey }, fetch, catalog)
          return
        }
        const payload = turnPayload(turn)
        if (agent.adapter_kind === "process") {
          yield await completeProcess({ command: config.command, args: config.args, cwd: config.cwd, payload, signal: turn.signal })
          return
        }
        if (agent.adapter_kind === "http") {
          yield await completeHttp({ endpoint: config.endpoint, token: apiKey, payload, signal: turn.signal })
          return
        }
        yield await completeA2A({ cardUrl: config.cardUrl, token: apiKey, text: payloadText(turn), signal: turn.signal })
      }
    }
  }

  async function catalogFor(config: StoredConfig, signal: AbortSignal): Promise<ToolCatalog | undefined> {
    if (!config.mcpUrl) return undefined
    const tools = await listMcpTools(config.mcpUrl, signal)
    return {
      definitions: tools,
      call(name, args, callSignal) {
        return callMcpTool(config.mcpUrl, name, args, callSignal)
      }
    }
  }

  function runWakeup(id: string) {
    const wakeup = getWakeup(db, id)
    if (!wakeup || wakeup.status !== "queued") return
    const promise = withLock(agentLocks, wakeup.agent_id, () => executeWakeup(id))
      .then(async (followups) => {
        await Promise.all(followups.map((followup) => Promise.resolve().then(() => runWakeup(followup))))
      })
      .catch((error: unknown) => {
        console.error(error)
      })
    track(promise)
  }

  async function executeWakeup(id: string): Promise<string[]> {
    const wakeup = getWakeup(db, id)
    if (!wakeup || wakeup.status !== "queued") return []
    const agent = getAgent(db, wakeup.agent_id)
    if (!agent) {
      updateWakeup(db, id, { status: "failed", error: "agent 已经不在房间里", finished_at: new Date().toISOString() })
      const failed = getWakeup(db, id)
      if (failed) emit({ type: "wakeup.finished", roomId: failed.room_id, wakeup: toPublicWakeup(failed), message: null })
      return []
    }

    updateWakeup(db, id, { status: "running" })
    const running = getWakeup(db, id)
    if (running) emit({ type: "wakeup.upsert", roomId: running.room_id, wakeup: toPublicWakeup(running) })
    setStatus(agent.id, "running")

    const userAbort = new AbortController()
    controllers.set(id, userAbort)
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([userAbort.signal, timeout])
    let text = ""

    try {
      const secret = agent.secret_id ? getSecret(db, agent.secret_id) : undefined
      const apiKey = secret ? decryptSecret(options.masterKey, secret.ciphertext) : ""
      const config = agentConfig(agent)
      const scope = wakeup.room_id
      const room = requireRoom(scope)
      const trigger = listMessages(db, scope).find((message) => message.id === wakeup.message_id)
      const history = listMessages(db, scope).map((message) => ({
        authorKind: message.author_kind,
        authorHandle: message.author_handle,
        text: message.text
      }))
      const runner = resolveRunner(agent, apiKey)
      for await (const piece of runner.complete({
        handle: agent.handle,
        systemPrompt: agent.system_prompt,
        model: config.model,
        baseURL: config.baseURL,
        apiKey,
        roomGoal: room.goal,
        scratchpad: room.scratchpad,
        history,
        triggerAuthor: trigger?.author_handle ?? "human",
        signal
      })) {
        if (signal.aborted) throw signal.reason ?? new DOMException("已停止", "AbortError")
        text += piece
        drafts.set(id, text)
        emit({ type: "wakeup.delta", roomId: wakeup.room_id, wakeupId: id, text: piece })
      }
      return await finishReply(agent, wakeup, text)
    } catch (error) {
      const timedOut = timeout.aborted
      const cancelled = userAbort.signal.aborted && !timedOut
      let message: PublicMessage | null = null
      if (text.trim()) message = storeAgentText(agent, text, false)
      const status = cancelled ? "cancelled" : "failed"
      const errorText = timedOut ? `超过 ${Math.round(timeoutMs / 1000)} 秒没有返回` : errorTextOf(error)
      updateWakeup(db, id, { status, error: cancelled ? "" : errorText, finished_at: new Date().toISOString() })
      setStatus(agent.id, cancelled ? "idle" : "failed")
      drafts.delete(id)
      const finished = getWakeup(db, id)
      if (finished) emit({ type: "wakeup.finished", roomId: finished.room_id, wakeup: toPublicWakeup(finished), message })
      return []
    } finally {
      controllers.delete(id)
    }
  }

  async function finishReply(agent: AgentRow, wakeup: WakeupRow, text: string): Promise<string[]> {
    return withLock(chainLocks, wakeup.chain_id, async () => {
      const scope = wakeup.room_id
      const handles = listAgents(db, scope).map((item) => item.handle)
      const parsed = parseMentions(text, handles, agent.handle)
      const message = storeAgentText(agent, text, parsed.addressedHuman)
      saveArtifacts(scope, message.id, text)
      updateWakeup(db, wakeup.id, { status: "done", error: null, finished_at: new Date().toISOString() })
      setStatus(agent.id, "idle")
      drafts.delete(wakeup.id)
      const done = getWakeup(db, wakeup.id)
      if (done) emit({ type: "wakeup.finished", roomId: scope, wakeup: toPublicWakeup(done), message })

      const planned = planWakeups({ actionable: parsed.actionable, ignored: parsed.ignored, hop: wakeup.hop + 1 })
      const replyRow = listMessages(db, scope).find((item) => item.id === message.id)
      const rows = replyRow ? materialize(planned, replyRow, wakeup.id) : []
      if (parsed.hasAll) systemNote(scope, "@all 不会叫醒所有人。请逐个写 @handle。")
      if (planned.some((item) => item.reason === "hop_limit")) {
        systemNote(scope, "这条链路已到第 4 跳，之后的点名不再执行。")
      }
      return rows.filter((row) => row.status === "queued").map((row) => row.id)
    })
  }

  function storeAgentText(agent: AgentRow, text: string, waitHuman: boolean): PublicMessage {
    return addMessage({
      id: crypto.randomUUID(),
      room_id: agent.room_id,
      author_kind: "agent",
      author_id: agent.id,
      author_handle: agent.handle,
      text,
      wait_human: waitHuman ? 1 : 0,
      created_at: new Date().toISOString()
    })
  }

  function postHumanMessage(text: string) {
    const trimmed = text.trim()
    if (!trimmed) throw new RequestError("请写一点内容", 400)
    if (trimmed.length > 20_000) throw new RequestError("消息太长", 400)
    const scope = activeRoomId
    const handles = listAgents(db, scope).map((agent) => agent.handle)
    const parsed = parseMentions(trimmed, handles, null)
    const message = addMessage({
      id: crypto.randomUUID(),
      room_id: scope,
      author_kind: "human",
      author_id: "human",
      author_handle: "human",
      text: trimmed,
      wait_human: parsed.addressedHuman ? 1 : 0,
      created_at: new Date().toISOString()
    })
    const source = listMessages(db, scope).find((item) => item.id === message.id)
    if (!source) throw new Error("message missing")
    const planned = planWakeups({ actionable: parsed.actionable, ignored: parsed.ignored, hop: 1 })
    const rows = materialize(planned, source, null)
    noteUnansweredHuman(scope, parsed, rows.filter((row) => row.status === "queued").length)
    if (planned.some((item) => item.reason === "hop_limit")) {
      systemNote(scope, "这条链路已到第 4 跳，之后的点名不再执行。")
    }
    for (const row of rows) {
      if (row.status === "queued") runWakeup(row.id)
    }
    return { message, wakeups: rows.map(toPublicWakeup) }
  }

  async function createAgent(input: CreateAgentInput): Promise<PublicAgent> {
    const handle = input.handle.trim().toLowerCase()
    validateHandle(handle)
    const displayName = (input.displayName ?? handle).trim()
    if (!displayName || displayName.length > 40) throw new RequestError("请写一个 40 字以内的名字", 400)
    const prepared = await prepareConnection(input.adapterKind, input, "")
    const row: AgentRow = {
      id: crypto.randomUUID(),
      room_id: activeRoomId,
      handle,
      display_name: displayName,
      adapter_kind: input.adapterKind,
      config_json: JSON.stringify(prepared.config),
      secret_id: prepared.secretId,
      system_prompt: input.systemPrompt?.trim() ?? "",
      runtime_status: "idle",
      created_at: new Date().toISOString()
    }
    try {
      insertAgent(db, row)
    } catch (error) {
      if (prepared.secretId) deleteSecret(db, prepared.secretId)
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new RequestError("这个 handle 已经在房间里", 409)
      }
      throw error
    }
    const agent = presentAgent(row)
    emit({ type: "agent.updated", roomId: row.room_id, agent })
    return agent
  }

  async function updateAgent(id: string, input: UpdateAgentInput): Promise<PublicAgent> {
    const current = getAgent(db, id)
    if (!current) throw new RequestError("找不到这个 agent", 404)
    const displayName = input.displayName?.trim() || current.display_name
    if (displayName.length > 40) throw new RequestError("请写一个 40 字以内的名字", 400)
    const config = agentConfig(current)
    const stored = current.secret_id ? getSecret(db, current.secret_id) : undefined
    const apiKey = input.apiKey?.trim() || (stored ? decryptSecret(options.masterKey, stored.ciphertext) : "")
    const prepared = await prepareConnection(current.adapter_kind, {
      handle: current.handle,
      adapterKind: current.adapter_kind,
      args: input.args ?? config.args.join(" "),
      baseURL: input.baseURL ?? config.baseURL,
      model: input.model ?? config.model,
      command: input.command ?? config.command,
      cwd: input.cwd ?? config.cwd,
      endpoint: input.endpoint ?? config.endpoint,
      cardUrl: input.cardUrl ?? config.cardUrl,
      mcpUrl: input.mcpUrl ?? config.mcpUrl,
      apiKey
    }, apiKey)
    if (current.secret_id && current.secret_id !== prepared.secretId) deleteSecret(db, current.secret_id)
    updateAgentRow(db, id, {
      display_name: displayName,
      config_json: JSON.stringify(prepared.config),
      secret_id: prepared.secretId,
      system_prompt: input.systemPrompt === undefined ? current.system_prompt : input.systemPrompt.trim(),
      runtime_status: "idle"
    })
    const agent = presentAgent(getAgent(db, id) as AgentRow)
    emit({ type: "agent.updated", roomId: current.room_id, agent })
    return agent
  }

  async function prepareConnection(kind: AdapterKind, input: CreateAgentInput, existingKey = ""): Promise<{ config: StoredConfig; secretId: string | null }> {
    if (!ADAPTERS.has(kind)) throw new RequestError("不支持的接入方式", 400)
    const apiKey = (input.apiKey ?? existingKey).trim()
    const config: StoredConfig = {
      baseURL: "",
      model: input.model?.trim() ?? "",
      command: input.command?.trim() ?? "",
      args: splitArgs(input.args ?? ""),
      cwd: input.cwd?.trim() ?? "",
      endpoint: "",
      cardUrl: "",
      mcpUrl: optionalUrl(input.mcpUrl)
    }
    let probe: "ok" | "unauthorized" | "unreachable" = "ok"
    if (kind === "openai_compat" || kind === "anthropic" || kind === "gemini") {
      if (!config.model) throw new RequestError("请填写模型名", 400)
      if (!apiKey) throw new RequestError("请填写 API Key", 400)
      if (kind === "openai_compat") {
        config.baseURL = safeBaseURL(input.baseURL ?? "")
        probe = await probeOpenAI({ baseURL: config.baseURL, apiKey, model: config.model })
      } else if (kind === "anthropic") {
        config.baseURL = input.baseURL?.trim() ? safeBaseURL(input.baseURL) : ""
        probe = await probeAnthropic({ baseURL: config.baseURL, apiKey, model: config.model })
      } else {
        config.baseURL = input.baseURL?.trim() ? safeBaseURL(input.baseURL) : ""
        probe = await probeGemini({ baseURL: config.baseURL, apiKey, model: config.model })
      }
    } else if (kind === "process") {
      if (!config.command) throw new RequestError("请填写命令", 400)
      probe = await probeProcess(config.command, config.cwd)
    } else if (kind === "http") {
      config.endpoint = mustUrl(input.endpoint, "请填写 HTTP 地址")
      probe = await probeHttp({ endpoint: config.endpoint, token: apiKey })
    } else if (kind === "a2a") {
      config.cardUrl = mustUrl(input.cardUrl, "请填写 Agent Card 地址")
      probe = await probeA2A({ cardUrl: config.cardUrl, token: apiKey })
    }
    if (config.mcpUrl) {
      const mcpProbe = await probeMcp(config.mcpUrl)
      if (mcpProbe !== "ok") throw new ProbeRejected(mcpProbe)
    }
    if (probe !== "ok") throw new ProbeRejected(probe)
    const needsSecret = Boolean(apiKey) && kind !== "echo" && kind !== "process"
    return { config, secretId: needsSecret ? storeSecret(apiKey) : null }
  }

  function storeSecret(apiKey: string): string {
    const secretId = crypto.randomUUID()
    insertSecret(db, {
      id: secretId,
      ciphertext: encryptSecret(options.masterKey, apiKey),
      fingerprint: fingerprintSecret(apiKey),
      created_at: new Date().toISOString()
    })
    return secretId
  }

  async function probeAgent(id: string) {
    const agent = getAgent(db, id)
    if (!agent) throw new RequestError("找不到这个 agent", 404)
    const secret = agent.secret_id ? decryptSecret(options.masterKey, getSecret(db, agent.secret_id)?.ciphertext ?? "") : ""
    const prepared = await prepareConnection(agent.adapter_kind, { ...agentConfig(agent), args: agentConfig(agent).args.join(" "), apiKey: secret, adapterKind: agent.adapter_kind, handle: agent.handle }, secret)
    if (agent.secret_id && agent.secret_id !== prepared.secretId) deleteSecret(db, agent.secret_id)
    updateAgentRow(db, id, { secret_id: prepared.secretId, config_json: JSON.stringify(prepared.config), runtime_status: "idle" })
    setStatus(agent.id, "idle")
    return "ok" as const
  }

  function deleteAgent(id: string) {
    const agent = getAgent(db, id)
    if (!agent) throw new RequestError("找不到这个 agent", 404)
    for (const wakeup of listWakeups(db, agent.room_id)) {
      if (wakeup.agent_id === id && (wakeup.status === "queued" || wakeup.status === "running")) cancelWakeup(wakeup.id)
    }
    deleteAgentRow(db, id)
    if (agent.secret_id) deleteSecret(db, agent.secret_id)
  }

  function cancelWakeup(id: string) {
    const wakeup = getWakeup(db, id)
    if (!wakeup) throw new RequestError("找不到这次唤醒", 404)
    if (wakeup.status === "queued") {
      const next = updateWakeup(db, id, { status: "cancelled", finished_at: new Date().toISOString() })
      emit({ type: "wakeup.finished", roomId: next.room_id, wakeup: toPublicWakeup(next), message: null })
      return
    }
    controllers.get(id)?.abort()
  }

  function updateRoom(patch: { goal?: string; scratchpad?: string; name?: string }) {
    const room = updateRoomById(db, activeRoomId, {
      name: patch.name === undefined ? undefined : String(patch.name).trim().slice(0, 40),
      goal: patch.goal === undefined ? undefined : String(patch.goal).slice(0, 4000),
      scratchpad: patch.scratchpad === undefined ? undefined : String(patch.scratchpad).slice(0, 8000)
    })
    const pub = toPublicRoom(room)
    emit({ type: "room.updated", roomId: room.id, room: pub })
    return pub
  }

  function createRoom(name: string) {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 40) throw new RequestError("请写一个 40 字以内的房间名", 400)
    const row = { id: crypto.randomUUID(), name: trimmed, goal: "", scratchpad: "", created_at: new Date().toISOString() }
    insertRoom(db, row)
    activeRoomId = row.id
    writeSetting(db, "active_room", activeRoomId)
    return getState()
  }

  function switchRoom(id: string) {
    if (!getRoomById(db, id)) throw new RequestError("找不到这个房间", 404)
    activeRoomId = id
    writeSetting(db, "active_room", activeRoomId)
    return getState()
  }

  function saveArtifacts(scope: string, messageId: string, text: string) {
    for (const artifact of extractArtifacts(text)) {
      const row = {
        id: crypto.randomUUID(),
        room_id: scope,
        message_id: messageId,
        path: artifact.path,
        content: artifact.content,
        created_at: new Date().toISOString()
      }
      insertArtifact(db, row)
      emit({ type: "artifact.created", roomId: scope, artifact: toPublicArtifact(row) })
    }
  }

  async function createDemoPair() {
    const handles = new Set(listAgents(db, activeRoomId).map((agent) => agent.handle))
    if (!handles.has("grok")) {
      await createAgent({
        handle: "grok",
        displayName: "Grok",
        adapterKind: "echo",
        systemPrompt: "你是 grok。只回答点名你的内容。"
      })
    }
    if (!handles.has("gpt")) {
      await createAgent({
        handle: "gpt",
        displayName: "GPT",
        adapterKind: "echo",
        systemPrompt: "你是 gpt。只回答点名你的内容。"
      })
    }
    return getState()
  }

  return {
    getState,
    subscribe,
    whenIdle,
    postHumanMessage,
    createAgent,
    updateAgent,
    deleteAgent,
    probeAgent,
    cancelWakeup,
    updateRoom,
    createRoom,
    switchRoom,
    createDemoPair
  }
}

function turnPayload(turn: TurnInput) {
  return {
    handle: turn.handle,
    systemPrompt: turn.systemPrompt,
    roomGoal: turn.roomGoal,
    scratchpad: turn.scratchpad,
    history: turn.history,
    triggerAuthor: turn.triggerAuthor
  }
}

function payloadText(turn: TurnInput): string {
  const trigger = [...turn.history].reverse().find((item) => item.authorHandle === turn.triggerAuthor)
  return [`你被 ${turn.triggerAuthor} 点名。`, trigger?.text ?? "", turn.roomGoal ? `房间目标：${turn.roomGoal}` : ""].filter(Boolean).join("\n\n")
}

function safeBaseURL(input: string): string {
  try {
    return normalizeBaseURL(input)
  } catch (error) {
    throw new RequestError(error instanceof Error ? error.message : "地址不正确", 400)
  }
}

function optionalUrl(input?: string): string {
  const value = input?.trim() ?? ""
  if (!value) return ""
  return mustUrl(value, "MCP 地址不正确")
}

function mustUrl(input: string | undefined, message: string): string {
  try {
    return normalizeHttpUrl(input ?? "")
  } catch {
    throw new RequestError(message, 400)
  }
}

const ADAPTERS = new Set<AdapterKind>(["openai_compat", "anthropic", "gemini", "process", "http", "a2a", "echo"])

function validateHandle(handle: string) {
  if (!/^[a-z0-9_-]{2,32}$/.test(handle)) {
    throw new RequestError("handle 需要 2 到 32 位小写字母、数字、下划线或连字符", 400)
  }
  if ((RESERVED_HANDLES as readonly string[]).includes(handle)) {
    throw new RequestError("这个 handle 被保留了", 400)
  }
}

function errorTextOf(error: unknown): string {
  if (error instanceof Error && error.message && error.name !== "AbortError") return error.message
  return "调用失败"
}

export type Runtime = ReturnType<typeof createRuntime>
