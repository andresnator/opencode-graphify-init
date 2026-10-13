import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"

const root = new URL("../", import.meta.url)
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
// The server and TUI bundles load in different processes, so each must stand alone.
const bundles = await Promise.all(
  ["dist/server.js", "dist/tui.js"].map(async (path) => ({ path, source: await readFile(new URL(path, root), "utf8") })),
)

assert.equal(packageJson.name, "opencode-graphify-init")
assert.equal(packageJson.dependencies, undefined, "published package must not have runtime dependencies")
assert.equal(packageJson.exports?.["."]?.import, "./dist/server.js")
assert.equal(packageJson.exports?.["./server"]?.import, "./dist/server.js")
assert.equal(packageJson.exports?.["./tui"]?.import, "./dist/tui.js")
assert.equal(packageJson.engines?.node, ">=22.0.0")
assert.equal(packageJson.engines?.opencode, ">=2.0.27 <3")

for (const { path, source } of bundles) {
  assert.ok(!source.includes("agents-orchestrator"), `${path} still contains source-harness coupling`)
  const bareImports = [...source.matchAll(/\b(?:from\s+|import\s*\()(["'])([^"']+)\1/g)].map((match) => match[2])
  assert.deepEqual(
    bareImports.filter((specifier) => !specifier.startsWith("node:")),
    [],
    `${path} contains a non-Node runtime import`,
  )
}

const rootPlugin = await import(packageJson.name)
const serverPlugin = await import(`${packageJson.name}/server`)
assert.equal(rootPlugin.default, serverPlugin.default, "root and /server must resolve to the same plugin")
assert.equal(rootPlugin.default?.id, "andresnator.graphify-init")
assert.equal(typeof rootPlugin.default?.setup, "function")

// OpenCode V2 resolves `<package>/server` and `<package>/tui` itself; both share the plugin id
// so the TUI's RPC client reaches the server plugin's toast channel.
const tuiPlugin = await import(`${packageJson.name}/tui`)
assert.equal(tuiPlugin.default?.id, rootPlugin.default.id)
assert.equal(typeof tuiPlugin.default?.setup, "function")

const packed = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
})
assert.equal(packed.status, 0, packed.stderr || packed.stdout)
const report = JSON.parse(packed.stdout)
const files = new Set(report.files.map((entry) => entry.path))
for (const required of [
  "dist/server.js",
  "dist/server.d.ts",
  "dist/tui.js",
  "dist/tui.d.ts",
  "commands/graphify-index.md",
  "README.md",
  "LICENSE",
  "NOTICE.md",
]) {
  assert.ok(files.has(required), `package is missing ${required}`)
}
for (const forbidden of [
  "src/server.ts",
  "src/tui.ts",
  "scripts/install.sh",
  "scripts/test-install.sh",
  "scripts/test-graphify-init.sh",
  ".github/workflows/ci.yml",
]) {
  assert.ok(!files.has(forbidden), `package unexpectedly contains ${forbidden}`)
}

process.stdout.write(`PASS: package contains ${files.size} files and no runtime dependencies.\n`)
