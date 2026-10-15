// Entity shapes for Mirrorlease, and the code that turns them into Arkiv creates and back.
// The full description lives in arkiv/schema.md; keep the two in sync.

import type { CreateEntityParameters, Entity } from "@arkiv-network/sdk"
import { u64 } from "@arkiv-network/sdk/attr"
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils"
import { type Channel, CHANNELS, EXPIRATION, KIND, NAMESPACE_ATTR, NAMESPACE_VALUE } from "./constants"

export type Hex = `0x${string}`

/** What every decoded entity carries from Arkiv itself, as opposed to what we wrote. */
export type EntityMeta = {
  key: Hex
  /** Immutable: the account that created the entity. Trust is decided on this. */
  creator: Hex
  /** Mutable: changes with changeOwnership. */
  owner: Hex
  createdAt: bigint
  expiresAt: bigint
  permissionlessExtension: boolean
}

export type AppRecord = EntityMeta & {
  kind: "app"
  app: string
  name: string
  description: string
  homepage: string
}

export type ReleaseRecord = EntityMeta & {
  kind: "release"
  app: string
  version: number
  sha256: string
  size: number
  channel: Channel
  versionName: string
  fileName: string
  notes: string
}

export type RevocationRecord = EntityMeta & {
  kind: "revocation"
  app: string
  sha256: string
  version: number
  severity: number
  reason: string
  replacedBySha256?: string
}

export type MirrorRecord = EntityMeta & {
  kind: "mirror"
  app: string
  sha256: string
  scheme: string
  region?: string
  url: string
  note: string
}

export type MirrorleaseRecord = AppRecord | ReleaseRecord | RevocationRecord | MirrorRecord

const SHA256_RE = /^[0-9a-f]{64}$/
const APP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function isSha256(value: string): boolean {
  return SHA256_RE.test(value)
}

export function normalizeSha256(value: string): string {
  const v = value.trim().toLowerCase().replace(/^0x/, "")
  if (!isSha256(v)) throw new Error(`not a sha256 hex digest: ${value}`)
  return v
}

export function assertAppId(app: string): string {
  if (!APP_ID_RE.test(app)) {
    throw new Error(`app id must be lowercase letters, digits, ".", "_" or "-" (max 64): ${app}`)
  }
  return app
}

/**
 * "1.2.3" -> 10203. Lets a human version name double as the numeric `version` attribute that
 * range queries need. Each part must be below 100; pass an explicit code otherwise.
 */
export function versionCodeFromName(name: string): number {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name.trim())
  if (!m) throw new Error(`cannot derive a version code from "${name}", pass --code`)
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (minor > 99 || patch > 99) throw new Error(`minor/patch above 99 in "${name}", pass --code`)
  return major * 10000 + minor * 100 + patch
}

/** Durations must be a whole number of 2-second blocks. */
function lifetime(seconds: number) {
  const even = Math.max(2, Math.round(seconds / 2) * 2)
  return ExpirationTime.fromSeconds(even)
}

const ns = { [NAMESPACE_ATTR]: NAMESPACE_VALUE }

export function appCreate(input: {
  app: string
  name: string
  description?: string
  homepage?: string
  seconds?: number
}): CreateEntityParameters {
  return {
    attributes: { ...ns, kind: KIND.app, app: assertAppId(input.app) },
    payload: jsonToPayload({
      name: input.name,
      description: input.description ?? "",
      homepage: input.homepage ?? "",
    }),
    contentType: "application/json",
    expires: lifetime(input.seconds ?? EXPIRATION.app),
  }
}

export function releaseCreate(input: {
  app: string
  version: number
  sha256: string
  size: number
  channel: Channel
  versionName: string
  fileName: string
  notes?: string
  seconds?: number
}): CreateEntityParameters {
  if (!CHANNELS.includes(input.channel)) throw new Error(`unknown channel ${input.channel}`)
  if (!Number.isSafeInteger(input.version) || input.version < 0) throw new Error("bad version code")
  if (!Number.isSafeInteger(input.size) || input.size < 0) throw new Error("bad size")
  return {
    attributes: {
      ...ns,
      kind: KIND.release,
      app: assertAppId(input.app),
      version: u64(BigInt(input.version)),
      sha256: normalizeSha256(input.sha256),
      size: u64(BigInt(input.size)),
      channel: input.channel,
    },
    payload: jsonToPayload({
      versionName: input.versionName,
      fileName: input.fileName,
      notes: input.notes ?? "",
    }),
    contentType: "application/json",
    expires: lifetime(input.seconds ?? EXPIRATION.release[input.channel]),
  }
}

export function revocationCreate(input: {
  app: string
  sha256: string
  version: number
  severity: number
  reason: string
  replacedBySha256?: string
  seconds?: number
}): CreateEntityParameters {
  if (![1, 2, 3].includes(input.severity)) throw new Error("severity must be 1, 2 or 3")
  const payload: Record<string, string> = { reason: input.reason }
  if (input.replacedBySha256) payload.replacedBySha256 = normalizeSha256(input.replacedBySha256)
  return {
    attributes: {
      ...ns,
      kind: KIND.revocation,
      app: assertAppId(input.app),
      sha256: normalizeSha256(input.sha256),
      version: u64(BigInt(input.version)),
      severity: u64(BigInt(input.severity)),
    },
    payload: jsonToPayload(payload),
    contentType: "application/json",
    expires: lifetime(input.seconds ?? EXPIRATION.revocation),
  }
}

export function mirrorCreate(input: {
  app: string
  sha256: string
  url: string
  region?: string
  note?: string
  seconds?: number
}): CreateEntityParameters {
  const url = new URL(input.url)
  if (url.protocol !== "https:") throw new Error("mirrors must be https URLs")
  const attributes: Record<string, string> = {
    ...ns,
    kind: KIND.mirror,
    app: assertAppId(input.app),
    sha256: normalizeSha256(input.sha256),
    scheme: "https",
  }
  if (input.region) attributes.region = input.region
  return {
    attributes,
    payload: jsonToPayload({ url: url.toString(), note: input.note ?? "" }),
    contentType: "application/json",
    expires: lifetime(input.seconds ?? EXPIRATION.mirrorLease),
    // Anyone who just downloaded and verified the file may extend the lease.
    flags: { permissionlessExtension: true },
  }
}

// ---------------------------------------------------------------------------------------------
// Decoding. Everything read from Arkiv is untrusted input: anyone can write an entity with
// ml = "1", so a malformed one is dropped rather than allowed to throw through the UI.

type AttrMap = Record<string, { type: string; value: unknown }>

function str(attrs: AttrMap, name: string): string | undefined {
  const a = attrs[name]
  return a && a.type === "str" && typeof a.value === "string" ? a.value : undefined
}

function num(attrs: AttrMap, name: string): number | undefined {
  const a = attrs[name]
  if (!a) return undefined
  if (typeof a.value === "bigint" && a.value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(a.value)
  if (typeof a.value === "number" && Number.isSafeInteger(a.value)) return a.value
  return undefined
}

function json(entity: Entity): Record<string, unknown> {
  try {
    const parsed = entity.toJson()
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function text(obj: Record<string, unknown>, name: string): string {
  const v = obj[name]
  return typeof v === "string" ? v : ""
}

function meta(entity: Entity): EntityMeta | null {
  if (!entity.key || !entity.creator || !entity.owner || entity.expiresAt === undefined) return null
  return {
    key: entity.key,
    creator: entity.creator.toLowerCase() as Hex,
    owner: entity.owner.toLowerCase() as Hex,
    createdAt: entity.createdAt ?? 0n,
    expiresAt: entity.expiresAt,
    permissionlessExtension: entity.creationFlags?.permissionlessExtension ?? false,
  }
}

export function decodeEntity(entity: Entity): MirrorleaseRecord | null {
  const m = meta(entity)
  const attrs = (entity.attributes ?? {}) as unknown as AttrMap
  if (!m || str(attrs, NAMESPACE_ATTR) !== NAMESPACE_VALUE) return null
  const kind = str(attrs, "kind")
  const app = str(attrs, "app")
  if (!app) return null
  const body = json(entity)

  if (kind === KIND.app) {
    return {
      ...m,
      kind,
      app,
      name: text(body, "name") || app,
      description: text(body, "description"),
      homepage: text(body, "homepage"),
    }
  }

  const sha = str(attrs, "sha256")
  if (!sha || !isSha256(sha)) return null

  if (kind === KIND.release) {
    const version = num(attrs, "version")
    const size = num(attrs, "size")
    const channel = str(attrs, "channel") as Channel | undefined
    if (version === undefined || size === undefined || !channel || !CHANNELS.includes(channel)) {
      return null
    }
    return {
      ...m,
      kind,
      app,
      version,
      sha256: sha,
      size,
      channel,
      versionName: text(body, "versionName") || String(version),
      fileName: text(body, "fileName"),
      notes: text(body, "notes"),
    }
  }

  if (kind === KIND.revocation) {
    const version = num(attrs, "version") ?? 0
    const severity = num(attrs, "severity") ?? 3
    const replaced = text(body, "replacedBySha256")
    return {
      ...m,
      kind,
      app,
      sha256: sha,
      version,
      severity,
      reason: text(body, "reason"),
      ...(isSha256(replaced) ? { replacedBySha256: replaced } : {}),
    }
  }

  if (kind === KIND.mirror) {
    const url = text(body, "url")
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return null
    }
    if (parsed.protocol !== "https:") return null
    const region = str(attrs, "region")
    return {
      ...m,
      kind,
      app,
      sha256: sha,
      scheme: "https",
      ...(region ? { region } : {}),
      url: parsed.toString(),
      note: text(body, "note"),
    }
  }

  return null
}

export function decodeAll<T extends MirrorleaseRecord["kind"]>(
  entities: Entity[],
  kind: T,
): Extract<MirrorleaseRecord, { kind: T }>[] {
  const out: Extract<MirrorleaseRecord, { kind: T }>[] = []
  for (const e of entities) {
    const r = decodeEntity(e)
    if (r && r.kind === kind) out.push(r as Extract<MirrorleaseRecord, { kind: T }>)
  }
  return out
}
