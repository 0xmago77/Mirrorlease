// Builds the npm tarball for a given version from a clean staging directory, so the published bytes
// do not depend on the repository README or on devDependencies.
//
//   node scripts/pack-cli.mjs 0.1.0 web/public/dist
//
// The bundle in dist/mirrorlease.mjs must be built first (npm run build:cli).
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const [version = "0.1.0", dest = "web/public/dist"] = process.argv.slice(2)
const stage = resolve(".pack", `mirrorlease-cli-${version}`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, "dist"), { recursive: true })

const bundle = readFileSync("dist/mirrorlease.mjs", "utf8").replace(/const VERSION = "[^"]+"/, `const VERSION = "${version}"`)
writeFileSync(join(stage, "dist", "mirrorlease.mjs"), bundle, { mode: 0o755 })
copyFileSync("cli/README.md", join(stage, "README.md"))
copyFileSync("LICENSE", join(stage, "LICENSE"))
writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: "mirrorlease-cli",
      version,
      description: "Verify and fetch software releases whose hashes, revocations and mirrors live on Arkiv.",
      license: "MIT",
      type: "module",
      bin: { mirrorlease: "dist/mirrorlease.mjs" },
      files: ["dist/mirrorlease.mjs"],
      engines: { node: ">=22" },
      repository: { type: "git", url: "https://github.com/0xmago77/Mirrorlease" },
    },
    null,
    2,
  )}\n`,
)
mkdirSync(resolve(dest), { recursive: true })
const out = execFileSync("npm", ["pack", "--pack-destination", resolve(dest)], { cwd: stage, encoding: "utf8" })
console.log(`${resolve(dest)}/${out.trim().split("\n").pop()}`)
