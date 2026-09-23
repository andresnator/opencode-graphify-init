import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
const workspace = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8")

function shouldPinPnpm12ExactlyAcrossBothCIJobsWithoutManagerTrustException() {
  // Given
  const setupVersions = [...workflow.matchAll(/uses: pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version: (\S+)/g)].map((match) => match[1])

  // When
  const packageManager = packageJson.packageManager

  // Then
  assert.equal(packageManager, "pnpm@12.5.1")
  assert.deepEqual(setupVersions, ["12.5.1", "12.5.1"])
  assert.doesNotMatch(workspace, /^\s*- pnpm@10\.34\.5\s*$/m)
  assert.match(workspace, /^trustPolicy: no-downgrade$/m)
  assert.match(workspace, /^\s+- effect@4\.0\.0-beta\.83$/m)
}

function shouldConfigurePnpmToRejectManagerMismatchWithoutDownloading() {
  // Given
  const managerPolicy = workspace.match(/^pmOnFail:\s*(\S+)\s*$/m)?.[1]

  // When
  const deprecatedSettings = /^packageManagerStrict(?:Version)?:/m.test(workspace)

  // Then
  assert.equal(managerPolicy, "error")
  assert.equal(deprecatedSettings, false)
}

function shouldTestCleanCacheInstallationAcrossSupportedOpenCodeVersions() {
  for (const version of ["1.18.0", "1.18.20", '"1"']) {
    assert.ok(workflow.includes(`version: ${version}`), `CI is missing OpenCode ${version}`)
  }
  for (const contract of [
    "npm install --prefix \"$OPENCODE_INSTALL_ROOT\"",
    "OPENCODE_BIN: ${{ runner.temp }}/opencode-${{ matrix.id }}/node_modules/.bin/opencode",
    "pnpm run test:install",
  ]) assert.ok(workflow.includes(contract), `CI is missing compatibility contract: ${contract}`)
}

shouldPinPnpm12ExactlyAcrossBothCIJobsWithoutManagerTrustException()
shouldConfigurePnpmToRejectManagerMismatchWithoutDownloading()
shouldTestCleanCacheInstallationAcrossSupportedOpenCodeVersions()
process.stdout.write("PASS: clean-cache installation CI covers OpenCode 1.18 and latest 1.x.\n")
