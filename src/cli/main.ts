// lifeboat: publish, mirror and verify software releases on Arkiv.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { eq, or } from "@arkiv-network/sdk/query"
import { ExpirationTime } from "@arkiv-network/sdk/utils"
import { formatEther, type Hash } from "viem"
import {
  type Channel,
  CHANNELS,
  EXPIRATION,
  explorerEntityUrl,
  KIND,
  explorerTxUrl,
  RPC_HTTP,
  RPC_WS,
} from "../core/constants"
import { downloadVerified, leaseInfo, NoGoodMirrorError, sortMirrors, uniqueByUrl } from "../core/download"
import { sha256Hex, shortHash } from "../core/hash"
import {
  base,
  type Client,
  decodeMany,
  fetchAll,
  getClock,
  makePublicClient,
  mirrorsByOperator,
  mirrorsBySha,
  Q,
  releasesByShaAnyone,
  releasesSince,
} from "../core/queries"
import {
  appCreate,
  assertAppId,
  decodeAll,
  decodeEntity,
  type Hex,
  type MirrorRecord,
  mirrorCreate,
  normalizeSha256,
  type ReleaseRecord,
  releaseCreate,
  revocationCreate,
  versionCodeFromName,
} from "../core/schema"
import { appStatus, checkHash } from "../core/service"
import { blockToMs, type Clock, formatDate, formatDuration } from "../core/time"
import { describeError, rpcStats } from "../core/rpc"
import { isAddress, lower, roleOf, signersFor } from "../core/trust"
import type { Verdict } from "../core/verdict"
import { Args, parseArgs, UsageError } from "./args"
import { c, chip, err, line, toJson } from "./out"
import { makeSigner, recordGas, type Signer } from "./wallet"

const VERSION = "0.1.0"

const BOOLEANS = new Set(["json", "vouch", "skip-check", "once", "no-history", "dry-run", "help", "force", "cost"])

type Ctx = {
  args: Args
  json: boolean
  rpc: string
  client: Client
  signer: () => Signer
}

const HELP = `lifeboat ${VERSION}: software releases that survive a blocked or hacked website.

Readers (no key needed):
  lifeboat status <app> --publisher <0x..>              releases, revocations, live mirrors
  lifeboat verify <file> --publisher <0x..> [--app id]  OK / TAMPERED / REVOKED / EOL / UNKNOWN_PUBLISHER
  lifeboat fetch <app> --publisher <0x..> [--out f]     download from the first mirror that serves
                 [--channel stable|beta] [--vouch]      the published bytes; --vouch renews its lease
                 [--url <u>]                            also try this URL (last), still hash-checked
  lifeboat updates <app> --publisher <0x..> --since <versionCode>
  lifeboat watch <app> --publisher <0x..>               print revocations and new mirrors live (WebSocket)

Publisher (key needed):
  lifeboat app create --app <id> --name <name> [--description d] [--homepage url]
  lifeboat app handoff <newOwner> --app <id>            hand the app entity to a new maintainer
  lifeboat publish <file> --app <id> --version 1.2.3 [--code n] [--channel stable|beta] [--notes t] [--days n]
  lifeboat support <sha256> --days <n>                  extend a release's support window
  lifeboat revoke <sha256> --reason <text> [--severity 1-3]
                 [--replacement <file> --version x.y.z [--channel c] [--notes t]]   one atomic batch

Mirror operator (key needed):
  lifeboat mirror add <url> --sha256 <hash> [--region r] [--note t]   downloads and checks first
  lifeboat mirror list [--operator 0x..]
  lifeboat keeper --once                                 re-check own mirrors, renew only on a match
  lifeboat whoami

Common flags:
  --json                 machine-readable output
  --cost                 print RPC requests and query budget used (stderr)
  --rpc <url>            any Arkiv RPC endpoint (default ${RPC_HTTP}), or LIFEBOAT_RPC
Env:
  LIFEBOAT_PUBLISHER     default for --publisher
  LIFEBOAT_KEY_FILE      path to a file holding the private key (or LIFEBOAT_PRIVATE_KEY)
  LIFEBOAT_GAS_LOG       append gas used per transaction to this file
`

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, BOOLEANS)
  const args = new Args(parsed)
  const [cmd, sub] = parsed.positionals
  if (!cmd && parsed.flags.has("version")) {
    line(VERSION)
    return 0
  }
  if (!cmd || args.bool("help") || cmd === "help") {
    line(HELP)
    return 0
  }
  if (cmd === "version") {
    line(VERSION)
    return 0
  }
  const rpc = args.str("rpc", "LIFEBOAT_RPC") ?? RPC_HTTP
  let signer: Signer | undefined
  const ctx: Ctx = {
    args,
    json: args.bool("json"),
    rpc,
    client: makePublicClient(rpc),
    signer: () => (signer ??= makeSigner(rpc)),
  }
  // Positionals after the command name, so handlers index from 0.
  const shift = (n: number) => new Args({ positionals: parsed.positionals.slice(n), flags: parsed.flags })

  switch (cmd) {
    case "app":
      if (sub === "create") return appCreateCmd({ ...ctx, args: shift(2) })
      if (sub === "handoff") return appHandoffCmd({ ...ctx, args: shift(2) })
      throw new UsageError("app create | app handoff")
    case "publish":
      return publishCmd({ ...ctx, args: shift(1) })
    case "support":
      return supportCmd({ ...ctx, args: shift(1) })
    case "revoke":
      return revokeCmd({ ...ctx, args: shift(1) })
    case "mirror":
      if (sub === "add") return mirrorAddCmd({ ...ctx, args: shift(2) })
      if (sub === "list") return mirrorListCmd({ ...ctx, args: shift(2) })
      throw new UsageError("mirror add | mirror list")
    case "verify":
      return verifyCmd({ ...ctx, args: shift(1) })
    case "fetch":
      return fetchCmd({ ...ctx, args: shift(1) })
    case "updates":
      return updatesCmd({ ...ctx, args: shift(1) })
    case "keeper":
      return keeperCmd({ ...ctx, args: shift(1) })
    case "status":
      return statusCmd({ ...ctx, args: shift(1) })
    case "watch":
      return watchCmd({ ...ctx, args: shift(1) })
    case "whoami":
      return whoamiCmd(ctx)
    default:
      throw new UsageError(`unknown command "${cmd}"`)
  }
}

// ---------------------------------------------------------------------------------------------
// helpers

function publisherArg(args: Args): Hex {
  const p = args.req("publisher", "LIFEBOAT_PUBLISHER")
  if (!isAddress(p)) throw new UsageError(`--publisher is not an address: ${p}`)
  return lower(p)
}

function readFile(path: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(path)))
}

function ago(ms: number): string {
  return ms >= 0 ? `in ${formatDuration(ms)}` : `${formatDuration(ms)} ago`
}

function expiryText(block: bigint, clock: Clock): string {
  const at = blockToMs(block, clock)
  return `${formatDate(at)} (${ago(at - clock.currentBlockTime * 1000)})`
}

async function reportTx(ctx: Ctx, op: string, txHash: Hash, extra: Record<string, unknown> = {}) {
  const gas = await recordGas(ctx.client, op, txHash)
  if (!ctx.json) {
    line(`  tx ${txHash}`)
    line(`     ${c.dim(explorerTxUrl(txHash))}`)
    line(`  gas ${gas.gasUsed} (${formatEther(gas.costWei)} GLM)`)
  }
  return { op, txHash, gasUsed: gas.gasUsed, costGlm: formatEther(gas.costWei), ...extra }
}

function printEntity(label: string, key: string) {
  line(`  ${label} ${key}`)
  line(`     ${c.dim(explorerEntityUrl(key))}`)
}

async function myAppEntity(ctx: Ctx, app: string, me: Hex) {
  // The app entity this account currently owns: the founder before a handoff, the maintainer after.
  const owned = decodeAll(await fetchAll(ctx.client.select("*").where(...base(KIND.app), eq("app", app)).ownedBy(me)), "app")
  return owned.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))[0]
}

async function ownedAbout(ctx: Ctx, me: Hex, shas: string[]) {
  const bySha = shas.length === 1 ? eq("sha256", shas[0]!) : or(...shas.map((h) => eq("sha256", h)))
  return decodeMany(await fetchAll(ctx.client.select("*").where(eq("lb", "1"), bySha).ownedBy(me)))
}

async function findOwnRelease(ctx: Ctx, sha: string, me: Hex): Promise<ReleaseRecord | undefined> {
  return (await ownedAbout(ctx, me, [sha]))
    .filter((r): r is ReleaseRecord => r.kind === "release")
    .sort((a, b) => b.version - a.version)[0]
}

// ---------------------------------------------------------------------------------------------
// publisher commands

async function appCreateCmd(ctx: Ctx): Promise<number> {
  const { args } = ctx
  const app = assertAppId(args.req("app"))
  const { wallet, address } = ctx.signer()
  const existing = await myAppEntity(ctx, app, address)
  if (existing && !args.bool("force")) {
    if (ctx.json) line(toJson({ existing: true, key: existing.key }))
    else {
      line(`app "${app}" already exists and you own it (use --force to create another)`)
      printEntity("app", existing.key)
    }
    return 0
  }
  const days = args.num("days")
  const res = await wallet.createEntity(
    appCreate({
      app,
      name: args.str("name") ?? app,
      description: args.str("description") ?? "",
      homepage: args.str("homepage") ?? "",
      ...(days ? { seconds: days * 86400 } : {}),
    }),
  )
  if (!ctx.json) {
    line(`${c.green("created")} app ${app}`)
    printEntity("app", res.entityKey)
  }
  const out = await reportTx(ctx, "app create", res.txHash, { key: res.entityKey })
  if (ctx.json) line(toJson(out))
  return 0
}

async function appHandoffCmd(ctx: Ctx): Promise<number> {
  const { args } = ctx
  const newOwner = args.pos(0, "<newOwner> address")
  if (!isAddress(newOwner)) throw new UsageError("newOwner must be an address")
  const app = assertAppId(args.req("app"))
  const { wallet, address } = ctx.signer()
  const entity = await myAppEntity(ctx, app, address)
  if (!entity) throw new Error(`you (${address}) do not own an app entity for "${app}"`)
  const res = await wallet.changeOwnership({ entityKey: entity.key, newOwner: newOwner as Hex })
  if (!ctx.json) {
    line(`${c.green("handed over")} ${app}: $owner ${address} -> ${lower(newOwner)}`)
    line(`  $creator stays ${entity.creator} (the founder). Verifiers that pin the founder now also accept`)
    line(`  releases created by ${lower(newOwner)}, labelled "maintainer".`)
    printEntity("app", entity.key)
  }
  const out = await reportTx(ctx, "app handoff", res.txHash, { key: entity.key, newOwner: lower(newOwner) })
  if (ctx.json) line(toJson(out))
  return 0
}

function releaseInputFromFile(args: Args, file: string, bytesSha: string, size: number, app: string, flagPrefix = "") {
  const versionName = args.req(`${flagPrefix}version`)
  const code = args.num(`${flagPrefix}code`) ?? versionCodeFromName(versionName)
  const channel = (args.str(`${flagPrefix}channel`) ?? "stable") as Channel
  if (!CHANNELS.includes(channel)) throw new UsageError(`--channel must be one of ${CHANNELS.join(", ")}`)
  const days = args.num(`${flagPrefix}days`)
  return {
    app,
    version: code,
    sha256: bytesSha,
    size,
    channel,
    versionName,
    fileName: basename(file),
    notes: args.str(`${flagPrefix}notes`) ?? "",
    ...(days ? { seconds: Math.round(days * 86400) } : {}),
  }
}

async function publishCmd(ctx: Ctx): Promise<number> {
  const { args } = ctx
  const file = args.pos(0, "<file>")
  const app = assertAppId(args.req("app"))
  const bytes = readFile(file)
  const sha = await sha256Hex(bytes)
  const input = releaseInputFromFile(args, file, sha, bytes.byteLength, app)
  const { wallet, address } = ctx.signer()
  const existing = await findOwnRelease(ctx, sha, address)
  if (existing && !args.bool("force")) {
    if (ctx.json) line(toJson({ existing: true, key: existing.key, sha256: sha }))
    else {
      line(`already published: ${existing.app} ${existing.versionName} has sha256 ${sha}`)
      printEntity("release", existing.key)
    }
    return 0
  }
  const res = await wallet.createEntity(releaseCreate(input))
  const clock = await getClock(ctx.client)
  if (!ctx.json) {
    line(`${c.green("published")} ${app} ${input.versionName} (code ${input.version}, ${input.channel})`)
    line(`  sha256 ${sha}  size ${bytes.byteLength}`)
    line(`  supported until ${expiryText(res.expiresAt, clock)}`)
    printEntity("release", res.entityKey)
  }
  const out = await reportTx(ctx, `publish ${input.channel}`, res.txHash, { key: res.entityKey, sha256: sha, size: bytes.byteLength })
  if (ctx.json) line(toJson(out))
  return 0
}

async function supportCmd(ctx: Ctx): Promise<number> {
  const { args } = ctx
  const sha = normalizeSha256(args.pos(0, "<sha256>"))
  const days = args.num("days")
  if (!days || days <= 0) throw new UsageError("--days <n> is required")
  const { wallet, address } = ctx.signer()
  const rel = await findOwnRelease(ctx, sha, address)
  if (!rel) throw new Error(`no live release with sha256 ${sha} owned by ${address} (an expired one cannot be extended; publish it again)`)
  const clock = await getClock(ctx.client)
  const res = await wallet.extendEntity({ entityKey: rel.key, expires: ExpirationTime.fromSeconds(Math.round((days * 86400) / 2) * 2) })
  if (!ctx.json) {
    line(`${c.green("extended")} support for ${rel.app} ${rel.versionName}`)
    line(`  was until ${expiryText(rel.expiresAt, clock)}`)
    line(`  now until ${expiryText(res.expiresAt, clock)}`)
    printEntity("release", rel.key)
  }
  const out = await reportTx(ctx, "support (lifetime extension)", res.txHash, { key: rel.key, expiresAt: res.expiresAt })
  if (ctx.json) line(toJson(out))
  return 0
}

async function revokeCmd(ctx: Ctx): Promise<number> {
  const { args } = ctx
  const sha = normalizeSha256(args.pos(0, "<sha256>"))
  const reason = args.req("reason")
  const severity = args.num("severity") ?? 3
  const { wallet, address } = ctx.signer()
  let replacementSha: string | undefined
  const replacementFile = args.str("replacement")
  if (replacementFile) replacementSha = await sha256Hex(readFile(replacementFile))
  // One query for everything we own about both hashes: the release, an earlier revocation, and
  // whether the replacement is already published.
  const owned = await ownedAbout(ctx, address, replacementSha ? [sha, replacementSha] : [sha])
  const rel = owned.filter((r): r is ReleaseRecord => r.kind === "release" && r.sha256 === sha).sort((a, b) => b.version - a.version)[0]
  const app = assertAppId(rel?.app ?? args.req("app"))
  const versionCode = rel?.version ?? args.num("code") ?? 0

  const existing = owned.filter((r) => r.kind === "revocation" && r.sha256 === sha)
  if (existing.length > 0 && !args.bool("force")) {
    if (ctx.json) line(toJson({ existing: true, key: existing[0]!.key }))
    else {
      line(`already revoked by you`)
      printEntity("revocation", existing[0]!.key)
    }
    return 0
  }

  const creates = []
  let replacement: ReturnType<typeof releaseInputFromFile> | undefined
  if (replacementFile) {
    const bytes = readFile(replacementFile)
    const rsha = await sha256Hex(bytes)
    if (rsha === sha) throw new UsageError("the replacement is the same file")
    replacement = releaseInputFromFile(args, replacementFile, rsha, bytes.byteLength, app)
  }
  creates.push(
    revocationCreate({
      app,
      sha256: sha,
      version: versionCode,
      severity,
      reason,
      ...(replacement ? { replacedBySha256: replacement.sha256 } : {}),
    }),
  )
  const replacementExists = replacement ? owned.find((r) => r.kind === "release" && r.sha256 === replacement!.sha256) : undefined
  if (replacement && !replacementExists) creates.push(releaseCreate(replacement))

  // One transaction: either the revocation and its replacement both land, or neither does.
  const res = await wallet.executeBatch({ creates })
  const [revKey, relKey] = res.createdEntities
  if (!ctx.json) {
    line(`${c.red("revoked")} ${app} ${rel?.versionName ?? `code ${versionCode}`} (${shortHash(sha)})`)
    line(`  reason: ${reason}  severity ${severity}`)
    printEntity("revocation", revKey!)
    if (replacement && relKey) {
      line(`${c.green("published")} replacement ${replacement.versionName} in the same transaction`)
      line(`  sha256 ${replacement.sha256}`)
      printEntity("release", relKey)
    } else if (replacementExists) {
      line(`  replacement ${replacement!.versionName} was already published: ${replacementExists.key}`)
    }
  }
  const out = await reportTx(ctx, replacement && relKey ? "revoke + replacement (batch)" : "revoke", res.txHash, {
    revocationKey: revKey,
    ...(relKey ? { replacementKey: relKey } : {}),
  })
  if (ctx.json) line(toJson(out))
  return 0
}

// ---------------------------------------------------------------------------------------------
// mirror operator

async function mirrorAddCmd(ctx: Ctx): Promise<number> {
  const { args } = ctx
  const url = args.pos(0, "<url>")
  const sha = normalizeSha256(args.req("sha256"))
  const skipCheck = args.bool("skip-check")
  const { wallet, address } = ctx.signer()

  // The release tells us the app id and the size. Any creator: the operator is not the one who has
  // to trust it; every downloader checks against their own pinned publisher anyway.
  // One query: everything live with this hash (its releases, and the mirrors already registered).
  const about = decodeMany(await fetchAll(ctx.client.select("*").where(eq("lb", "1"), eq("sha256", sha))))
  const releases = about.filter((r): r is ReleaseRecord => r.kind === "release")
  const app = assertAppId(args.str("app") ?? releases[0]?.app ?? "")
  const size = releases[0]?.size

  const mine = about.filter(
    (m): m is MirrorRecord => m.kind === "mirror" && m.creator === address && m.url === new URL(url).toString(),
  )
  if (mine.length > 0 && !args.bool("force")) {
    if (ctx.json) line(toJson({ existing: true, key: mine[0]!.key }))
    else {
      line(`already registered by you: ${url}`)
      printEntity("mirror", mine[0]!.key)
    }
    return 0
  }

  if (skipCheck) {
    if (!ctx.json) line(c.yellow("--skip-check: registering without downloading. Demo use only: this is how the dead and poisoned demo mirrors were added."))
  } else {
    if (size === undefined) throw new Error("no release with this sha256 is published, so there is nothing to check the URL against")
    if (!ctx.json) line(`checking ${url} ...`)
    try {
      await downloadVerified([{ url }], { sha256: sha, size }, {
        onAttempt: (a) => !ctx.json && a.status !== "trying" && line(`  ${a.status}: ${a.detail}`),
      })
    } catch {
      err(c.red("refusing to register: the URL does not serve the published bytes"))
      return 2
    }
  }
  const note = args.str("note") ?? ""
  const region = args.str("region")
  const res = await wallet.createEntity(mirrorCreate({ app, sha256: sha, url, note, ...(region ? { region } : {}) }))
  if (!ctx.json) {
    line(`${c.green("registered")} mirror for ${app} ${shortHash(sha)}, lease ${formatDuration(EXPIRATION.mirrorLease * 1000)}`)
    line(`  anyone who verifies a download from it may renew the lease (permissionless extension)`)
    printEntity("mirror", res.entityKey)
  }
  const out = await reportTx(ctx, skipCheck ? "mirror add (skip-check)" : "mirror add", res.txHash, { key: res.entityKey })
  if (ctx.json) line(toJson(out))
  return 0
}

async function mirrorListCmd(ctx: Ctx): Promise<number> {
  const op = ctx.args.str("operator")
  const operator = op ? lower(op) : ctx.signer().address
  const [clock, mirrors] = await Promise.all([getClock(ctx.client), mirrorsByOperator(ctx.client, operator)])
  if (ctx.json) {
    line(toJson(mirrors.map((m) => ({ ...m, lease: leaseInfo(m, clock) }))))
    return 0
  }
  line(`${mirrors.length} live mirror(s) registered by ${operator}`)
  for (const m of sortMirrors(mirrors, clock)) {
    const l = leaseInfo(m, clock)
    line(`  ${m.url}`)
    line(`     ${m.app} ${shortHash(m.sha256)}  lease expires ${ago(l.remainingMs)}  ${c.dim(m.key)}`)
  }
  return 0
}

async function keeperCmd(ctx: Ctx): Promise<number> {
  const { wallet, address } = ctx.signer()
  const dry = ctx.args.bool("dry-run")
  const leaseSeconds = (ctx.args.num("lease-hours") ?? EXPIRATION.mirrorLease / 3600) * 3600
  const mirrors = await mirrorsByOperator(ctx.client, address)
  const clock = await getClock(ctx.client)
  const results: Record<string, unknown>[] = []
  if (!ctx.json) line(`keeper: ${mirrors.length} live mirror(s) owned by ${address}`)
  const sizes = new Map<string, number>()
  for (const m of mirrors) {
    if (!sizes.has(m.sha256)) {
      const rel = (await releasesByShaAnyone(ctx.client, m.sha256))[0]
      if (rel) sizes.set(m.sha256, rel.size)
    }
    const size = sizes.get(m.sha256)
    const lease = leaseInfo(m, clock)
    const base = { key: m.key, url: m.url, sha256: m.sha256, leaseLeft: formatDuration(lease.remainingMs) }
    if (size === undefined) {
      if (!ctx.json) line(`  ${c.yellow("skip")} ${m.url}: no live release with this hash, letting the lease lapse`)
      results.push({ ...base, action: "skip-no-release" })
      continue
    }
    let status = ""
    let detail = ""
    try {
      await downloadVerified([{ url: m.url }], { sha256: m.sha256, size }, { onAttempt: (a) => ((status = a.status), (detail = a.detail)) })
    } catch {
      // status and detail say what went wrong
    }
    if (status !== "ok") {
      const label = status === "dead" ? "UNREACHABLE" : "WRONG BYTES"
      if (!ctx.json) line(`  ${c.red(label)} ${m.url}: ${detail}. Not renewing; the lease lapses ${ago(lease.remainingMs)}.`)
      results.push({ ...base, action: "not-renewed", status, detail })
      continue
    }
    if (dry) {
      if (!ctx.json) line(`  ${c.green("ok")} ${m.url} (dry run, not renewing)`)
      results.push({ ...base, action: "ok-dry-run" })
      continue
    }
    try {
      const res = await wallet.extendEntity({ entityKey: m.key, expires: ExpirationTime.fromSeconds(leaseSeconds) })
      if (!ctx.json) line(`  ${c.green("renewed")} ${m.url}: lease now ${expiryText(res.expiresAt, clock)}`)
      const tx = await reportTx({ ...ctx, json: true }, "keeper renew lease", res.txHash)
      results.push({ ...base, action: "renewed", ...tx })
    } catch (e) {
      if (!ctx.json) line(`  ${c.red("renew failed")} ${m.url}: ${(e as Error).message.split("\n")[0]}`)
      results.push({ ...base, action: "renew-failed", error: (e as Error).message })
    }
  }
  if (ctx.json) line(toJson(results))
  return 0
}

// ---------------------------------------------------------------------------------------------
// readers

const VERDICT_TONE: Record<Verdict, "good" | "bad" | "warn"> = {
  OK: "good",
  TAMPERED: "bad",
  REVOKED: "bad",
  EOL: "warn",
  UNKNOWN_PUBLISHER: "bad",
}

async function verifyCmd(ctx: Ctx): Promise<number> {
  const { args } = ctx
  const file = args.pos(0, "<file>")
  const publisher = publisherArg(args)
  const bytes = readFile(file)
  const sha = await sha256Hex(bytes)
  const app = args.str("app")
  const res = await checkHash(ctx.client, publisher, sha, {
    ...(app ? { app } : {}),
    fileName: basename(file),
    history: !args.bool("no-history"),
  })
  if (ctx.json) {
    const { trust, clock, ...rest } = res
    line(toJson({ file, sha256: sha, size: bytes.byteLength, publisher, ...rest }))
  } else {
    line(`${basename(file)}  sha256 ${sha}`)
    line(`${chip(res.verdict, VERDICT_TONE[res.verdict])} ${res.summary}`)
    if (res.release) {
      line(`  release ${res.release.app} ${res.release.versionName} by ${res.role} ${res.release.creator}`)
      if (res.verdict === "OK") line(`  supported until ${expiryText(res.release.expiresAt, res.clock)}`)
      if (res.verdict === "EOL") line(`  support ended ${expiryText(res.release.expiresAt, res.clock)} (found by reading earlier blocks)`)
      line(`     ${c.dim(explorerEntityUrl(res.release.key))}`)
    }
    if (res.revocation) printEntity("revocation", res.revocation.key)
    if (res.probes > 0 && res.verdict !== "EOL") line(c.dim(`  searched ${res.probes} earlier block(s) for an expired release`))
  }
  return res.verdict === "OK" ? 0 : 2
}

async function statusCmd(ctx: Ctx): Promise<number> {
  const app = assertAppId(ctx.args.pos(0, "<app>"))
  const publisher = publisherArg(ctx.args)
  const st = await appStatus(ctx.client, publisher, app, { ...(ctx.args.str("channel") ? { channel: ctx.args.str("channel")! } : {}) })
  if (ctx.json) {
    const { trust, ...rest } = st
    line(toJson({ publisher, ...rest, mirrors: st.mirrors.map((m) => ({ ...m, lease: leaseInfo(m, st.clock) })) }))
    return 0
  }
  const { clock } = st
  if (!st.app) {
    line(c.yellow(`no app entity "${app}" created by ${publisher}`))
  } else {
    line(`${c.bold(st.app.name)} (${app})  ${st.app.description}`)
    line(`  founder    ${st.app.creator}  ($creator, never changes)`)
    line(
      `  maintainer ${st.app.owner}  ($owner${st.app.owner === st.app.creator ? ", same as founder" : ", handed over"})`,
    )
    line(`  app entity expires ${expiryText(st.app.expiresAt, clock)}`)
    line(`     ${c.dim(explorerEntityUrl(st.app.key))}`)
  }
  line()
  line(c.bold(`Releases (${st.releases.length} live)`))
  for (const r of st.releases) {
    const state = r.revocation
      ? chip("REVOKED", "bad")
      : chip(`SUPPORTED until ${formatDate(blockToMs(r.expiresAt, clock)).slice(0, 10)}`, "good")
    line(`  ${r.versionName.padEnd(8)} ${r.channel.padEnd(6)} ${state} ${shortHash(r.sha256, 16)} ${r.fileName}  by ${r.role}`)
    if (r.revocation) line(`           ${c.red(r.revocation.reason)}`)
    line(`           ${c.dim(explorerEntityUrl(r.key))}`)
  }
  const orphanRevs = st.revocations.filter((v) => !st.releases.some((r) => r.sha256 === v.sha256))
  for (const v of orphanRevs) {
    line(`  code ${v.version}  ${chip("REVOKED", "bad")} ${shortHash(v.sha256, 16)} (release itself already expired) ${v.reason}`)
  }
  line()
  if (!st.recommended) {
    line(c.yellow("No supported, unrevoked release."))
    return 0
  }
  line(c.bold(`Mirrors for ${st.recommended.versionName} (${st.mirrors.length} live, freshest lease first)`))
  for (const m of st.mirrors) {
    const l = leaseInfo(m, clock)
    line(`  ${m.url}`)
    line(
      `     lease renewed ~${formatDuration(clock.currentBlockTime * 1000 - l.renewedAtMs)} ago, expires ${ago(l.remainingMs)}` +
        `${l.unusual ? c.yellow(" (extended past the normal window)") : ""}  by ${m.creator}`,
    )
  }
  if (st.mirrors.length === 0) line("  none registered right now")
  return 0
}

async function fetchCmd(ctx: Ctx): Promise<number> {
  const { args } = ctx
  const app = assertAppId(args.pos(0, "<app>"))
  const publisher = publisherArg(args)
  const channel = args.str("channel")
  const st = await appStatus(ctx.client, publisher, app, channel ? { channel } : {})
  const rel = st.recommended
  if (!rel) {
    const msg = st.releases.length
      ? "every live release is revoked"
      : "no supported release: nothing is published or every support window has ended (EOL)"
    if (ctx.json) line(toJson({ ok: false, error: msg }))
    else err(c.red(msg))
    return 2
  }
  const revoked = st.releases.filter((r) => r.revocation)
  if (!ctx.json) {
    line(`${app} ${rel.versionName} (${rel.channel}) by ${rel.role} ${rel.creator}`)
    line(`  sha256 ${rel.sha256}  size ${rel.size}`)
    for (const r of revoked) line(c.yellow(`  note: ${r.versionName} is revoked: ${r.revocation!.reason}`))
    line(`  ${st.mirrors.length} mirror(s) on Arkiv, trying freshest lease first`)
  }
  const sources: { url: string; key?: string }[] = uniqueByUrl(st.mirrors).map((m) => ({ url: m.url, key: m.key }))
  const extra = args.str("url")
  if (extra) sources.push({ url: extra })
  let result
  try {
    result = await downloadVerified(sources, rel, {
      onAttempt: (a) => {
        if (ctx.json || a.status === "trying") return
        const tone = a.status === "ok" ? c.green : a.status === "dead" ? c.dim : c.red
        line(`  ${tone(a.status.padEnd(11))} ${a.url}\n              ${a.detail}`)
      },
    })
  } catch (e) {
    if (e instanceof NoGoodMirrorError) {
      if (ctx.json) line(toJson({ ok: false, release: rel, attempts: e.attempts }))
      else err(c.red(`no mirror served the published bytes (${e.attempts.length} tried). Nothing was saved.`))
      return 2
    }
    throw e
  }
  const defaultName = rel.fileName || `${app}-${rel.versionName}`
  let out = resolve(args.str("out") ?? defaultName)
  if (existsSync(out) && statSync(out).isDirectory()) out = join(out, defaultName)
  writeFileSync(out, result.bytes)
  let vouch: Record<string, unknown> | undefined
  if (args.bool("vouch") && result.mirror.key) {
    // The mirror entity was created with permissionlessExtension, so any downloader may renew it.
    const { wallet } = ctx.signer()
    const res = await wallet.extendEntity({ entityKey: result.mirror.key as Hex, expires: ExpirationTime.fromSeconds(EXPIRATION.mirrorLease) })
    if (!ctx.json) line(`${c.green("vouched")}: renewed the lease of ${result.mirror.url}`)
    vouch = await reportTx(ctx, "vouch (permissionless lease extension)", res.txHash)
  }
  if (ctx.json) line(toJson({ ok: true, out, release: rel, mirror: result.mirror, attempts: result.attempts, ...(vouch ? { vouch } : {}) }))
  else line(`${chip("OK", "good")} saved ${out}`)
  return 0
}

async function updatesCmd(ctx: Ctx): Promise<number> {
  const app = assertAppId(ctx.args.pos(0, "<app>"))
  const publisher = publisherArg(ctx.args)
  const since = ctx.args.num("since") ?? 0
  const { trust } = await appStatus(ctx.client, publisher, app)
  const newer = await releasesSince(ctx.client, trust, app, since)
  if (ctx.json) line(toJson(newer))
  else if (newer.length === 0) line(`no release of ${app} newer than code ${since}`)
  else for (const r of newer) line(`  ${r.versionName} (code ${r.version}, ${r.channel}) ${r.sha256}`)
  return 0
}

async function watchCmd(ctx: Ctx): Promise<number> {
  const app = assertAppId(ctx.args.pos(0, "<app>"))
  const publisher = publisherArg(ctx.args)
  const { createPublicClient } = await import("@arkiv-network/sdk")
  const { tiramisu } = await import("@arkiv-network/sdk/chains")
  const { webSocket } = await import("viem")
  const ws = createPublicClient({ chain: tiramisu, transport: webSocket(ctx.args.str("ws") ?? RPC_WS) })
  let st = await appStatus(ctx.client, publisher, app)
  const signers = () => new Set<string>(signersFor(st.trust, app))
  const knownMirrors = new Set(st.mirrors.map((m) => m.key))
  const say = (obj: Record<string, unknown>, text: string) => line(ctx.json ? toJson(obj) : text)
  line(ctx.json ? toJson({ event: "watching", app, publisher }) : `watching ${app} for revocations, releases and mirrors (Ctrl-C to stop)`)

  // The chain carries every app's events. Only entities created by the pinned signers are fetched
  // one by one; a possible new mirror (created with permissionlessExtension) triggers at most one
  // mirror re-read per minute. That keeps a long-running watch inside the anonymous query budget.
  let lastMirrorCheck = 0
  const checkMirrors = async () => {
    if (!st.recommended || Date.now() - lastMirrorCheck < 60_000) return
    lastMirrorCheck = Date.now()
    const now = (await mirrorsBySha(ctx.client, st.recommended.sha256)).filter((m) => m.app === app)
    for (const m of now) {
      if (knownMirrors.has(m.key)) continue
      knownMirrors.add(m.key)
      say({ event: "mirror", mirror: m }, `${chip("MIRROR", "info")} ${m.url} for ${st.recommended.versionName}, by ${m.creator}`)
    }
  }
  ws.watchEntityEvents({
    onEntityCreated: async (ev) => {
      try {
        if (signers().has(lower(ev.owner))) {
          const entity = decodeEntity((await ctx.client.getEntity(ev.entityKey)) as never)
          if (!entity || entity.app !== app) return
          const role = roleOf(st.trust, entity.creator, app)
          if (entity.kind === "revocation") say({ event: "revocation", role, entity }, `${chip("REVOKED", "bad")} ${entity.sha256} by the ${role}: ${entity.reason}`)
          if (entity.kind === "release") say({ event: "release", role, entity }, `${chip("RELEASE", "good")} ${entity.versionName} ${entity.sha256} by the ${role}`)
          st = await appStatus(ctx.client, publisher, app)
        } else if (ev.creationFlags.permissionlessExtension) {
          await checkMirrors()
        }
      } catch (e) {
        err(`watch: ${describeError(e)}`)
      }
    },
    onExpiryExtended: (ev) => {
      const m = st.mirrors.find((x) => x.key === ev.entityKey)
      if (m) say({ event: "lease", key: m.key, expiresAt: ev.expiresAt }, `${chip("LEASE", "info")} ${m.url} renewed until ${expiryText(ev.expiresAt, st.clock)}`)
    },
    onError: (e) => err(`watch error: ${describeError(e)}`),
  })
  await new Promise(() => {})
  return 0
}

async function whoamiCmd(ctx: Ctx): Promise<number> {
  const { address } = ctx.signer()
  const bal = await ctx.client.getBalance({ address })
  if (ctx.json) line(toJson({ address, balance: formatEther(bal) }))
  else line(`${address}  ${formatEther(bal)} GLM`)
  return 0
}

function printCost() {
  if (!process.argv.includes("--cost")) return
  const rl = rpcStats.rateLimit
  err(
    `rpc: ${rpcStats.requests} request(s), Arkiv-Cost total ${rpcStats.cost}` +
      (rl ? `; request rate limit ${rl.remaining}/${rl.limit} left, resets in ${rl.resetSeconds}s` : ""),
  )
}

main(process.argv.slice(2)).then(
  (code) => {
    printCost()
    process.exit(code)
  },
  (e: unknown) => {
    if (e instanceof UsageError) {
      err(`lifeboat: ${e.message}\nrun "lifeboat help" for usage`)
      process.exit(64)
    }
    err(`lifeboat: ${describeError(e)}`)
    printCost()
    if (process.env.LIFEBOAT_DEBUG) err(String((e as Error)?.stack ?? e))
    process.exit(1)
  },
)

