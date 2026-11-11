import { describe, expect, it } from "vitest"
import { textFromA2A } from "./a2a"
import { splitArgs } from "./process-agent"

describe("later adapters", () => {
  it("reads text from an A2A task artifact", () => {
    expect(textFromA2A({ artifacts: [{ parts: [{ kind: "text", text: "做好了" }] }] })).toBe("做好了")
  })

  it("splits process arguments on quotes", () => {
    expect(splitArgs('-e "console.log(1)" --flag')).toEqual(["-e", "console.log(1)", "--flag"])
  })
})