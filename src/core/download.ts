// Download with failover. Mirrors are untrusted: each one is tried in order, and only bytes whose
// sha256 equals the publisher's release are ever handed back. Shared by the CLI and the web page.

import { sha256Hex } from "./hash"
import type { MirrorRecord, ReleaseRecord } from "./schema"
import { blockToMs, type Clock } from "./time"
import { EXPIRATION } from "./constants"

export type AttemptStatus = "trying" | "dead" | "wrong-bytes" | "ok"

export type Attempt = {
  url: string
  mirrorKey?: string
  status: AttemptStatus
  detail: string
  sha256?: string
  ms?: number
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

export type DownloadResult = {
  bytes: Uint8Array
  mirror: { url: string; key?: string }
  attempts: Attempt[]
}

export class NoGoodMirrorError extends Error {
  constructor(readonly attempts: Attempt[]) {
    super(`no mirror served the published bytes (${attempts.length} tried)`)
  }
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel()
      throw new Error(`more than ${cap} bytes, larger than the published size`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/**
 * Tries each URL in order until one returns exactly the release's bytes.
 * `onAttempt` fires on every state change so a UI can show a live log.
 */
export async function downloadVerified(
  sources: { url: string; key?: string }[],
  release: Pick<ReleaseRecord, "sha256" | "size">,
  opts: { fetch?: FetchLike; timeoutMs?: number; onAttempt?: (a: Attempt) => void } = {},
): Promise<DownloadResult> {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => globalThis.fetch(u, i))
  const timeoutMs = opts.timeoutMs ?? 30_000
  const attempts: Attempt[] = []
  const report = (a: Attempt) => {
    opts.onAttempt?.({ ...a })
  }

  for (const src of sources) {
    const attempt: Attempt = { url: src.url, status: "trying", detail: "connecting", ...(src.key ? { mirrorKey: src.key } : {}) }
    report(attempt)
    const started = Date.now()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await doFetch(src.url, { signal: ctrl.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = await readCapped(res, release.size)
      const sha = await sha256Hex(bytes)
      attempt.sha256 = sha
      attempt.ms = Date.now() - started
      if (sha !== release.sha256 || bytes.byteLength !== release.size) {
        attempt.status = "wrong-bytes"
        attempt.detail = `rejected: got ${bytes.byteLength} bytes with sha256 ${sha.slice(0, 12)}…, expected ${release.sha256.slice(0, 12)}…`
        attempts.push(attempt)
        report(attempt)
        continue
      }
      attempt.status = "ok"
      attempt.detail = `sha256 matches (${bytes.byteLength} bytes in ${attempt.ms} ms)`
      attempts.push(attempt)
      report(attempt)
      return { bytes, mirror: src, attempts }
    } catch (err) {
      attempt.ms = Date.now() - started
      const e = err as Error
      const msg = e.name === "AbortError" ? `timed out after ${timeoutMs} ms` : e.message || String(e)
      attempt.status = msg.startsWith("more than") ? "wrong-bytes" : "dead"
      attempt.detail = attempt.status === "dead" ? `unreachable: ${describeFetchError(e, msg)}` : `rejected: ${msg}`
      attempts.push(attempt)
      report(attempt)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new NoGoodMirrorError(attempts)
}

function describeFetchError(e: Error, msg: string): string {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause
  if (cause?.code) return `${msg} (${cause.code})`
  if (msg === "Failed to fetch") return "network error or CORS refused"
  return msg
}

export type LeaseInfo = {
  expiresAtMs: number
  remainingMs: number
  /** Approximate: assumes the last Lifetime Extension asked for the standard lease length. */
  renewedAtMs: number
  /** Someone extended the lease further than the standard window. Possible, since anyone may. */
  unusual: boolean
}

export function leaseInfo(m: MirrorRecord, clock: Clock): LeaseInfo {
  const expiresAtMs = blockToMs(m.expiresAt, clock)
  const now = clock.currentBlockTime * 1000
  const leaseMs = EXPIRATION.mirrorLease * 1000
  const remainingMs = expiresAtMs - now
  return {
    expiresAtMs,
    remainingMs,
    renewedAtMs: expiresAtMs - leaseMs,
    unusual: remainingMs > leaseMs + 10 * 60 * 1000,
  }
}

/**
 * Freshest lease first. A lease pushed past the normal window is moved to the back: permissionless
 * extension means anyone can do that, so it says nothing about whether the mirror still works.
 */
export function sortMirrors(mirrors: MirrorRecord[], clock: Clock): MirrorRecord[] {
  return [...mirrors].sort((a, b) => {
    const ua = leaseInfo(a, clock).unusual
    const ub = leaseInfo(b, clock).unusual
    if (ua !== ub) return ua ? 1 : -1
    return a.expiresAt === b.expiresAt ? 0 : a.expiresAt > b.expiresAt ? -1 : 1
  })
}

/** Same URL registered twice (by different operators, say) is only worth one attempt. */
export function uniqueByUrl(mirrors: MirrorRecord[]): MirrorRecord[] {
  const seen = new Set<string>()
  return mirrors.filter((m) => (seen.has(m.url) ? false : (seen.add(m.url), true)))
}
