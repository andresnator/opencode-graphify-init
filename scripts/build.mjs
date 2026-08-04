import { rm } from "node:fs/promises"
import { build } from "esbuild"

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true })

await build({
  entryPoints: [new URL("../src/server.ts", import.meta.url).pathname],
  outfile: new URL("../dist/server.js", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  sourcemap: false,
  legalComments: "none",
})
