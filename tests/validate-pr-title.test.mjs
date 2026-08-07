import assert from "node:assert/strict"
import { validatePullRequestTitle } from "../scripts/validate-pr-title.mjs"

function shouldAcceptSupportedConventionalTitlesWhenSyntaxIsValid() {
  // Given
  const titles = [
    "fix: correct stale graph detection",
    "feat(installer): add global command registration",
    "feat!: remove the legacy mode marker",
    "chore(main): release opencode-graphify-init 0.1.1",
    "deps: update development dependencies",
  ]

  // When
  const results = titles.map(validatePullRequestTitle)

  // Then
  assert.ok(results.every((result) => result.valid), JSON.stringify(results))
}

function shouldRejectUnsupportedOrMalformedTitlesWhenSyntaxIsInvalid() {
  // Given
  const titles = [
    "Harden portable CI",
    "Fix: use a lower-case type",
    "fix missing colon",
    "fix: ",
    "security: add a dependency gate",
  ]

  // When
  const results = titles.map(validatePullRequestTitle)

  // Then
  assert.ok(results.every((result) => !result.valid), JSON.stringify(results))
}

shouldAcceptSupportedConventionalTitlesWhenSyntaxIsValid()
shouldRejectUnsupportedOrMalformedTitlesWhenSyntaxIsInvalid()
process.stdout.write("PASS: 2 pull request title contracts.\n")
