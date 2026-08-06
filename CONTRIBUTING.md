# Contributing

Use the pinned Node.js and pnpm versions, preserve the consent boundary, and run the repository's complete and security checks before opening a pull request.

## Set up the checkout

| Tool | Required contract |
| --- | --- |
| Node.js | 22.23.2, matching `.node-version` and CI |
| Package manager | pnpm 10.34.5, matching `packageManager` and `pnpm-lock.yaml` |
| TypeScript | 5.9.3, strict mode, targeting ES2022 |
| OpenCode test binary | 1.18.13, matching `package.json` |
| Graphify behavior | `graphifyy` 0.9.32, matching the characterized lifecycle contract |

Install exactly the dependency graph recorded in the lockfile:

```bash
pnpm install --frozen-lockfile
```

Do not replace the lockfile or rewrite it with npm, Yarn, or another pnpm version. npm remains available only for registry-signature verification.

## Load the development checkout

Run `./scripts/install.sh` from the checkout under test. It registers the checkout globally, resolves the same configuration directory through OpenCode, and exposes `/graphify-index` without replacing an unrelated command. Keep the checkout at that path and restart OpenCode before manual verification.

## Make a focused change

- Never start a first Graphify index without the explicit `/graphify-index` consent flow.
- Keep startup refresh work non-blocking, bounded, recoverable, and scoped to `.ai/graphify-out/`.
- Preserve the recorded code-only or docs mode; ambient environment variables must not rewrite a repository decision.
- Remain compatible with the OpenCode range declared in `package.json` and Graphify behavior documented in `docs/lifecycle.md`.
- Keep public documentation in English and update the canonical owner when behavior, configuration, recovery, installation, or contribution routes change.

When changing the OpenCode API boundary, verify the current upstream server-plugin contract and update `engines.opencode` only with runtime evidence.

## Follow the test contract

Observable behavior changes require a contract in the appropriate Bash suite:

- name the function `should...When...`;
- divide every non-trivial test into visible `# Given`, `# When`, and `# Then` sections;
- isolate OpenCode, Git, Graphify, configuration, and user state under temporary directories; and
- assert observable files, processes, commands, logs, and events instead of implementation details.

## Navigate the repository

| Path | Purpose |
| --- | --- |
| `src/server.ts` | Background refresh implementation |
| `commands/graphify-index.md` | Explicit first-index and consent workflow |
| `scripts/test-graphify-init.sh` | Real-server lifecycle contracts |
| `scripts/test-install.sh` | Isolated installer ownership contracts |
| `docs/lifecycle.md` | Canonical state and recovery contract |
| `.github/` | CI, release automation, and contribution intake |

## Verify the change

Run the one required repository sequence:

```bash
pnpm run check
```

It runs type checking, workflow-action pinning, a clean build, installer and lifecycle contracts, release-policy contracts, and package verification. Record any focused manual checks separately in the pull request.

Run the dependency-security gates separately:

```bash
pnpm run security:check
```

The audit rejects every known vulnerability at `low` severity or higher. The signature check verifies registry signatures for the installed dependency graph. Do not use an automatic audit fix in place of reviewing and updating the lockfile.

## Prepare the pull request

- Use `type(scope)!: description` for the pull request title. The scope and `!` are optional; valid types are `build`, `chore`, `ci`, `deps`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, and `test`.
- Use `feat`, `fix`, or `deps` when a normal release should be proposed. Before `1.0.0`, all three produce a patch release; a breaking title or `BREAKING CHANGE:` footer produces a minor release. Other types do not produce a release unless they are breaking.
- Put useful release detail and any `BREAKING CHANGE:` footer in the pull request body. GitHub preserves the title as the squash commit subject and the body as its message.
- Summarize the public impact and include verification evidence, not only a claim that checks passed.
- Keep the implementation, committed distribution, tests, lifecycle documentation, installation guidance, and changelog aligned.

Release Please opens or updates a release pull request after qualifying changes reach `main`. Merging that release pull request updates `package.json` and `CHANGELOG.md`, creates a `vX.Y.Z` tag, and publishes a GitHub Release. It does not publish the package to npm.
