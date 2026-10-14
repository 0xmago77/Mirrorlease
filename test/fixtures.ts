import type { AppRecord, Hex, MirrorRecord, ReleaseRecord, RevocationRecord } from "../src/core/schema"

export const PUB = "0x1111111111111111111111111111111111111111" as Hex
export const MAINT = "0x2222222222222222222222222222222222222222" as Hex
export const EVIL = "0x6666666666666666666666666666666666666666" as Hex
export const SHA_A = "a".repeat(64)
export const SHA_B = "b".repeat(64)
export const SHA_C = "c".repeat(64)

let n = 0
const key = () => `0x${(++n).toString(16).padStart(64, "0")}` as Hex

const meta = (creator: Hex, owner = creator) => ({
  key: key(),
  creator,
  owner,
  createdAt: BigInt(100 + n),
  expiresAt: 10_000n,
  permissionlessExtension: false,
})

export function app(creator: Hex, owner: Hex = creator, id = "demo"): AppRecord {
  return { ...meta(creator, owner), kind: "app", app: id, name: id, description: "", homepage: "" }
}

export function release(creator: Hex, sha: string, version = 100, extra: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    ...meta(creator),
    kind: "release",
    app: "demo",
    version,
    sha256: sha,
    size: 10,
    channel: "stable",
    versionName: `v${version}`,
    fileName: "demo.tgz",
    notes: "",
    ...extra,
  }
}

export function revocation(creator: Hex, sha: string, extra: Partial<RevocationRecord> = {}): RevocationRecord {
  return { ...meta(creator), kind: "revocation", app: "demo", sha256: sha, version: 1, severity: 3, reason: "bad build", ...extra }
}

export function mirror(creator: Hex, url: string, expiresAt: bigint): MirrorRecord {
  return { ...meta(creator), expiresAt, permissionlessExtension: true, kind: "mirror", app: "demo", sha256: SHA_A, scheme: "https", url, note: "" }
}
