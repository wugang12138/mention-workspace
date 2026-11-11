import type { ProbeResult } from "./shared"

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409
  ) {
    super(message)
  }
}

export class ProbeRejected extends Error {
  readonly result: Exclude<ProbeResult, "ok">

  constructor(result: Exclude<ProbeResult, "ok">) {
    super(result === "unauthorized" ? "API Key 未被接受" : "模型接口连不上")
    this.result = result
  }
}
