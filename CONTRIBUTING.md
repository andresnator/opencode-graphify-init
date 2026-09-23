# Contributing

Use Node.js `22.23.2`, pnpm `12.5.1`, OpenCode `1.18.13`, and Graphify `0.9.32`.

## Quick path

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run security:check
```

CI also verifies a first npm installation with an empty cache on OpenCode 1.18.0, 1.18.20, and the latest 1.x release.

Keep one behavior per change. Update its tests and public documentation before opening a pull request. Do not rewrite `pnpm-lock.yaml` with npm, Yarn, or another pnpm version.

## Test local source

Use isolated OpenCode configuration when possible. Register the checkout under test with:

```bash
opencode plugin "$PWD" --global --force
```

Keep the checkout at that path, restart OpenCode, and verify `/graphify-index` plus background refresh behavior.

## Preserve contracts

- Never start first indexing without `/graphify-index` consent.
- Keep refresh work non-blocking, bounded, recoverable, and scoped to `.ai/graphify-out/`.
- Extract only code; preserve consent and reconstruct every unversioned authorized graph once under the successful code-only policy.
- Validate global tag ownership before add/remove, and retain pending reconciliation after opt-out or failure.
- Keep runtime npm dependencies at zero.
- Add observable behavior contracts to the relevant test suite.
- Keep public documentation in English.

Name non-trivial tests `should...When...` and use visible Given, When, and Then sections.

## Open the pull request

Use `type(scope)!: description`. Supported types are `build`, `chore`, `ci`, `deps`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, and `test`.

Describe user impact and list automated and manual evidence. Release Please creates stable GitHub releases; `.github/workflows/publish.yml` publishes them to npm through Trusted Publishing. Never add an npm token to the repository.

## Request an explicit release

When a public behavior change was merged under a non-releasing commit type,
request a version explicitly instead of labeling documentation as a feature.
Release Please supports a `Release-As` footer in the commit body:

```text
chore: request release 0.2.0

Release-As: 0.2.0
```

1. Open a reviewed PR explaining the target version and user-facing changes.
2. When squash-merging, preserve the footer in the final commit body; a footer
   only in the PR description is not sufficient.
3. Wait for Release Please to open the version/changelog PR. Review its release
   notes, compatibility impact, and CI before merging it.
4. Merging that release PR creates the GitHub release and triggers npm publishing.
   Check the publish workflow before announcing availability.

For the code-only transition in PR #25, the proposed next version is `0.2.0`:
legacy documentation indexing is removed, authorized indexes are rebuilt, and
uncertain locks require manual recovery. Include these changes in the release
notes even though the original commit was classified as `refactor`.

Do not manually bump the package or manifest for this request, create a tag, or
publish to npm. Let the subsequent release PR own those changes.

Reference: [Release Please: changing the version number](https://github.com/googleapis/release-please#how-do-i-change-the-version-number).
