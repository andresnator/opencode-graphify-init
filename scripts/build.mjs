import { rm } from "node:fs/promises"
import { build } from "esbuild"

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true })

// The server and TUI entries load in different processes, so each is bundled on its own.
// OpenCode resolves its plugin API itself; the sources only import its types.
await build({
  entryPoints: {
    server: new URL("../src/server.ts", import.meta.url).pathname,
    tui: new URL("../src/tui.ts", import.meta.url).pathname,
  },
  outdir: new URL("../dist", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["@opencode/*", "effect"],
  sourcemap: false,
  legalComments: "none",
})
