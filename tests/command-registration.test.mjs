import assert from "node:assert/strict"
import { registerGraphifyIndexCommand } from "../dist/server.js"

function fixture(existing = []) {
  const definitions = []
  const calls = []
  const ctx = {
    command: {
      list: async () => ({ data: existing }),
      transform: async (callback) => {
        // Given transforms can be replayed, registration must have no execution side effects.
        const editor = { add: (command) => definitions.push(command) }
        callback(editor)
        callback(editor)
      },
    },
    session: {
      switchAgent: async (input) => calls.push({ action: "agent", input }),
      prompt: async (input) => calls.push({ action: "prompt", input }),
    },
  }
  return { ctx, definitions, calls }
}

async function shouldExecuteTheBundledConsentPromptWhenInvoked() {
  // Given
  const { ctx, definitions, calls } = fixture()
  await registerGraphifyIndexCommand(ctx)
  assert.equal(definitions.length, 2)
  assert.deepEqual(calls, [])
  const command = definitions[0]
  assert.equal(command.name, "graphify-index")
  assert.match(command.description, /explicit human consent/i)
  const prompt = { text: "  ./repo $&  ", files: [{ uri: "file:///example.py" }], metadata: { test: true } }

  // When
  await command.execute({ sessionID: "session-1", prompt, delivery: "queue" })

  // Then
  assert.deepEqual(calls[0], { action: "agent", input: { sessionID: "session-1", agent: "build" } })
  const actual = calls[1].input
  assert.equal(actual.sessionID, "session-1")
  assert.equal(actual.delivery, "queue")
  assert.equal(actual.files, prompt.files)
  assert.equal(actual.metadata, prompt.metadata)
  assert.match(actual.text, /You are running `\/graphify-index`/)
  assert.match(actual.text, /`\.\/repo \$&`/)
  assert.doesNotMatch(actual.text, /\$ARGUMENTS/)
  assert.match(actual.text, /Never run `graphify update`/)
  assert.match(actual.text, /graphify extract \. --code-only/)
  assert.match(actual.text, /policyVersion/)
}

async function shouldPreserveAnExistingCommandWhenTheNameIsAlreadyOwned() {
  // Given
  const { ctx, definitions, calls } = fixture([{ name: "graphify-index", description: "User command" }])

  // When
  await registerGraphifyIndexCommand(ctx)

  // Then
  assert.deepEqual(definitions, [])
  assert.deepEqual(calls, [])
}

await shouldExecuteTheBundledConsentPromptWhenInvoked()
await shouldPreserveAnExistingCommandWhenTheNameIsAlreadyOwned()
process.stdout.write("PASS: 2 OpenCode v2 command registration and execution contracts.\n")
