import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")

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

shouldTestCleanCacheInstallationAcrossSupportedOpenCodeVersions()
process.stdout.write("PASS: clean-cache installation CI covers OpenCode 1.18 and latest 1.x.\n")
