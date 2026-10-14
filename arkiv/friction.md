# Friction report

Everything here was hit while building Lifeboat, between 2026-10-14 and 2026-10-15, against the
Tiramisu testnet. Nothing is hypothetical; each item has the steps we used to reproduce it.

Environment for all items unless noted: `@arkiv-network/sdk` 0.8.1, `viem` 2.57.7, Node 26.7.0 on
Linux x64, RPC `https://rpc.tiramisu.db-chain.testnet.arkiv.network`, browser tests in headless
Chromium.

## 1. The anonymous query budget is invisible until it runs out, and then the SDK appears to hang

Surface: public Tiramisu RPC, `arkiv_query` via the SDK's `select().fetch()`.

Expected: either documented limits, or, when a limit is hit, an immediate error that says so.

Actual: after about an hour of normal development (CLI end-to-end tests plus history lookups), every
`arkiv_query` returned

```
HTTP/2 429
ratelimit: limit=10000, remaining=0, reset=2016
retry-after: 2016
{"error":"ANON_COST_LIMITED","message":"unauthenticated query budget exhausted; get an API key at https://hub.arkiv.network for a monthly quota"}
```

`eth_blockNumber` kept working, so it is a cost budget on queries, per connection, of 10000 units
with a window of roughly 35 minutes. Three things made this costly to discover:

- The body is not a JSON-RPC response, and viem's HTTP transport retries 429 with exponential
  backoff. From the SDK, `fetch()` just sat there for one to two minutes, then failed with
  `RPC Request failed.`. Our first guess was a server-side hang on a query after `changeOwnership`.
- Neither the SDK README nor the SDK source mentions the budget, the `Arkiv-Cost` header, or API
  keys. `createPublicClient` has no API key option, and we did not find documentation on
  hub.arkiv.network for how a key is sent (header name or URL form).
- The cost of a query is only visible after the fact, in `Arkiv-Cost`.

Steps to reproduce:

```sh
Q='{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["kind = str('"'"'app'"'"')",{"select":{"key":true,"attributes":true,"payload":true}}]}'
for i in $(seq 1 400); do
  curl -s -o /dev/null -D - -X POST -H 'content-type: application/json' --data "$Q" \
    https://rpc.tiramisu.db-chain.testnet.arkiv.network | grep -iE '^HTTP|ratelimit|arkiv-cost'
done
```

Watch `ratelimit: remaining` fall until the 429. Then call any `client.select(...).fetch()` from the
SDK and time it.

Suggested fix: document the budget and the cost model next to `select()`; return a JSON-RPC error
body (with a code viem does not retry) alongside the 429; add an `apiKey` option to the client
factories; have the SDK surface `Arkiv-Cost` and `RateLimit` on the `QueryResult`.

What we did: `src/core/rpc.ts` wraps `fetch`, records `Arkiv-Cost` and `RateLimit`, and turns the
429 into a JSON-RPC error with a non-retryable code and the reset time, so the CLI and page say
"budget exhausted, resets in about N min" within a second. The page shows the cost of each view.
We also cut the queries per view (see "Measured costs" below) and made the live view filter
WebSocket events before fetching anything.

### Measured costs

Measured on 2026-10-14 from the `Arkiv-Cost` and `RateLimit` response headers:

| call | Arkiv-Cost | notes |
|---|---|---|
| `arkiv_query`, full selection, limit 200, 4 results | 100 | |
| `arkiv_query`, key only, 0 results | 100 | cost does not depend on selection or result size |
| `arkiv_query` with a nested `OR` | 100 | so one OR query is far cheaper than several simple ones |
| `arkiv_getBlockTiming`, `eth_getLogs`, `eth_blockNumber` | none | only a request-rate limit: `ratelimit: limit=600` per ~60 s window |

The cost budget itself is invisible while it lasts: successful responses carry only the request-rate
`RateLimit` (limit=600), `Arkiv-Quota-Used-Percent` was never sent to us, and `limit=10000` only
appears in the 429. The budget was exhausted around 19:45 UTC and came back at 20:21 UTC.

At 100 units a query, the anonymous budget is 100 queries per window. Our first version of the app
page made about 6 queries per load (app entity, releases and revocations per signer, mirrors), and
verifying an unknown file made one more query per expired entity; a dozen page loads and a few
history lookups emptied the budget. After restructuring around single OR queries:

| view | before | after |
|---|---|---|
| app page / `lifeboat status` | 600 | 100 (200 after a maintainer handoff) |
| check a file, published and live | 500 | 100 |
| check a file that has expired (EOL) | 500 + 100 per expired entity of the publisher | 100 + 100 per history block actually read (1 in our tests) |


## 2. `exists()` is exported and documented, but the node rejects it with an unrelated message

Surface: `@arkiv-network/sdk/query` `exists()`, `QueryError`.

Expected: `select({ key: true }).where(exists("type")).fetch()` returns entities that have a `type`
attribute, or, if unsupported, an error saying so.

Actual: `QueryError: Query rejected (type, -32002): Requested resource not available.. Query: EXISTS(type)`.
The real reason is only in `error.data.message`: `exists(…) is not supported — the index has no
per-attribute presence set in this version`. The `kind` field says `type`, which reads like a type
error.

Steps: in the SDK, `client.select({ key: true }).where(exists("type")).limit(1).fetch()` against
Tiramisu.

Suggested fix: use `data.message` as the `QueryError` message when present; mark `exists()` and
`not(exists())` as unsupported on current nodes in the JSDoc.

## 3. `eth_getLogs` has an undocumented 100000-block range limit, and viem hides the reason

Surface: `client.getLogs` with `ENTITY_EVENTS_ABI`, needed to find entities that have expired.

Expected: a range covering the chain's history (about 580000 blocks at the time), or a documented
limit.

Actual: the node answers `{"code":-32602,"message":"query exceeds max block range 100000"}`, a
clear message, but through viem it surfaces as `Invalid parameters were provided to the RPC method.
Double check you have provided the correct parameters.`, so we had to replay the call with `curl` to
learn the limit. 100000 blocks is about 2.3 days at 2 seconds per block.

Steps:

```sh
curl -s -X POST -H 'content-type: application/json' https://rpc.tiramisu.db-chain.testnet.arkiv.network \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"address":"0x4400000000000000000000000000000000000044","fromBlock":"0x0","toBlock":"latest"}]}'
```

Suggested fix: document the range limit for Tiramisu; consider an SDK helper that pages entity
events by range.

## 4. Expired entities vanish from queries; finding "what was this" takes two RPC families

Surface: `arkiv_query`, Entity Expiration.

This is a design consequence more than a bug, but it cost us real time. Lifeboat wants to tell a
user "this file was version 0.0.8, its support ended on <date>", which is the whole point of using
expiration as a support window. After expiry the entity no longer matches any query at the head,
and there is no "include expired" option.

What works: `EntityCreated` and `ExpiryExtended` logs index `owner`, so `getLogs` filtered by the
publisher lists every entity they created with its last expiry. Then `select().where(eq("$key", ...)).atBlock(expiresAt - 1n)`
reads the entity as it was on its last day. `atBlock` reached back over 500000 blocks in our tests.

Friction along the way: `ARKIV_ADDRESS` (the address that emits these events) is not exported from
the SDK, while `ENTITY_EVENTS_ABI` is, so we copied `0x44…44` from `src/consts.ts`. And the 100000
block log range above.

Suggested fix: export `ARKIV_ADDRESS`; document the logs + `atBlock` pattern as the way to read
expired entities, or offer a query option that includes entities that expired after a given block.

## 5. Importing the SDK in Node 25+ prints an ExperimentalWarning on every run

Surface: `src/utils/logger.ts`, `getDebugEnv()`.

Expected: a CLI built on the SDK prints only its own output.

Actual: every invocation that makes an SDK call prints

```
(node:12345) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.
```

because the logger, on its first use when `DEBUG` is unset, reads `globalThis.localStorage`, and on
Node 25+ touching that getter emits the warning. Importing alone is silent; the first action call
is enough.

Steps, with Node 26.7.0 and `DEBUG` unset:

```sh
node --input-type=module -e 'import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { http } from "viem"
await createPublicClient({ chain: tiramisu, transport: http() }).getBlockTiming()'
```

Suggested fix: check `typeof process !== "undefined"` first and skip `localStorage` in Node, or wrap
the access in a check for `typeof window !== "undefined"`.

What we did: `src/cli/bin.ts` filters that one warning before importing the CLI.

## 6. The SDK package has no `license` field

Surface: `node_modules/@arkiv-network/sdk/package.json`.

`LICENSE.md` (MIT) is in the package, but `package.json` has no `license`, so license scanners
report it as unknown. Found while writing our credits table. Suggested fix: add `"license": "MIT"`.

## 7. A range query with a bare number silently matches nothing on `u64` attributes

Surface: `@arkiv-network/sdk/query` `gt()` / `lt()` with an untyped number.

Expected: `gt("version", 0)` on entities whose `version` is `u64(1)`…`u64(4)` returns them, or fails
with a type mismatch.

Actual: the SDK renders the bare `0` as `i32(0)` (`version > i32(0)`), the node accepts the query,
and it returns zero entities. No error, no warning. Four matching releases existed. With
`gt("version", u64(0n))` all four come back.

Steps: create an entity with `attributes: { version: u64(5n) }`, then run
`client.select({ key: true }).where(gt("version", 0)).fetch()`.

Why it matters: the SDK's own docs say a bare number defaults to `i32`, which is reasonable for
writes, but on the read side it turns a typo-level mistake into an empty result that looks like
"no data". We found it only because we were testing on purpose; our code always uses `u64()`.

Suggested fix: have the node reject (or warn on) comparisons between different numeric types, or
have the SDK refuse untyped numbers in range predicates.

## Tested paths that worked

Each of these was exercised on Tiramisu by the CLI in this repository; transaction hashes are in
`README.md` (demo data) and the gas table below.

- `createEntity` with `u64` attributes, JSON payload and `ExpirationTime.fromSeconds`; the returned
  `expiresAt` matched what the explorer showed.
- `executeBatch` with two creates (a revocation and its replacement release) in one transaction;
  both keys came back in order in `createdEntities`.
- `extendEntity` on a release (support window from 1 day to 2 days) and on mirrors. As documented,
  an extension sets a new expiry counted from now; it does not add to the old one.
- `permissionlessExtension`: a wallet that was not the owner extended a mirror entity created by the
  mirror operator's wallet. The owner did not have to do anything.
- `changeOwnership` on the app entity: `$owner` changed, `$creator` stayed, and `createdBy()` /
  `ownedBy()` returned what we expected afterwards.
- Range query `gt("version", u64(9n))` on a `u64` attribute.
- `createdBy()` as the trust filter; results from other creators never leak in.
- `atBlock` reads back to block ~78000, and reading at `expiresAt - 1` returns an entity that has
  since expired.
- `watchEntityEvents` with a `webSocket` transport and no `fromBlock`: events arrived about once per
  second during our tests; `creationFlags` on `EntityCreated` and `expiresAt` on `ExpiryExtended`
  were enough to filter without extra queries.
- CORS: the RPC sends `access-control-allow-origin: *` and exposes `Arkiv-Cost`, `RateLimit` and
  `Retry-After` to the browser, so a static page can read Arkiv and show its own query cost.
- The explorer's `/entity/<key>`, `/tx/<hash>` and `/address/<addr>` routes, linked from every
  entity on the page.

## Gas per operation

Gas price on Tiramisu was about 1 gwei throughout, so costs below are in GLM at that price.

| operation | runs | gas used (each) | GLM (each) |
|---|---|---|---|
| app create | 2 | 96072–98616 | 0.000099 |
| publish beta | 4 | 116136–117912 | 0.000118 |
| revoke + replacement (batch) | 2 | 228280–230280 | 0.000230 |
| support (lifetime extension) | 1 | 25240 | 0.000025 |
| mirror add | 2 | 106232–111680 | 0.000112 |
| mirror add (skip-check) | 1 | 106552 | 0.000107 |
| vouch (permissionless lease extension) | 1 | 25210 | 0.000025 |
| keeper renew lease | 2 | 25210 | 0.000025 |
| app handoff | 1 | 25430 | 0.000025 |
| publish stable | 1 | 116680 | 0.000117 |

Total for the 17 logged transactions while building and seeding the demo: 0.001687 GLM. (Two more, a maintainer publish and a maintainer revoke during the browser test, ran without the gas log.)

