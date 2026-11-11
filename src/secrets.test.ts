import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { decryptSecret, encryptSecret, fingerprintSecret } from "./secrets"

describe("secrets", () => {
  it("round-trips a key and keeps only a short fingerprint", () => {
    const key = randomBytes(32)
    const payload = encryptSecret(key, "sk-test-secret")
    expect(payload).not.toContain("sk-test-secret")
    expect(decryptSecret(key, payload)).toBe("sk-test-secret")
    expect(fingerprintSecret("sk-test-secret")).toHaveLength(4)
  })
})
