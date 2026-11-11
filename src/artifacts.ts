export type ExtractedArtifact = {
  path: string
  content: string
}

const FILE_FENCE = /```file[ \t]+([^\n]+)\n([\s\S]*?)```/g

export function extractArtifacts(text: string): ExtractedArtifact[] {
  const found: ExtractedArtifact[] = []
  for (const match of text.matchAll(FILE_FENCE)) {
    const path = sanitizeArtifactPath(match[1] ?? "")
    if (!path) continue
    found.push({ path, content: (match[2] ?? "").replace(/\n$/, "") })
  }
  return found
}

export function sanitizeArtifactPath(input: string): string | null {
  const normalized = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "")
  if (!normalized || normalized.length > 180) return null
  if (normalized.startsWith("/") || normalized.includes("..") || /^[a-zA-Z]:/.test(normalized)) return null
  if (!/^[a-zA-Z0-9_./-]+$/.test(normalized)) return null
  return normalized
}
