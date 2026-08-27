import assert from "node:assert/strict"
import { registerGraphifyIndexCommand } from "../dist/server.js"

async function shouldRegisterTheBundledCommandWhenNoCommandExists() {
  // Given
  const config = {}

  // When
  await registerGraphifyIndexCommand(config)

  // Then
  assert.equal(config.command["graphify-index"].agent, "build")
  assert.match(config.command["graphify-index"].description, /explicit human consent/i)
  assert.match(config.command["graphify-index"].template, /You are running `\/graphify-index`/)
  assert.match(config.command["graphify-index"].template, /Never run `graphify update`/)
}

async function shouldPreserveAnExistingCommandWhenTheNameIsAlreadyOwned() {
  // Given
  const existing = { template: "Keep me", description: "User command" }
  const config = { command: { "graphify-index": existing } }
  const warnings = []
  const originalWarn = console.warn
  console.warn = (message) => warnings.push(message)

  try {
    // When
    await registerGraphifyIndexCommand(config)
  } finally {
    console.warn = originalWarn
  }

  // Then
  assert.equal(config.command["graphify-index"], existing)
  assert.deepEqual(warnings, ["[graphify-init] /graphify-index already exists; keeping the existing command"])
}

await shouldRegisterTheBundledCommandWhenNoCommandExists()
await shouldPreserveAnExistingCommandWhenTheNameIsAlreadyOwned()
process.stdout.write("PASS: 2 bundled command registration contracts.\n")
