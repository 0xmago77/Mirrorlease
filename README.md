# Lifeboat

Software downloads that keep working, and stay verifiable, when the project's website or GitHub is
blocked, taken down or hacked.

Live page: https://0xmago77.github.io/lifeboat/
Demo app: https://0xmago77.github.io/lifeboat/#/app/lifeboat-cli?publisher=0x8fb633d00b49d851dbff111b0d7c1eec8f9dcea2

Built for the Arkiv "Global Tour Stop" builder challenge. Tracks: Censorship Resistance (primary),
Security, Open Source.

## The problem

When a project's download site is blocked in a country, seized, or quietly replaced with a
backdoored build, its users lose the one place they knew to get the real file. Mirrors appear, but
nobody can tell a good mirror from a poisoned one, and checksums published on the same blocked or
hacked site are worth nothing. Old builds with known holes keep being installed because nothing
tells the user that the project stopped supporting them.

## What Lifeboat does

- The **publisher** writes a release entity to Arkiv from their wallet for each build: version,
  sha256, size, channel. Its Entity Expiration is the support window. When the window ends, the
  build is end-of-life and every Lifeboat client says so.
- If a build is compromised, the publisher **revokes** it. The revocation and the fixed release go
  out in one atomic transaction, and open pages show the revocation live over a WebSocket.
- Anyone can run a **mirror**: a URL that serves the exact file, registered as a 6 hour lease on
  Arkiv. A keeper re-downloads it every two hours and renews the lease only while the bytes still
  match. Users who verified a download can renew it too. Mirrors that go bad lapse on their own.
- The **user** pins the publisher's address once (from the project's README, a signed tag, a QR
  code). Lifeboat reads Arkiv directly, with no Lifeboat server in between, tries mirrors freshest
  lease first, hashes the file locally, and refuses anything that does not match.

Who it is for: maintainers of tools that get blocked or targeted (VPNs, privacy tools, wallets,
messengers, anything people in a censored network need), and the people who download them.

## Try it in 60 seconds

In a browser:

1. Open the [demo app](https://0xmago77.github.io/lifeboat/#/app/lifeboat-cli?publisher=0x8fb633d00b49d851dbff111b0d7c1eec8f9dcea2).
   The app is Lifeboat's own CLI. You see the founder and current maintainer, the releases with
   their support windows, a red banner for the revoked 0.0.9, and the mirrors with their leases.
2. Press **Download & verify**. The log shows each mirror being tried: the "official" download host
   is dead, a poisoned mirror serves a modified tarball and is rejected on its hash, and a good
   mirror wins. Only then is the file offered for saving.
3. Open [Check a file](https://0xmago77.github.io/lifeboat/#/check) and drop in any of the demo
   files linked at the bottom of that page: 0.1.0 is OK, 0.0.9 is REVOKED, 0.0.8 is END-OF-LIFE
   (its one day support window ended), and the tampered copy is TAMPERED.
4. [Read it without us](https://0xmago77.github.io/lifeboat/#/raw) has the exact queries, as SDK code and
   as `curl`, to get the same data from any machine without this site.

From a terminal (Node 22+):

```sh
# Get the CLI from any mirror. It is one file with no dependencies.
curl -LO https://cdn.jsdelivr.net/gh/0xmago77/lifeboat@main/web/public/dist/lifeboat-cli-0.1.0.tgz
npm i -g ./lifeboat-cli-0.1.0.tgz

P=0x8fb633d00b49d851dbff111b0d7c1eec8f9dcea2
lifeboat verify lifeboat-cli-0.1.0.tgz --publisher $P   # did the publisher vouch for the file you just got?
lifeboat status lifeboat-cli --publisher $P             # releases, revocations, mirror leases
lifeboat fetch lifeboat-cli --publisher $P --out /tmp/lb.tgz   # failover across mirrors, hash-checked
lifeboat watch lifeboat-cli --publisher $P              # revocations and new mirrors, live
```

Or run it from a clone: `npm ci && npm run lifeboat -- status lifeboat-cli --publisher $P`.

## Why Arkiv

What Lifeboat needs from its data layer, and what goes wrong elsewhere:

- **No single place to block or seize.** A Postgres database behind our own API is one more server
  that can be blocked, taken down or hacked, which is the exact failure Lifeboat exists to survive.
  Arkiv is read through any RPC endpoint, and the page and CLI talk to it directly.
- **Authorship you do not have to trust us for.** `$creator` is set by the chain and cannot be
  changed. In our own database, whoever controls the database decides who "published" what. The
  pinned address plus `$creator` is the whole trust model.
- **Records that expire on their own.** Support windows and mirror leases are Entity Expiration,
  enforced by the chain. On IPFS a release record is either pinned forever or silently gone; there is
  no "valid until" that every reader agrees on, and no cheap way to say "this mirror was alive an
  hour ago".
- **Queries, not just storage.** "Releases of app X by address P with version > N", "is hash H
  revoked", "mirrors for hash H": attribute queries with ranges, served by the RPC. IPFS has no
  query layer; a subgraph needs an indexer someone has to run and that can itself be blocked.
- **Revocations that reach people.** WebSocket entity events push a revocation to every open page.
  Polling our own API means running that API.
- **Someone else can keep a record alive without being able to change it.** Mirror entities are
  created with `permissionlessExtension`, so users can renew a mirror's lease, but only its operator
  can change or delete it. That is hard to express on a plain database or on IPFS.

What stays off Arkiv: the files themselves (payloads are capped at 128 KB; Arkiv holds the hash,
size and mirror URLs), private keys, and any record of who downloaded what.

## How each Arkiv feature shows up for the user

| Arkiv feature | Where you see it |
|---|---|
| Attributes + queries (`eq`, range `gt` on `u64`) | Release list, "updates since", verify-by-hash, mirror list |
| `createdBy` / `$creator` | Only the pinned address's entities are shown; anything else is "UNKNOWN PUBLISHER" |
| `$owner` + `changeOwnership` | App card shows founder vs maintainer; maintainer releases are accepted and labelled |
| Entity Expiration | "SUPPORTED until <date>" chips; releases past their window drop off and verify says END-OF-LIFE; mirror "expires in 5h" |
| Lifetime Extension (`extendEntity`) | `lifeboat support` extends a support window; keeper renews mirror leases; the countdown on the page moves |
| `permissionlessExtension` creation flag | `lifeboat fetch --vouch` renews the lease of the mirror you just verified, from your own wallet |
| `executeBatch` | `lifeboat revoke --replacement`: revocation and fixed release land in one transaction |
| `watchEntityEvents` over WebSocket | Revocation banner appears on open pages without a reload; lease countdowns update from `ExpiryExtended` events |
| `atBlock` historical queries + entity event logs | Verify can say "this was 0.0.8, support ended on <date>" after the entity expired |
| Explorer | Every entity on the page links to `tiramisu.explorer.arkiv.network/entity/<key>` |

## Trust pinning

You trust exactly one thing: the publisher's address. It must reach you through the project's own
channels (README, signed git tag, release notes, a QR code at a talk, a package you already have),
never only through a Lifeboat link. Lifeboat then:

- shows only releases and revocations whose `$creator` is that address;
- also accepts the current `$owner` of an app entity that address created (a maintainer handoff),
  scoped to that app, and labels those entries "maintainer";
- ignores everything else, including look-alike app entities with the same id created by others;
- never uses an attribute or payload field to decide who is trusted.

The web page remembers the address you confirmed for an app in your browser, and warns loudly if a
later link pins a different one.

## Threat model

Lifeboat protects against:

- **A blocked or seized download site.** Any mirror on any host works, and the list lives on Arkiv.
- **Poisoned mirrors and a hacked site serving a modified build.** Bytes are hashed locally and
  compared with the publisher's release before you can save them. A wrong file is never offered.
- **A compromised build the publisher already shipped.** Revocations reach the CLI and open pages,
  and outlive the release by design.
- **Silent use of unsupported builds.** An expired support window shows as END-OF-LIFE.
- **A malicious mirror operator gaming the order.** Anyone can extend a mirror's lease, so someone
  could push a bad mirror's expiry far out to be tried first. Clients try over-extended leases last,
  and the hash check still rejects the bytes.

Lifeboat does not protect against:

- **A compromised publisher key.** Whoever holds it can publish a malicious build that verifies as
  OK. Keep the key offline; a handoff to a new maintainer key is possible, but there is no on-chain
  key rotation or multi-signature requirement in this version.
- **Arkiv RPC being blocked for the user.** The data is on Arkiv, but you need some way to reach it.
  Mitigations: any Arkiv RPC endpoint works (`--rpc` / `LIFEBOAT_RPC`), you can run your own node or
  watcher, and the snippets on the "Read it without us" page work from any machine.
- **First contact.** If the first address you ever see for a project is an attacker's, Lifeboat will
  faithfully verify the attacker's builds. Get the address from more than one channel.
- **Malware in a build the publisher really did sign.** Lifeboat proves origin and integrity, not
  safety.
- **Metadata privacy.** Your RPC provider and the mirror you download from can see your requests.
- **The public RPC's anonymous query budget.** The public Tiramisu RPC limits how many queries one
  connection can make (see `arkiv/friction.md`). A view costs a handful of queries; heavy use from
  one IP can hit the limit, and Lifeboat then says so instead of hanging.

## CLI reference

```
Readers (no key needed):
  lifeboat status <app> --publisher <0x..>
  lifeboat verify <file> --publisher <0x..> [--app id]     exit 0 only when OK
  lifeboat fetch <app> --publisher <0x..> [--out f] [--channel stable|beta] [--vouch]
  lifeboat updates <app> --publisher <0x..> --since <versionCode>
  lifeboat watch <app> --publisher <0x..>

Publisher (key needed):
  lifeboat app create --app <id> --name <name> [--description d] [--homepage url]
  lifeboat app handoff <newOwner> --app <id>
  lifeboat publish <file> --app <id> --version 1.2.3 [--code n] [--channel stable|beta] [--notes t] [--days n]
  lifeboat support <sha256> --days <n>
  lifeboat revoke <sha256> --reason <text> [--severity 1-3] [--replacement <file> --version x.y.z]

Mirror operator (key needed):
  lifeboat mirror add <url> --sha256 <hash> [--region r] [--note t]
  lifeboat mirror list [--operator 0x..]
  lifeboat keeper --once [--dry-run]
  lifeboat whoami

All commands: --json, --cost (RPC requests and query budget used), --rpc <url>.
Keys are read only from LIFEBOAT_KEY_FILE (a path) or LIFEBOAT_PRIVATE_KEY, and never printed.
```

### Running a mirror

```sh
export LIFEBOAT_KEY_FILE=~/.config/lifeboat/mirror.key   # a funded Tiramisu key
lifeboat mirror add https://example.org/files/app-1.2.3.tgz --sha256 <hash>   # downloads and checks first
scripts/install-keeper.sh ~/.config/lifeboat/mirror.key   # systemd user timer, every 2 hours
```

`scripts/keeper.service` and `scripts/keeper.timer` are templates with placeholders
(`{{LIFEBOAT_DIR}}`, `{{NODE_BIN_DIR}}`, `{{KEY_FILE}}`); the install script fills them in. The
demo's keeper also re-registers the dead and poisoned demo entries after they lapse, so the failover
demo stays visible; drop that `ExecStart` line for a real mirror.

## Demo data on Tiramisu

Publisher `0x8fb633d00b49d851dbff111b0d7c1eec8f9dcea2`, mirror operator
`0xddce3253a9ce18459b9a7ad4b49e7f8aaa4f9776`. Created with `scripts/seed-demo.ts`, which drives the
CLI and skips anything that already exists.

| entity | key | transaction | Entity Expiration |
|---|---|---|---|
| app `lifeboat-cli` | [0x552a5c68…](https://tiramisu.explorer.arkiv.network/entity/0x552a5c68bb43f0a0f39deb5cbd8c9d359f7b6576be879e3d185eccb102bfbf17) | [0x0bfbe0c7…](https://tiramisu.explorer.arkiv.network/tx/0x0bfbe0c7cd8b37b6494f36973e79ba1c6c82c7dff165669c6176b3abe6c7ca5d) | 180 days |
| release 0.0.8 (beta) | [0x2e7a8427…](https://tiramisu.explorer.arkiv.network/entity/0x2e7a8427c3f241c8200dae8953f1796ad0060f7f951e1dacdb6c2efde0919e14) | [0x0cfe95b0…](https://tiramisu.explorer.arkiv.network/tx/0x0cfe95b0a94170756caeabfe8b4e1aa6d2b00312465f6195140052f66721df09) | 1 day: end-of-life from 2026-10-15 20:25 UTC |
| release 0.0.9 (stable) | [0x5bdc13e7…](https://tiramisu.explorer.arkiv.network/entity/0x5bdc13e7747ac1d5a9b322f4c2b500ec45f2a07e3ad989000344147cb1bec80b) | [0x20f67927…](https://tiramisu.explorer.arkiv.network/tx/0x20f67927be63003cd90906cf6a817b147225f59a944a8c46e8eba7add4b8ef36) | 60 days, revoked |
| revocation of 0.0.9 | [0xa6f223f3…](https://tiramisu.explorer.arkiv.network/entity/0xa6f223f3c029157ab1c798c013ea3266007d617f6865643e412b1ec87d6aaf7f) | [0x05de3541…](https://tiramisu.explorer.arkiv.network/tx/0x05de3541259f773698902287f92fec2b22b810c94089a8bcf7db5a1a21c57c66) | 365 days |
| release 0.1.0 (stable), same batch | [0x405bdb22…](https://tiramisu.explorer.arkiv.network/entity/0x405bdb22cf5c96027d07ecc081882c624198a64086eeb3877944a6876353dd44) | [0x05de3541…](https://tiramisu.explorer.arkiv.network/tx/0x05de3541259f773698902287f92fec2b22b810c94089a8bcf7db5a1a21c57c66) | 60 days |

Files (`web/public/dist`): `lifeboat-cli-0.1.0.tgz` sha256 `f9d7faac274bf3e3c24f43f6692435b2f7c2ac73d28bd2c3b8337b9549de6a43`,
`lifeboat-cli-0.0.9.tgz` `a975ad6318733c5111bc0eb60ca509360b51930280dfd162844c324b87c54880`,
`lifeboat-cli-0.0.8.tgz` `826c088d2c56b6b565e5a1ce5576023e81fcba2352d0f43037944e5d1f77445c`, and the poisoned
copy `tampered/lifeboat-cli-0.1.0.tgz` `d09c6da860aedfef5e9ebc53571848a5ad9942736254cb2fccb5aa08a8da616d`.

Mirrors for 0.1.0, registered by the mirror operator after the repository is public (the real ones are
downloaded and checked before registration): GitHub Pages, jsDelivr and raw.githubusercontent copies of
the tarball, a dead "official" host (`downloads.lifeboat-demo.invalid`) and the poisoned copy. The last two
are registered with `--skip-check`, which exists only for this demo.

The app `lb-selftest` holds the end-to-end tests run while building: a handoff to a maintainer, releases
by both, two revocations (one by the maintainer, sent while a browser had the page open), and mirrors on
jsDelivr and unpkg. Its entities expire within a few days.


## Development

```sh
npm ci
npm test               # vitest: verdicts, trust pinning, download failover, schema round trips
npm run typecheck
npm run dev:web        # http://localhost:5173/lifeboat/
npm run build:web      # web/dist, deployable to any static host
npm run build:cli      # dist/lifeboat.mjs, one file
node scripts/pack-cli.mjs 0.1.0 web/public/dist
```

Layout: `src/core` (shared by CLI and page: schema, queries, trust, verdicts, verified download),
`src/cli`, `web`, `scripts`, `arkiv/schema.md` (entities and exact queries), `arkiv/friction.md`
(what was hard, with reproduction steps).

## Credits

| Library | Use | License |
|---|---|---|
| [@arkiv-network/sdk](https://github.com/Arkiv-Network/arkiv-sdk-js) | Arkiv client | MIT |
| [viem](https://github.com/wevm/viem) | Ethereum transports, accounts | MIT |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes), [@noble/curves](https://github.com/paulmillr/noble-curves), [@scure/*](https://github.com/paulmillr/scure-base) | bundled via viem | MIT |
| [abitype](https://github.com/wevm/abitype), [ox](https://github.com/wevm/ox) | bundled via viem | MIT |
| [Vite](https://vitejs.dev) | web build | MIT |
| [esbuild](https://esbuild.github.io) | CLI bundle | MIT |
| [Vitest](https://vitest.dev) | tests | MIT |
| [tsx](https://github.com/privatenumber/tsx) | running TypeScript | MIT |
| [TypeScript](https://www.typescriptlang.org) | types | Apache-2.0 |

## License

MIT, see [LICENSE](LICENSE).
