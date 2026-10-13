# OpenCode Graphify Init

[![npm version](https://img.shields.io/npm/v/opencode-graphify-init?logo=npm&label=npm)](https://www.npmjs.com/package/opencode-graphify-init)

Keep [Graphify](https://github.com/Graphify-Labs/graphify) code graphs fresh in the background. First indexing requires `/graphify-index` consent; authorized older graphs are automatically reconstructed once under the code-only policy.

## Install

Requires OpenCode `>=2.0.27 <3` and Graphify `0.9.32` with MCP support:

```bash
uv tool install "graphifyy[mcp]==0.9.32"
opencode plugin add opencode-graphify-init
```

OpenCode loads the new plugin without restarting its server. Reopen any terminal UI that was already running so it loads the bundled notification component, open a concrete project, then run:

```text
/graphify-index
```

Confirm the repository set and authorize local, free code-only indexing. Project documentation is not indexed or deleted; source comments and docstrings remain available to Graphify.

### Upgrade from OpenCode 1.x

OpenCode 2 reads plugins from the `plugins` list, so add this plugin again with `opencode plugin add opencode-graphify-init` after upgrading OpenCode. Existing consent and graphs under `.ai/graphify-out/` carry over unchanged.

Release `0.1.7` is the last one for OpenCode 1.x. To stay on 1.x, pin it there with `opencode plugin opencode-graphify-init@0.1.7 --global --force`.

## Use

1. Run `/graphify-index` and confirm the target repositories before their first indexing.
2. Let OpenCode reconstruct legacy graphs once and refresh stale code graphs automatically when it opens the project and whenever another terminal UI attaches to it.

`/graphify-index` runs in the current session with its selected agent. A user-defined `graphify-index` command replaces the bundled one.

Consent and successful code-only policy state are recorded under `.ai/graphify-out/`. Historical mode/backend settings cannot enable documentation extraction.

## Behavior

| Project state | Result |
| --- | --- |
| No authorized graph or consent | Show one hint; start nothing |
| Previously authorized graph without successful policy proof | Rebuild once from clean generated state, even when current at `HEAD` |
| Graph commit differs from Git `HEAD` | Refresh incrementally with `--code-only` |
| Graph/empty corpus is current | Keep local state; retry pending global work when enabled |

Refreshes run in the background, use exclusive local and global locks, and keep project state under `.ai/graphify-out/`. Interrupted or uncertain work retains its lock until an operator confirms quiescence and removes only that lock. Global reconciliation is separately pending on opt-out or failure; the plugin verifies ownership before a scoped global mutation. See [Graph lifecycle](docs/lifecycle.md) for manual recovery and external-CLI race limitations.

Notifications appear as terminal UI toasts. Clients without the terminal UI, such as the web client, still refresh graphs; the server keeps up to 50 undelivered notifications for the next terminal UI that attaches.

## Configure

| Variable | Effect |
| --- | --- |
| `OPENCODE_GRAPHIFY_AUTOINIT=0` | Disable refresh for this OpenCode server process |
| `OPENCODE_GRAPHIFY_GLOBAL=0` | Leave shared global data untouched; retry pending reconciliation when enabled |
| `GRAPHIFY_OUT=.ai/graphify-out` | Keep Graphify CLI and MCP paths aligned |

The plugin reads these variables from the OpenCode server, not from the terminal UI. For the background service, set one and restart the service:

```bash
opencode service set env OPENCODE_GRAPHIFY_AUTOINIT 0
opencode service restart
```

Use `GRAPHIFY_OUT=.ai/graphify-out` in shells and Graphify MCP configuration. Do not combine it with `--out`.

## Update or remove

A bare `opencode-graphify-init` entry follows npm `latest`. Update it with:

```bash
opencode plugin update opencode-graphify-init
```

To pin a release, replace the configured entry:

```bash
opencode plugin remove opencode-graphify-init
opencode plugin add opencode-graphify-init@<version>
```

To remove the plugin, run `opencode plugin remove` with its exact configured specifier, such as `opencode-graphify-init` or `opencode-graphify-init@<version>`. Every other configured plugin stays. Existing graph data remains until you remove it separately.

## Develop

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run security:check
```

See [Contributing](CONTRIBUTING.md) for local loading and review rules.

## Help

- [Graph lifecycle and recovery](docs/lifecycle.md)
- [Report a problem](https://github.com/andresnator/opencode-graphify-init/issues)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [MIT License](LICENSE)
