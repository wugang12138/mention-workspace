import { describe, expect, it } from "vitest"
import { extractArtifacts } from "./artifacts"

describe("extractArtifacts", () => {
  it("reads explicit file fences and drops unsafe paths", () => {
    const text = ["说明", "```file notes/a.txt", "hello", "@gpt", "```", "```file ../secret.txt", "no", "```"].join("\n")
    expect(extractArtifacts(text)).toEqual([{ path: "notes/a.txt", content: "hello\n@gpt" }])
  })
})
