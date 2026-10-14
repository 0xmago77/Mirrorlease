import "./style.css"
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { toRpcSelect } from "@arkiv-network/sdk/query"
import { webSocket } from "viem"
import {
  type AppStatus,
  type Attempt,
  appStatus,
  blockToMs,
  type CheckResult,
  checkHash,
  type Clock,
  describeError,
  downloadVerified,
  explorerAddressUrl,
  explorerEntityUrl,
  formatDate,
  formatDuration,
  type Hex,
  isAddress,
  leaseInfo,
  lower,
  makePublicClient,
  NoGoodMirrorError,
  Q,
  RPC_HTTP,
  RPC_WS,
  type ReleaseView,
  rpcStats,
  sha256Hex,
  signersFor,
  uniqueByUrl,
  VERDICT_TEXT,
  type Verdict,
} from "../../src/core"
import { append, clear, h, safeLink } from "./dom"

/** The demo publisher. In real use the address comes from the project's own README or tag. */
const DEMO_APP = "lifeboat-cli"
const DEMO_PUBLISHER = "0x8fb633d00b49d851dbff111b0d7c1eec8f9dcea2" as Hex

const view = document.getElementById("view")!
const client = makePublicClient()
let teardown: (() => void)[] = []

// ---------------------------------------------------------------------------------------------
// routing: #/app/<id>?publisher=0x.., #/check?publisher=..&app=.., #/raw, #/

function parseHash(): { path: string[]; params: URLSearchParams } {
  const raw = location.hash.replace(/^#/, "") || "/"
  const [p, q] = raw.split("?")
  return { path: (p ?? "/").split("/").filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(q ?? "") }
}

function route() {
  for (const t of teardown) t()
  teardown = []
  clear(view)
  window.scrollTo(0, 0)
  const { path, params } = parseHash()
  for (const a of document.querySelectorAll<HTMLAnchorElement>("nav a[data-nav]")) {
    a.classList.toggle("active", a.dataset.nav === (path[0] ?? ""))
  }
  const demoLink = document.querySelector<HTMLAnchorElement>('nav a[data-nav="app"]')
  if (demoLink) demoLink.href = `#/app/${DEMO_APP}?publisher=${DEMO_PUBLISHER}`
  if (path[0] === "app" && path[1]) return appView(path[1], params.get("publisher") ?? "")
  if (path[0] === "check") return checkView(params)
  if (path[0] === "raw") return rawView(params)
  return homeView()
}


// ---------------------------------------------------------------------------------------------
// pins: trust on first use. The address in a link is only a claim; once you confirm it for an app,
// a later link that pins a different address for the same app is flagged.

const PIN_KEY = "lifeboat:pins"

function loadPins(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) ?? "{}")
  } catch {
    return {}
  }
}

function savePin(app: string, address: string) {
  const pins = loadPins()
  pins[app] = lower(address)
  localStorage.setItem(PIN_KEY, JSON.stringify(pins))
}

// ---------------------------------------------------------------------------------------------
// shared bits

const CHIP_TONE: Record<Verdict, string> = {
  OK: "good",
  TAMPERED: "bad",
  REVOKED: "bad",
  EOL: "warn",
  UNKNOWN_PUBLISHER: "bad",
}

function chip(text: string, tone: string) {
  return h("span", { class: `chip ${tone}` }, text)
}

function keyLink(key: string, label = "entity") {
  return h("a", { href: explorerEntityUrl(key), target: "_blank", rel: "noopener", class: "key", title: key }, `${label} ${key.slice(0, 10)}…`)
}

function addrLink(a: string) {
  return h("a", { href: explorerAddressUrl(a), target: "_blank", rel: "noopener", class: "mono addr" }, a)
}

function costNote(before: { requests: number; cost: number }) {
  const rl = rpcStats.rateLimit
  return h(
    "p",
    { class: "cost" },
    `This view made ${rpcStats.requests - before.requests} RPC request(s) to Arkiv` +
      (rpcStats.cost - before.cost > 0 ? `, query cost ${rpcStats.cost - before.cost}` : "") +
      (rl ? `. Anonymous budget left for your connection: ${rl.remaining} of ${rl.limit}.` : "."),
  )
}

function errorBox(e: unknown) {
  return h("div", { class: "banner bad" }, h("strong", {}, "Could not read from Arkiv. "), describeError(e))
}

/** The clock moves on between reads; estimate the head from local time so countdowns stay live. */
function liveClock(c: Clock, fetchedAt: number): Clock {
  const dt = (Date.now() - fetchedAt) / 1000
  return {
    currentBlock: c.currentBlock + BigInt(Math.floor(dt / c.blockDuration)),
    currentBlockTime: c.currentBlockTime + dt,
    blockDuration: c.blockDuration,
  }
}

function until(ms: number, clock: Clock) {
  const d = ms - clock.currentBlockTime * 1000
  return d >= 0 ? `in ${formatDuration(d)}` : `${formatDuration(d)} ago`
}

function trustExplainer() {
  return h(
    "details",
    { class: "explain" },
    h("summary", {}, "Why should I trust this page?"),
    h(
      "p",
      {},
      "You should not have to. The publisher address is the only thing you trust, and it has to come from the project itself: its README, a signed git tag, a QR code at a talk, a package you already have. Lifeboat then shows only Arkiv entities whose $creator is that address. $creator is set by the chain when an entity is created and can never be changed, unlike attributes or payloads, which anyone can write.",
    ),
    h(
      "p",
      {},
      "Mirrors are untrusted on purpose. Anyone can register one, and every download is hashed in your browser and compared with the sha256 the publisher wrote. Wrong bytes are thrown away before you can save them.",
    ),
    h(
      "p",
      {},
      "If the project hands maintenance to someone else, the founder transfers the app entity with changeOwnership. Its $creator stays the founder; its $owner becomes the maintainer, and releases from the maintainer are accepted and labelled as such.",
    ),
  )
}

// ---------------------------------------------------------------------------------------------
// home

function homeView() {
  const appInput = h("input", { value: DEMO_APP, "aria-label": "App id", spellcheck: "false" })
  const pubInput = h("input", { value: DEMO_PUBLISHER, "aria-label": "Publisher address", spellcheck: "false", class: "mono" })
  const go = (e: Event) => {
    e.preventDefault()
    const pub = pubInput.value.trim()
    if (!isAddress(pub)) {
      pubInput.setCustomValidity("Not an address")
      pubInput.reportValidity()
      return
    }
    location.hash = `#/app/${encodeURIComponent(appInput.value.trim())}?publisher=${lower(pub)}`
  }
  append(view, [
    h("section", { class: "hero" },
      h("h1", {}, "Downloads that keep working when the website doesn't."),
      h("p", { class: "lede" },
        "When a project's site or GitHub is blocked, seized or hacked, its users lose the one place they knew to get the real file. Lifeboat keeps the release hashes on Arkiv, signed by the publisher's wallet, and lets anyone run a mirror. This page finds a mirror that still works and checks the bytes before you get them.",
      ),
    ),
    h("form", { class: "card pin", onsubmit: go },
      h("h2", {}, "Open an app"),
      h("label", {}, "App id", appInput),
      h("label", {}, "Publisher address (from the project's README, tag or QR)", pubInput),
      h("button", { type: "submit" }, "Show releases and mirrors"),
    ),
    h("section", { class: "grid3" },
      h("div", { class: "card" }, h("h3", {}, "Publisher"),
        h("p", {}, "Writes a release entity per build: version, sha256, size, channel. Its Entity Expiration is the support window; when it ends, the build is end-of-life. A compromised build gets a revocation entity, written together with the fixed release in one transaction.")),
      h("div", { class: "card" }, h("h3", {}, "Mirror operator"),
        h("p", {}, "Registers a URL that serves the exact file. The mirror entity is a 6 hour lease. A keeper re-downloads it every two hours and renews the lease only if the bytes still match. Any user who verified a download may renew it too (lifeboat fetch --vouch). A mirror that goes bad simply lapses.")),
      h("div", { class: "card" }, h("h3", {}, "User"),
        h("p", {}, "Pins the publisher address once. Lifeboat reads Arkiv directly, tries mirrors freshest lease first, hashes the file locally and refuses anything that does not match. Revocations show up live over a WebSocket.")),
    ),
    trustExplainer(),
  ])
}

// ---------------------------------------------------------------------------------------------
// app page

function appView(appId: string, publisherParam: string) {
  const pins = loadPins()
  const stored = pins[appId]
  const publisher = (isAddress(publisherParam) ? lower(publisherParam) : stored ?? "") as Hex
  if (!publisher) {
    append(view, h("div", { class: "banner warn" }, "This link has no publisher address. Open the app from the home page and paste the address the project publishes."))
    return
  }
  const before = { requests: rpcStats.requests, cost: rpcStats.cost }

  const pinBar = h("div", { class: "pinbar" })
  const banners = h("div", { class: "banners" })
  const body = h("div", {}, h("p", { class: "muted" }, "Reading Arkiv…"))
  const liveDot = h("span", { class: "live off" }, "live updates: connecting")
  append(view, [pinBar, banners, body])

  // pin status
  const renderPin = () => {
    clear(pinBar)
    const now = loadPins()[appId]
    append(pinBar, [
      h("span", { class: "muted" }, "Publisher pinned for this view: "),
      addrLink(publisher),
      " ",
      now === publisher
        ? chip("you confirmed this address before", "good")
        : now
          ? chip("DIFFERS from the address you confirmed earlier", "bad")
          : h("button", { class: "small", onclick: () => (savePin(appId, publisher), renderPin()) }, "I checked it, remember it for this app"),
      liveDot,
    ])
    if (now && now !== publisher) {
      append(pinBar, h("p", { class: "banner bad" },
        `Earlier you confirmed ${now} as the publisher of ${appId}. This link pins a different address. A link can be forged; check the project's own channels before trusting it.`))
    }
  }
  renderPin()

  let state: AppStatus | undefined
  let fetchedAt = 0
  const seenRevocations = new Set<string>()
  let first = true

  const load = async () => {
    try {
      state = await appStatus(client, publisher, appId)
      fetchedAt = Date.now()
      render()
      first = false
    } catch (e) {
      clear(body)
      append(body, errorBox(e))
    }
  }

  const render = () => {
    if (!state) return
    const st = state
    const clock = liveClock(st.clock, fetchedAt)
    clear(body)
    clear(banners)

    for (const r of st.revocations) {
      const rel = st.releases.find((x) => x.sha256 === r.sha256)
      const replacement = r.replacedBySha256 ? st.releases.find((x) => x.sha256 === r.replacedBySha256) : undefined
      const isNew = !first && !seenRevocations.has(r.key)
      seenRevocations.add(r.key)
      append(banners, h("div", { class: `banner bad${isNew ? " flash" : ""}` },
        h("strong", {}, `${isNew ? "Just revoked: " : "Revoked: "}${rel ? `${rel.versionName} ` : ""}(${r.sha256.slice(0, 12)}…). `),
        r.reason || "No reason given.",
        replacement ? ` Use ${replacement.versionName} instead.` : r.replacedBySha256 ? ` Replacement sha256 ${r.replacedBySha256.slice(0, 12)}….` : "",
        " ",
        keyLink(r.key, "revocation"),
      ))
    }

    if (!st.app) {
      append(body, h("div", { class: "banner warn" }, `No app entity "${appId}" was created by this address. Either the id or the address is wrong, or the app entity expired.`))
    } else {
      const a = st.app
      append(body, h("section", { class: "card" },
        h("h1", {}, a.name, " ", h("span", { class: "muted small" }, a.app)),
        a.description ? h("p", {}, a.description) : null,
        a.homepage ? h("p", { class: "muted" }, "Homepage (may be the blocked site): ", safeLink(a.homepage)) : null,
        h("dl", { class: "kv" },
          h("dt", {}, "Founder"), h("dd", {}, addrLink(a.creator), h("span", { class: "muted" }, " $creator, fixed forever")),
          h("dt", {}, "Maintainer"), h("dd", {}, addrLink(a.owner), h("span", { class: "muted" }, a.owner === a.creator ? " $owner, same as founder" : " $owner, handed over by the founder")),
          h("dt", {}, "App entity"), h("dd", {}, keyLink(a.key), h("span", { class: "muted" }, ` expires ${until(blockToMs(a.expiresAt, clock), clock)}`)),
        ),
      ))
    }

    const rec = st.recommended
    if (rec) append(body, downloadCard(rec, st, clock))
    else append(body, h("div", { class: "banner warn" }, "No supported, unrevoked release. Either nothing is published, every support window has ended (end-of-life), or everything was revoked."))

    append(body, releasesCard(st, clock))
    append(body, mirrorsCard(st, clock))
    append(body, trustExplainer())
    append(body, costNote(before))
  }

  // the download card keeps its log across re-renders
  let logEl: HTMLElement | undefined
  let saveEl: HTMLElement | undefined
  let busy = false

  const downloadCard = (rec: ReleaseView, st: AppStatus, clock: Clock) => {
    logEl ??= h("ol", { class: "log" })
    saveEl ??= h("div", {})
    const btn = h("button", { class: "big", disabled: busy || st.mirrors.length === 0 }, busy ? "Working…" : "Download & verify")
    btn.addEventListener("click", () => void runDownload(rec, st, btn))
    return h("section", { class: "card release" },
      h("div", { class: "row" },
        h("h2", {}, `${rec.versionName}`, " ", h("span", { class: "muted small" }, rec.channel)),
        chip(`SUPPORTED until ${formatDate(blockToMs(rec.expiresAt, clock)).slice(0, 10)}`, "good"),
      ),
      h("dl", { class: "kv" },
        h("dt", {}, "File"), h("dd", { class: "mono" }, rec.fileName || "(no name)"),
        h("dt", {}, "sha256"), h("dd", { class: "mono wrap" }, rec.sha256),
        h("dt", {}, "Size"), h("dd", {}, `${rec.size.toLocaleString("en")} bytes`),
        h("dt", {}, "Signed by"), h("dd", {}, `${rec.role} `, addrLink(rec.creator)),
        h("dt", {}, "Release"), h("dd", {}, keyLink(rec.key)),
      ),
      rec.notes ? h("p", { class: "notes" }, rec.notes) : null,
      h("div", { class: "row" }, btn, h("span", { class: "muted" }, `${st.mirrors.length} mirror(s), freshest lease first. Bytes are hashed here, in your browser.`)),
      logEl,
      saveEl,
    )
  }

  const runDownload = async (rec: ReleaseView, st: AppStatus, btn: HTMLButtonElement) => {
    if (busy || !logEl || !saveEl) return
    busy = true
    btn.disabled = true
    btn.textContent = "Working…"
    clear(logEl)
    clear(saveEl)
    const rows = new Map<string, HTMLElement>()
    const label: Record<Attempt["status"], string> = { trying: "trying", dead: "dead", "wrong-bytes": "wrong bytes, rejected", ok: "verified" }
    const sources = uniqueByUrl(st.mirrors).map((m) => ({ url: m.url, key: m.key }))
    try {
      const res = await downloadVerified(sources, rec, {
        timeoutMs: 20_000,
        onAttempt: (a) => {
          let row = rows.get(a.url)
          if (!row) {
            row = h("li", {})
            rows.set(a.url, row)
            logEl!.append(row)
          }
          clear(row)
          row.className = a.status
          append(row, [h("span", { class: "st" }, label[a.status]), safeLink(a.url, a.url, "url"), h("span", { class: "detail" }, a.detail)])
        },
      })
      const blob = new Blob([res.bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" })
      const href = URL.createObjectURL(blob)
      teardown.push(() => URL.revokeObjectURL(href))
      const a = h("a", { href, download: rec.fileName || `${appId}-${rec.versionName}`, class: "button" }, `Save ${rec.fileName || "file"}`)
      append(saveEl, h("div", { class: "banner good" },
        h("strong", {}, "Verified. "),
        `sha256 ${rec.sha256} matches the release signed by the ${rec.role}. `, a))
      a.click()
    } catch (e) {
      const msg = e instanceof NoGoodMirrorError ? "No mirror served the published bytes. Nothing was saved." : describeError(e)
      append(saveEl, h("div", { class: "banner bad" }, msg))
    } finally {
      busy = false
      btn.disabled = false
      btn.textContent = "Download & verify"
    }
  }

  const releasesCard = (st: AppStatus, clock: Clock) =>
    h("section", { class: "card" },
      h("h2", {}, "Releases"),
      st.releases.length === 0 ? h("p", { class: "muted" }, "None live.") : null,
      h("table", { class: "list" },
        h("tbody", {},
          st.releases.map((r) =>
            h("tr", {},
              h("td", { class: "mono" }, r.versionName),
              h("td", { class: "muted" }, r.channel),
              h("td", {}, r.revocation ? chip("REVOKED", "bad") : chip(`SUPPORTED until ${formatDate(blockToMs(r.expiresAt, clock)).slice(0, 10)}`, "good")),
              h("td", { class: "mono", title: r.sha256 }, `${r.sha256.slice(0, 12)}…`),
              h("td", { class: "muted" }, r.role),
              h("td", {}, keyLink(r.key)),
            ),
          ),
        ),
      ),
      h("p", { class: "muted small" },
        "Releases past their support window are no longer returned by Arkiv, so they drop off this list: they are end-of-life. Drop one on ",
        h("a", { href: `#/check?publisher=${publisher}&app=${appId}` }, "Check a file"),
        " to see when its support ended.",
      ),
    )

  const mirrorsCard = (st: AppStatus, clock: Clock) =>
    h("section", { class: "card" },
      h("h2", {}, `Mirrors for ${st.recommended?.versionName ?? "the current release"}`),
      st.mirrors.length === 0 ? h("p", { class: "muted" }, "No live mirror leases right now.") : null,
      h("ul", { class: "mirrors" },
        st.mirrors.map((m) => {
          const l = leaseInfo(m, clock)
          return h("li", {},
            safeLink(m.url, m.url, "url"),
            h("div", { class: "muted small" },
              `lease renewed ~${formatDuration(clock.currentBlockTime * 1000 - l.renewedAtMs)} ago, expires ${until(l.expiresAtMs, clock)}`,
              l.unusual ? " (extended past the normal 6h window, tried last)" : "",
              m.region ? ` · ${m.region}` : "",
              " · operator ", h("span", { class: "mono" }, `${m.creator.slice(0, 10)}…`), " · ",
              keyLink(m.key, "mirror"),
            ),
            m.note ? h("div", { class: "small" }, m.note) : null,
          )
        }),
      ),
      h("p", { class: "muted small" }, "Mirrors are not trusted. Each one is a 6 hour lease that the operator's keeper renews only while the URL still serves the right bytes."),
    )

  // live: WebSocket subscription to Arkiv entity events
  const signers = () => new Set<string>(state ? signersFor(state.trust, appId) : [publisher])
  let lastMirrorRefresh = 0
  let pending: ReturnType<typeof setTimeout> | undefined
  const refreshSoon = (ms: number) => {
    clearTimeout(pending)
    pending = setTimeout(() => void load(), ms)
  }
  try {
    const ws = createPublicClient({ chain: tiramisu, transport: webSocket(RPC_WS, { reconnect: true }) })
    const stop = ws.watchEntityEvents({
      onEntityCreated: (ev) => {
        liveDot.className = "live on"
        if (signers().has(lower(ev.owner))) {
          // A release or revocation from the publisher: re-read now.
          refreshSoon(500)
        } else if (ev.creationFlags.permissionlessExtension && Date.now() - lastMirrorRefresh > 60_000) {
          // Mirrors are the only entities we create with permissionless extension. Anyone can add
          // one, so re-read at most once a minute.
          lastMirrorRefresh = Date.now()
          refreshSoon(2_000)
        }
      },
      onExpiryExtended: (ev) => {
        liveDot.className = "live on"
        // Lease renewals and support extensions carry the new expiry: no query needed.
        const m = state?.mirrors.find((x) => x.key === ev.entityKey)
        const r = state?.releases.find((x) => x.key === ev.entityKey)
        if (m) m.expiresAt = ev.expiresAt
        if (r) r.expiresAt = ev.expiresAt
        if (m || r) render()
      },
      onEntityDeleted: (ev) => {
        if (state?.releases.some((r) => r.key === ev.entityKey) || state?.mirrors.some((m) => m.key === ev.entityKey)) refreshSoon(500)
      },
      onError: () => {
        liveDot.className = "live off"
        liveDot.textContent = "live updates: reconnecting"
      },
    })
    liveDot.className = "live on"
    liveDot.textContent = "live: watching Arkiv"
    teardown.push(stop)
  } catch {
    liveDot.textContent = "live updates unavailable"
  }

  // local countdowns
  const tick = setInterval(render, 30_000)
  teardown.push(() => clearInterval(tick), () => clearTimeout(pending))
  void load()
}

// ---------------------------------------------------------------------------------------------
// check a file

function checkView(params: URLSearchParams) {
  const pins = loadPins()
  const app = params.get("app") ?? ""
  const pub = params.get("publisher") || (app && pins[app]) || DEMO_PUBLISHER
  const pubInput = h("input", { value: pub, class: "mono", spellcheck: "false", "aria-label": "Publisher address" })
  const appInput = h("input", { value: app, placeholder: "optional, e.g. lifeboat-cli", spellcheck: "false", "aria-label": "App id" })
  const fileInput = h("input", { type: "file" })
  const result = h("div", {})
  const drop = h("label", { class: "drop" }, h("strong", {}, "Drop a file here"), h("span", { class: "muted" }, " or click to choose one. It is hashed locally and never uploaded."), fileInput)

  const run = async (file: File) => {
    clear(result)
    const p = pubInput.value.trim()
    if (!isAddress(p)) {
      append(result, h("div", { class: "banner bad" }, "The publisher address is not valid."))
      return
    }
    const before = { requests: rpcStats.requests, cost: rpcStats.cost }
    append(result, h("p", { class: "muted" }, `Hashing ${file.name}…`))
    const sha = await sha256Hex(await file.arrayBuffer())
    clear(result)
    const status = h("p", { class: "muted" }, "Asking Arkiv…")
    append(result, [h("p", { class: "mono wrap" }, `sha256 ${sha}`), status])
    let res: CheckResult
    try {
      const appId = appInput.value.trim()
      res = await checkHash(client, lower(p), sha, {
        ...(appId ? { app: appId } : {}),
        fileName: file.name,
        onProbe: () => (status.textContent = "Not live now. Reading earlier blocks to see whether it was ever published…"),
      })
    } catch (e) {
      status.replaceWith(errorBox(e))
      return
    }
    status.remove()
    const clock = res.clock
    append(result, h("section", { class: `card verdict ${CHIP_TONE[res.verdict]}` },
      h("div", { class: "row" }, chip(res.verdict.replace("_", " "), CHIP_TONE[res.verdict]), h("span", {}, VERDICT_TEXT[res.verdict])),
      h("p", { class: "summary" }, res.summary),
      res.release
        ? h("dl", { class: "kv" },
            h("dt", {}, "Release"), h("dd", {}, `${res.release.app} ${res.release.versionName} (${res.release.channel}) `, keyLink(res.release.key)),
            h("dt", {}, "Signed by"), h("dd", {}, `${res.role} `, addrLink(res.release.creator)),
            res.verdict === "OK" ? [h("dt", {}, "Supported until"), h("dd", {}, formatDate(blockToMs(res.release.expiresAt, clock)))] : null,
            res.verdict === "EOL" ? [h("dt", {}, "Support ended"), h("dd", {}, `${formatDate(blockToMs(res.release.expiresAt, clock))}, found by reading the chain state at earlier blocks`)] : null,
            res.verdict === "TAMPERED" ? [h("dt", {}, "Expected sha256"), h("dd", { class: "mono wrap" }, res.release.sha256)] : null,
          )
        : null,
      res.revocation ? h("p", {}, "Revocation: ", keyLink(res.revocation.key, "revocation"), res.revocation.replacedBySha256 ? ` · replacement sha256 ${res.revocation.replacedBySha256}` : "") : null,
      res.untrusted.length > 0
        ? h("p", { class: "muted small" }, `Also claimed by ${res.untrusted.length} address(es) you did not pin: `, ...res.untrusted.slice(0, 3).map((r) => h("span", { class: "mono" }, `${r.creator} `)), "Ignored.")
        : null,
    ))
    append(result, costNote(before))
  }

  fileInput.addEventListener("change", () => fileInput.files?.[0] && void run(fileInput.files[0]))
  drop.addEventListener("dragover", (e) => (e.preventDefault(), drop.classList.add("over")))
  drop.addEventListener("dragleave", () => drop.classList.remove("over"))
  drop.addEventListener("drop", (e) => {
    e.preventDefault()
    drop.classList.remove("over")
    const f = (e as DragEvent).dataTransfer?.files?.[0]
    if (f) void run(f)
  })

  append(view, [
    h("h1", {}, "Check a file"),
    h("p", { class: "lede" }, "Already have the file, from a mirror, a friend or a USB stick? Find out whether the publisher vouches for it, revoked it, or let its support window run out."),
    h("section", { class: "card" },
      h("label", {}, "Publisher address", pubInput),
      h("label", {}, "App id", appInput),
      drop,
    ),
    result,
    h("section", { class: "card" },
      h("h3", {}, "What the answers mean"),
      h("dl", { class: "kv" }, (Object.keys(VERDICT_TEXT) as Verdict[]).flatMap((v) => [h("dt", {}, chip(v.replace("_", " "), CHIP_TONE[v])), h("dd", {}, VERDICT_TEXT[v])])),
      h("p", { class: "muted small" }, "Try it with the demo files: ",
        h("a", { href: `${import.meta.env.BASE_URL}dist/lifeboat-cli-0.1.0.tgz`, download: true }, "0.1.0"), " (OK), ",
        h("a", { href: `${import.meta.env.BASE_URL}dist/lifeboat-cli-0.0.9.tgz`, download: true }, "0.0.9"), " (revoked), ",
        h("a", { href: `${import.meta.env.BASE_URL}dist/lifeboat-cli-0.0.8.tgz`, download: true }, "0.0.8"), " (end-of-life), ",
        h("a", { href: `${import.meta.env.BASE_URL}dist/tampered/lifeboat-cli-0.1.0.tgz`, download: true }, "tampered 0.1.0"), " (tampered)."),
    ),
  ])
}

// ---------------------------------------------------------------------------------------------
// read it without us

function rawView(params: URLSearchParams) {
  const app = params.get("app") ?? DEMO_APP
  const pub = (params.get("publisher") ?? DEMO_PUBLISHER) as Hex
  const sha = "<sha256 of the file>"
  const select = JSON.stringify(toRpcSelect("*"))
  const queries: [string, string][] = [
    ["Releases of an app by the pinned publisher (sort by version yourself)", Q.releases(client, app, pub).toString()],
    ["Updates newer than versionCode 9", Q.releasesSince(client, app, 9, pub).toString()],
    ["Is this file published?", Q.releaseBySha(client, sha, pub).toString()],
    ["Is this file revoked?", Q.revocationBySha(client, sha, pub).toString()],
    ["Mirrors for a file (any operator; sort by $expiresAt yourself)", Q.mirrorsBySha(client, sha).toString()],
    ["Who maintains the app now ($owner) and who founded it ($creator)", Q.appsByPublisher(client, pub, app).toString()],
  ]
  const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const curl = (q: string) =>
    `curl -s ${RPC_HTTP} -H 'content-type: application/json' \\\n  --data ${shq(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "arkiv_query", params: [q, { select: JSON.parse(select) }] }))}`
  const sdk = `import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"
import { http } from "viem"

const client = createPublicClient({ chain: tiramisu, transport: http() })
const publisher = "${pub}"

const page = await client
  .select("*")
  .where(eq("lb", "1"), eq("kind", "release"), eq("app", "${app}"))
  .createdBy(publisher)          // the trust decision: $creator, never a writable field
  .limit(200)
  .fetch()

const releases = page.entities
  .map((e) => ({ key: e.key, attrs: e.attributes, body: e.toJson(), expiresAt: e.expiresAt }))
  .sort((a, b) => Number(b.attrs.version.value - a.attrs.version.value))
console.log(releases)`

  append(view, [
    h("h1", {}, "Read it without us"),
    h("p", { class: "lede" },
      "This page is a convenience. Everything it shows lives on Arkiv and can be read from any machine with the snippets below, through any Arkiv RPC endpoint. If this site is blocked too, the releases, revocations and mirrors are still there."),
    h("section", { class: "card" },
      h("h2", {}, "With the TypeScript SDK"),
      h("pre", {}, h("code", {}, sdk)),
      h("p", { class: "muted small" }, "Or install the CLI from any mirror and run: ", h("code", {}, `lifeboat fetch ${app} --publisher ${pub}`)),
    ),
    h("section", { class: "card" },
      h("h2", {}, "With plain JSON-RPC"),
      h("p", { class: "muted" }, "arkiv_query takes the query text and a selection. These are the exact queries Lifeboat sends."),
      queries.map(([title, q]) => [h("h3", {}, title), h("pre", {}, h("code", {}, curl(q)))]),
      h("p", { class: "muted small" },
        "Expiry comes back as a block number. arkiv_getBlockTiming returns the current block and its timestamp, and blocks are 2 seconds apart, which is how the page turns blocks into dates."),
    ),
    h("section", { class: "card" },
      h("h2", {}, "Live, over WebSocket"),
      h("pre", {}, h("code", {}, `import { webSocket } from "viem"

const ws = createPublicClient({ chain: tiramisu, transport: webSocket("${RPC_WS}") })
ws.watchEntityEvents({
  onEntityCreated: async ({ entityKey, owner }) => {
    if (owner.toLowerCase() !== publisher.toLowerCase()) return
    const e = await client.getEntity(entityKey)
    if (e.attributes.kind?.value === "revocation") console.log("REVOKED", e.attributes.sha256.value, e.toJson())
  },
})`)),
    ),
  ])
}

// Start last, so every const above is initialised before the first view renders.
window.addEventListener("hashchange", route)
route()
