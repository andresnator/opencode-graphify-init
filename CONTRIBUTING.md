# Contributing

Use Node.js `22.23.2`, pnpm `10.34.5`, OpenCode `1.18.13`, and Graphify `0.9.32`.

## Quick path

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run security:check
```

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
- Preserve the recorded code-only or docs mode.
- Keep runtime npm dependencies at zero.
- Add observable behavior contracts to the relevant test suite.
- Keep public documentation in English.

Name non-trivial tests `should...When...` and use visible Given, When, and Then sections.

## Open the pull request

Use `type(scope)!: description`. Supported types are `build`, `chore`, `ci`, `deps`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, and `test`.

Describe user impact and list automated and manual evidence. Release Please creates stable GitHub releases; `.github/workflows/publish.yml` publishes them to npm through Trusted Publishing. Never add an npm token to the repository.
