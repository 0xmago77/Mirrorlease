// The two reads every front end needs: "what is the state of this app" and "is this file good".
// Each is one arkiv_query in the common case (two after a maintainer handoff), plus free calls.

import { sortMirrors } from "./download"
import { type Client, decodeMany, fetchAll, findExpiredRelease, getClock, Q } from "./queries"
import type { AppRecord, Hex, LifeboatRecord, MirrorRecord, ReleaseRecord, RevocationRecord } from "./schema"
import type { Clock } from "./time"
import { buildTrust, lower, roleOf, type SignerRole, type Trust } from "./trust"
import { computeVerdict, type VerdictResult } from "./verdict"

export type ReleaseView = ReleaseRecord & {
  role: SignerRole
  revocation?: RevocationRecord
}

export type AppStatus = {
  clock: Clock
  trust: Trust
  app?: AppRecord
  releases: ReleaseView[]
  revocations: RevocationRecord[]
  /** The newest release that is not revoked, preferring stable. */
  recommended?: ReleaseView
  /** Mirrors for the recommended release, freshest lease first. */
  mirrors: MirrorRecord[]
  /** Every live mirror entity for this app, any release. */
  allMirrors: MirrorRecord[]
}

const ofKind = <K extends LifeboatRecord["kind"]>(records: LifeboatRecord[], kind: K) =>
  records.filter((r): r is Extract<LifeboatRecord, { kind: K }> => r.kind === kind)

function dedupe<T extends { key: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)))
}

export function pickRecommended(releases: ReleaseView[], channel?: string): ReleaseView | undefined {
  const usable = releases.filter((r) => !r.revocation)
  if (channel) return usable.find((r) => r.channel === channel)
  return usable.find((r) => r.channel === "stable") ?? usable[0]
}

/** Pure: builds the app view from whatever records the queries returned. */
export function buildAppStatus(publisher: Hex, appId: string, records: LifeboatRecord[], clock: Clock, opts: { channel?: string } = {}): AppStatus {
  const all = dedupe(records).filter((r) => r.app === appId)
  const trust = buildTrust(publisher, ofKind(all, "app"))
  const revocations = ofKind(all, "revocation").filter((r) => roleOf(trust, r.creator, r.app))
  const releases: ReleaseView[] = ofKind(all, "release")
    .map((r) => ({ r, role: roleOf(trust, r.creator, r.app) }))
    .filter((x): x is { r: ReleaseRecord; role: SignerRole } => x.role !== null)
    .map(({ r, role }) => {
      const revocation = revocations.find((v) => v.sha256 === r.sha256)
      return { ...r, role, ...(revocation ? { revocation } : {}) }
    })
    .sort((a, b) => b.version - a.version || (a.createdAt > b.createdAt ? -1 : 1))
  const recommended = pickRecommended(releases, opts.channel)
  const allMirrors = ofKind(all, "mirror")
  const mirrors = recommended ? sortMirrors(allMirrors.filter((m) => m.sha256 === recommended.sha256), clock) : []
  const app = trust.apps.get(appId)
  return { clock, trust, ...(app ? { app } : {}), releases, revocations, ...(recommended ? { recommended } : {}), mirrors, allMirrors }
}

export async function appStatus(c: Client, publisher: Hex, appId: string, opts: { channel?: string } = {}): Promise<AppStatus> {
  const p = lower(publisher)
  const [clock, first] = await Promise.all([getClock(c), fetchAll(Q.appBundle(c, appId, p))])
  let records = decodeMany(first)
  // Handoff: the app entity's current owner may publish too. One more query for what they wrote.
  const appEntity = buildTrust(p, ofKind(records, "app")).apps.get(appId)
  if (appEntity && appEntity.owner !== p) {
    records = records.concat(decodeMany(await fetchAll(Q.appBySigner(c, appId, appEntity.owner))))
  }
  return buildAppStatus(p, appId, records, clock, opts)
}

export type CheckResult = VerdictResult & { clock: Clock; trust: Trust; probes: number }

/**
 * Verdict for a file hash against a pinned publisher. `fileName` lets a same-named file with
 * different bytes be called TAMPERED rather than merely unknown.
 */
export async function checkHash(
  c: Client,
  publisher: Hex,
  sha256: string,
  opts: { app?: string; fileName?: string; history?: boolean; onProbe?: (b: bigint) => void } = {},
): Promise<CheckResult> {
  const p = lower(publisher)
  const [clock, first] = await Promise.all([getClock(c), fetchAll(Q.fileBundle(c, sha256, p))])
  let records = decodeMany(first)
  let trust = buildTrust(p, ofKind(records, "app"))
  // Handoff: also read what each maintainer created (same query shape, their address).
  const maintainers = [...new Set([...trust.apps.values()].filter((a) => !opts.app || a.app === opts.app).map((a) => a.owner))].filter(
    (o) => o !== p,
  )
  for (const m of maintainers) records = records.concat(decodeMany(await fetchAll(Q.fileBundle(c, sha256, m))))
  records = dedupe(records)
  if (opts.app) {
    const app = trust.apps.get(opts.app)
    trust = { pinned: trust.pinned, apps: new Map(app ? [[opts.app, app]] : []) }
  }

  const releases = ofKind(records, "release").filter((r) => r.sha256 === sha256)
  const revocations = ofKind(records, "revocation").filter((r) => r.sha256 === sha256)
  const expected = opts.fileName
    ? ofKind(records, "release").filter((r) => r.fileName === opts.fileName && (!opts.app || r.app === opts.app))
    : []

  let probes = 0
  let expiredReleases: ReleaseRecord[] = []
  const liveTrusted = releases.some((r) => roleOf(trust, r.creator, r.app))
  if (!liveTrusted && opts.history !== false && trust.apps.size > 0) {
    // Search back to the oldest app entity this publisher created: no release can predate it.
    const since = [...trust.apps.values()].reduce((m, a) => (a.createdAt < m ? a.createdAt : m), clock.currentBlock)
    expiredReleases = await findExpiredRelease(c, trust, sha256, clock, since, (b) => {
      probes++
      opts.onProbe?.(b)
    })
  }
  const result = computeVerdict({ sha256, trust, releases, revocations, expiredReleases, expected })
  return { ...result, clock, trust, probes }
}
