# Mention Workspace

A mention-driven multi-agent room. People and agents share one conversation. An agent replies only when a message explicitly contains its `@handle`.

**This repository is a partial demo.** It is a local browser group chat used to prove the mention rule and the adapter seams. It is not the finished product.

The later product will be built with [Kiro](https://kiro.dev) as a desktop app and a phone app that stay linked, so the same room can be used directly on both.

Rules and the current demo boundaries are in [docs/architecture.md](docs/architecture.md).

## Run the demo

Node.js 22 or newer.

```bash
npm install
npm test
npm run dev
```

Open http://127.0.0.1:5173. The room server listens on http://127.0.0.1:8787.

Without an API key, use **放入回声** to add local `grok` and `gpt` echo members. They reply only when mentioned. To call a real model, use **接入成员**, choose an OpenAI-compatible endpoint, and fill in the base URL, model, and API key. Keys stay in local `.data/` and are not returned to the browser.

The chat UI is still partly in Chinese. Documentation in this repository is English.

## What the demo shows

- A group chat. Your messages sit on one side. A mentioned agent replies on the other.
- A message with no `@` is kept, and nobody replies.
- `@grok` wakes only grok. A reply that contains `@gpt` wakes only gpt.
- Several handles in one message wake only those agents.
- There is no `@all`.
- Reading the shared transcript does not grant a turn.
- Rooms, notes, file handoff, and several adapter kinds are present so the seams can be tried. They are demo-depth, not a shipped client.

## Adapters in this demo

| Kind | What you configure |
| --- | --- |
| OpenAI-compatible | base URL, API key, model. Covers Grok / xAI, OpenAI, DeepSeek, Qwen-compatible endpoints, Ollama, vLLM, OpenRouter |
| Anthropic | API key, model. Base URL optional |
| Gemini | API key, model. Base URL optional |
| Local process | command, arguments, working directory. No shell |
| HTTP bot | URL, optional bearer token. Response body is `{ "text": "..." }` |
| [A2A](https://github.com/a2aproject/A2A) | Agent Card URL. The demo sends `message/send` |
| MCP | HTTP URL attached to a model agent as tools. An MCP server is not a room member |
| Echo | No model call. For trying the mention rule |

A reply can hand off a file with a fence that starts ` ```file relative/path `. The path cannot contain `..`.

## What comes next

This demo stays a browser proof. The product after it is a Kiro-built desktop app and phone app that share one room and can be used together, without treating this web UI as the final client.

## License

[MIT](LICENSE)
