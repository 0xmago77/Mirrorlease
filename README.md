# Mirrorlease

Software downloads that keep working, and stay verifiable, when the project's website or GitHub is
blocked, taken down or hacked.

Live page: https://0xmago77.github.io/Mirrorlease/
Demo app: https://0xmago77.github.io/Mirrorlease/#/app/mirrorlease-cli?publisher=0x8fb633d00b49d851dbff111b0d7c1eec8f9dcea2

Built for the Arkiv "Global Tour Stop" builder challenge. Tracks: Censorship Resistance (primary),
Security, Open Source.

## The problem

When a project's download site is blocked in a country, seized, or quietly replaced with a
backdoored build, its users lose the one place they knew to get the real file. Mirrors appear, but
nobody can tell a good mirror from a poisoned one, and checksums published on the same blocked or
hacked site are worth nothing. Old builds with known holes keep being installed because nothing
tells the user that the project stopped supporting them.

## What Mirrorlease does

- The **publisher** writes a release entity to Arkiv from their wallet for each build: version,
  sha256, size, channel. Its Entity Expiration is the support window. When the window ends, the
  build is end-of-life and every Mirrorlease client says so.
- If a build is compromised, the publisher **revokes** it. The revocation and the fixed release go
  out in one atomic transaction, and open pages show the revocation live over a WebSocket.
- Anyone can run a **mirror**: a URL that serves the exact file, registered as a 6 hour lease on
  Arkiv. A keeper re-downloads it every two hours and renews the lease only while the bytes still
  match. Users who verified a download can renew it too (`mirrorlease fetch --vouch`). Mirrors that go
  bad lapse on their own.
- The **user** pins the publisher's address once (from the project's README, a signed tag, a QR
  code). Mirrorlease reads Arkiv directly, with no Mirrorlease server in between, tries mirrors freshest
  lease first, hashes the file locally, and refuses anything that does not match.

Who it is for: maintainers of tools that get blocked or targeted (VPNs, privacy tools, wallets,
messengers, anything people in a censored network need), and the people who download them.

## Try it in 60 seconds

In a browser:

1. Open the [demo app](https://0xmago77.github.io/Mirrorlease/#/app/mirrorlease-cli?publisher=0x8fb633d00b49d851dbff111b0d7c1eec8f9dcea2).
   The app is Mirrorlease's own CLI. You see the founder and current maintainer, the releases with
   their support windows, a red banner for the revoked 0.0.9, and the mirrors with their leases.
2. Press **Download & verify**. Mirrors are tried freshest lease first; the log shows each attempt,
   and the file is offered for saving only after its sha256 matched the release. Then press
   **Check every mirror**: each one is downloaded and hashed separately, so you see the "official"
   download host is dead, a poisoned mirror serving a modified tarball is rejected on its hash, and
   the good mirrors verify.
3. Open [Check a file](https://0xmago77.github.io/Mirrorlease/#/check) and drop in any of the demo
   files linked at the bottom of that page: 0.1.0 is OK, 0.0.9 is REVOKED, 0.0.8 is END-OF-LIFE
   (its one day support window ended), and the tampered copy is TAMPERED.
4. [Read it without us](https://0xmago77.github.io/Mirrorlease/#/raw) has the exact queries, as SDK code and
   as `curl`, to get the same data from any machine without this site.

From a terminal (Node 22+):

```sh
# Get the CLI from any mirror. It is one file with no dependencies.
curl -LO https://cdn.jsdelivr.net/gh/0xmago77/Mirrorlease@main/web/public/dist/mirrorlease-cli-0.1.0.tgz
npm i -g ./mirrorlease-cli-0.1.0.tgz

P=0x8fb633d00b49d851dbff111b0d7c1eec8f9dcea2
mirrorlease verify mirrorlease-cli-0.1.0.tgz --publisher $P   # did the publisher vouch for the file you just got?
mirrorlease status mirrorlease-cli --publisher $P             # releases, revocations, mirror leases
mirrorlease fetch mirrorlease-cli --publisher $P --out /tmp/ml.tgz   # failover across mirrors, hash-checked
mirrorlease watch mirrorlease-cli --publisher $P              # revocations and new mirrors, live
```

Or run it from a clone: `npm ci && npm run mirrorlease -- status mirrorlease-cli --publisher $P`.

## Why Arkiv

What Mirrorlease needs from its data layer, and what goes wrong elsewhere:

- **No single place to block or seize.** A Postgres database behind our own API is one more server
  that can be blocked, taken down or hacked, which is the exact failure Mirrorlease exists to survive.
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
| Lifetime Extension (`extendEntity`) | `mirrorlease support` extends a support window; keeper renews mirror leases; the countdown on the page moves |
| `permissionlessExtension` creation flag | `mirrorlease fetch --vouch` renews the lease of the mirror you just verified, from your own wallet |
| `executeBatch` | `mirrorlease revoke --replacement`: revocation and fixed release land in one transaction |
| `watchEntityEvents` over WebSocket | Revocation banner appears on open pages without a reload; lease countdowns update from `ExpiryExtended` events |
| `atBlock` historical queries + entity event logs | Verify can say "this was 0.0.8, support ended on <date>" after the entity expired |
| Explorer | Every entity on the page links to `tiramisu.explorer.arkiv.network/entity/<key>` |

## Trust pinning

You trust exactly one thing: the publisher's address. It must reach you through the project's own
channels (README, signed git tag, release notes, a QR code at a talk, a package you already have),
never only through a Mirrorlease link. Mirrorlease then:

- shows only releases and revocations whose `$creator` is that address;
- also accepts the current `$owner` of an app entity that address created (a maintainer handoff),
  scoped to that app, and labels those entries "maintainer";
- ignores everything else, including look-alike app entities with the same id created by others;
- never uses an attribute or payload field to decide who is trusted.

The web page remembers the address you confirmed for an app in your browser, and warns loudly if a
later link pins a different one.

## Threat model

Mirrorlease protects against:

- **A blocked or seized download site.** Any mirror on any host works, and the list lives on Arkiv.
- **Poisoned mirrors and a hacked site serving a modified build.** Bytes are hashed locally and
  compared with the publisher's release before you can save them. A wrong file is never offered.
- **A compromised build the publisher already shipped.** Revocations reach the CLI and open pages,
  and outlive the release by design.
- **Silent use of unsupported builds.** An expired support window shows as END-OF-LIFE.
- **A malicious mirror operator gaming the order.** Anyone can extend a mirror's lease, so someone
  could push a bad mirror's expiry far out to be tried first. Clients try over-extended leases last,
  and the hash check still rejects the bytes.

Mirrorlease does not protect against:

- **A compromised publisher key.** Whoever holds it can publish a malicious build that verifies as
  OK. Keep the key offline; a handoff to a new maintainer key is possible, but there is no on-chain
  key rotation or multi-signature requirement in this version.
- **Arkiv RPC being blocked for the user.** The data is on Arkiv, but you need some way to reach it.
  Mitigations: any Arkiv RPC endpoint works (`--rpc` / `MIRRORLEASE_RPC`), you can run your own node or
  watcher, and the snippets on the "Read it without us" page work from any machine.
- **First contact.** If the first address you ever see for a project is an attacker's, Mirrorlease will
  faithfully verify the attacker's builds. Get the address from more than one channel.
- **Malware in a build the publisher really did sign.** Mirrorlease proves origin and integrity, not
  safety.
- **Metadata privacy.** Your RPC provider and the mirror you download from can see your requests.
- **The public RPC's anonymous query budget.** The public Tiramisu RPC limits how many queries one
  connection can make (see `arkiv/friction.md`). A view costs a handful of queries; heavy use from
  one IP can hit the limit, and Mirrorlease then says so instead of hanging.

## CLI reference

```
Readers (no key needed):
  mirrorlease status <app> --publisher <0x..>
  mirrorlease verify <file> --publisher <0x..> [--app id]     exit 0 only when OK
  mirrorlease fetch <app> --publisher <0x..> [--out f] [--channel stable|beta] [--vouch]
  mirrorlease updates <app> --publisher <0x..> --since <versionCode>
  mirrorlease watch <app> --publisher <0x..>

Publisher (key needed):
  mirrorlease app create --app <id> --name <name> [--description d] [--homepage url]
  mirrorlease app handoff <newOwner> --app <id>
  mirrorlease publish <file> --app <id> --version 1.2.3 [--code n] [--channel stable|beta] [--notes t] [--days n]
  mirrorlease support <sha256> --days <n>
  mirrorlease revoke <sha256> --reason <text> [--severity 1-3] [--replacement <file> --version x.y.z]

Mirror operator (key needed):
  mirrorlease mirror add <url> --sha256 <hash> [--region r] [--note t]
  mirrorlease mirror list [--operator 0x..]
  mirrorlease keeper --once [--dry-run]
  mirrorlease whoami

All commands: --json, --cost (RPC requests and query budget used), --rpc <url>.
Keys are read only from MIRRORLEASE_KEY_FILE (a path) or MIRRORLEASE_PRIVATE_KEY, and never printed.
```

### Running a mirror

```sh
export MIRRORLEASE_KEY_FILE=~/.config/mirrorlease/mirror.key   # a funded Tiramisu key
mirrorlease mirror add https://example.org/files/app-1.2.3.tgz --sha256 <hash>   # downloads and checks first
scripts/install-keeper.sh ~/.config/mirrorlease/mirror.key   # systemd user timer, every 2 hours
```

`scripts/keeper.service` and `scripts/keeper.timer` are templates with placeholders
(`{{MIRRORLEASE_DIR}}`, `{{NODE_BIN_DIR}}`, `{{KEY_FILE}}`); the install script fills them in. The
demo's keeper also re-registers the dead and poisoned demo entries after they lapse, so the failover
demo stays visible; drop that `ExecStart` line for a real mirror.

## Demo data on Tiramisu

Renamed from Lifeboat on 15 October 2026; early test entities on Tiramisu use the old `lb` namespace and app ids `lifeboat-cli` / `lb-selftest`.

Publisher `0x8fb633d00b49d851dbff111b0d7c1eec8f9dcea2`, mirror operator
`0xddce3253a9ce18459b9a7ad4b49e7f8aaa4f9776`. Created with `scripts/seed-demo.ts`, which drives the
CLI and skips anything that already exists.

| entity | key | transaction | Entity Expiration |
|---|---|---|---|
| app `mirrorlease-cli` | [0x368f733a…](https://tiramisu.explorer.arkiv.network/entity/0x368f733a056f4036fc155fd23b1e23bd3bf3db52106a5c8218ddca9149cbea4d) | [0x030f9bf9…](https://tiramisu.explorer.arkiv.network/tx/0x030f9bf9c75be36a0cbaf7a72b20c95b1d6131a871b14493f3d99eb96316d54d) | 180 days |
| release 0.0.8 (beta) | [0xcb353b4b…](https://tiramisu.explorer.arkiv.network/entity/0xcb353b4ba2be3c8249a30cabbd1057d422e2a6999d0627e84a243fa6d2040f5e) | [0xdb3c9c22…](https://tiramisu.explorer.arkiv.network/tx/0xdb3c9c2202d91b474cbb4ff33d167d2934367aa74ea6d1de30416d6512949519) | 1 day: end-of-life from 2026-10-16 04:50 UTC |
| release 0.0.9 (stable) | [0x9edb043b…](https://tiramisu.explorer.arkiv.network/entity/0x9edb043b6fa4a958b378a89fdcc81990e7f2c052a2fed0fcb191f0011b30c5cc) | [0xd2c6798b…](https://tiramisu.explorer.arkiv.network/tx/0xd2c6798b3f972d1fae7e84f4a3707695a51f7810d870fc59be0f764e4fb08e20) | 60 days, revoked |
| revocation of 0.0.9 | [0x4d11efce…](https://tiramisu.explorer.arkiv.network/entity/0x4d11efce1525c49c5fa63192b06b16f1da6a67a011130baadc07d0fddb45af5d) | [0x5e341aaa…](https://tiramisu.explorer.arkiv.network/tx/0x5e341aaacaba8079553ccb24db39b7cda1764942364303af50dc9438eb1dba19) | 365 days |
| release 0.1.0 (stable), same batch | [0xe28de0e6…](https://tiramisu.explorer.arkiv.network/entity/0xe28de0e6f2945e8fa47e73fa17547b36d00ff830a71d8e50939d1c1f2a68b35b) | [0x5e341aaa…](https://tiramisu.explorer.arkiv.network/tx/0x5e341aaacaba8079553ccb24db39b7cda1764942364303af50dc9438eb1dba19) | 60 days |
| mirror: GitHub Pages copy | TBD after push (mirror 1) | TBD after push (mirror 1) | 6 hours, renewed by the keeper |
| mirror: jsDelivr copy | TBD after push (mirror 2) | TBD after push (mirror 2) | 6 hours, renewed by the keeper |
| mirror: raw.githubusercontent copy | TBD after push (mirror 3) | TBD after push (mirror 3) | 6 hours, renewed by the keeper |
| mirror: dead host, demo | TBD after push (mirror 4) | TBD after push (mirror 4) | 6 hours, re-registered by the keeper timer |
| mirror: poisoned copy, demo | TBD after push (mirror 5) | TBD after push (mirror 5) | 6 hours, re-registered by the keeper timer |

Files (`web/public/dist`): `mirrorlease-cli-0.1.0.tgz` sha256 `4daac0631e2798cfac60b8eccf35840f3fa70f872608fd4c720bd45a88442e26`,
`mirrorlease-cli-0.0.9.tgz` `320219485c46b096946625e87da17c6b0d73b0057f84a9168f29e5fe42076b45`,
`mirrorlease-cli-0.0.8.tgz` `7185fc7c06910fa196b0cb8a5c77915184ea4d15244c5622d13e8397b998b030`, and the poisoned
copy `tampered/mirrorlease-cli-0.1.0.tgz` `dc1d29d3d25c74bdf6a08f124a7bc100eef95bc979769d559e0a3662ce493a8d`.

Mirrors for 0.1.0, registered by the mirror operator after the repository is public (the real ones are
downloaded and checked before registration): GitHub Pages, jsDelivr and raw.githubusercontent copies of
the tarball, a dead "official" host (`downloads.mirrorlease-demo.invalid`) and the poisoned copy. The last two
are registered with `--skip-check`, which exists only for this demo.

The app `lb-selftest` (old `lb` namespace) holds the end-to-end tests run while building: a handoff to a maintainer, releases
by both, two revocations (one by the maintainer, sent while a browser had the page open), and mirrors on
jsDelivr and unpkg. Its entities expire within a few days.


## Development

```sh
npm ci
npm test               # vitest: verdicts, trust pinning, download failover, schema round trips
npm run typecheck
npm run dev:web        # http://localhost:5173/mirrorlease/
npm run build:web      # web/dist, deployable to any static host
npm run build:cli      # dist/mirrorlease.mjs, one file
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
