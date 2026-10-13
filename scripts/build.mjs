import { rm } from "node:fs/promises"
import { build } from "esbuild"

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true })

await build({
  entryPoints: ["server", "tui"].map((name) => new URL(`../src/${name}.ts`, import.meta.url).pathname),
  outdir: new URL("../dist", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  sourcemap: false,
  legalComments: "none",
})
