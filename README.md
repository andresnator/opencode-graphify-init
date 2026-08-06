# OpenCode Graphify Init

Keep existing [Graphify](https://github.com/Graphify-Labs/graphify) graphs fresh in the background without ever starting a token-spending first index behind the user's back. The repository includes both the OpenCode server plugin and the `/graphify-index` command that records explicit consent.

## Quick path

This is the temporary distribution route: the plugin is not available on npm, so choose a published `vX.Y.Z` tag from [GitHub Releases](https://github.com/andresnator/opencode-graphify-init/releases) and retain its local checkout.

1. Install Graphify. Code-only indexing needs no model credentials:

   ```bash
   uv tool install "graphifyy==0.9.32"
   ```

2. Confirm that Git is installed and OpenCode is `>=1.17.15 <2`, then clone the release tag you selected:

   ```bash
   RELEASE_TAG=vX.Y.Z
   git clone --branch "$RELEASE_TAG" --depth 1 https://github.com/andresnator/opencode-graphify-init.git
   cd opencode-graphify-init
   ```

3. For `v0.1.1` or later, register the checkout and expose its companion command:

   ```bash
   ./scripts/install.sh
   ```

4. Keep the cloned directory because OpenCode and the command link refer to it. Restart OpenCode, open a concrete repository, and run:

   ```text
   /graphify-index
   ```

The command asks for code-only or docs + code mode and records the choice. Future sessions refresh the graph automatically and incrementally.

> The npm manifest is ready for `opencode-graphify-init@<version>`, but availability is not claimed until an npm release is published.

### Installation safety and existing checkouts

The installer asks OpenCode for its active global configuration directory before creating the command link, so plugin registration and command discovery use the same location. Re-running it is safe when the existing `/graphify-index` link points to the same checkout; it refuses to replace an unrelated file or link.

To exercise an existing development checkout, run `./scripts/install.sh` at its repository root, keep it at that path, and restart OpenCode.

The original `v0.1.0` tag predates the installer. For that tag only, register the checkout with `opencode plugin "$PWD" --global`, then link `commands/graphify-index.md` into `~/.config/opencode/commands/graphify-index.md` manually.

## Consent boundary

The plugin never performs first indexing. A repository without both a readable graph and a recorded mode receives one informational toast per session pointing to `/graphify-index`; no Graphify process is started.

The command writes one of these records before its first extract:

```json
{"mode":"code-only"}
```

```json
{"mode":"docs","backend":"<backend>"}
```

That file is standing consent for later rebuilds and the source of truth for every refresh. Ambient environment variables never change an already-recorded mode.

## Behavior

- Returns control to OpenCode immediately and runs stale-graph work in the background.
- Uses `graphify extract`, which is incremental, and never uses `update` or `watch` because those recreate output outside `.ai/`.
- Keeps all per-project state under `.ai/graphify-out/` and adds that exact path to Git's local info exclude.
- Compares Graphify's `built_at_commit` stamp with Git `HEAD` and retries once if the commit moves during extraction.
- Discovers Git repositories up to two levels below a plain aggregator workspace.
- Uses a multi-PID lock to prevent concurrent extracts across OpenCode sessions.
- Terminates tracked extract children when OpenCode exits and enforces a bounded extraction timeout.
- Registers successful graphs in Graphify's global graph by default.
- Queues startup toasts until a TUI subscriber is ready; a disconnected TUI never blocks indexing.

See [the lifecycle contract](docs/lifecycle.md) for the decision table and state files.

## Environment variables

| Variable | Effect |
|---|---|
| `OPENCODE_GRAPHIFY_AUTOINIT=0` | Disable refresh for the current OpenCode process |
| `OPENCODE_GRAPHIFY_GLOBAL=0` | Skip global-graph merge |
| `OPENCODE_GRAPHIFY_DOCS=1` | Suggest docs + code in `/graphify-index`; the command still asks and the recorded mode still wins |
| `OPENCODE_GRAPHIFY_BACKEND=<name>` | Backend fallback for legacy docs graphs without a recorded mode |
| `GRAPHIFY_OUT=.ai/graphify-out` | Required in shells and MCP configuration so reads and writes agree |

`OPENCODE_GRAPHIFY_TOAST_DELAY_MS` and `OPENCODE_GRAPHIFY_EXTRACT_TIMEOUT_MS` are test/diagnostic overrides; normal users should keep the defaults.

## Docs-mode caution

Docs + code routes documents, papers, and images through a configured LLM backend. It can take minutes and spend substantial tokens. Code-only is the recommended default because it is local, fast, and free.

Changing from docs to code-only requires a clean rebuild: remove the repository's global tag, clear `.ai/graphify-out/`, then run `/graphify-index` again. Incremental code-only extraction intentionally preserves old document nodes.

## Recovery

The plugin's error toast prints the mode-faithful recovery command. The general form is:

```bash
GRAPHIFY_OUT=.ai/graphify-out graphify extract '<repo>' --code-only
```

For docs mode, replace `--code-only` with `--backend <backend>` when the recorded mode pins one. If only the global merge failed, repair it without rebuilding:

```bash
graphify global add '<repo>/.ai/graphify-out/graph.json' --as <repo-tag>
```

## Compatibility and package shape

| Concern | Contract |
|---|---|
| OpenCode | `>=1.17.15 <2`; tested against the 1.18.x server plugin API |
| Graphify | Behavior characterized against `graphifyy` 0.9.32 |
| Agent harness | None; the companion command uses OpenCode's built-in `build` agent |
| Runtime npm dependencies | None |
| Package entry | `exports["./server"]` → `dist/server.js` |

The default export is `{ id, server }`, and the bundle imports only Node builtins. Graphify itself remains an external CLI dependency.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run security:check
```

The behavioral suite launches a real isolated OpenCode server and a fake Graphify binary. Its 42 lifecycle scenarios cover consent, freshness, code/docs modes, corrupt graphs, empty corpora, nested repositories, global registration, locks, shutdown, timeouts, and notifications. Nine additional installer scenarios cover fresh installation, idempotency, partial repair, config precedence, foreign-file ownership, rollback, path discovery, and help behavior.

## Repository map

| Path | Purpose |
|---|---|
| `src/server.ts` | Background refresher implementation |
| `commands/graphify-index.md` | Explicit first-index workflow |
| `scripts/install.sh` | Safe global checkout and command registration |
| `scripts/test-graphify-init.sh` | Real-server behavioral suite |
| `scripts/test-install.sh` | Isolated installer ownership suite |
| `docs/lifecycle.md` | Durable lifecycle and state contract |

See [NOTICE.md](NOTICE.md) for extraction provenance. The project is licensed under the [MIT License](LICENSE).
