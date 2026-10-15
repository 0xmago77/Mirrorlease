// Trust pinning. The user brings one address (from the project's README, a signed tag, a QR code)
// and Mirrorlease only believes entities whose immutable $creator is that address, or the current
// $owner of an app entity that address created (a maintainer handoff). No writable field such as an
// attribute or payload is ever used to decide who is trusted.

import type { AppRecord, Hex } from "./schema"

export type SignerRole = "publisher" | "maintainer"

export type Trust = {
  pinned: Hex
  /** app id -> the app entity created by the pinned publisher (newest if several). */
  apps: Map<string, AppRecord>
}

export function lower(a: string): Hex {
  return a.toLowerCase() as Hex
}

export function isAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a)
}

/**
 * Builds the trust set from the pinned address and whatever app entities were found. App entities
 * not created by the pinned address are ignored: anyone can create an app entity with the same id.
 */
export function buildTrust(pinned: string, appEntities: AppRecord[]): Trust {
  const p = lower(pinned)
  const apps = new Map<string, AppRecord>()
  for (const a of appEntities) {
    if (lower(a.creator) !== p) continue
    const prev = apps.get(a.app)
    if (!prev || a.createdAt > prev.createdAt) apps.set(a.app, a)
  }
  return { pinned: p, apps }
}

/** Which role, if any, `creator` holds for `app` under this trust set. */
export function roleOf(trust: Trust, creator: string, app: string): SignerRole | null {
  const c = lower(creator)
  if (c === trust.pinned) return "publisher"
  const appEntity = trust.apps.get(app)
  if (appEntity && lower(appEntity.owner) === c) return "maintainer"
  return null
}

/** Every address whose entities should be fetched for `app` (pinned first). */
export function signersFor(trust: Trust, app?: string): Hex[] {
  const out = new Set<Hex>([trust.pinned])
  for (const [id, a] of trust.apps) {
    if (app === undefined || id === app) out.add(lower(a.owner))
  }
  return [...out]
}
