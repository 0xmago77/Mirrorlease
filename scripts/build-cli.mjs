// Bundles the CLI and its dependencies into one file, dist/mirrorlease.mjs, so the npm tarball has no
// runtime dependencies and installs offline: `npm i -g ./mirrorlease-cli-0.1.0.tgz`.
import { build } from "esbuild"

await build({
  entryPoints: ["src/cli/bin.ts"],
  outfile: "dist/mirrorlease.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  legalComments: "eof",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
})
