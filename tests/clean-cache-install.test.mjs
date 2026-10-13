import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const PACKAGE_NAME = "opencode-graphify-init"
const INSTALL_TIMEOUT_MS = 60_000
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
  const project = path.join(temporaryRoot, "packed-project")
  const requests = []
  await Promise.all([packageDirectory, configHome, dataHome, cacheHome, npmCache, home, project].map((directory) => mkdir(directory)))

  let registry
  try {
    const tarball = await packPackage(packageDirectory)
    registry = await startRegistry(tarball, requests)

    // When
    const env = {
      ...process.env,
      CI: "true",
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
      XDG_STATE_HOME: path.join(temporaryRoot, "state"),
      HOME: home,
      OPENCODE_SERVER_PASSWORD: "graphify-test-password",
      OPENCODE_GRAPHIFY_AUTOINIT: "1",
    }
    for (const key of ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_PROJECT_DISABLE", "OPENCODE_DISABLE_PROJECT_CONFIG"]) delete env[key]
    const result = await runProcess(process.env.OPENCODE_BIN ?? DEFAULT_OPENCODE_BIN, [
      "plugin", "add", packageSpec, "--print-logs", "--log-level", "debug",
    ], env)

    // Then
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`)
    assert.equal(result.timedOut, false, `OpenCode installation timed out:\n${output}`)
    assert.equal(result.code, 0, `first OpenCode installation failed:\n${output}\nregistry requests: ${requests.join(", ")}`)
    assert.match(output, /installed and added/)
    assert.ok(requests.includes(`GET /${PACKAGE_NAME}`), "OpenCode did not request the package metadata")
    assert.ok(
      requests.includes(`GET /${PACKAGE_NAME}/-/${PACKAGE_NAME}-${packageJson.version}.tgz`),
      `OpenCode did not download the packed artifact: ${requests.join(", ")}`,
    )

    const configFile = path.join(configHome, "opencode", "opencode.json")
    const config = JSON.parse(await readFile(configFile, "utf8"))
    assert.deepEqual(config.plugins, [packageSpec])
    await verifyInstalledRuntime(env, project)

    const version = await runProcess(process.env.OPENCODE_BIN ?? DEFAULT_OPENCODE_BIN, ["--version"], process.env)
    assert.equal(version.code, 0, version.stderr)
    process.stdout.write(`PASS: first clean-cache installation succeeds on OpenCode ${version.stdout.trim()}.\n`)
  } finally {
    await registry?.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function verifyInstalledRuntime(env, project) {
  const server = spawn(process.env.OPENCODE_BIN ?? DEFAULT_OPENCODE_BIN, [
    "serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs", "--log-level", "error",
  ], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  let logs = ""
  server.stdout.on("data", (chunk) => { logs += chunk })
  server.stderr.on("data", (chunk) => { logs += chunk })
  const stopped = once(server, "exit")
  try {
    const deadline = Date.now() + INSTALL_TIMEOUT_MS
    let baseUrl
    while (Date.now() < deadline && server.exitCode === null) {
      baseUrl = logs.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      if (baseUrl) break
      await delay(50)
    }
    assert.ok(baseUrl, `packed plugin server did not start:\n${logs}`)
    const headers = { authorization: `Basic ${Buffer.from("opencode:graphify-test-password").toString("base64")}` }
    const location = `?${new URLSearchParams({ "location[directory]": project })}`
    const get = async (endpoint) => {
      const response = await fetch(`${baseUrl}/api/${endpoint}${location}`, { headers, signal: AbortSignal.timeout(5_000) })
      if (response.status !== 200) assert.fail(`HTTP ${response.status}: ${await response.text()}`)
      return response.json()
    }
    let installed
    while (Date.now() < deadline) {
      installed = (await get("plugin")).data.find((plugin) => plugin.id === "andresnator.graphify-init")
      if (installed?.state.status === "active") break
      if (installed?.state.status === "failed") assert.fail(JSON.stringify(installed))
      await delay(50)
    }
    assert.equal(installed?.state.status, "active", `packed plugin did not activate:\n${logs}`)
    assert.deepEqual(installed.features, { server: true, tui: true })
    assert.equal(installed.source.type, "package")
    assert.ok((await get("command")).data.some((command) => command.name === "graphify-index"))
    const response = await fetch(`${baseUrl}/api/rpc/andresnator.graphify-init/notifications${location}`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ input: {} }),
      signal: AbortSignal.timeout(5_000),
    })
    assert.equal(response.status, 200)
    const backlog = (await response.json()).output
    assert.ok(backlog.some((notification) => /packed-project.*authorize code-only indexing/.test(notification.message)))
    await assert.rejects(stat(path.join(project, ".ai")), { code: "ENOENT" })
  } finally {
    server.kill("SIGTERM")
    const timer = setTimeout(() => server.kill("SIGKILL"), 5_000)
    try { await stopped } finally { clearTimeout(timer) }
  }
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
