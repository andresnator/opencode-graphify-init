import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const ROOT = new URL("../", import.meta.url)
const PUBLISH_WORKFLOW = new URL("../.github/workflows/publish.yml", import.meta.url)
const RELEASE_TAG_VERIFIER = new URL("../scripts/verify-release-tag.mjs", import.meta.url)
const workflow = await readFile(PUBLISH_WORKFLOW, "utf8")
const packageJson = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"))

function shouldRunOnlyForPublishedStableReleasesWhenTriggered() {
  const trigger = workflow.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1].trim()
  assert.equal(trigger, "release:\n    types: [published]")
  assert.ok(workflow.includes("github.event.release.draft == false && github.event.release.prerelease == false"))
}

function shouldUsePinnedToolingAndTheReleaseTag() {
  const actionReferences = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1])
  assert.deepEqual(actionReferences, [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
  ])
  assert.ok(workflow.includes("ref: ${{ github.event.release.tag_name }}"))
  assert.ok(workflow.includes("persist-credentials: false"))
  assert.ok(workflow.includes("node-version: 22.23.2"))
  assert.ok(workflow.includes("version: 10.34.5"))
  assert.ok(workflow.includes("npm install --global npm@12.0.2"))
}

function shouldAcceptOnlyThePackageVersionTag() {
  const accepted = runReleaseTagVerifier(`v${packageJson.version}`)
  const rejected = runReleaseTagVerifier("v999.999.999")
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /does not match package version/)
}

function shouldPublishThroughOidcAfterAllGates() {
  const permissions = workflow.match(/^permissions:\n([\s\S]*?)\n\nconcurrency:/m)?.[1].trim()
  assert.equal(permissions, "contents: read\n  id-token: write")
  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm run check",
    "pnpm run security:check",
    "git diff --exit-code -- dist",
    "npm publish --ignore-scripts --access public",
  ]) {
    assert.ok(workflow.includes(command), `workflow is missing ${command}`)
  }
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./)
}

function runReleaseTagVerifier(releaseTag) {
  return spawnSync(process.execPath, [fileURLToPath(RELEASE_TAG_VERIFIER)], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, RELEASE_TAG: releaseTag },
  })
}

shouldRunOnlyForPublishedStableReleasesWhenTriggered()
shouldUsePinnedToolingAndTheReleaseTag()
shouldAcceptOnlyThePackageVersionTag()
shouldPublishThroughOidcAfterAllGates()
process.stdout.write("PASS: 4 npm publish workflow contracts.\n")
