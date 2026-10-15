// Seeds the public demo on Tiramisu by driving the mirrorlease CLI. Safe to rerun: every step checks
// what already exists first and skips it.
//
//   MIRRORLEASE_PUBLISHER_KEY_FILE=~/.config/mirrorlease/publisher.key \
//   MIRRORLEASE_MIRROR_KEY_FILE=~/.config/mirrorlease/mirror.key \
//   npx tsx scripts/seed-demo.ts [core|mirrors|demo-mirrors|all]
//
//   core          app entity, 0.0.8 (beta, 1 day support so it is end-of-life soon),
//                 0.0.9 (stable), then revoke 0.0.9 and publish 0.1.0 in one atomic batch
//   mirrors       the three real mirrors for 0.1.0 (each is downloaded and checked first),
//                 plus the dead and poisoned demo entries
//   demo-mirrors  only the dead and poisoned entries. The keeper rightly lets those lapse, so the
//                 keeper timer reruns this to keep the failover demo visible.
//
// Needs the files in web/public/dist (built with scripts/pack-cli.mjs). Prints every key.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const APP = "mirrorlease-cli"
const DIST = resolve("web/public/dist")
const PAGES = "https://0xmago77.github.io/Mirrorlease/dist"
const CDN = "https://cdn.jsdelivr.net/gh/0xmago77/Mirrorlease@main/web/public/dist"
const RAW = "https://raw.githubusercontent.com/0xmago77/Mirrorlease/main/web/public/dist"

const pubKey = process.env.MIRRORLEASE_PUBLISHER_KEY_FILE
const mirKey = process.env.MIRRORLEASE_MIRROR_KEY_FILE
const phase = process.argv[2] ?? "all"

const file = (v: string) => resolve(DIST, `mirrorlease-cli-${v}.tgz`)
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

type Json = Record<string, unknown>

function cli(keyFile: string | undefined, args: string[], allowFail = false): Json {
  const env = { ...process.env }
  delete env.MIRRORLEASE_PRIVATE_KEY
  if (keyFile) env.MIRRORLEASE_KEY_FILE = keyFile
  else delete env.MIRRORLEASE_KEY_FILE
  try {
    const out = execFileSync("npx", ["tsx", "src/cli/bin.ts", ...args, "--json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return JSON.parse(out)
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout)
        if (allowFail) return parsed
      } catch {
        // fall through
      }
    }
    if (allowFail) return { error: err.stderr?.trim() ?? String(e) }
    throw new Error(`mirrorlease ${args.join(" ")} failed: ${err.stderr?.trim() ?? e}`)
  }
}

function show(label: string, r: Json) {
  const key = r.key ?? r.revocationKey
  const status = r.existing ? "exists " : r.error ? "FAILED " : "created"
  console.log(`${status} ${label.padEnd(34)} ${key ?? ""}${r.txHash ? `  tx ${r.txHash}` : ""}${r.error ? `  ${r.error}` : ""}`)
  if (r.replacementKey) console.log(`created ${"release 0.1.0 (same batch)".padEnd(34)} ${r.replacementKey}`)
}

function need(v: string | undefined, name: string): string {
  if (!v) throw new Error(`set ${name}`)
  return v
}

function publisherAddress(): string {
  return String(cli(need(pubKey, "MIRRORLEASE_PUBLISHER_KEY_FILE"), ["whoami"]).address)
}

function core() {
  const key = need(pubKey, "MIRRORLEASE_PUBLISHER_KEY_FILE")
  for (const v of ["0.0.8", "0.0.9", "0.1.0"]) if (!existsSync(file(v))) throw new Error(`missing ${file(v)}`)
  const publisher = publisherAddress()

  show(
    "app mirrorlease-cli",
    cli(key, ["app", "create", "--app", APP, "--name", "Mirrorlease CLI",
      "--description", "Command line client for Mirrorlease. This app is its own demo: its releases and mirrors are the ones shown on the site.",
      "--homepage", "https://downloads.mirrorlease-demo.invalid/"]),
  )

  // 0.0.8: once its 1-day window ends it is gone from the head, so ask the verifier, which also
  // looks through history, whether it was ever published.
  const v008 = cli(undefined, ["verify", file("0.0.8"), "--publisher", publisher, "--app", APP], true)
  if (v008.verdict === "OK" || v008.verdict === "EOL") {
    console.log(`exists  ${"release 0.0.8 (beta)".padEnd(34)} ${v008.verdict}`)
  } else {
    show(
      "release 0.0.8 (beta, 1 day)",
      cli(key, ["publish", file("0.0.8"), "--app", APP, "--version", "0.0.8", "--channel", "beta", "--days", "1",
        "--notes", "Beta with a one day support window. It goes end-of-life on purpose, to show what users see then."]),
    )
  }

  const v009 = cli(undefined, ["verify", file("0.0.9"), "--publisher", publisher, "--app", APP], true)
  if (v009.verdict === "REVOKED") {
    console.log(`exists  ${"release 0.0.9 + revocation".padEnd(34)} REVOKED`)
  } else {
    show(
      "release 0.0.9 (stable)",
      cli(key, ["publish", file("0.0.9"), "--app", APP, "--version", "0.0.9", "--channel", "stable",
        "--notes", "First stable build."]),
    )
    show(
      "revoke 0.0.9 + publish 0.1.0",
      cli(key, ["revoke", sha(file("0.0.9")), "--reason",
        "Build machine compromised; this tarball cannot be trusted. Upgrade to 0.1.0.", "--severity", "3",
        "--replacement", file("0.1.0"), "--version", "0.1.0", "--channel", "stable",
        "--notes", "Rebuilt from a clean machine. Same features as 0.0.9."]),
    )
  }
  // In case 0.1.0 was not created by the batch (e.g. rerun after a partial failure).
  show("release 0.1.0 (stable)", cli(key, ["publish", file("0.1.0"), "--app", APP, "--version", "0.1.0", "--channel", "stable",
    "--notes", "Rebuilt from a clean machine. Same features as 0.0.9."]))
}

function realMirrors() {
  const key = need(mirKey, "MIRRORLEASE_MIRROR_KEY_FILE")
  const h = sha(file("0.1.0"))
  const list: [string, string, string][] = [
    ["mirror (a) GitHub Pages", `${PAGES}/mirrorlease-cli-0.1.0.tgz`, "GitHub Pages copy"],
    ["mirror (b) jsDelivr", `${CDN}/mirrorlease-cli-0.1.0.tgz`, "jsDelivr CDN in front of the GitHub repo"],
    ["mirror (c) raw.githubusercontent", `${RAW}/mirrorlease-cli-0.1.0.tgz`, "raw file from the GitHub repo"],
  ]
  for (const [label, url, note] of list) {
    show(label, cli(key, ["mirror", "add", url, "--sha256", h, "--app", APP, "--region", "global", "--note", note], true))
  }
}

function demoMirrors() {
  const key = need(mirKey, "MIRRORLEASE_MIRROR_KEY_FILE")
  const h = sha(file("0.1.0"))
  show("mirror (d) dead, demo", cli(key, ["mirror", "add", "https://downloads.mirrorlease-demo.invalid/mirrorlease-cli-0.1.0.tgz",
    "--sha256", h, "--app", APP, "--skip-check", "--note", "Demo: the project's official download site, now unreachable."], true))
  show("mirror (e) poisoned, demo", cli(key, ["mirror", "add", `${PAGES}/tampered/mirrorlease-cli-0.1.0.tgz`,
    "--sha256", h, "--app", APP, "--skip-check", "--note", "Demo: a mirror serving a modified tarball under the same name."], true))
}

if (phase === "core" || phase === "all") core()
if (phase === "mirrors" || phase === "all") {
  realMirrors()
  demoMirrors()
}
if (phase === "demo-mirrors") demoMirrors()
