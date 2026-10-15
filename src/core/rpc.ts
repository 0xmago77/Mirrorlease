// HTTP transport for Arkiv with two additions:
//
// 1. It reads the Arkiv-Cost / RateLimit headers the public RPC sends, so the CLI and the page can
//    show how much of the anonymous query budget a view used.
// 2. When the anonymous budget is spent the RPC answers HTTP 429 with a non-JSON-RPC body. viem
//    retries 429s with backoff, which looks like a hang. We turn that answer into a JSON-RPC error
//    with a code viem does not retry, carrying the reset time, so the user sees it at once.

import { http } from "viem"

export const BUDGET_ERROR_CODE = -32090

export type RpcStats = {
  requests: number
  /** Sum of Arkiv-Cost headers seen. */
  cost: number
  /** Last RateLimit header: "limit=10000, remaining=9800, reset=1200". */
  rateLimit?: { limit: number; remaining: number; resetSeconds: number }
  quotaUsedPercent?: number
}

export const rpcStats: RpcStats = { requests: 0, cost: 0 }

function parseRateLimit(h: string | null): RpcStats["rateLimit"] | undefined {
  if (!h) return undefined
  const get = (k: string) => Number(new RegExp(`${k}=(\\d+)`).exec(h)?.[1])
  const limit = get("limit")
  const remaining = get("remaining")
  const resetSeconds = get("reset")
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return undefined
  return { limit, remaining, resetSeconds: Number.isFinite(resetSeconds) ? resetSeconds : 0 }
}

function requestIds(body: unknown): (number | string)[] {
  try {
    const parsed = JSON.parse(String(body))
    return (Array.isArray(parsed) ? parsed : [parsed]).map((r) => r.id)
  } catch {
    return [0]
  }
}

export async function meteredFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await globalThis.fetch(input, init)
  rpcStats.requests++
  const cost = Number(res.headers.get("Arkiv-Cost"))
  if (Number.isFinite(cost)) rpcStats.cost += cost
  const quota = Number(res.headers.get("Arkiv-Quota-Used-Percent"))
  if (Number.isFinite(quota) && res.headers.has("Arkiv-Quota-Used-Percent")) rpcStats.quotaUsedPercent = quota
  const rl = parseRateLimit(res.headers.get("RateLimit"))
  if (rl) rpcStats.rateLimit = rl

  if (res.status !== 429) return res
  const text = await res.text()
  let detail = text
  try {
    const j = JSON.parse(text)
    detail = j.message ?? j.error ?? text
  } catch {
    // keep the raw text
  }
  const retry = Number(res.headers.get("Retry-After"))
  const wait = Number.isFinite(retry) && retry > 0 ? ` Resets in about ${Math.ceil(retry / 60)} min.` : ""
  const message =
    `Arkiv RPC refused the request (HTTP 429): ${detail}.${wait} ` +
    "Try again later, or point Mirrorlease at another Arkiv RPC endpoint."
  const ids = requestIds(init?.body)
  const errors = ids.map((id) => ({ jsonrpc: "2.0", id, error: { code: BUDGET_ERROR_CODE, message } }))
  return new Response(JSON.stringify(errors.length === 1 ? errors[0] : errors), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

export function arkivHttp(url: string) {
  return http(url, { fetchFn: meteredFetch, retryCount: 2, timeout: 20_000 })
}

/**
 * The most useful line from an error thrown by viem or the SDK. Their top-level messages are often
 * generic ("RPC Request failed.", "Requested resource not available") while the reason sits in a
 * nested cause, `details`, or `data.message`.
 */
export function describeError(e: unknown): string {
  const seen = new Set<unknown>()
  const found: string[] = []
  let cur: unknown = e
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur)
    const o = cur as { code?: number; details?: string; data?: { message?: string }; shortMessage?: string; message?: string; cause?: unknown }
    if (o.code === BUDGET_ERROR_CODE && (o.details || o.message)) return (o.details || o.message)!.split("\n")[0]!
    if (o.data?.message) found.push(o.data.message)
    if (o.details) found.push(o.details)
    cur = o.cause
  }
  if (found.length > 0) return found[0]!.split("\n")[0]!
  const top = e as { shortMessage?: string; message?: string }
  return (top?.shortMessage || top?.message || String(e)).split("\n")[0]!
}
