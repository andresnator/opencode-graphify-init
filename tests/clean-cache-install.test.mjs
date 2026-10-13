import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const PACKAGE_NAME = "opencode-graphify-init"
const INSTALL_TIMEOUT_MS = 60_000
const SERVE_TIMEOUT_MS = 15_000
const SERVER_PASSWORD = "graphify-install"
const PLUGIN_ID = "andresnator.graphify-init"
const DEFAULT_OPENCODE_BIN = fileURLToPath(new URL("../node_modules/.bin/opencode", import.meta.url))
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
const packageSpec = `${PACKAGE_NAME}@${packageJson.version}`

async function shouldInstallOnFirstAttemptWhenCacheIsEmpty() {
  // Given
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "graphify-init-install-"))
  const packageDirectory = path.join(temporaryRoot, "package")
  const configHome = path.join(temporaryRoot, "config")
  const dataHome = path.join(temporaryRoot, "data")
  const cacheHome = path.join(temporaryRoot, "cache")
  const npmCache = path.join(temporaryRoot, "npm-cache")
  const home = path.join(temporaryRoot, "home")
  const project = path.join(temporaryRoot, "project")
  const requests = []
  await Promise.all(
    [packageDirectory, configHome, dataHome, cacheHome, npmCache, home, project].map((directory) => mkdir(directory)),
  )

  let registry
  try {
    const tarball = await packPackage(packageDirectory)
    registry = await startRegistry(tarball, requests)

    const environment = {
      ...process.env,
      CI: "true",
      HOME: home,
      NO_COLOR: "1",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_CACHE: npmCache,
      NPM_CONFIG_REGISTRY: registry.url,
      npm_config_audit: "false",
      npm_config_cache: npmCache,
      npm_config_registry: registry.url,
      XDG_CACHE_HOME: cacheHome,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
    }

    // When
    const result = await runProcess(opencodeBin(), ["plugin", "add", packageSpec], environment)

    // Then
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`)
    assert.equal(result.timedOut, false, `OpenCode installation timed out:\n${output}`)
    assert.equal(result.code, 0, `first OpenCode installation failed:\n${output}\nregistry requests: ${requests.join(", ")}`)
    assert.match(output, /installed and added to/)
    assert.ok(requests.includes(`GET /${PACKAGE_NAME}`), "OpenCode did not request the package metadata")
    assert.ok(
      requests.includes(`GET /${PACKAGE_NAME}/-/${PACKAGE_NAME}-${packageJson.version}.tgz`),
      `OpenCode did not download the packed artifact: ${requests.join(", ")}`,
    )

    const configFile = path.join(configHome, "opencode", "opencode.json")
    const config = JSON.parse(await readFile(configFile, "utf8"))
    assert.deepEqual(config.plugins, [packageSpec])

    // And the installed package loads both entrypoints through its `./server` and `./tui` exports.
    const plugin = await installedPlugin(environment, project)
    assert.deepEqual(plugin, {
      id: PLUGIN_ID,
      source: { type: "package", target: packageSpec, version: packageJson.version },
      features: { server: true, tui: true },
      state: { status: "active" },
    })

    const version = await runProcess(opencodeBin(), ["--version"], process.env)
    assert.equal(version.code, 0, version.stderr)
    process.stdout.write(`PASS: first clean-cache installation succeeds on OpenCode ${version.stdout.trim()}.\n`)
  } finally {
    await registry?.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function opencodeBin() {
  return process.env.OPENCODE_BIN ?? DEFAULT_OPENCODE_BIN
}

// Serves the installed configuration and reports the plugin's state for one project location.
// The first request for a location answers before plugins finish loading, so the bundled
// command appearing in the command list is the readiness signal.
async function installedPlugin(environment, directory) {
  const port = await freePort()
  const server = spawn(opencodeBin(), ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: ROOT,
    env: { ...environment, OPENCODE_GRAPHIFY_AUTOINIT: "0", OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  server.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  server.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk })
  const location = `location%5Bdirectory%5D=${encodeURIComponent(directory)}`
  const request = async (route) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${route}?${location}`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${SERVER_PASSWORD}`).toString("base64")}` },
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) throw new Error(`${route} answered ${response.status}`)
    return (await response.json()).data
  }

  try {
    const deadline = Date.now() + SERVE_TIMEOUT_MS
    for (;;) {
      const commands = await request("command").catch(() => [])
      if (commands.some((command) => command.name === "graphify-index")) break
      assert.ok(Date.now() < deadline, `installed plugin never registered /graphify-index:\n${stripAnsi(output)}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return (await request("plugin")).find((plugin) => plugin.id === PLUGIN_ID)
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolve) => server.once("close", resolve))
      server.kill("SIGTERM")
      await exited
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(address.port))
    })
  })
}

async function packPackage(destination) {
  const packed = spawnSync("pnpm", ["pack", "--pack-destination", destination], {
    cwd: ROOT,
    encoding: "utf8",
  })
  assert.equal(packed.status, 0, packed.stderr || packed.stdout)
  return readFile(path.join(destination, `${PACKAGE_NAME}-${packageJson.version}.tgz`))
}

async function startRegistry(tarball, requests) {
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (request.method === "GET" && request.url === `/${PACKAGE_NAME}`) {
      const address = server.address()
      assert.ok(address && typeof address === "object")
      const tarballUrl = `http://127.0.0.1:${address.port}/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${packageJson.version}.tgz`
      return sendJson(response, {
        name: PACKAGE_NAME,
        "dist-tags": { latest: packageJson.version },
        versions: {
          [packageJson.version]: {
            ...packageJson,
            dist: {
              integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
              shasum: createHash("sha1").update(tarball).digest("hex"),
              tarball: tarballUrl,
            },
          },
        },
      })
    }

    if (request.method === "GET" && request.url === `/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${packageJson.version}.tgz`) {
      response.writeHead(200, { "content-length": tarball.length, "content-type": "application/octet-stream" })
      return response.end(tarball)
    }

    if (request.method === "POST" && request.url?.startsWith("/-/npm/v1/security/")) return sendJson(response, {})
    response.writeHead(404)
    return response.end()
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    url: `http://127.0.0.1:${address.port}/`,
  }
}

function sendJson(response, value) {
  const body = JSON.stringify(value)
  response.writeHead(200, { "content-length": Buffer.byteLength(body), "content-type": "application/json" })
  response.end(body)
}

function runProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, INSTALL_TIMEOUT_MS)
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal, stderr, stdout, timedOut })
    })
  })
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

await shouldInstallOnFirstAttemptWhenCacheIsEmpty()
