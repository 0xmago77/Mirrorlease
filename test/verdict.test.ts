import { describe, expect, it } from "vitest"
import { buildTrust } from "../src/core/trust"
import { computeVerdict } from "../src/core/verdict"
import { app, EVIL, MAINT, PUB, release, revocation, SHA_A, SHA_B, SHA_C } from "./fixtures"

const trust = buildTrust(PUB, [app(PUB)])
const handedOff = buildTrust(PUB, [app(PUB, MAINT)])

describe("computeVerdict", () => {
  it("OK for a live release by the pinned publisher", () => {
    const r = computeVerdict({ sha256: SHA_A, trust, releases: [release(PUB, SHA_A)], revocations: [] })
    expect(r.verdict).toBe("OK")
    expect(r.role).toBe("publisher")
  })

  it("OK labelled maintainer for a release by the new owner after handoff", () => {
    const r = computeVerdict({ sha256: SHA_A, trust: handedOff, releases: [release(MAINT, SHA_A)], revocations: [] })
    expect(r.verdict).toBe("OK")
    expect(r.role).toBe("maintainer")
  })

  it("UNKNOWN_PUBLISHER when only an unpinned address published the hash", () => {
    const r = computeVerdict({ sha256: SHA_A, trust, releases: [release(EVIL, SHA_A)], revocations: [] })
    expect(r.verdict).toBe("UNKNOWN_PUBLISHER")
    expect(r.untrusted).toHaveLength(1)
  })

  it("UNKNOWN_PUBLISHER for a maintainer release when there was no handoff", () => {
    const r = computeVerdict({ sha256: SHA_A, trust, releases: [release(MAINT, SHA_A)], revocations: [] })
    expect(r.verdict).toBe("UNKNOWN_PUBLISHER")
  })

  it("UNKNOWN_PUBLISHER when nothing matches at all", () => {
    const r = computeVerdict({ sha256: SHA_C, trust, releases: [], revocations: [] })
    expect(r.verdict).toBe("UNKNOWN_PUBLISHER")
    expect(r.untrusted).toHaveLength(0)
  })

  it("REVOKED beats a live release", () => {
    const r = computeVerdict({
      sha256: SHA_A,
      trust,
      releases: [release(PUB, SHA_A)],
      revocations: [revocation(PUB, SHA_A, { replacedBySha256: SHA_B })],
    })
    expect(r.verdict).toBe("REVOKED")
    expect(r.revocation?.replacedBySha256).toBe(SHA_B)
    expect(r.release?.sha256).toBe(SHA_A)
  })

  it("a revocation by an unpinned address is ignored", () => {
    const r = computeVerdict({
      sha256: SHA_A,
      trust,
      releases: [release(PUB, SHA_A)],
      revocations: [revocation(EVIL, SHA_A)],
    })
    expect(r.verdict).toBe("OK")
  })

  it("the maintainer can revoke after a handoff", () => {
    const r = computeVerdict({
      sha256: SHA_A,
      trust: handedOff,
      releases: [release(PUB, SHA_A)],
      revocations: [revocation(MAINT, SHA_A)],
    })
    expect(r.verdict).toBe("REVOKED")
  })

  it("REVOKED even after the release itself expired", () => {
    const r = computeVerdict({ sha256: SHA_A, trust, releases: [], revocations: [revocation(PUB, SHA_A)] })
    expect(r.verdict).toBe("REVOKED")
  })

  it("EOL when the release is only found in history", () => {
    const r = computeVerdict({
      sha256: SHA_A,
      trust,
      releases: [],
      revocations: [],
      expiredReleases: [release(PUB, SHA_A, 8)],
    })
    expect(r.verdict).toBe("EOL")
    expect(r.release?.version).toBe(8)
  })

  it("expired releases by unpinned addresses do not make it EOL", () => {
    const r = computeVerdict({ sha256: SHA_A, trust, releases: [], revocations: [], expiredReleases: [release(EVIL, SHA_A)] })
    expect(r.verdict).toBe("UNKNOWN_PUBLISHER")
  })

  it("TAMPERED when the expected release has a different hash", () => {
    const r = computeVerdict({
      sha256: SHA_C,
      trust,
      releases: [],
      revocations: [],
      expected: [release(PUB, SHA_A)],
    })
    expect(r.verdict).toBe("TAMPERED")
    expect(r.release?.sha256).toBe(SHA_A)
  })

  it("an expectation set by an unpinned address cannot produce TAMPERED", () => {
    const r = computeVerdict({ sha256: SHA_C, trust, releases: [], revocations: [], expected: [release(EVIL, SHA_A)] })
    expect(r.verdict).toBe("UNKNOWN_PUBLISHER")
  })

  it("picks the highest version when several trusted releases share a hash", () => {
    const r = computeVerdict({
      sha256: SHA_A,
      trust,
      releases: [release(PUB, SHA_A, 5), release(PUB, SHA_A, 7)],
      revocations: [],
    })
    expect(r.release?.version).toBe(7)
  })
})
