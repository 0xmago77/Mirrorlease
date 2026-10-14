import { afterEach, describe, expect, it, vi } from "vitest"
import { BUDGET_ERROR_CODE, describeError, meteredFetch, rpcStats } from "../src/core/rpc"

afterEach(() => vi.unstubAllGlobals())

describe("meteredFetch", () => {
  it("records Arkiv-Cost and RateLimit headers", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { headers: { "Arkiv-Cost": "12", RateLimit: "limit=10000, remaining=9988, reset=60" } }))
    const before = rpcStats.cost
    await meteredFetch("https://rpc", { body: JSON.stringify({ id: 1 }) })
    expect(rpcStats.cost - before).toBe(12)
    expect(rpcStats.rateLimit).toEqual({ limit: 10000, remaining: 9988, resetSeconds: 60 })
  })

  it("turns the budget 429 into a non-retryable JSON-RPC error with the same id", async () => {
    const body = JSON.stringify({ error: "ANON_COST_LIMITED", message: "unauthenticated query budget exhausted" })
    vi.stubGlobal("fetch", async () => new Response(body, { status: 429, headers: { "Retry-After": "600" } }))
    const res = await meteredFetch("https://rpc", { body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "arkiv_query" }) })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.id).toBe(7)
    expect(j.error.code).toBe(BUDGET_ERROR_CODE)
    expect(j.error.message).toContain("budget exhausted")
    expect(j.error.message).toContain("10 min")
  })
})

describe("describeError", () => {
  it("prefers the nested reason over a generic top-level message", () => {
    const e = Object.assign(new Error("Requested resource not available"), { data: { message: "exists(…) is not supported" } })
    expect(describeError(e)).toBe("exists(…) is not supported")
  })
})
