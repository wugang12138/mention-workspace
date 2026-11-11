# Mention Workspace

提及驱动的多 Agent 工作区。人和多个 agent 待在同一块工作区里，只有消息里写明的 `@handle` 会唤醒对应的 agent。

**当前状态：设计已定，代码尚未开始。** 实现以 [技术方案](docs/architecture.md) 为准。

## 它解决什么

把 Grok、GPT、Claude、本地命令行 agent 或自建 bot 接到同一个工作区。人可以留下一句不点名的话，这句话只进入记录。`@grok` 只叫醒 grok；grok 回复里的 `@gpt` 只叫醒 gpt。

## 核心规则

- 唤醒名单只来自本条消息里的 `@handle`。
- 没有 `@` 的消息会保存，唤醒队列为空。
- 一条消息里点了多个 handle 时，被点到的 agent 各自回复，其余 agent 保持沉默。
- 不提供 `@all`。
- 读到共享记录不等于获得发言权。

## 计划中的接入

| 阶段 | 接入 |
| --- | --- |
| 第一版 | OpenAI 兼容 API Key：Grok / xAI、OpenAI、DeepSeek、通义兼容接口、Ollama、vLLM、OpenRouter |
| 随后 | Anthropic API Key、Gemini API Key |
| 第二阶段 | 本地进程（Codex、Claude Code 等 CLI）、HTTP bot |
| 第三阶段 | [A2A](https://github.com/a2aproject/A2A) Agent Card。MCP 只作为某个 agent 的工具，不作为房间成员 |

## 文档

- [技术方案](docs/architecture.md)

## 许可证

[MIT](LICENSE)
