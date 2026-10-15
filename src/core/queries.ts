// Every Arkiv read Mirrorlease makes. arkiv/schema.md quotes these; keep them in sync.
//
// The public RPC charges a flat 100 units per arkiv_query (whatever it selects or returns) against
// an anonymous budget of 10000 units, while getBlockTiming and eth_getLogs are free. So the views
// are built from as few queries as possible, using OR to fetch several kinds at once, and filter
// on the client.

import { createPublicClient, ENTITY_EVENTS_ABI, type Entity, type PublicArkivClient } from "@arkiv-network/sdk"
import { addr, u64 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq, gt, or } from "@arkiv-network/sdk/query"
import {
  ARKIV_ADDRESS,
  HISTORY_MAX_DEAD,
  KIND,
  type Kind,
  LOG_RANGE,
  NAMESPACE_ATTR,
  NAMESPACE_VALUE,
  PAGE_SIZE,
  RPC_HTTP,
} from "./constants"
import { decodeAll, decodeEntity, type Hex, type MirrorleaseRecord, type MirrorRecord, type ReleaseRecord } from "./schema"
import { arkivHttp } from "./rpc"
import type { Clock } from "./time"
import { roleOf, signersFor, type Trust } from "./trust"

export type Client = PublicArkivClient

export function makePublicClient(rpcUrl: string = RPC_HTTP): Client {
  return createPublicClient({ chain: tiramisu, transport: arkivHttp(rpcUrl) }) as Client
}

const ns = () => eq(NAMESPACE_ATTR, NAMESPACE_VALUE)

/** Namespace + kind: the first two predicates of the single-kind queries. */
export function base(kind: Kind) {
  return [ns(), eq("kind", kind)]
}

type Builder = ReturnType<Client["select"]>

/** Walks pages (newest first, max 200 each) up to `maxPages`. Each page is one billed query. */
export async function fetchAll(builder: Builder, maxPages = 5): Promise<Entity[]> {
  const out: Entity[] = []
  let page = await builder.limit(PAGE_SIZE).fetch()
  for (let i = 0; ; i++) {
    out.push(...(page.entities as unknown as Entity[]))
    if (!page.hasNextPage() || i + 1 >= maxPages) break
    page = (await page.next())!
  }
  return out
}

export function decodeMany(entities: Entity[]): MirrorleaseRecord[] {
  return entities.map(decodeEntity).filter((r): r is MirrorleaseRecord => r !== null)
}

export async function getClock(client: Client): Promise<Clock> {
  return client.getBlockTiming()
}

// --- query builders, exported so the "read it without us" page can print their exact text ---

export const Q = {
  /** App page, one query: the app entity, the signer's releases and revocations, every mirror. */
  appBundle: (c: Client, app: string, signer: Hex) =>
    c.select("*").where(ns(), eq("app", app), or(eq("$creator", addr(signer)), eq("kind", KIND.mirror))),
  /** After a handoff: what the maintainer created for this app. */
  appBySigner: (c: Client, app: string, signer: Hex) => c.select("*").where(ns(), eq("app", app)).createdBy(signer),
  /** Check a file, one query: anything about this hash, plus everything the signer created. */
  fileBundle: (c: Client, sha: string, signer: Hex) =>
    c.select("*").where(ns(), or(eq("sha256", sha), eq("$creator", addr(signer)))),
  releasesSince: (c: Client, app: string, version: number, signer: Hex) =>
    c
      .select("*")
      .where(...base(KIND.release), eq("app", app), gt("version", u64(BigInt(version))))
      .createdBy(signer),
  releaseBySha: (c: Client, sha: string, signer: Hex) =>
    c.select("*").where(...base(KIND.release), eq("sha256", sha)).createdBy(signer),
  releaseByShaAnyone: (c: Client, sha: string) => c.select("*").where(...base(KIND.release), eq("sha256", sha)),
  mirrorsBySha: (c: Client, sha: string) => c.select("*").where(...base(KIND.mirror), eq("sha256", sha)),
  mirrorsByOperator: (c: Client, operator: Hex) => c.select("*").where(...base(KIND.mirror)).createdBy(operator),
  ownedBy: (c: Client, kind: Kind, owner: Hex) => c.select("*").where(...base(kind)).ownedBy(owner),
}

// --- reads used by single commands ---

export async function releasesSince(c: Client, trust: Trust, app: string, version: number): Promise<ReleaseRecord[]> {
  const lists = await Promise.all(
    signersFor(trust, app).map(async (s) => decodeAll(await fetchAll(Q.releasesSince(c, app, version, s)), "release")),
  )
  return lists
    .flat()
    .filter((r) => roleOf(trust, r.creator, r.app))
    .sort((a, b) => b.version - a.version)
}

/** Releases of this hash by anyone, for the mirror operator (who is not the one deciding trust). */
export async function releasesByShaAnyone(c: Client, sha: string): Promise<ReleaseRecord[]> {
  const page = await Q.releaseByShaAnyone(c, sha).limit(20).fetch()
  return decodeAll(page.entities as unknown as Entity[], "release")
}

export async function mirrorsBySha(c: Client, sha: string): Promise<MirrorRecord[]> {
  return decodeAll(await fetchAll(Q.mirrorsBySha(c, sha)), "mirror")
}

export async function mirrorsByOperator(c: Client, operator: Hex): Promise<MirrorRecord[]> {
  return decodeAll(await fetchAll(Q.mirrorsByOperator(c, operator)), "mirror")
}

// --- history: finding a release that has expired (EOL) ---

type Lifetime = { key: Hex; created: bigint; expires: bigint }

/**
 * Every entity a signer created, with the block it was created in and its last known expiry, from
 * EntityCreated and ExpiryExtended logs (both index the owner). eth_getLogs is free on the public
 * RPC but capped at 100000 blocks per call, so the range is paged.
 */
export async function createdHistory(c: Client, signer: Hex, fromBlock: bigint, toBlock: bigint): Promise<Lifetime[]> {
  const life = new Map<Hex, Lifetime>()
  const ranges: [bigint, bigint][] = []
  for (let from = fromBlock; from <= toBlock; from += LOG_RANGE + 1n) {
    ranges.push([from, from + LOG_RANGE > toBlock ? toBlock : from + LOG_RANGE])
  }
  for (let i = 0; i < ranges.length; i += 4) {
    const chunk = await Promise.all(
      ranges.slice(i, i + 4).map(async ([from, to]) =>
        Promise.all([
          c.getLogs({ address: ARKIV_ADDRESS, event: ENTITY_EVENTS_ABI[0], args: { owner: signer }, fromBlock: from, toBlock: to }),
          c.getLogs({ address: ARKIV_ADDRESS, event: ENTITY_EVENTS_ABI[2], args: { owner: signer }, fromBlock: from, toBlock: to }),
        ]),
      ),
    )
    for (const [created, extended] of chunk) {
      for (const log of created) {
        const k = log.args.entityKey as Hex
        life.set(k, { key: k, created: log.blockNumber ?? 0n, expires: log.args.expiresAt as bigint })
      }
      for (const log of extended) {
        const l = life.get(log.args.entityKey as Hex)
        const at = log.args.expiresAt as bigint
        if (l && at > l.expires) l.expires = at
      }
    }
  }
  return [...life.values()]
}

/**
 * The fewest blocks such that every dead entity was alive at one of them (greedy interval
 * stabbing: sort by last live block, take it, skip every interval it covers). Reading the state at
 * those blocks sees every expired entity at least once, at 100 units a read instead of one read per
 * entity.
 */
export function stabbingBlocks(lifetimes: Lifetime[], head: bigint): bigint[] {
  const dead = lifetimes
    .filter((l) => l.expires <= head && l.expires > l.created)
    .map((l) => ({ start: l.created, end: l.expires - 1n }))
    .sort((a, b) => (a.end === b.end ? 0 : a.end < b.end ? -1 : 1))
  const points: bigint[] = []
  for (const iv of dead) {
    const last = points[points.length - 1]
    if (last !== undefined && last >= iv.start && last <= iv.end) continue
    points.push(iv.end)
  }
  // Newest first: a recently ended support window is the likeliest answer.
  return points.reverse().slice(0, HISTORY_MAX_DEAD)
}

/**
 * Finds releases of this hash that existed and have since expired. Expired entities do not match
 * queries at the head, so this reads the signers' entity logs, works out the blocks at which every
 * now-dead entity was alive, and queries the state at those blocks with atBlock.
 */
export async function findExpiredRelease(
  c: Client,
  trust: Trust,
  sha: string,
  clock: Clock,
  sinceBlock: bigint,
  onProbe?: (block: bigint) => void,
): Promise<ReleaseRecord[]> {
  for (const signer of signersFor(trust)) {
    const blocks = stabbingBlocks(await createdHistory(c, signer, sinceBlock, clock.currentBlock), clock.currentBlock)
    for (const b of blocks) {
      onProbe?.(b)
      const page = await Q.releaseBySha(c, sha, signer).atBlock(b).limit(10).fetch()
      const hits = decodeAll(page.entities as unknown as Entity[], "release").filter((r) => roleOf(trust, r.creator, r.app))
      if (hits.length > 0) return hits
    }
  }
  return []
}
