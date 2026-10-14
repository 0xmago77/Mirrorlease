// Every Arkiv read Lifeboat makes. arkiv/schema.md quotes these; keep them in sync.

import { createPublicClient, ENTITY_EVENTS_ABI, type Entity, type PublicArkivClient } from "@arkiv-network/sdk"
import { key as keyAttr, u64 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq, gt } from "@arkiv-network/sdk/query"
import { arkivHttp } from "./rpc"
import { ARKIV_ADDRESS, HISTORY_MAX_DEAD, HISTORY_MAX_PROBES, LOG_RANGE, HISTORY_STEP, KIND, type Kind, NAMESPACE_ATTR, NAMESPACE_VALUE, PAGE_SIZE, RPC_HTTP } from "./constants"
import {
  type AppRecord,
  decodeAll,
  type Hex,
  type MirrorRecord,
  type ReleaseRecord,
  type RevocationRecord,
} from "./schema"
import type { Clock } from "./time"
import { buildTrust, roleOf, signersFor, type Trust } from "./trust"

export type Client = PublicArkivClient

export function makePublicClient(rpcUrl: string = RPC_HTTP): Client {
  return createPublicClient({ chain: tiramisu, transport: arkivHttp(rpcUrl) }) as Client
}

/** Namespace + kind: the first two predicates of every query. */
export function base(kind: Kind) {
  return [eq(NAMESPACE_ATTR, NAMESPACE_VALUE), eq("kind", kind)]
}

type Builder = ReturnType<Client["select"]>

/** Walks pages (newest first, max 200 each) up to `maxPages`. */
export async function fetchAll(builder: Builder, maxPages = 10): Promise<Entity[]> {
  const out: Entity[] = []
  let page = await builder.limit(PAGE_SIZE).fetch()
  for (let i = 0; ; i++) {
    out.push(...(page.entities as unknown as Entity[]))
    if (!page.hasNextPage() || i + 1 >= maxPages) break
    page = (await page.next())!
  }
  return out
}

export async function getClock(client: Client): Promise<Clock> {
  return client.getBlockTiming()
}

// --- query builders, exported so the "read it without us" page can print their exact text ---

export const Q = {
  appsByPublisher: (c: Client, publisher: Hex, app?: string) => {
    const b = c.select("*").where(...base(KIND.app)).createdBy(publisher)
    return app ? b.where(eq("app", app)) : b
  },
  releases: (c: Client, app: string, signer: Hex) =>
    c.select("*").where(...base(KIND.release), eq("app", app)).createdBy(signer),
  releasesSince: (c: Client, app: string, version: number, signer: Hex) =>
    c
      .select("*")
      .where(...base(KIND.release), eq("app", app), gt("version", u64(BigInt(version))))
      .createdBy(signer),
  releaseBySha: (c: Client, sha: string, signer: Hex) =>
    c.select("*").where(...base(KIND.release), eq("sha256", sha)).createdBy(signer),
  releaseByShaAnyone: (c: Client, sha: string) => c.select("*").where(...base(KIND.release), eq("sha256", sha)),
  revocationBySha: (c: Client, sha: string, signer: Hex) =>
    c.select("*").where(...base(KIND.revocation), eq("sha256", sha)).createdBy(signer),
  revocationsForApp: (c: Client, app: string, signer: Hex) =>
    c.select("*").where(...base(KIND.revocation), eq("app", app)).createdBy(signer),
  mirrorsBySha: (c: Client, sha: string) => c.select("*").where(...base(KIND.mirror), eq("sha256", sha)),
  mirrorsByOperator: (c: Client, operator: Hex) => c.select("*").where(...base(KIND.mirror)).createdBy(operator),
}

// --- higher-level reads ---

export async function loadTrust(c: Client, publisher: Hex, app?: string): Promise<Trust> {
  const apps = decodeAll(await fetchAll(Q.appsByPublisher(c, publisher, app)), "app")
  return buildTrust(publisher, apps)
}

async function perSigner<T>(signers: Hex[], fn: (s: Hex) => Promise<T[]>): Promise<T[]> {
  return (await Promise.all(signers.map(fn))).flat()
}

export async function listReleases(c: Client, trust: Trust, app: string): Promise<ReleaseRecord[]> {
  const all = await perSigner(signersFor(trust, app), async (s) => decodeAll(await fetchAll(Q.releases(c, app, s)), "release"))
  return all.filter((r) => roleOf(trust, r.creator, r.app)).sort((a, b) => b.version - a.version || cmpBig(b.createdAt, a.createdAt))
}

export async function releasesSince(c: Client, trust: Trust, app: string, version: number): Promise<ReleaseRecord[]> {
  const all = await perSigner(signersFor(trust, app), async (s) =>
    decodeAll(await fetchAll(Q.releasesSince(c, app, version, s)), "release"),
  )
  return all.filter((r) => roleOf(trust, r.creator, r.app)).sort((a, b) => b.version - a.version)
}

export async function listRevocations(c: Client, trust: Trust, app: string): Promise<RevocationRecord[]> {
  const all = await perSigner(signersFor(trust, app), async (s) =>
    decodeAll(await fetchAll(Q.revocationsForApp(c, app, s)), "revocation"),
  )
  return all.filter((r) => roleOf(trust, r.creator, r.app))
}

export async function releasesBySha(c: Client, trust: Trust, sha: string, atBlock?: bigint): Promise<ReleaseRecord[]> {
  return perSigner(signersFor(trust), async (s) => {
    const b = Q.releaseBySha(c, sha, s)
    if (atBlock !== undefined) b.atBlock(atBlock)
    return decodeAll(await fetchAll(b, 1), "release")
  })
}

/** Releases of this hash by anyone, for display only ("other addresses claim this file"). */
export async function releasesByShaAnyone(c: Client, sha: string): Promise<ReleaseRecord[]> {
  const page = await Q.releaseByShaAnyone(c, sha).limit(20).fetch()
  return decodeAll(page.entities as unknown as Entity[], "release")
}

export async function revocationsBySha(c: Client, trust: Trust, sha: string): Promise<RevocationRecord[]> {
  return perSigner(signersFor(trust), async (s) => decodeAll(await fetchAll(Q.revocationBySha(c, sha, s)), "revocation"))
}

export async function mirrorsBySha(c: Client, sha: string): Promise<MirrorRecord[]> {
  return decodeAll(await fetchAll(Q.mirrorsBySha(c, sha), 5), "mirror")
}

export async function mirrorsByOperator(c: Client, operator: Hex): Promise<MirrorRecord[]> {
  return decodeAll(await fetchAll(Q.mirrorsByOperator(c, operator)), "mirror")
}

/**
 * Every entity a signer ever created, with its last known expiry, from EntityCreated and
 * ExpiryExtended logs (both index the owner). Paged because eth_getLogs caps the block range.
 */
export async function createdHistory(c: Client, signer: Hex, fromBlock: bigint, toBlock: bigint) {
  const expiry = new Map<Hex, bigint>()
  const ranges: [bigint, bigint][] = []
  for (let from = fromBlock; from <= toBlock; from += LOG_RANGE + 1n) {
    ranges.push([from, from + LOG_RANGE > toBlock ? toBlock : from + LOG_RANGE])
  }
  for (let i = 0; i < ranges.length; i += 4) {
    const chunk = await Promise.all(
      ranges.slice(i, i + 4).map(async ([from, to]) => {
        const [created, extended] = await Promise.all([
          c.getLogs({ address: ARKIV_ADDRESS, event: ENTITY_EVENTS_ABI[0], args: { owner: signer }, fromBlock: from, toBlock: to }),
          c.getLogs({ address: ARKIV_ADDRESS, event: ENTITY_EVENTS_ABI[2], args: { owner: signer }, fromBlock: from, toBlock: to }),
        ])
        return [...created, ...extended]
      }),
    )
    for (const log of chunk.flat()) {
      const k = log.args.entityKey as Hex | undefined
      const at = log.args.expiresAt as bigint | undefined
      if (!k || at === undefined) continue
      const prev = expiry.get(k)
      if (prev === undefined || at > prev) expiry.set(k, at)
    }
  }
  return expiry
}

/**
 * Finds a release of this hash that existed and has since expired (EOL).
 *
 * Expired entities no longer match a query at the head, so this reads history: the signer's
 * EntityCreated / ExpiryExtended logs give every entity they made and when it expired, and an
 * arkiv_query with atBlock = (expiry - 1) reads each dead one as it was on its last day. If the
 * node refuses the logs, it falls back to probing the state every HISTORY_STEP.
 */
export async function findExpiredRelease(
  c: Client,
  trust: Trust,
  sha: string,
  clock: Clock,
  sinceBlock: bigint,
  onProbe?: (block: bigint) => void,
): Promise<ReleaseRecord[]> {
  try {
    const found: ReleaseRecord[] = []
    for (const signer of signersFor(trust)) {
      const history = await createdHistory(c, signer, sinceBlock, clock.currentBlock)
      // Newest first, and capped: each one costs a query against the anonymous budget.
      const dead = [...history]
        .filter(([, exp]) => exp <= clock.currentBlock)
        .sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))
        .slice(0, HISTORY_MAX_DEAD)
      for (let i = 0; i < dead.length; i += 6) {
        const res = await Promise.all(
          dead.slice(i, i + 6).map(async ([k, exp]) => {
            onProbe?.(exp - 1n)
            const page = await c
              .select("*")
              .where(eq("$key", keyAttr(k)), ...base(KIND.release), eq("sha256", sha))
              .atBlock(exp - 1n)
              .limit(1)
              .fetch()
            return decodeAll(page.entities as unknown as Entity[], "release")
          }),
        )
        found.push(...res.flat().filter((r) => roleOf(trust, r.creator, r.app)))
      }
    }
    return found
  } catch {
    return probeHistory(c, trust, sha, clock, sinceBlock, onProbe)
  }
}

/** Fallback: read the state every HISTORY_STEP back to `sinceBlock`. Misses very short windows. */
async function probeHistory(
  c: Client,
  trust: Trust,
  sha: string,
  clock: Clock,
  sinceBlock: bigint,
  onProbe?: (block: bigint) => void,
): Promise<ReleaseRecord[]> {
  const step = BigInt(Math.max(1, Math.floor(HISTORY_STEP / clock.blockDuration)))
  const blocks: bigint[] = []
  for (let b = clock.currentBlock - step; b > sinceBlock && blocks.length < HISTORY_MAX_PROBES; b -= step) blocks.push(b)
  for (let i = 0; i < blocks.length; i += 6) {
    const results = await Promise.all(
      blocks.slice(i, i + 6).map(async (b) => {
        onProbe?.(b)
        try {
          return await releasesBySha(c, trust, sha, b)
        } catch {
          return []
        }
      }),
    )
    const hit = results.flat().filter((r) => roleOf(trust, r.creator, r.app))
    if (hit.length > 0) return hit
  }
  return []
}

function cmpBig(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? 1 : -1
}
