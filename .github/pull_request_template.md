## Summary

<!-- What does this pull request change, and why? -->

## Test scenarios

<!--
List every focused or manual scenario that must pass before merge. Copy the block below for each scenario.

### Scenario: <behavior or risk being verified>

- Environment: <operating system, Node.js version, OpenCode version, Graphify version when applicable, and repository shape>
- Preconditions: <fixtures, recorded mode, configuration, or starting state>
- Steps:
  1. <exact command or action>
  2. <next command or action>
- Expected result: <observable outcome>
- Observed result and evidence: <actual outcome, logs, screenshots, or CI link>
- Outcome: Passed | Failed | Not run — <required reason>
-->

## Verification

<!-- List the commands or manual checks you ran and their results. Explain anything not run. -->

## Quality checklist

<!-- Check every applicable item. For an item that does not apply, check it and add "N/A — <reason>". -->

- [ ] The title follows `type(scope)!: description` with an allowed Conventional Commit type.
- [ ] `pnpm run check` completed successfully.
- [ ] `pnpm run security:check` completed successfully.
- [ ] Required CI checks pass on Ubuntu and macOS.
- [ ] Observable behavior changes have contract coverage, or `N/A` is justified.
- [ ] Committed `dist/` artifacts were regenerated and match the source.
- [ ] Every required manual scenario above was executed and its evidence recorded.
- [ ] Consent, failure, concurrency, cleanup, and recovery behavior was considered when applicable.
- [ ] Documentation was updated or created when needed.
- [ ] The diff contains no secrets, machine-specific paths, temporary files, or local-only data.

## Documentation or release effect

<!-- List updated documentation and whether this should produce a release. If neither applies, explain why. -->
