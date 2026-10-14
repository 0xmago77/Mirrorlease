// Turns "here is a file hash" plus what Arkiv returned into one answer for the user.
// Pure: no network, so it can be unit tested with fake entities.

import type { ReleaseRecord, RevocationRecord } from "./schema"
import { roleOf, type SignerRole, type Trust } from "./trust"

export type Verdict = "OK" | "TAMPERED" | "REVOKED" | "EOL" | "UNKNOWN_PUBLISHER"

export type VerdictInput = {
  sha256: string
  trust: Trust
  /** Live releases whose sha256 equals the file's (any creator). */
  releases: ReleaseRecord[]
  /** Live revocations whose sha256 equals the file's (any creator). */
  revocations: RevocationRecord[]
  /** Releases with this sha256 that were live at some earlier block but are gone now. */
  expiredReleases?: ReleaseRecord[]
  /**
   * Live releases of the same app that the file was expected to match, e.g. the release a mirror
   * claimed to serve, or releases with the same file name. Used to tell "tampered" from "unknown".
   */
  expected?: ReleaseRecord[]
}

export type VerdictResult = {
  verdict: Verdict
  /** The release this verdict is about, when there is one. */
  release?: ReleaseRecord
  role?: SignerRole
  revocation?: RevocationRecord
  /** Releases with this hash by addresses the user did not pin. Shown, never trusted. */
  untrusted: ReleaseRecord[]
  summary: string
}

function trusted<T extends { creator: string; app: string }>(trust: Trust, items: T[]) {
  return items
    .map((item) => ({ item, role: roleOf(trust, item.creator, item.app) }))
    .filter((x): x is { item: T; role: SignerRole } => x.role !== null)
}

function newest<T extends { createdAt: bigint }>(items: T[]): T | undefined {
  return [...items].sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt > b.createdAt ? -1 : 1))[0]
}

export function computeVerdict(input: VerdictInput): VerdictResult {
  const sha = input.sha256.toLowerCase()
  const { trust } = input
  const matches = (r: { sha256: string }) => r.sha256 === sha

  const releases = trusted(trust, input.releases.filter(matches))
  const revocations = trusted(trust, input.revocations.filter(matches))
  const untrusted = input.releases.filter((r) => matches(r) && roleOf(trust, r.creator, r.app) === null)
  const expired = trusted(trust, (input.expiredReleases ?? []).filter(matches))

  // A revocation wins over everything, including a release that is still inside its window.
  const rev = newest(revocations.map((r) => r.item))
  if (rev) {
    const rel = releases[0] ?? expired[0]
    return {
      verdict: "REVOKED",
      revocation: rev,
      ...(rel ? { release: rel.item, role: rel.role } : {}),
      untrusted,
      summary:
        `Revoked by the ${roleOf(trust, rev.creator, rev.app)}: ${rev.reason || "no reason given"}` +
        (rev.replacedBySha256 ? ` Use the replacement ${rev.replacedBySha256.slice(0, 12)}… instead.` : ""),
    }
  }

  const live = releases.sort((a, b) => b.item.version - a.item.version)[0]
  if (live) {
    return {
      verdict: "OK",
      release: live.item,
      role: live.role,
      untrusted,
      summary: `Matches ${live.item.app} ${live.item.versionName} (${live.item.channel}), published by the ${live.role}.`,
    }
  }

  const old = expired.sort((a, b) => b.item.version - a.item.version)[0]
  if (old) {
    return {
      verdict: "EOL",
      release: old.item,
      role: old.role,
      untrusted,
      summary:
        `This is ${old.item.app} ${old.item.versionName}. Its support window has ended, ` +
        "so the publisher no longer vouches for it.",
    }
  }

  const expected = trusted(trust, input.expected ?? []).filter((x) => x.item.sha256 !== sha)
  if (expected.length > 0) {
    const e = expected.sort((a, b) => b.item.version - a.item.version)[0]!
    return {
      verdict: "TAMPERED",
      release: e.item,
      role: e.role,
      untrusted,
      summary:
        `Does not match ${e.item.app} ${e.item.versionName}: expected sha256 ${e.item.sha256.slice(0, 12)}…, ` +
        `got ${sha.slice(0, 12)}…. Do not run this file.`,
    }
  }

  return {
    verdict: "UNKNOWN_PUBLISHER",
    untrusted,
    summary:
      untrusted.length > 0
        ? `Not published by ${trust.pinned}. ${untrusted.length} other address(es) claim this file; Lifeboat ignores them.`
        : `Nothing on Arkiv from ${trust.pinned} vouches for this file.`,
  }
}

/** One line per verdict, for docs and UI legends. */
export const VERDICT_TEXT: Record<Verdict, string> = {
  OK: "Published by the pinned address and inside its support window.",
  TAMPERED: "Claims to be a published file but the bytes differ. Do not run it.",
  REVOKED: "The publisher revoked this build.",
  EOL: "Was published, but the support window ended. No longer vouched for by the publisher.",
  UNKNOWN_PUBLISHER: "The pinned address never published this file.",
}
