export type IgnoredMention = {
  handle: string
  reason: "code" | "thinking" | "self" | "duplicate"
}

export type ParseResult = {
  actionable: string[]
  ignored: IgnoredMention[]
  addressedHuman: boolean
  hasAll: boolean
}

type Range = { start: number; end: number; reason: "code" | "thinking" }

const HANDLE_PATTERN = /(?<![A-Za-z0-9_])@([A-Za-z0-9_-]{2,32})(?![A-Za-z0-9_-])/g

export function parseMentions(text: string, knownHandles: Iterable<string>, selfHandle?: string | null): ParseResult {
  const known = new Set(Array.from(knownHandles, (handle) => handle.toLowerCase()))
  const self = selfHandle?.toLowerCase() ?? null
  const ranges = maskRanges(text)
  const actionable: string[] = []
  const ignored: IgnoredMention[] = []
  const seen = new Set<string>()
  let addressedHuman = false
  let hasAll = false

  for (const match of text.matchAll(HANDLE_PATTERN)) {
    const handle = match[1].toLowerCase()
    const start = match.index ?? 0
    const masked = rangeReason(ranges, start)

    if (handle === "all") {
      if (!masked) hasAll = true
      continue
    }

    if (handle === "human") {
      if (!masked) addressedHuman = true
      continue
    }

    if (!known.has(handle)) continue

    if (masked) {
      ignored.push({ handle, reason: masked })
      continue
    }

    if (handle === self) {
      ignored.push({ handle, reason: "self" })
      continue
    }

    if (seen.has(handle)) {
      ignored.push({ handle, reason: "duplicate" })
      continue
    }

    seen.add(handle)
    actionable.push(handle)
  }

  return { actionable, ignored, addressedHuman, hasAll }
}

function maskRanges(text: string): Range[] {
  const ranges: Range[] = []
  let cursor = 0
  while (cursor < text.length) {
    const fence = text.indexOf("```", cursor)
    if (fence < 0) break
    const close = text.indexOf("```", fence + 3)
    if (close < 0) {
      ranges.push({ start: fence, end: text.length, reason: "code" })
      break
    }
    ranges.push({ start: fence, end: close + 3, reason: "code" })
    cursor = close + 3
  }

  const thinking = /<thinking\b[^>]*>[\s\S]*?(?:<\/thinking>|$)/gi
  for (const match of text.matchAll(thinking)) {
    const start = match.index ?? 0
    ranges.push({ start, end: start + match[0].length, reason: "thinking" })
  }
  return ranges
}

function rangeReason(ranges: Range[], index: number): "code" | "thinking" | null {
  const hit = ranges.find((range) => index >= range.start && index < range.end)
  return hit?.reason ?? null
}
