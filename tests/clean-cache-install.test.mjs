import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
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
  const requests = []
  await Promise.all([mkdir(packageDirectory), mkdir(configHome), mkdir(dataHome), mkdir(cacheHome), mkdir(npmCache)])

  let registry
  try {
    const tarball = await packPackage(packageDirectory)
    registry = await startRegistry(tarball, requests)

    // When
    const result = await runProcess(process.env.OPENCODE_BIN ?? DEFAULT_OPENCODE_BIN, [
      "plugin", packageSpec, "--global", "--pure", "--print-logs", "--log-level", "DEBUG",
    ], {
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
    })

    // Then
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`)
    assert.equal(result.timedOut, false, `OpenCode installation timed out:\n${output}`)
    assert.equal(result.code, 0, `first OpenCode installation failed:\n${output}\nregistry requests: ${requests.join(", ")}`)
    assert.match(output, /Detected server target/)
    assert.ok(requests.includes(`GET /${PACKAGE_NAME}`), "OpenCode did not request the package metadata")
    assert.ok(
      requests.includes(`GET /${PACKAGE_NAME}/-/${PACKAGE_NAME}-${packageJson.version}.tgz`),
      `OpenCode did not download the packed artifact: ${requests.join(", ")}`,
    )

    const configFile = path.join(configHome, "opencode", "opencode.jsonc")
    const config = JSON.parse(await readFile(configFile, "utf8"))
    assert.deepEqual(config.plugin, [packageSpec])

    const version = await runProcess(process.env.OPENCODE_BIN ?? DEFAULT_OPENCODE_BIN, ["--version"], process.env)
    assert.equal(version.code, 0, version.stderr)
    process.stdout.write(`PASS: first clean-cache installation succeeds on OpenCode ${version.stdout.trim()}.\n`)
  } finally {
    await registry?.close()
    await rm(temporaryRoot, { recursive: true, force: true })
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
