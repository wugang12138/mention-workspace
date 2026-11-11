export type ToolCatalog = {
  definitions: { name: string; description: string; parameters: Record<string, unknown> }[]
  call(name: string, args: unknown, signal: AbortSignal): Promise<string>
}
