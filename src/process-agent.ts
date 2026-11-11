import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import type { ProbeResult } from "./shared"

export function splitArgs(input: string): string[] {
  const args: string[] = []
  for (const match of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    args.push(match[1] ?? match[2] ?? match[3] ?? "")
  }
  return args.filter((item) => item.length > 0)
}

export async function probeProcess(command: string, cwd?: string): Promise<ProbeResult> {
  const executable = command.trim()
  if (!executable || /[|&;<>`$]/.test(executable)) return "unreachable"
  if (cwd?.trim()) {
    try {
      await access(cwd.trim())
    } catch {
      return "unreachable"
    }
  }
  if (executable.includes("/") || executable.includes("\\")) {
    try {
      await access(executable)
      return "ok"
    } catch {
      return "unreachable"
    }
  }
  const checker = process.platform === "win32" ? "where" : "which"
  const exists = await new Promise<boolean>((resolve) => {
    const child = spawn(checker, [executable], { shell: false, windowsHide: true })
    child.on("error", () => resolve(false))
    child.on("close", (code) => resolve(code === 0))
  })
  return exists ? "ok" : "unreachable"
}

export async function completeProcess(input: {
  command: string
  args: string[]
  cwd?: string
  payload: unknown
  signal: AbortSignal
}): Promise<string> {
  const command = input.command.trim()
  if (!command || /[|&;<>`$]/.test(command)) throw new Error("命令不可用")
  const child = spawn(command, input.args, {
    cwd: input.cwd?.trim() || undefined,
    shell: false,
    windowsHide: true,
    signal: input.signal,
    stdio: ["pipe", "pipe", "pipe"]
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })
  child.stdin.end(JSON.stringify(input.payload))
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (exitCode) => resolve(exitCode ?? 1))
  })
  if (code !== 0) throw new Error(stderr.trim().slice(0, 400) || `进程退出码 ${code}`)
  return stdout
}
