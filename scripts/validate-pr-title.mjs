import { pathToFileURL } from "node:url"

export const ALLOWED_TYPES = [
  "build",
  "chore",
  "ci",
  "deps",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
]
const TYPE_PATTERN = ALLOWED_TYPES.join("|")
const TITLE_PATTERN = new RegExp(`^(?:${TYPE_PATTERN})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S.*$`)

export function validatePullRequestTitle(title) {
  if (typeof title !== "string" || !TITLE_PATTERN.test(title)) {
    return {
      valid: false,
      message: `Pull request title must match type(scope)!: description. Allowed types: ${ALLOWED_TYPES.join(", ")}.`,
    }
  }

  return { valid: true }
}

export function runCli(title = process.env.PR_TITLE) {
  const result = validatePullRequestTitle(title)
  if (!result.valid) {
    process.stderr.write(`ERROR: ${result.message}\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write(`PASS: pull request title follows Conventional Commits: ${title}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli()
}
