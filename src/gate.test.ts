import { describe, expect, it } from "vitest"
import { planWakeups } from "./gate"

describe("planWakeups", () => {
  it("queues the first four hops and skips the fifth", () => {
    expect(planWakeups({ actionable: ["gpt"], ignored: [], hop: 4 })[0]?.status).toBe("queued")
    const skipped = planWakeups({ actionable: ["grok"], ignored: [], hop: 5 })
    expect(skipped).toEqual([{ handle: "grok", hop: 5, status: "skipped", reason: "hop_limit" }])
  })

  it("keeps ignored mentions out of the queue", () => {
    const planned = planWakeups({
      actionable: ["gpt"],
      ignored: [{ handle: "grok", reason: "code" }],
      hop: 1
    })
    expect(planned.map((item) => item.status)).toEqual(["queued", "skipped"])
  })
})
