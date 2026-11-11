import { mkdirSync } from "node:fs"
import { serve } from "@hono/node-server"
import { createApp } from "./app"
import { openDatabase } from "./db"
import { createRuntime } from "./runtime"
import { loadMasterKey } from "./secrets"

const dataDir = ".data"
mkdirSync(dataDir, { recursive: true })
const db = openDatabase(`${dataDir}/mention.sqlite`)
const runtime = createRuntime(db, { masterKey: loadMasterKey(`${dataDir}/master.key`) })
const app = createApp(runtime)
const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`mention-workspace http://127.0.0.1:${info.port}`)
})
