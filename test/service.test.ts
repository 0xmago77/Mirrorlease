import { describe, expect, it } from "vitest"
import { stabbingBlocks } from "../src/core/queries"
import { buildAppStatus } from "../src/core/service"
import { app, EVIL, MAINT, mirror, PUB, release, revocation, SHA_A, SHA_B, SHA_C } from "./fixtures"

const clock = { currentBlock: 1000n, currentBlockTime: 1_000_000, blockDuration: 2 }
const k = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`

describe("stabbingBlocks", () => {
  it("reads overlapping lifetimes once and ignores live entities", () => {
    const pts = stabbingBlocks(
      [
        { key: k(1), created: 10n, expires: 100n },
        { key: k(2), created: 50n, expires: 120n }, // overlaps the first at 50..99
        { key: k(3), created: 300n, expires: 400n },
        { key: k(4), created: 500n, expires: 5000n }, // still alive
      ],
      1000n,
    )
    expect(pts).toEqual([399n, 99n])
    // every dead interval contains one of the points
    for (const [s, e] of [[10n, 99n], [50n, 119n], [300n, 399n]] as const) expect(pts.some((p) => p >= s && p <= e)).toBe(true)
  })
})

describe("buildAppStatus", () => {
  it("keeps only trusted releases, marks revoked ones, recommends the newest unrevoked stable", () => {
    const st = buildAppStatus(
      PUB,
      "demo",
      [
        app(PUB),
        release(PUB, SHA_A, 9),
        release(PUB, SHA_B, 100),
        release(EVIL, SHA_C, 999),
        revocation(PUB, SHA_A, { replacedBySha256: SHA_B }),
        revocation(EVIL, SHA_B),
        mirror(EVIL, "https://m1", 2000n),
      ],
      clock,
    )
    expect(st.releases.map((r) => r.version)).toEqual([100, 9])
    expect(st.releases.find((r) => r.version === 9)?.revocation).toBeDefined()
    expect(st.recommended?.version).toBe(100)
    expect(st.revocations).toHaveLength(1)
    expect(st.mirrors).toHaveLength(0) // fixture mirror serves SHA_A, recommended is SHA_B
  })

  it("accepts maintainer releases after a handoff", () => {
    const st = buildAppStatus(PUB, "demo", [app(PUB, MAINT), release(MAINT, SHA_C, 200)], clock)
    expect(st.recommended?.role).toBe("maintainer")
    expect(st.app?.owner).toBe(MAINT)
  })
})
