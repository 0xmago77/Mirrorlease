// Every Arkiv read Lifeboat makes. arkiv/schema.md quotes these; keep them in sync.

import { createPublicClient, type Entity, type PublicArkivClient } from "@arkiv-network/sdk"
import { u64 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq, gt } from "@arkiv-network/sdk/query"
import { http } from "viem"
import { HISTORY_MAX_PROBES, HISTORY_STEP, KIND, type Kind, NAMESPACE_ATTR, NAMESPACE_VALUE, PAGE_SIZE, RPC_HTTP } from "./constants"
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
  return createPublicClient({ chain: tiramisu, transport: http(rpcUrl) }) as Client
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
 * Looks for a release of this hash that has since expired, by reading the state at earlier blocks
 * (arkiv_query with atBlock). Probes every HISTORY_STEP back to `sinceBlock`, newest first, a few
 * at a time, and stops at the first hit. A support window shorter than HISTORY_STEP can be missed.
 */
export async function findExpiredRelease(
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
  if (sinceBlock > 0n && sinceBlock < clock.currentBlock && blocks.length < HISTORY_MAX_PROBES) blocks.push(sinceBlock + 1n)

  const batch = 6
  for (let i = 0; i < blocks.length; i += batch) {
    const slice = blocks.slice(i, i + batch)
    const results = await Promise.all(
      slice.map(async (b) => {
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
