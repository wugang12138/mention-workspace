export function workspaceSystemPrompt(turn: {
  handle: string
  systemPrompt: string
  roomGoal: string
  scratchpad: string
  triggerAuthor: string
}): string {
  return [
    turn.systemPrompt.trim() || `你是 ${turn.handle}。`,
    turn.roomGoal.trim() ? `房间目标：${turn.roomGoal.trim()}` : "",
    turn.scratchpad.trim() ? `共享备忘：\n${turn.scratchpad.trim()}` : "",
    [
      "你只有在被 @ 到时才会被调用。",
      "需要其他成员继续时，在回复正文里写 @handle。",
      "不需要别人时不要写 @。",
      "不要写 @all。代码块和 <thinking> 里的 @ 不会叫醒任何人。",
      "把事情交还给人时写 @human。",
      "要交出文件时，使用 ```file 相对路径 开头的围栏，路径里不能有 .. 。",
      `你被 ${turn.triggerAuthor} 点名。请只回复这件事。`
    ].join("")
  ]
    .filter(Boolean)
    .join("\n\n")
}
