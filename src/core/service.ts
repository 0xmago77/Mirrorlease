// The two reads every front end needs: "what is the state of this app" and "is this file good".

import {
  type Client,
  findExpiredRelease,
  getClock,
  listReleases,
  listRevocations,
  loadTrust,
  mirrorsBySha,
  releasesBySha,
  releasesByShaAnyone,
  revocationsBySha,
} from "./queries"
import type { AppRecord, Hex, MirrorRecord, ReleaseRecord, RevocationRecord } from "./schema"
import type { Clock } from "./time"
import { roleOf, type SignerRole, type Trust } from "./trust"
import { computeVerdict, type VerdictResult } from "./verdict"
import { sortMirrors } from "./download"

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
}

export function pickRecommended(releases: ReleaseView[], channel?: string): ReleaseView | undefined {
  const usable = releases.filter((r) => !r.revocation)
  if (channel) return usable.find((r) => r.channel === channel)
  return usable.find((r) => r.channel === "stable") ?? usable[0]
}

export async function appStatus(c: Client, publisher: Hex, appId: string, opts: { channel?: string } = {}): Promise<AppStatus> {
  const [clock, trust] = await Promise.all([getClock(c), loadTrust(c, publisher, appId)])
  const [releases, revocations] = await Promise.all([listReleases(c, trust, appId), listRevocations(c, trust, appId)])
  const views: ReleaseView[] = releases.map((r) => {
    const revocation = revocations.find((v) => v.sha256 === r.sha256)
    return { ...r, role: roleOf(trust, r.creator, r.app)!, ...(revocation ? { revocation } : {}) }
  })
  const recommended = pickRecommended(views, opts.channel)
  const mirrors = recommended ? sortMirrors((await mirrorsBySha(c, recommended.sha256)).filter((m) => m.app === appId), clock) : []
  const app = trust.apps.get(appId)
  return { clock, trust, ...(app ? { app } : {}), releases: views, revocations, ...(recommended ? { recommended } : {}), mirrors }
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
  const [clock, trust] = await Promise.all([getClock(c), loadTrust(c, publisher, opts.app)])
  const [releases, revocations, others] = await Promise.all([
    releasesBySha(c, trust, sha256),
    revocationsBySha(c, trust, sha256),
    releasesByShaAnyone(c, sha256),
  ])
  const all = dedupe([...releases, ...others])
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
  let expected: ReleaseRecord[] = []
  if (opts.fileName) {
    const apps = opts.app ? [opts.app] : [...trust.apps.keys()]
    const lists = await Promise.all(apps.map((a) => listReleases(c, trust, a)))
    expected = lists.flat().filter((r) => r.fileName === opts.fileName)
  }
  const result = computeVerdict({ sha256, trust, releases: all, revocations, expiredReleases, expected })
  return { ...result, clock, trust, probes }
}

function dedupe<T extends { key: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)))
}
