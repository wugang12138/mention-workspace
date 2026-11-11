import { useEffect, useMemo, useRef, useState } from "react"
import type { AdapterKind, PublicAgent, PublicMessage, PublicWakeup, RoomState, ServerEvent, WakeStatus } from "@shared"
import { activateRoom, cancelWakeup, createAgent, createDemoPair, createRoom, loadState, openEvents, postMessage, removeAgent, saveRoom } from "./api"

const WAKE_LABEL: Record<WakeStatus, string> = {
  queued: "排队",
  running: "生成中",
  done: "完成",
  failed: "失败",
  cancelled: "已停止",
  skipped: "未执行"
}

const REASON_LABEL: Record<string, string> = {
  code: "写在代码块里",
  thinking: "写在思考块里",
  self: "点了自己",
  duplicate: "重复点名",
  hop_limit: "超过 4 跳",
  mention: "点名"
}

const STATUS_LABEL = {
  idle: "空闲",
  running: "生成中",
  failed: "失败",
  unavailable: "不可用"
} as const

export function App() {
  const [state, setState] = useState<RoomState | null>(null)
  const [loadError, setLoadError] = useState("")
  const [draft, setDraft] = useState("")
  const [cursor, setCursor] = useState(0)
  const [menuIndex, setMenuIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [formError, setFormError] = useState("")
  const [formBusy, setFormBusy] = useState(false)
  const [goal, setGoal] = useState("")
  const [scratchpad, setScratchpad] = useState("")
  const transcriptRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const hydrated = useRef(false)
  const skipSave = useRef(true)

  useEffect(() => {
    let source: EventSource | null = null
    let cancelled = false
    void loadState()
      .then((initial) => {
        if (cancelled) return
        setState(initial)
        source = openEvents((event) => setState((current) => applyEvent(current, event)))
        source.onerror = () => {
          void loadState()
            .then((next) => {
              if (!cancelled) setState(next)
            })
            .catch(() => setLoadError("和房间服务断开了"))
        }
      })
      .catch(() => setLoadError("房间服务没有启动。在项目目录运行 npm run dev。"))
    return () => {
      cancelled = true
      source?.close()
    }
  }, [])

  useEffect(() => {
    if (!state || hydrated.current) return
    hydrated.current = true
    setGoal(state.room.goal)
    setScratchpad(state.room.scratchpad)
  }, [state])

  useEffect(() => {
    if (!hydrated.current) return
    if (skipSave.current) {
      skipSave.current = false
      return
    }
    const timer = window.setTimeout(() => {
      void saveRoom({ goal, scratchpad }).catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "备忘没有保存")
      })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [goal, scratchpad])

  useEffect(() => {
    const node = transcriptRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [state?.messages.length, state?.drafts])

  const token = useMemo(() => mentionToken(draft, cursor), [draft, cursor])
  const options = useMemo(() => {
    if (!token || !state) return []
    return ["human", ...state.agents.map((agent) => agent.handle)].filter((handle) => handle.startsWith(token.query))
  }, [token, state])

  useEffect(() => setMenuIndex(0), [token?.query, options.length])

  const chain = useMemo(() => {
    if (!state) return []
    const latestHuman = [...state.messages].reverse().find((message) => message.authorKind === "human")
    if (!latestHuman) return []
    return state.wakeups.filter((wakeup) => wakeup.chainId === latestHuman.id)
  }, [state])

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setDraft("")
    setCursor(0)
    try {
      await postMessage(text)
    } catch (error) {
      setDraft(text)
      setLoadError(error instanceof Error ? error.message : "没有发出去")
    } finally {
      setSending(false)
      composerRef.current?.focus()
    }
  }

  function insertHandle(handle: string) {
    if (!token) return
    const next = `${draft.slice(0, token.start)}@${handle} ${draft.slice(cursor)}`
    const caret = token.start + handle.length + 2
    setDraft(next)
    setCursor(caret)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionRange(caret, caret)
    })
  }

  async function onCreate(input: AgentForm) {
    setFormBusy(true)
    setFormError("")
    try {
      const agent = await createAgent(input)
      setState((current) => (current ? { ...current, agents: [...current.agents.filter((item) => item.id !== agent.id), agent] } : current))
      setFormOpen(false)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "没有接入")
    } finally {
      setFormBusy(false)
    }
  }

  async function onDemo() {
    setFormError("")
    try {
      setState(await createDemoPair())
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "没有放进演示成员")
    }
  }

  async function onRemove(agent: PublicAgent) {
    if (!window.confirm(`把 @${agent.handle} 移出工作区？`)) return
    await removeAgent(agent.id)
    setState((current) => (current ? { ...current, agents: current.agents.filter((item) => item.id !== agent.id) } : current))
  }

  if (loadError && !state) {
    return (
      <main className="boot">
        <h1>Mention Workspace</h1>
        <p>{loadError}</p>
      </main>
    )
  }

  if (!state) {
    return (
      <main className="boot" aria-busy="true">
        <p>正在打开工作区</p>
      </main>
    )
  }

  return (
    <div className="shell">
      <aside className="rail">
        <header className="brand">
          <p className="eyebrow">Mention Workspace</p>
          <h1>工作区</h1>
        </header>
        <RoomBar
          roomId={state.room.id}
          rooms={state.rooms}
          onSwitch={async (id) => {
            const next = await activateRoom(id)
            skipSave.current = true
            setGoal(next.room.goal)
            setScratchpad(next.room.scratchpad)
            setState(next)
          }}
          onCreate={async (name) => {
            const next = await createRoom(name)
            skipSave.current = true
            setGoal(next.room.goal)
            setScratchpad(next.room.scratchpad)
            setState(next)
          }}
        />
        <div className="rail-actions">
          <button type="button" className="primary" onClick={() => setFormOpen((open) => !open)}>
            {formOpen ? "收起接入" : "接入 agent"}
          </button>
          <button type="button" onClick={() => void onDemo()}>
            放入回声演示
          </button>
        </div>
        {formOpen ? <AgentForm busy={formBusy} error={formError} onSubmit={onCreate} /> : null}
        <ul className="roster">
          {state.agents.length === 0 ? (
            <li className="empty">还没有成员。接入一个 API Key，或先放入 grok 和 gpt 两个本地回声。</li>
          ) : (
            state.agents.map((agent) => (
              <li key={agent.id}>
                <div className="member">
                  <span className={`status-dot ${agent.runtimeStatus}`} aria-hidden="true" />
                  <div>
                    <strong>{agent.displayName}</strong>
                    <span>@{agent.handle}</span>
                  </div>
                </div>
                <p className="meta">
                  {adapterLabel(agent)}
                  {" · "}
                  {STATUS_LABEL[agent.runtimeStatus]}
                  {agent.fingerprint ? ` · 密钥 ${agent.fingerprint}` : ""}
                </p>
                <button type="button" className="textish" onClick={() => void onRemove(agent)}>
                  移出
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>

      <main className="stage">
        <div className="transcript" ref={transcriptRef} aria-live="polite">
          {state.messages.length === 0 ? (
            <p className="empty-stage">写给工作区。没有 @ 的话会留下，但不会叫醒任何人。</p>
          ) : (
            state.messages.map((message) => <MessageView key={message.id} message={message} />)
          )}
          {state.drafts.map((item) => {
            const wakeup = state.wakeups.find((candidate) => candidate.id === item.wakeupId)
            if (!wakeup || wakeup.status === "done") return null
            return (
              <article key={item.wakeupId} className="bubble agent">
                <header>
                  <strong>@{wakeup.handle}</strong>
                  <span>生成中</span>
                </header>
                <p>{item.text}</p>
                <button type="button" onClick={() => void cancelWakeup(item.wakeupId)}>
                  停止
                </button>
              </article>
            )
          })}
        </div>
        {loadError ? <p className="banner">{loadError}</p> : null}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          {options.length > 0 ? (
            <ul className="mention-menu" role="listbox" aria-label="选择要叫醒的成员">
              {options.map((handle, index) => (
                <li key={handle}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === menuIndex}
                    className={index === menuIndex ? "selected" : ""}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      insertHandle(handle)
                    }}
                  >
                    @{handle}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label htmlFor="composer">发给工作区</label>
          <textarea
            id="composer"
            ref={composerRef}
            value={draft}
            placeholder="用 @handle 叫醒某一个 agent。不写 @ 就只留下笔记。"
            rows={3}
            onChange={(event) => {
              setDraft(event.target.value)
              setCursor(event.target.selectionStart)
            }}
            onClick={(event) => setCursor(event.currentTarget.selectionStart)}
            onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (options.length > 0 && event.key === "ArrowDown") {
                event.preventDefault()
                setMenuIndex((index) => (index + 1) % options.length)
                return
              }
              if (options.length > 0 && event.key === "ArrowUp") {
                event.preventDefault()
                setMenuIndex((index) => (index - 1 + options.length) % options.length)
                return
              }
              if (options.length > 0 && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                event.preventDefault()
                insertHandle(options[menuIndex] ?? options[0])
                return
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <div className="composer-bar">
            <p>一条消息里点到谁，谁才会回复。</p>
            <button type="submit" className="primary" disabled={sending || draft.trim().length === 0}>
              发送
            </button>
          </div>
        </form>
      </main>

      <aside className="side">
        <section>
          <label htmlFor="goal">房间目标</label>
          <textarea id="goal" value={goal} onChange={(event) => setGoal(event.target.value)} rows={4} />
        </section>
        <section>
          <label htmlFor="scratchpad">共享备忘</label>
          <textarea id="scratchpad" value={scratchpad} onChange={(event) => setScratchpad(event.target.value)} rows={8} />
        </section>
        <section>
          <h2>产物</h2>
          {state.artifacts.length === 0 ? (
            <p className="meta">回复里用 ```file 相对路径 交出文件后，会出现在这里。</p>
          ) : (
            state.artifacts.map((artifact) => (
              <details key={artifact.path}>
                <summary>{artifact.path}</summary>
                <pre>{artifact.content}</pre>
              </details>
            ))
          )}
        </section>
        <section>
          <h2>本轮链路</h2>
          {chain.length === 0 ? <p className="meta">还没有人被点名。</p> : <ChainList chain={chain} />}
        </section>
      </aside>
    </div>
  )
}

function MessageView({ message }: { message: PublicMessage }) {
  return (
    <article className={`bubble ${message.authorKind}`}>
      <header>
        <strong>{message.authorKind === "human" ? "我" : message.displayName}</strong>
        {message.authorKind === "agent" ? <span>@{message.authorHandle}</span> : null}
        {message.waitHuman ? <em>等你</em> : null}
      </header>
      <RichText text={message.text} />
    </article>
  )
}

function RichText({ text }: { text: string }) {
  const parts = text.split(/(@[A-Za-z0-9_-]{2,32})/g)
  return (
    <p>
      {parts.map((part, index) =>
        part.startsWith("@") ? (
          <span className="mention" key={`${part}-${index}`}>
            {part}
          </span>
        ) : (
          <span key={`${index}-${part.slice(0, 8)}`}>{part}</span>
        )
      )}
    </p>
  )
}

function ChainList({ chain }: { chain: PublicWakeup[] }) {
  return (
    <ol className="chain">
      {chain.map((wakeup) => (
        <li key={wakeup.id}>
          <span>
            第 {wakeup.hop} 跳 @{wakeup.handle}
          </span>
          <span>
            {WAKE_LABEL[wakeup.status]}
            {wakeup.status === "skipped" && REASON_LABEL[wakeup.reason] ? ` · ${REASON_LABEL[wakeup.reason]}` : ""}
            {wakeup.error ? ` · ${wakeup.error}` : ""}
          </span>
        </li>
      ))}
    </ol>
  )
}

type AgentForm = {
  handle: string
  displayName: string
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

function AgentForm({
  busy,
  error,
  onSubmit
}: {
  busy: boolean
  error: string
  onSubmit: (input: AgentForm) => Promise<void>
}) {
  const [adapterKind, setAdapterKind] = useState<AdapterKind>("openai_compat")
  const [displayName, setDisplayName] = useState("")
  const [handle, setHandle] = useState("")
  const [baseURL, setBaseURL] = useState("")
  const [model, setModel] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [command, setCommand] = useState("")
  const [args, setArgs] = useState("")
  const [cwd, setCwd] = useState("")
  const [endpoint, setEndpoint] = useState("")
  const [cardUrl, setCardUrl] = useState("")
  const [mcpUrl, setMcpUrl] = useState("")
  const [systemPrompt, setSystemPrompt] = useState("")
  const usesModel = adapterKind === "openai_compat" || adapterKind === "anthropic" || adapterKind === "gemini"

  return (
    <form
      className="join"
      onSubmit={(event) => {
        event.preventDefault()
        void onSubmit({ handle, displayName, adapterKind, baseURL, model, apiKey, systemPrompt, command, args, cwd, endpoint, cardUrl, mcpUrl })
      }}
    >
      <label htmlFor="adapter-kind">接入方式</label>
      <select
        id="adapter-kind"
        value={adapterKind}
        onChange={(event) => setAdapterKind(event.target.value as AdapterKind)}
      >
        <option value="openai_compat">OpenAI 兼容 API Key</option>
        <option value="anthropic">Anthropic API Key</option>
        <option value="gemini">Gemini API Key</option>
        <option value="process">本地进程</option>
        <option value="http">HTTP bot</option>
        <option value="a2a">A2A Agent Card</option>
        <option value="echo">本地回声</option>
      </select>
      <label htmlFor="display-name">名字</label>
      <input id="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      <label htmlFor="handle">handle</label>
      <input id="handle" value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="grok" />
      {usesModel ? (
        <>
          <label htmlFor="base-url">baseURL</label>
          <input id="base-url" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder={adapterKind === "openai_compat" ? "https://api.openai.com/v1" : "可留空，使用官方地址"} />
          <label htmlFor="model">模型</label>
          <input id="model" value={model} onChange={(event) => setModel(event.target.value)} />
          <label htmlFor="api-key">API Key</label>
          <input id="api-key" type="password" value={apiKey} autoComplete="off" onChange={(event) => setApiKey(event.target.value)} />
        </>
      ) : null}
      {adapterKind === "process" ? (
        <>
          <label htmlFor="command">命令</label>
          <input id="command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="node" />
          <label htmlFor="args">参数</label>
          <input id="args" value={args} onChange={(event) => setArgs(event.target.value)} />
          <label htmlFor="cwd">工作目录</label>
          <input id="cwd" value={cwd} onChange={(event) => setCwd(event.target.value)} />
        </>
      ) : null}
      {adapterKind === "http" ? (
        <>
          <label htmlFor="endpoint">地址</label>
          <input id="endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://127.0.0.1:9000/agent" />
          <label htmlFor="api-key">Bearer Token</label>
          <input id="api-key" type="password" value={apiKey} autoComplete="off" onChange={(event) => setApiKey(event.target.value)} />
        </>
      ) : null}
      {adapterKind === "a2a" ? (
        <>
          <label htmlFor="card-url">Agent Card</label>
          <input id="card-url" value={cardUrl} onChange={(event) => setCardUrl(event.target.value)} />
          <label htmlFor="api-key">Bearer Token</label>
          <input id="api-key" type="password" value={apiKey} autoComplete="off" onChange={(event) => setApiKey(event.target.value)} />
        </>
      ) : null}
      {adapterKind !== "echo" ? (
        <>
          <label htmlFor="mcp-url">MCP 工具地址</label>
          <input id="mcp-url" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} placeholder="可留空" />
        </>
      ) : null}
      <label htmlFor="system-prompt">系统提示</label>
      <textarea id="system-prompt" rows={3} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} />
      {error ? <p className="form-error">{error}</p> : null}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? "正在检查" : "保存"}
      </button>
    </form>
  )
}

function RoomBar({
  roomId,
  rooms,
  onSwitch,
  onCreate
}: {
  roomId: string
  rooms: RoomState["rooms"]
  onSwitch: (id: string) => Promise<void>
  onCreate: (name: string) => Promise<void>
}) {
  const [name, setName] = useState("")
  return (
    <form
      className="join"
      onSubmit={(event) => {
        event.preventDefault()
        const next = name.trim()
        if (!next) return
        setName("")
        void onCreate(next)
      }}
    >
      <label htmlFor="room-switch">房间</label>
      <select id="room-switch" value={roomId} onChange={(event) => void onSwitch(event.target.value)}>
        {rooms.map((room) => (
          <option key={room.id} value={room.id}>
            {room.name}
          </option>
        ))}
      </select>
      <label htmlFor="room-name">新房间</label>
      <input id="room-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="房间名" />
      <button type="submit">新建房间</button>
    </form>
  )
}

function adapterLabel(agent: PublicAgent): string {
  if (agent.adapterKind === "echo") return "本地回声"
  if (agent.adapterKind === "process") return agent.command || "本地进程"
  if (agent.adapterKind === "http") return "HTTP"
  if (agent.adapterKind === "a2a") return "A2A"
  return agent.model || agent.adapterKind
}

function applyEvent(current: RoomState | null, event: ServerEvent): RoomState | null {
  if (!current || event.roomId !== current.room.id) return current
  switch (event.type) {
    case "message.created":
      if (current.messages.some((message) => message.id === event.message.id)) return current
      return { ...current, messages: [...current.messages, event.message] }
    case "wakeup.upsert":
      return { ...current, wakeups: upsertById(current.wakeups, event.wakeup) }
    case "wakeup.delta":
      return {
        ...current,
        drafts: appendDraft(current.drafts, event.wakeupId, event.text)
      }
    case "wakeup.finished": {
      const messages =
        event.message && !current.messages.some((message) => message.id === event.message?.id)
          ? [...current.messages, event.message]
          : current.messages
      return {
        ...current,
        messages,
        wakeups: upsertById(current.wakeups, event.wakeup),
        drafts: current.drafts.filter((draft) => draft.wakeupId !== event.wakeup.id)
      }
    }
    case "agent.updated": {
      const exists = current.agents.some((agent) => agent.id === event.agent.id)
      const agents = exists
        ? current.agents.map((agent) => (agent.id === event.agent.id ? event.agent : agent))
        : [...current.agents, event.agent]
      return { ...current, agents }
    }
    case "room.updated":
      return { ...current, room: event.room }
    case "artifact.created": {
      const artifacts = current.artifacts.filter((item) => item.path !== event.artifact.path)
      return { ...current, artifacts: [...artifacts, event.artifact] }
    }
    default:
      return current
  }
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id)
  if (index < 0) return [...items, next]
  return items.map((item) => (item.id === next.id ? next : item))
}

function appendDraft(drafts: RoomState["drafts"], wakeupId: string, text: string) {
  const existing = drafts.find((draft) => draft.wakeupId === wakeupId)
  if (!existing) return [...drafts, { wakeupId, text }]
  return drafts.map((draft) => (draft.wakeupId === wakeupId ? { ...draft, text: draft.text + text } : draft))
}

function mentionToken(text: string, cursor: number) {
  const match = text.slice(0, cursor).match(/(^|[\s(])@([a-zA-Z0-9_-]*)$/)
  if (!match) return null
  const query = match[2].toLowerCase()
  return { query, start: cursor - query.length - 1 }
}
