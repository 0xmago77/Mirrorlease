import { Entity } from "@arkiv-network/sdk"
import { describe, expect, it } from "vitest"
import { decodeEntity, mirrorCreate, releaseCreate, revocationCreate, versionCodeFromName } from "../src/core/schema"
import { PUB, SHA_A, SHA_B } from "./fixtures"

function asEntity(params: ReturnType<typeof releaseCreate>, creator = PUB): Entity {
  const attributes = Object.fromEntries(
    Object.entries(params.attributes ?? {}).map(([k, v]) => [k, typeof v === "string" ? { type: "str", value: v } : v]),
  )
  return new Entity({
    key: `0x${"1".repeat(64)}`,
    creator,
    owner: creator,
    createdAt: 1n,
    expiresAt: 2n,
    payload: params.payload,
    attributes: attributes as never,
    creationFlags: { readonly: false, permissionlessExtension: !!params.flags?.permissionlessExtension, raw: 0 },
  })
}

describe("schema", () => {
  it("derives version codes", () => {
    expect(versionCodeFromName("0.1.0")).toBe(100)
    expect(versionCodeFromName("v1.2.3")).toBe(10203)
    expect(() => versionCodeFromName("1.2")).toThrow()
  })

  it("round-trips a release", () => {
    const p = releaseCreate({ app: "demo", version: 100, sha256: SHA_A.toUpperCase(), size: 42, channel: "stable", versionName: "0.1.0", fileName: "x.tgz" })
    const r = decodeEntity(asEntity(p))
    expect(r).toMatchObject({ kind: "release", version: 100, size: 42, sha256: SHA_A, fileName: "x.tgz", channel: "stable" })
  })

  it("round-trips a revocation with replacement", () => {
    const p = revocationCreate({ app: "demo", sha256: SHA_A, version: 9, severity: 3, reason: "r", replacedBySha256: SHA_B })
    expect(decodeEntity(asEntity(p))).toMatchObject({ kind: "revocation", replacedBySha256: SHA_B, severity: 3 })
  })

  it("mirrors are created with permissionless extension and must be https", () => {
    const p = mirrorCreate({ app: "demo", sha256: SHA_A, url: "https://example.org/x.tgz" })
    expect(p.flags?.permissionlessExtension).toBe(true)
    expect(decodeEntity(asEntity(p))).toMatchObject({ kind: "mirror", url: "https://example.org/x.tgz", permissionlessExtension: true })
    expect(() => mirrorCreate({ app: "demo", sha256: SHA_A, url: "http://example.org/x" })).toThrow()
  })

  it("drops entities outside the namespace or with bad fields", () => {
    const p = releaseCreate({ app: "demo", version: 1, sha256: SHA_A, size: 1, channel: "beta", versionName: "a", fileName: "a" })
    const e = asEntity(p)
    ;(e.attributes as Record<string, unknown>).ml = { type: "str", value: "2" }
    expect(decodeEntity(e)).toBeNull()
    const e2 = asEntity(p)
    ;(e2.attributes as Record<string, unknown>).sha256 = { type: "str", value: "zz" }
    expect(decodeEntity(e2)).toBeNull()
  })
})
