import { describe, expect, it } from "vitest"
import { parseMentions } from "./mention"

const known = ["grok", "gpt", "claude"]

describe("parseMentions", () => {
  it("normalizes handles and keeps order", () => {
    const result = parseMentions("@Grok 先看，然后 @gpt，", known)
    expect(result.actionable).toEqual(["grok", "gpt"])
  })

  it("matches a handle after Chinese text", () => {
    expect(parseMentions("请@gpt 写标题", known).actionable).toEqual(["gpt"])
  })

  it("does not treat an email as a mention", () => {
    expect(parseMentions("写到 user@grok.com", known).actionable).toEqual([])
  })

  it("collapses a repeated handle in one message", () => {
    const result = parseMentions("@gpt 和再次 @gpt", known)
    expect(result.actionable).toEqual(["gpt"])
    expect(result.ignored).toEqual([{ handle: "gpt", reason: "duplicate" }])
  })

  it("skips the sender", () => {
    const result = parseMentions("@grok 自己来", known, "grok")
    expect(result.actionable).toEqual([])
    expect(result.ignored).toEqual([{ handle: "grok", reason: "self" }])
  })

  it("drops unknown handles", () => {
    expect(parseMentions("@nobody 在吗", known).actionable).toEqual([])
  })

  it("ignores mentions inside fenced code, including an unclosed fence", () => {
    const fenced = parseMentions("看这段\n```ts\n@gpt\n```\n谢谢", known)
    expect(fenced.actionable).toEqual([])
    expect(fenced.ignored).toEqual([{ handle: "gpt", reason: "code" }])

    const open = parseMentions("```\n@claude", known)
    expect(open.actionable).toEqual([])
    expect(open.ignored[0]?.reason).toBe("code")
  })

  it("ignores mentions inside thinking blocks", () => {
    const result = parseMentions("结论如下 <thinking>先问 @gpt</thinking> @claude 收尾", known)
    expect(result.actionable).toEqual(["claude"])
    expect(result.ignored).toEqual([{ handle: "gpt", reason: "thinking" }])
  })

  it("records @all outside code and ignores @all inside code", () => {
    expect(parseMentions("@all 看一下", known).hasAll).toBe(true)
    expect(parseMentions("```\n@all\n```", known).hasAll).toBe(false)
  })

  it("addresses the human only outside masked regions", () => {
    expect(parseMentions("@human 你定", known).addressedHuman).toBe(true)
    expect(parseMentions("```\n@human\n```", known).addressedHuman).toBe(false)
  })
})
