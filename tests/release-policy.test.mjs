import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { ALLOWED_TYPES } from "../scripts/validate-pr-title.mjs"

const root = new URL("../", import.meta.url)
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
const manifest = JSON.parse(await readFile(new URL(".release-please-manifest.json", root), "utf8"))
const releaseConfig = JSON.parse(await readFile(new URL("release-please-config.json", root), "utf8"))

function shouldKeepReleaseStateAlignedWhenAutomationIsConfigured() {
  // Given
  const rootPackage = releaseConfig.packages["."]

  // When
  const actual = {
    releaseType: rootPackage["release-type"],
    includeComponentInTag: rootPackage["include-component-in-tag"],
    includeVInTag: rootPackage["include-v-in-tag"],
  }

  // Then
  assert.equal(packageJson.version, manifest["."])
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(actual, {
    releaseType: "node",
    includeComponentInTag: false,
    includeVInTag: true,
  })
}

function shouldApplyThePreMajorVersionPolicyWhenChangesReachMain() {
  // Given
  const sections = releaseConfig["changelog-sections"]

  // When
  const configuredTypes = sections.map((section) => section.type).sort()
  const releaseTypes = sections
    .filter((section) => section.hidden !== true)
    .map((section) => section.type)
    .sort()

  // Then
  assert.equal(releaseConfig["bump-minor-pre-major"], true)
  assert.equal(releaseConfig["bump-patch-for-minor-pre-major"], true)
  assert.deepEqual(configuredTypes, [...ALLOWED_TYPES].sort())
  assert.deepEqual(releaseTypes, ["deps", "feat", "fix"])
}

shouldKeepReleaseStateAlignedWhenAutomationIsConfigured()
shouldApplyThePreMajorVersionPolicyWhenChangesReachMain()
process.stdout.write("PASS: 2 release policy contracts.\n")
