import { useEffect, useMemo, useRef, useState } from "react"
import type { AdapterKind, PublicAgent, PublicArtifact, PublicMessage, RoomState, ServerEvent } from "@shared"
import { activateRoom, cancelWakeup, createAgent, createDemoPair, createRoom, loadState, openEvents, postMessage, removeAgent, saveRoom } from "./api"

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
  const [roomName, setRoomName] = useState("")
  const [goal, setGoal] = useState("")
  const [scratchpad, setScratchpad] = useState("")
  const logRef = useRef<HTMLDivElement>(null)
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
              if (cancelled) return
              setState(next)
              setLoadError("")
            })
            .catch(() => {
              if (!cancelled) setLoadError("和房间服务断开了。刷新页面再试。")
            })
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
    const node = logRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [state?.messages.length, state?.drafts])

  const token = useMemo(() => mentionToken(draft, cursor), [draft, cursor])
  const options = useMemo(() => {
    if (!token || !state) return []
    return state.agents.map((agent) => agent.handle).filter((handle) => handle.startsWith(token.query))
  }, [token, state])

  useEffect(() => setMenuIndex(0), [token?.query, options.length])

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setDraft("")
    setCursor(0)
    try {
      await postMessage(text)
      setLoadError("")
    } catch (error) {
      setDraft(text)
      setLoadError(error instanceof Error ? error.message : "没有发出去")
    } finally {
      setSending(false)
      composerRef.current?.focus()
    }
  }

  function insertHandle(handle: string) {
    if (!handle) return
    const start = token?.start ?? cursor
    const next = `${draft.slice(0, start)}@${handle} ${draft.slice(cursor)}`
    const caret = start + handle.length + 2
    setDraft(next)
    setCursor(caret)
    requestAnimationFrame(() => {
      composerRef.current?.focus()
      composerRef.current?.setSelectionRange(caret, caret)
    })
  }

  async function useRoom(next: RoomState) {
    skipSave.current = true
    setGoal(next.room.goal)
    setScratchpad(next.room.scratchpad)
    setState(next)
    setLoadError("")
  }

  if (loadError && !state) {
    return (
      <main className="boot">
        <h1>工作区</h1>
        <p>{loadError}</p>
      </main>
    )
  }

  if (!state) {
    return (
      <main className="boot" aria-busy="true">
        <p>正在打开群聊</p>
      </main>
    )
  }

  const notices = state.wakeups.filter((wakeup) => wakeup.status === "failed" || wakeup.status === "cancelled")

  return (
    <div className="app">
      <p className="sr">群聊。只有消息里写明的成员会回复。</p>
      <header className="top">
        <div>
          <h1>{state.room.name}</h1>
          <p className="quiet">点一个人的名字，或在下面写 @handle。</p>
          <div className="tools">
            <label className="sr" htmlFor="room-switch">房间</label>
            <select id="room-switch" value={state.room.id} onChange={(event) => void activateRoom(event.target.value).then(useRoom).catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "没有切换房间"))}>
              {state.rooms.map((room) => (
                <option key={room.id} value={room.id}>{room.name}</option>
              ))}
            </select>
            <input aria-label="新房间" value={roomName} placeholder="新房间" onChange={(event) => setRoomName(event.target.value)} />
            <button type="button" onClick={() => {
              const name = roomName.trim()
              if (!name) return
              setRoomName("")
              void createRoom(name).then(useRoom).catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "没有建成房间"))
            }}>新建房间</button>
            <button type="button" onClick={() => setFormOpen((open) => !open)}>{formOpen ? "收起接入" : "接入成员"}</button>
            <button type="button" onClick={() => void createDemoPair().then(setState).catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "没有放进演示成员"))}>放入回声</button>
          </div>
        </div>
        <ul className="people">
          {state.agents.length === 0 ? <li className="quiet">还没有成员</li> : state.agents.map((agent) => (
            <li key={agent.id}>
              <button type="button" data-running={agent.runtimeStatus === "running"} onClick={() => insertHandle(agent.handle)}>
                {agent.displayName}
                {agent.runtimeStatus === "running" ? " · 生成中" : ""}
              </button>
            </li>
          ))}
        </ul>
      </header>

      {formOpen ? (
        <AgentForm
          busy={formBusy}
          error={formError}
          agents={state.agents}
          onRemove={async (agent) => {
            await removeAgent(agent.id)
            setState((current) => current ? { ...current, agents: current.agents.filter((item) => item.id !== agent.id) } : current)
          }}
          onSubmit={async (input) => {
            setFormBusy(true)
            setFormError("")
            try {
              const agent = await createAgent(input)
              setState((current) => current ? { ...current, agents: [...current.agents.filter((item) => item.id !== agent.id), agent] } : current)
              setFormOpen(false)
            } catch (error) {
              setFormError(error instanceof Error ? error.message : "没有接入")
            } finally {
              setFormBusy(false)
            }
          }}
        />
      ) : null}

      <details className="notes">
        <summary>备忘</summary>
        <label htmlFor="goal">房间目标</label>
        <textarea id="goal" rows={2} value={goal} onChange={(event) => setGoal(event.target.value)} />
        <label htmlFor="scratchpad">共享备忘</label>
        <textarea id="scratchpad" rows={3} value={scratchpad} onChange={(event) => setScratchpad(event.target.value)} />
      </details>

      <div className="log" ref={logRef} aria-live="polite">
        {state.messages.length === 0 ? <p className="system">写一句。不写 @ 就只留下，不会全体回复。</p> : null}
        {state.messages.map((message) => (
          <MessageView key={message.id} message={message} artifacts={state.artifacts.filter((artifact) => artifact.messageId === message.id)} />
        ))}
        {notices.map((wakeup) => (
          <p className="system" key={wakeup.id}>
            @{wakeup.handle} {wakeup.status === "cancelled" ? "已停止" : "没有完成"}
            {wakeup.error ? `。${wakeup.error}` : ""}
          </p>
        ))}
        {state.drafts.map((item) => {
          const wakeup = state.wakeups.find((candidate) => candidate.id === item.wakeupId)
          if (!wakeup || wakeup.status === "done") return null
          const agent = state.agents.find((candidate) => candidate.handle === wakeup.handle)
          return (
            <article className="agent" key={item.wakeupId}>
              <p className="who">{agent?.displayName ?? wakeup.handle}</p>
              <p className="body">{stripFiles(item.text) || "正在写"}</p>
              <button type="button" className="file" onClick={() => void cancelWakeup(item.wakeupId)}>停止</button>
            </article>
          )
        })}
      </div>

      {loadError ? <p className="error" style={{ padding: "0 16px" }}>{loadError}</p> : null}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        {options.length > 0 ? (
          <ul className="menu" role="listbox" aria-label="选择要叫醒的成员">
            {options.map((handle, index) => (
              <li key={handle}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === menuIndex}
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
        <label htmlFor="composer">发给这个群</label>
        <textarea
          id="composer"
          ref={composerRef}
          rows={3}
          value={draft}
          placeholder="@grok 看一下登录页的结构"
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
              insertHandle(options[menuIndex] ?? options[0] ?? "")
              return
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="bar">
          <p className="quiet">没写 @ 就只留下，不会全体回复。</p>
          <button type="submit" disabled={sending || draft.trim().length === 0}>发送</button>
        </div>
      </form>
    </div>
  )
}

function MessageView({ message, artifacts }: { message: PublicMessage; artifacts: PublicArtifact[] }) {
  if (message.authorKind === "system") return <p className="system">{message.text}</p>
  const text = stripFiles(message.text)
  return (
    <article className={message.authorKind === "human" ? "mine" : "agent"}>
      <p className="who">{message.authorKind === "human" ? "我" : message.displayName}{message.waitHuman ? " · 等你" : ""}</p>
      {text ? <RichText text={text} /> : null}
      {artifacts.map((artifact) => <FileChip key={artifact.id} artifact={artifact} />)}
    </article>
  )
}

function FileChip({ artifact }: { artifact: PublicArtifact }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="file" onClick={() => setOpen((value) => !value)}>
        {open ? "收起" : "打开"} {artifact.path}
      </button>
      {open ? <pre className="file-body">{artifact.content}</pre> : null}
    </>
  )
}

function RichText({ text }: { text: string }) {
  const parts = text.split(/(@[A-Za-z0-9_-]{2,32})/g)
  return (
    <p className="body">
      {parts.map((part, index) => part.startsWith("@") ? <span className="mention" key={`${part}-${index}`}>{part}</span> : <span key={`${index}-${part.slice(0, 12)}`}>{part}</span>)}
    </p>
  )
}

function stripFiles(text: string) {
  return text.replace(/```file[ \t]+[^\n]+\n[\s\S]*?```/g, "").trim()
}

type AgentDraft = {
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
  agents,
  onSubmit,
  onRemove
}: {
  busy: boolean
  error: string
  agents: PublicAgent[]
  onSubmit: (input: AgentDraft) => Promise<void>
  onRemove: (agent: PublicAgent) => Promise<void>
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
      className="panel"
      onSubmit={(event) => {
        event.preventDefault()
        void onSubmit({ handle, displayName, adapterKind, baseURL, model, apiKey, systemPrompt, command, args, cwd, endpoint, cardUrl, mcpUrl })
      }}
    >
      <label htmlFor="adapter-kind">接入方式</label>
      <select id="adapter-kind" value={adapterKind} onChange={(event) => setAdapterKind(event.target.value as AdapterKind)}>
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
      <input id="handle" value={handle} placeholder="grok" onChange={(event) => setHandle(event.target.value)} />
      {usesModel ? (
        <>
          <label htmlFor="base-url">baseURL</label>
          <input id="base-url" value={baseURL} placeholder={adapterKind === "openai_compat" ? "https://api.openai.com/v1" : "可留空，使用官方地址"} onChange={(event) => setBaseURL(event.target.value)} />
          <label htmlFor="model">模型</label>
          <input id="model" value={model} onChange={(event) => setModel(event.target.value)} />
          <label htmlFor="api-key">API Key</label>
          <input id="api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
        </>
      ) : null}
      {adapterKind === "process" ? (
        <>
          <label htmlFor="command">命令</label>
          <input id="command" value={command} placeholder="node" onChange={(event) => setCommand(event.target.value)} />
          <label htmlFor="args">参数</label>
          <input id="args" value={args} onChange={(event) => setArgs(event.target.value)} />
          <label htmlFor="cwd">工作目录</label>
          <input id="cwd" value={cwd} onChange={(event) => setCwd(event.target.value)} />
        </>
      ) : null}
      {adapterKind === "http" ? (
        <>
          <label htmlFor="endpoint">地址</label>
          <input id="endpoint" value={endpoint} placeholder="http://127.0.0.1:9000/agent" onChange={(event) => setEndpoint(event.target.value)} />
          <label htmlFor="http-token">Bearer Token</label>
          <input id="http-token" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
        </>
      ) : null}
      {adapterKind === "a2a" ? (
        <>
          <label htmlFor="card-url">Agent Card</label>
          <input id="card-url" value={cardUrl} onChange={(event) => setCardUrl(event.target.value)} />
          <label htmlFor="a2a-token">Bearer Token</label>
          <input id="a2a-token" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
        </>
      ) : null}
      {adapterKind !== "echo" ? (
        <>
          <label htmlFor="mcp-url">MCP 工具地址</label>
          <input id="mcp-url" value={mcpUrl} placeholder="可留空" onChange={(event) => setMcpUrl(event.target.value)} />
        </>
      ) : null}
      <label htmlFor="system-prompt">系统提示</label>
      <textarea id="system-prompt" rows={3} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} />
      {error ? <p className="error">{error}</p> : null}
      <button type="submit" disabled={busy}>{busy ? "正在检查" : "保存"}</button>
      {agents.length > 0 ? (
        <ul className="people">
          {agents.map((agent) => (
            <li key={agent.id}>
              <button type="button" onClick={() => void onRemove(agent)}>移出 {agent.displayName}</button>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  )
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
      return { ...current, drafts: appendDraft(current.drafts, event.wakeupId, event.text) }
    case "wakeup.finished": {
      const messages = event.message && !current.messages.some((message) => message.id === event.message?.id)
        ? [...current.messages, event.message]
        : current.messages
      return {
        ...current,
        messages,
        wakeups: upsertById(current.wakeups, event.wakeup),
        drafts: current.drafts.filter((item) => item.wakeupId !== event.wakeup.id)
      }
    }
    case "agent.updated": {
      const exists = current.agents.some((agent) => agent.id === event.agent.id)
      const agents = exists ? current.agents.map((agent) => agent.id === event.agent.id ? event.agent : agent) : [...current.agents, event.agent]
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
  return items.map((item) => item.id === next.id ? next : item)
}

function appendDraft(drafts: RoomState["drafts"], wakeupId: string, text: string) {
  const existing = drafts.find((item) => item.wakeupId === wakeupId)
  if (!existing) return [...drafts, { wakeupId, text }]
  return drafts.map((item) => item.wakeupId === wakeupId ? { ...item, text: item.text + text } : item)
}

function mentionToken(text: string, cursor: number) {
  const match = text.slice(0, cursor).match(/(^|[\s(])@([a-zA-Z0-9_-]*)$/)
  if (!match) return null
  const query = match[2].toLowerCase()
  return { query, start: cursor - query.length - 1 }
}
