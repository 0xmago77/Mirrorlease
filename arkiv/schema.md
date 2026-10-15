# Mirrorlease on Arkiv: schema and queries

Network: Tiramisu testnet, chain id 7738577, RPC `https://rpc.tiramisu.db-chain.testnet.arkiv.network`
(WebSocket on the same host with `wss://`). SDK: `@arkiv-network/sdk` 0.8.1 with viem 2.57.

The code that writes these entities is `src/core/schema.ts`; the code that reads them is
`src/core/queries.ts`. This file and those two must agree.

## Rules that apply to every entity

- Every entity carries `ml = "1"` (string). It is a namespace, so our queries never match someone
  else's data, and a version marker if the schema ever changes.
- `kind` (string) is one of `app`, `release`, `revocation`, `mirror`.
- `app` (string) is the app id, lowercase `[a-z0-9._-]`, up to 64 characters.
- Payloads are JSON (`contentType: application/json`). Payloads are not queryable, so anything a
  query filters on is an attribute, and anything that is only displayed is in the payload.
- Numbers that are compared with `<`/`>` are `u64` attributes, written with `u64(...)` from
  `@arkiv-network/sdk/attr`. A bare JS number would be stored as `i32`, and a range query has to use
  the same type as the stored value.
- Who wrote an entity is decided by `$creator`, which the chain sets and nobody can change. Mirrorlease
  never trusts a writable attribute or payload field to say who published something.
- Everything read back is treated as untrusted input. Anyone can write an entity with `ml = "1"`;
  malformed ones are dropped by the decoder, and ones from unpinned addresses are ignored by the
  trust rules below.

## 1. app

Created by the publisher (the founder). One per app id.

| attribute | type | value |
|---|---|---|
| `ml` | str | `"1"` |
| `kind` | str | `"app"` |
| `app` | str | app id, e.g. `mirrorlease-cli` |

Payload: `{ "name": string, "description": string, "homepage": string }`

Entity Expiration: 180 days. The app entity is the anchor for handoff, so it lives longer than any
release; the publisher renews it with a Lifetime Extension while the project is alive.

Ownership: `$creator` is the founder forever. `changeOwnership` (`mirrorlease app handoff <addr>`)
moves `$owner` to a new maintainer. Verifiers that pin the founder then also accept releases and
revocations created by the app entity's current `$owner`, for that app only, and label them
"maintainer". An app entity created by anyone other than the pinned address is ignored, even if it
uses the same app id, so nobody can hijack an app by creating a look-alike entity.

## 2. release

Created by the publisher or the current maintainer. One per build.

| attribute | type | value |
|---|---|---|
| `ml` | str | `"1"` |
| `kind` | str | `"release"` |
| `app` | str | app id |
| `version` | u64 | version code, monotonic. `1.2.3` becomes `10203` unless `--code` is given |
| `sha256` | str | lowercase hex sha256 of the file, 64 characters |
| `size` | u64 | file size in bytes |
| `channel` | str | `"stable"` or `"beta"` |

Payload: `{ "versionName": "0.1.0", "fileName": "mirrorlease-cli-0.1.0.tgz", "notes": string }`

Entity Expiration: the support window. Stable 60 days, beta 7 days, or `--days n`.
`mirrorlease support <sha256> --days n` is a Lifetime Extension of that window. When the window ends
the entity expires, queries at the head stop returning it, and the build is end-of-life (EOL): users
see "no longer vouched for by the publisher" instead of silently installing it.

How EOL is detected after the entity is gone: the verifier reads the publisher's `EntityCreated` and
`ExpiryExtended` logs (both index `owner`) to list every entity they made, when it was created and
when it expired, then runs the release-by-hash query with `atBlock` at a few blocks chosen so that
every now-dead entity was alive at one of them. That reads the release as it was before it expired,
so the answer can say which version it was and when support ended. Code: `findExpiredRelease` in `src/core/queries.ts`.

## 3. revocation

Created by the publisher or the current maintainer.

| attribute | type | value |
|---|---|---|
| `ml` | str | `"1"` |
| `kind` | str | `"revocation"` |
| `app` | str | app id |
| `sha256` | str | sha256 of the revoked file |
| `version` | u64 | version code of the revoked release |
| `severity` | u64 | 1 (advisory) to 3 (do not run) |

Payload: `{ "reason": string, "replacedBySha256"?: string }`

Entity Expiration: 365 days, longer than any support window, so a revocation outlives the release
it revokes. A revoked file stays REVOKED even after its release entity expired.

`mirrorlease revoke <sha> --replacement <file> --version x.y.z` writes the revocation and the
replacement release in one `executeBatch` transaction. Both land or neither does, so there is never
a moment where users are told "revoked" with nothing to upgrade to, or see the new release without
the warning about the old one.

## 4. mirror

Created by any mirror operator. Mirrors are untrusted: every download is hashed and compared with
the publisher's release before the user gets it.

| attribute | type | value |
|---|---|---|
| `ml` | str | `"1"` |
| `kind` | str | `"mirror"` |
| `app` | str | app id |
| `sha256` | str | sha256 of the file this URL is supposed to serve |
| `scheme` | str | `"https"` |
| `region` | str | optional, free text |

Payload: `{ "url": "https://...", "note": string }`

Creation flags: `permissionlessExtension: true`.

Entity Expiration: a 6 hour lease. The operator's keeper (`mirrorlease keeper --once`, every 2 hours
from a systemd timer) downloads each of its mirrors, hashes it, and extends the lease to 6 hours
from now only if the bytes match. Because of the creation flag, any user whose client just
downloaded and verified the file may extend it too (`mirrorlease fetch --vouch`), so a mirror that
people actually use stays listed even if its operator disappears. A mirror that stops serving the
right bytes is simply not renewed and lapses within 6 hours.

Because anyone may extend a mirror, someone could push a bad mirror's expiry far into the future to
put it first in the list. Clients treat a lease longer than the normal window as suspicious and try
it last; it would still be rejected by the hash check.

`mirror add` downloads the URL and refuses to register it if the hash does not match. The
`--skip-check` flag exists only to register the dead and poisoned demo entries.

## Queries

The public Tiramisu RPC bills every `arkiv_query` a flat 100 units against an anonymous budget of
10000 units per window, whatever the query selects or returns; `arkiv_getBlockTiming` and
`eth_getLogs` are not billed (measured from the `Arkiv-Cost` header, see `arkiv/friction.md`). So
each view is built from as few queries as possible: one OR query fetches several kinds at once, and
the client filters by kind, trust and hash, and sorts (there is no ORDER BY; results come newest
first, at most 200 per page, with a cursor). Builders live in `Q` in `src/core/queries.ts`; the
rendered text below is exactly what goes to `arkiv_query`.

App page and `mirrorlease status` / `fetch`: one query returns the app entity, the publisher's
releases and revocations for the app, and every mirror registered for the app (any operator):

```ts
client.select("*").where(
  eq("ml", "1"), eq("app", app),
  or(eq("$creator", addr(publisher)), eq("kind", "mirror")),
)
// ml = str('1') AND app = str('mirrorlease-cli') AND ($creator = addr(0x8fB6...CeA2) OR kind = str('mirror'))
```

The client keeps releases and revocations whose creator is trusted, sorts releases by `version`
descending, picks the newest unrevoked stable release, and sorts that release's mirrors by
`$expiresAt` descending (freshest lease first). If the app entity's `$owner` is not the publisher
(a handoff), one more query reads what the maintainer created for this app:

```ts
client.select("*").where(eq("ml", "1"), eq("app", app)).createdBy(maintainer)
```

Check a file and `mirrorlease verify`: one query returns anything that mentions the hash (releases,
revocations, mirrors, by anyone) and everything the publisher created (its app entities, so
handoffs are visible, and its releases, so a same-named file with other bytes is TAMPERED):

```ts
client.select("*").where(eq("ml", "1"), or(eq("sha256", sha), eq("$creator", addr(publisher))))
// ml = str('1') AND (sha256 = str('...') OR $creator = addr(0x8fB6...CeA2))
```

Releases by unpinned addresses that match the hash are shown as "also claimed by", never trusted.
After a handoff the same query runs once more with the maintainer's address.

Updates newer than what the user has (range query on the `u64` attribute; the literal must be
`u64` too, see friction item 7):

```ts
client.select("*")
  .where(eq("ml", "1"), eq("kind", "release"), eq("app", app), gt("version", u64(BigInt(current))))
  .createdBy(publisher)
// ... AND version > u64(9) AND $creator = addr(...)
```

Mirror operator: `mirror add` reads everything about the hash (`ml = 1 AND sha256 = H`) to learn the
app id and size and to skip a URL it already registered; the keeper lists its own mirrors:

```ts
client.select("*").where(eq("ml", "1"), eq("kind", "mirror")).createdBy(operator)
```

Publisher commands check what they already own before writing, so reruns do not duplicate:

```ts
client.select("*").where(eq("ml", "1"), or(eq("sha256", revoked), eq("sha256", replacement))).ownedBy(me)
```

History, for EOL (see the release section). The logs are free; each `atBlock` read costs one query.
To keep that small, the client computes the fewest blocks at which every now-dead entity of the
publisher was alive (greedy interval stabbing over `[created, expiresAt - 1]`) and reads only
those, newest first, stopping at the first hit:

```ts
client.getLogs({ address: "0x4400000000000000000000000000000000000044", event: EntityCreated, args: { owner: publisher }, fromBlock, toBlock })
client.getLogs({ address: "0x4400000000000000000000000000000000000044", event: ExpiryExtended, args: { owner: publisher }, fromBlock, toBlock })
client.select("*").where(eq("ml", "1"), eq("kind", "release"), eq("sha256", sha)).createdBy(publisher).atBlock(block)
```

`eth_getLogs` on Tiramisu accepts at most 100000 blocks per call, so the range is paged.

Live updates (web page): `watchEntityEvents` over a WebSocket transport, with no `fromBlock`, so it
is a real `eth_subscribe` rather than polling. To stay within the anonymous query budget the page
does not fetch every new entity on the chain:

- `EntityCreated` whose `owner` is the pinned publisher or maintainer: re-read the app (a new
  release or revocation; the revocation banner appears without a reload).
- `EntityCreated` with the `permissionlessExtension` flag from anyone else: maybe a new mirror,
  re-read at most once a minute.
- `ExpiryExtended` for a mirror or release on screen: the event carries the new expiry, so the lease
  countdown updates with no query at all.

## Demo entity keys

Publisher `0x8fb633d00b49d851dbff111b0d7c1eec8f9dcea2`, app `mirrorlease-cli`, namespace `ml = "1"`:

| entity | key |
|---|---|
| app | `0x368f733a056f4036fc155fd23b1e23bd3bf3db52106a5c8218ddca9149cbea4d` |
| release 0.0.8 (beta) | `0xcb353b4ba2be3c8249a30cabbd1057d422e2a6999d0627e84a243fa6d2040f5e` |
| release 0.0.9 | `0x9edb043b6fa4a958b378a89fdcc81990e7f2c052a2fed0fcb191f0011b30c5cc` |
| revocation of 0.0.9 | `0x4d11efce1525c49c5fa63192b06b16f1da6a67a011130baadc07d0fddb45af5d` |
| release 0.1.0 | `0xe28de0e6f2945e8fa47e73fa17547b36d00ff830a71d8e50939d1c1f2a68b35b` |
| mirror: GitHub Pages | [0x046ad4a4…](https://tiramisu.explorer.arkiv.network/entity/0x046ad4a477359575ffad725b532d5655c92ad45475c8989cc74d20cd35c92b0b) |
| mirror: jsDelivr | [0x78bf29fa…](https://tiramisu.explorer.arkiv.network/entity/0x78bf29fa2df026588087c48c8ec8b99d4eb05344fd657805b045c5c6305be2c4) |
| mirror: raw.githubusercontent | [0xea58d962…](https://tiramisu.explorer.arkiv.network/entity/0xea58d962f0d846f07c3fc15f276f135fc1224ffafd23c9ff31e43c6fd7d2e3ab) |
| mirror: dead host, demo | [0x272bab6b…](https://tiramisu.explorer.arkiv.network/entity/0x272bab6ba5442b7b23273e53e1a5d83751246e35b949831773ea523c56070078) (first lease; re-registered later) |
| mirror: poisoned copy, demo | [0x4241e254…](https://tiramisu.explorer.arkiv.network/entity/0x4241e25467aa21d58927a66f806ecde776cb8ec9c972bf029349d7c943238714) (first lease; re-registered later) |

## What stays off Arkiv

- The files themselves. Payloads are capped at 128 KB and a release can be hundreds of MB; Arkiv
  holds the hash, the size and where to find copies, and the mirrors hold the bytes.
- Private keys. They are read from `MIRRORLEASE_KEY_FILE` or `MIRRORLEASE_PRIVATE_KEY` and never written
  anywhere.
- Download logs and who downloaded what. A vouch extends a lease; it does not record the user.
