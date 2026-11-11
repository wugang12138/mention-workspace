import type { DatabaseSync } from "node:sqlite"
import {
  agentConfig,
  deleteAgent as deleteAgentRow,
  deleteSecret,
  ensureRoom,
  getAgent,
  getAgentByHandle,
  getRoom,
  getSecret,
  getWakeup,
  insertAgent,
  insertMessage,
  insertSecret,
  insertWakeup,
  listAgents,
  listMessages,
  listWakeups,
  toPublicAgent,
  toPublicMessage,
  toPublicRoom,
  toPublicWakeup,
  updateAgent as updateAgentRow,
  updateRoom as updateRoomRow,
  updateSecret,
  updateWakeup,
  type AgentRow,
  type MessageRow,
  type WakeupRow
} from "./db"
import { ProbeRejected, RequestError } from "./errors"
import { planWakeups } from "./gate"
import { parseMentions } from "./mention"
import { completeOpenAI, normalizeBaseURL, probeOpenAI, type TurnInput } from "./openai"
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
}

export type UpdateAgentInput = {
  displayName?: string
  baseURL?: string
  model?: string
  apiKey?: string
  systemPrompt?: string
}

type RuntimeOptions = {
  masterKey: Buffer
  timeoutMs?: number
  resolveAdapter?: (agent: AgentRow, apiKey: string) => AgentRunner
}

export function createRuntime(db: DatabaseSync, options: RuntimeOptions) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const roomId = ensureRoom(db).id
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
    const room = getRoom(db)
    return {
      room: toPublicRoom(room),
      agents: listAgents(db, room.id).map(presentAgent),
      messages: listMessages(db, room.id).map(presentMessage),
      wakeups: listWakeups(db, room.id).map(toPublicWakeup),
      drafts: Array.from(drafts, ([wakeupId, text]) => ({ wakeupId, text }))
    }
  }

  function setStatus(agentId: string, runtimeStatus: RuntimeStatus) {
    const agent = getAgent(db, agentId)
    if (!agent) return
    updateAgentRow(db, agentId, { runtime_status: runtimeStatus })
    const next = getAgent(db, agentId)
    if (next) emit({ type: "agent.updated", agent: presentAgent(next) })
  }

  function addMessage(row: MessageRow): PublicMessage {
    insertMessage(db, row)
    const message = presentMessage(row)
    emit({ type: "message.created", message })
    return message
  }

  function systemNote(text: string) {
    addMessage({
      id: crypto.randomUUID(),
      room_id: roomId,
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
      const agent = getAgentByHandle(db, roomId, item.handle)
      if (!agent) continue
      const row: WakeupRow = {
        id: crypto.randomUUID(),
        room_id: roomId,
        chain_id: source.author_kind === "human" ? source.id : sourceChainId(source.id, parentWakeupId),
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
      emit({ type: "wakeup.upsert", wakeup: toPublicWakeup(row) })
      rows.push(row)
    }
    return rows
  }

  function sourceChainId(messageId: string, parentWakeupId: string | null): string {
    if (parentWakeupId) return getWakeup(db, parentWakeupId)?.chain_id ?? messageId
    const parent = listWakeups(db, roomId).find((wakeup) => wakeup.message_id === messageId && wakeup.status === "done")
    return parent?.chain_id ?? messageId
  }

  function noteUnansweredHuman(parsed: ReturnType<typeof parseMentions>, queued: number) {
    if (parsed.hasAll) systemNote("@all 不会叫醒所有人。请逐个写 @handle。")
    if (queued > 0 || parsed.addressedHuman) return
    if (parsed.hasAll && parsed.actionable.length === 0 && parsed.ignored.length === 0) return
    if (parsed.actionable.length === 0 && parsed.ignored.length === 0) {
      systemNote("没有点名，没有 agent 被叫醒。")
      return
    }
    if (parsed.actionable.length === 0 && parsed.ignored.length > 0) {
      systemNote("点名写在代码块或思考块里，没有 agent 被叫醒。")
    }
  }

  function resolveRunner(agent: AgentRow, apiKey: string): AgentRunner {
    if (options.resolveAdapter) return options.resolveAdapter(agent, apiKey)
    if (agent.adapter_kind === "echo") {
      return {
        async *complete(turn) {
          const from = turn.triggerAuthor === "human" ? "你" : turn.triggerAuthor
          const text = `收到。我是 ${turn.handle}，这条回复只因为被 ${from} 点名。`
          for (let index = 0; index < text.length; index += 12) {
            if (turn.signal.aborted) throw turn.signal.reason ?? new DOMException("已停止", "AbortError")
            yield text.slice(index, index + 12)
          }
        }
      }
    }
    return {
      complete(turn) {
        return completeOpenAI(turn)
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
      if (failed) emit({ type: "wakeup.finished", wakeup: toPublicWakeup(failed), message: null })
      return []
    }

    updateWakeup(db, id, { status: "running" })
    const running = getWakeup(db, id)
    if (running) emit({ type: "wakeup.upsert", wakeup: toPublicWakeup(running) })
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
      const trigger = listMessages(db, roomId).find((message) => message.id === wakeup.message_id)
      const history = listMessages(db, roomId).map((message) => ({
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
        roomGoal: getRoom(db).goal,
        scratchpad: getRoom(db).scratchpad,
        history,
        triggerAuthor: trigger?.author_handle ?? "human",
        signal
      })) {
        if (signal.aborted) throw signal.reason ?? new DOMException("已停止", "AbortError")
        text += piece
        drafts.set(id, text)
        emit({ type: "wakeup.delta", wakeupId: id, text: piece })
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
      if (finished) emit({ type: "wakeup.finished", wakeup: toPublicWakeup(finished), message })
      return []
    } finally {
      controllers.delete(id)
    }
  }

  async function finishReply(agent: AgentRow, wakeup: WakeupRow, text: string): Promise<string[]> {
    return withLock(chainLocks, wakeup.chain_id, async () => {
      const handles = listAgents(db, roomId).map((item) => item.handle)
      const parsed = parseMentions(text, handles, agent.handle)
      const message = storeAgentText(agent, text, parsed.addressedHuman)
      updateWakeup(db, wakeup.id, { status: "done", error: null, finished_at: new Date().toISOString() })
      setStatus(agent.id, "idle")
      drafts.delete(wakeup.id)
      const done = getWakeup(db, wakeup.id)
      if (done) emit({ type: "wakeup.finished", wakeup: toPublicWakeup(done), message })

      const planned = planWakeups({ actionable: parsed.actionable, ignored: parsed.ignored, hop: wakeup.hop + 1 })
      const replyRow = listMessages(db, roomId).find((item) => item.id === message.id)
      const rows = replyRow ? materialize(planned, replyRow, wakeup.id) : []
      if (parsed.hasAll) systemNote("@all 不会叫醒所有人。请逐个写 @handle。")
      if (planned.some((item) => item.reason === "hop_limit")) {
        systemNote("这条链路已到第 4 跳，之后的点名不再执行。")
      }
      return rows.filter((row) => row.status === "queued").map((row) => row.id)
    })
  }

  function storeAgentText(agent: AgentRow, text: string, waitHuman: boolean): PublicMessage {
    return addMessage({
      id: crypto.randomUUID(),
      room_id: roomId,
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
    const handles = listAgents(db, roomId).map((agent) => agent.handle)
    const parsed = parseMentions(trimmed, handles, null)
    const message = addMessage({
      id: crypto.randomUUID(),
      room_id: roomId,
      author_kind: "human",
      author_id: "human",
      author_handle: "human",
      text: trimmed,
      wait_human: parsed.addressedHuman ? 1 : 0,
      created_at: new Date().toISOString()
    })
    const source = listMessages(db, roomId).find((item) => item.id === message.id)
    if (!source) throw new Error("message missing")
    const planned = planWakeups({ actionable: parsed.actionable, ignored: parsed.ignored, hop: 1 })
    const rows = materialize(planned, source, null)
    noteUnansweredHuman(parsed, rows.filter((row) => row.status === "queued").length)
    if (planned.some((item) => item.reason === "hop_limit")) {
      systemNote("这条链路已到第 4 跳，之后的点名不再执行。")
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
    if (input.adapterKind !== "openai_compat" && input.adapterKind !== "echo") {
      throw new RequestError("不支持的接入方式", 400)
    }
    const prepared = await prepareConnection(input.adapterKind, {
      baseURL: input.baseURL ?? "",
      model: input.model ?? "",
      apiKey: input.apiKey ?? ""
    })
    const row: AgentRow = {
      id: crypto.randomUUID(),
      room_id: roomId,
      handle,
      display_name: displayName,
      adapter_kind: input.adapterKind,
      config_json: JSON.stringify({ baseURL: prepared.baseURL, model: prepared.model }),
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
    emit({ type: "agent.updated", agent })
    return agent
  }

  async function updateAgent(id: string, input: UpdateAgentInput): Promise<PublicAgent> {
    const current = getAgent(db, id)
    if (!current) throw new RequestError("找不到这个 agent", 404)
    const displayName = input.displayName?.trim() || current.display_name
    if (displayName.length > 40) throw new RequestError("请写一个 40 字以内的名字", 400)
    const config = agentConfig(current)
    const nextURL = input.baseURL === undefined ? config.baseURL : input.baseURL
    const nextModel = input.model === undefined ? config.model : input.model
    const nextPrompt = input.systemPrompt === undefined ? current.system_prompt : input.systemPrompt.trim()
    let secretId = current.secret_id
    if (current.adapter_kind === "openai_compat") {
      const stored = current.secret_id ? getSecret(db, current.secret_id) : undefined
      const apiKey = input.apiKey?.trim() || (stored ? decryptSecret(options.masterKey, stored.ciphertext) : "")
      const prepared = await prepareConnection("openai_compat", { baseURL: nextURL, model: nextModel, apiKey })
      if (current.secret_id && prepared.secretId && prepared.secretId !== current.secret_id) {
        deleteSecret(db, prepared.secretId)
        updateSecret(db, current.secret_id, encryptSecret(options.masterKey, apiKey), fingerprintSecret(apiKey))
        secretId = current.secret_id
      } else {
        secretId = prepared.secretId
      }
    }
    updateAgentRow(db, id, {
      display_name: displayName,
      config_json: JSON.stringify({
        baseURL: current.adapter_kind === "openai_compat" ? normalizeBaseURL(nextURL) : "",
        model: nextModel.trim()
      }),
      secret_id: secretId,
      system_prompt: nextPrompt,
      runtime_status: "idle"
    })
    const agent = presentAgent(getAgent(db, id) as AgentRow)
    emit({ type: "agent.updated", agent })
    return agent
  }

  async function prepareConnection(kind: AdapterKind, input: { baseURL: string; model: string; apiKey: string }) {
    if (kind === "echo") return { baseURL: "", model: "", secretId: null as string | null }
    let baseURL = ""
    try {
      baseURL = normalizeBaseURL(input.baseURL)
    } catch (error) {
      throw new RequestError(error instanceof Error ? error.message : "baseURL 不正确", 400)
    }
    const model = input.model.trim()
    const apiKey = input.apiKey.trim()
    if (!model) throw new RequestError("请填写模型名", 400)
    if (!apiKey) throw new RequestError("请填写 API Key", 400)
    const probe = await probeOpenAI({ baseURL, apiKey, model })
    if (probe !== "ok") throw new ProbeRejected(probe)
    const secretId = crypto.randomUUID()
    insertSecret(db, {
      id: secretId,
      ciphertext: encryptSecret(options.masterKey, apiKey),
      fingerprint: fingerprintSecret(apiKey),
      created_at: new Date().toISOString()
    })
    return { baseURL, model, secretId }
  }

  async function probeAgent(id: string) {
    const agent = getAgent(db, id)
    if (!agent) throw new RequestError("找不到这个 agent", 404)
    if (agent.adapter_kind === "echo") return "ok" as const
    const secret = agent.secret_id ? getSecret(db, agent.secret_id) : undefined
    if (!secret) throw new RequestError("还没有 API Key", 400)
    const config = agentConfig(agent)
    const result = await probeOpenAI({
      baseURL: config.baseURL,
      apiKey: decryptSecret(options.masterKey, secret.ciphertext),
      model: config.model
    })
    setStatus(agent.id, result === "ok" ? "idle" : "unavailable")
    return result
  }

  function deleteAgent(id: string) {
    const agent = getAgent(db, id)
    if (!agent) throw new RequestError("找不到这个 agent", 404)
    for (const wakeup of listWakeups(db, roomId)) {
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
      emit({ type: "wakeup.finished", wakeup: toPublicWakeup(next), message: null })
      return
    }
    controllers.get(id)?.abort()
  }

  function updateRoom(patch: { goal?: string; scratchpad?: string }) {
    const room = updateRoomRow(db, {
      goal: patch.goal === undefined ? undefined : String(patch.goal).slice(0, 4000),
      scratchpad: patch.scratchpad === undefined ? undefined : String(patch.scratchpad).slice(0, 8000)
    })
    const pub = toPublicRoom(room)
    emit({ type: "room.updated", room: pub })
    return pub
  }

  async function createDemoPair() {
    const handles = new Set(listAgents(db, roomId).map((agent) => agent.handle))
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
    createDemoPair
  }
}

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
