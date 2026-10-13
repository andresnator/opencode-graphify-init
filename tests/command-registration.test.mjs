import assert from "node:assert/strict"
import { registerGraphifyIndexCommand, renderIndexCommand } from "../dist/server.js"

// A V2 plugin context reduced to the two domains the command uses: the editor receives the
// definition, and the session domain records every prompt the command submits.
function fakeContext() {
  const commands = []
  const prompts = []
  const context = {
    command: {
      transform: async (callback) => {
        callback({ add: (definition) => commands.push(definition) })
        return { dispose: async () => {} }
      },
    },
    session: {
      prompt: async (input) => {
        prompts.push(input)
      },
    },
  }
  return { context, commands, prompts }
}

async function shouldRegisterTheBundledCommand() {
  // Given
  const { context, commands } = fakeContext()

  // When
  await registerGraphifyIndexCommand(context)

  // Then
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, "graphify-index")
  assert.match(commands[0].description, /explicit human consent/i)
  assert.equal(typeof commands[0].execute, "function")
}

async function shouldPromptTheSessionWithTheRenderedTemplate() {
  // Given
  const { context, commands, prompts } = fakeContext()
  await registerGraphifyIndexCommand(context)
  const files = [{ type: "file", url: "file:///tmp/notes.md", mention: { start: 0, end: 6 } }]

  // When
  await commands[0].execute({
    sessionID: "ses_test",
    prompt: { text: "  code-only please  ", files },
    delivery: "queue",
  })

  // Then the session receives the packaged template with trimmed arguments, and attachments
  // stay behind: their mention offsets point into the arguments, not into the template.
  assert.equal(prompts.length, 1)
  const [prompt] = prompts
  assert.deepEqual(Object.keys(prompt).sort(), ["delivery", "sessionID", "text"])
  assert.equal(prompt.sessionID, "ses_test")
  assert.equal(prompt.delivery, "queue")
  assert.match(prompt.text, /You are running `\/graphify-index` with raw arguments:\n`code-only please`/)
  assert.match(prompt.text, /Never run `graphify update`/)
  assert.match(prompt.text, /graphify extract \. --code-only/)
  assert.match(prompt.text, /policyVersion/)
  assert.doesNotMatch(prompt.text, /\$ARGUMENTS/)
  assert.doesNotMatch(prompt.text, /\[--code-only \| --backend|Choose code-only or docs mode/)
}

function shouldSubstituteArgumentsLiterally() {
  // Given arguments that a string replacement would read as special patterns.
  const template = "first: $ARGUMENTS / second: $ARGUMENTS"

  // When
  const rendered = renderIndexCommand(template, "  $& and $1  ")

  // Then
  assert.equal(rendered, "first: $& and $1 / second: $& and $1")
}

await shouldRegisterTheBundledCommand()
await shouldPromptTheSessionWithTheRenderedTemplate()
shouldSubstituteArgumentsLiterally()
process.stdout.write("PASS: 3 bundled command registration contracts.\n")
