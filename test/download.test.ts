import { describe, expect, it } from "vitest"
import { downloadVerified, NoGoodMirrorError, sortMirrors, leaseInfo } from "../src/core/download"
import { sha256Hex } from "../src/core/hash"
import { mirror, PUB } from "./fixtures"

const good = new TextEncoder().encode("the real release bytes")
const bad = new TextEncoder().encode("the real release bytez")

async function releaseFor(bytes: Uint8Array) {
  return { sha256: await sha256Hex(bytes), size: bytes.byteLength }
}

const fakeFetch = (routes: Record<string, Uint8Array | number | "throw">) => async (url: string) => {
  const r = routes[url]
  if (r === undefined || r === "throw") throw new TypeError("fetch failed")
  if (typeof r === "number") return new Response("nope", { status: r })
  return new Response(r as Uint8Array<ArrayBuffer>)
}

describe("downloadVerified", () => {
  it("skips dead and tampered mirrors and returns the first good one", async () => {
    const rel = await releaseFor(good)
    const log: string[] = []
    const res = await downloadVerified(
      [{ url: "https://dead" }, { url: "https://404" }, { url: "https://poison" }, { url: "https://good" }],
      rel,
      {
        fetch: fakeFetch({ "https://404": 404, "https://poison": bad, "https://good": good }),
        onAttempt: (a) => a.status !== "trying" && log.push(`${a.url} ${a.status}`),
      },
    )
    expect(res.mirror.url).toBe("https://good")
    expect(new TextDecoder().decode(res.bytes)).toBe("the real release bytes")
    expect(log).toEqual(["https://dead dead", "https://404 dead", "https://poison wrong-bytes", "https://good ok"])
  })

  it("rejects a body larger than the published size without hashing it all", async () => {
    const rel = await releaseFor(good)
    const big = new Uint8Array(good.byteLength + 100)
    await expect(downloadVerified([{ url: "https://big" }], rel, { fetch: fakeFetch({ "https://big": big }) })).rejects.toBeInstanceOf(
      NoGoodMirrorError,
    )
  })

  it("throws NoGoodMirrorError with every attempt when nothing works", async () => {
    const rel = await releaseFor(good)
    try {
      await downloadVerified([{ url: "https://a" }, { url: "https://b" }], rel, { fetch: fakeFetch({ "https://b": bad }) })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(NoGoodMirrorError)
      expect((e as NoGoodMirrorError).attempts.map((a) => a.status)).toEqual(["dead", "wrong-bytes"])
    }
  })
})

describe("mirror ordering", () => {
  const clock = { currentBlock: 1000n, currentBlockTime: 1_000_000, blockDuration: 2 }
  it("puts the freshest lease first and an over-extended lease last", () => {
    const stale = mirror(PUB, "https://stale", 1000n + 600n) // 20 min left
    const fresh = mirror(PUB, "https://fresh", 1000n + 10_000n) // ~5.5h left
    const pushed = mirror(PUB, "https://pushed", 1000n + 1_000_000n) // weeks: someone extended it far out
    const order = sortMirrors([stale, pushed, fresh], clock).map((m) => m.url)
    expect(order).toEqual(["https://fresh", "https://stale", "https://pushed"])
    expect(leaseInfo(pushed, clock).unusual).toBe(true)
    expect(leaseInfo(fresh, clock).unusual).toBe(false)
  })
})
