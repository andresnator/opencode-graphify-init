import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"

const workflows = new URL("../.github/workflows/", import.meta.url)
const workflowFiles = (await readdir(workflows)).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
const unpinnedActions = []
let externalActions = 0

for (const file of workflowFiles) {
  const contents = await readFile(new URL(file, workflows), "utf8")
  for (const [index, line] of contents.split("\n").entries()) {
    const reference = line.match(/^\s*uses:\s*([^\s#]+)/)?.[1]
    if (!reference || reference.startsWith("./")) continue

    externalActions += 1
    if (!/^[^@]+@[0-9a-f]{40}$/.test(reference)) {
      unpinnedActions.push(`${file}:${index + 1}: ${reference}`)
    }
  }
}

assert.deepEqual(unpinnedActions, [], `workflow actions must use full commit SHAs:\n${unpinnedActions.join("\n")}`)
process.stdout.write(`PASS: ${externalActions} workflow actions use full commit SHAs.\n`)
