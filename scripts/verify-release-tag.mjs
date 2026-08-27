import { readFile } from "node:fs/promises"

const root = new URL("../", import.meta.url)
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
const expectedTag = `v${packageJson.version}`
const releaseTag = process.env.RELEASE_TAG

if (releaseTag !== expectedTag) {
  process.stderr.write(`Release tag ${releaseTag ?? "<missing>"} does not match package version ${expectedTag}.\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`PASS: release tag ${releaseTag} matches package version.\n`)
}
