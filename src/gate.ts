import { MAX_HOP } from "./shared"
import type { IgnoredMention } from "./mention"

export type PlannedWakeup = {
  handle: string
  hop: number
  status: "queued" | "skipped"
  reason: "mention" | IgnoredMention["reason"] | "hop_limit"
}

export function planWakeups(input: { actionable: string[]; ignored: IgnoredMention[]; hop: number }): PlannedWakeup[] {
  const planned: PlannedWakeup[] = []
  const queued = new Set<string>()

  for (const handle of input.actionable) {
    if (input.hop > MAX_HOP) {
      planned.push({ handle, hop: input.hop, status: "skipped", reason: "hop_limit" })
      continue
    }
    if (queued.has(handle)) {
      planned.push({ handle, hop: input.hop, status: "skipped", reason: "duplicate" })
      continue
    }
    queued.add(handle)
    planned.push({ handle, hop: input.hop, status: "queued", reason: "mention" })
  }

  for (const item of input.ignored) {
    planned.push({
      handle: item.handle,
      hop: input.hop,
      status: "skipped",
      reason: item.reason
    })
  }

  return planned
}
