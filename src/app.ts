import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { ProbeRejected, RequestError } from "./errors"
import type { Runtime } from "./runtime"

export function createApp(runtime: Runtime) {
  const app = new Hono()

  app.onError((error, c) => {
    if (error instanceof RequestError) return c.json({ error: error.message }, error.status)
    if (error instanceof ProbeRejected) return c.json({ error: error.message, probe: error.result }, 400)
    console.error(error)
    return c.json({ error: "服务器错误" }, 500)
  })

  app.get("/api/state", (c) => c.json(runtime.getState()))

  app.put("/api/room", async (c) => {
    const body = await c.req.json<{ goal?: string; scratchpad?: string }>()
    return c.json(runtime.updateRoom(body))
  })

  app.post("/api/agents", async (c) => {
    const body = await c.req.json()
    return c.json(await runtime.createAgent(body), 201)
  })

  app.patch("/api/agents/:id", async (c) => {
    const body = await c.req.json()
    return c.json(await runtime.updateAgent(c.req.param("id"), body))
  })

  app.delete("/api/agents/:id", (c) => {
    runtime.deleteAgent(c.req.param("id"))
    return c.body(null, 204)
  })

  app.post("/api/agents/:id/probe", async (c) => {
    const result = await runtime.probeAgent(c.req.param("id"))
    return c.json({ result })
  })

  app.post("/api/rooms", async (c) => {
    const body = await c.req.json<{ name?: string }>()
    return c.json(runtime.createRoom(body.name ?? ""), 201)
  })

  app.post("/api/rooms/:id/activate", (c) => c.json(runtime.switchRoom(c.req.param("id"))))

  app.post("/api/demo-pair", async (c) => c.json(await runtime.createDemoPair()))

  app.post("/api/messages", async (c) => {
    const body = await c.req.json<{ text?: string }>()
    return c.json(runtime.postHumanMessage(body.text ?? ""), 201)
  })

  app.post("/api/wakeups/:id/cancel", (c) => {
    runtime.cancelWakeup(c.req.param("id"))
    return c.json({ ok: true })
  })

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false
      const unsubscribe = runtime.subscribe((event) => {
        if (closed) return
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {
          closed = true
        })
      })
      const abort = () => {
        closed = true
        unsubscribe()
      }
      stream.onAbort(abort)
      while (!closed) {
        await stream.sleep(15_000)
        if (closed) break
        await stream.writeSSE({ event: "ping", data: "{}" })
      }
      unsubscribe()
    })
  })

  return app
}
