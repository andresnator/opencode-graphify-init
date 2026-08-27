# Understand the Graphify lifecycle

First indexing is a human decision. Later sessions maintain only graphs whose mode has already been recorded.

## State

| Path | Purpose |
| --- | --- |
| `.ai/graphify-out/graph.json` | Current graph |
| `.ai/graphify-out/.opencode-index-mode` | Standing consent and selected mode |
| `.ai/graphify-out/.opencode-extract-lock` | Live OpenCode and Graphify process IDs |
| `.ai/graphify-out/.opencode-empty-corpus` | Commit known to have no indexable nodes |
| `~/.graphify/global-graph.json` | Optional cross-project graph |

Every Graphify call receives `GRAPHIFY_OUT=.ai/graphify-out`. Using `--out` as well creates a different path and breaks MCP lookup.

## Refresh decisions

- Matching `built_at_commit` and Git `HEAD`: no work.
- Different commit: incremental extract in the recorded mode.
- Missing or unreadable graph with a mode file: rebuild.
- No graph and no mode file: show one hint and wait for `/graphify-index`.
- Empty corpus: record the commit and retry only after the repository changes.

Legacy graphs infer docs mode from `.graphify_semantic_marker`, then store an explicit mode after a successful refresh.

## Change mode

Code-only to docs needs no purge; the semantic pass adds document nodes. Docs to code-only requires removing the repository from the global graph and clearing `.ai/graphify-out/` before running `/graphify-index` again. Incremental code-only extraction does not remove old document nodes.

## Process safety

The lock records the OpenCode process and active Graphify child. Another session skips live locks. Stale locks are repaired only after every recorded process exits.

Extracts have a 30-minute budget. OpenCode shutdown sends `SIGTERM`, then `SIGKILL` when needed, preventing abandoned docs-mode work from spending tokens indefinitely.

## Recover

The error toast prints a mode-faithful command. Code-only uses:

```bash
GRAPHIFY_OUT=.ai/graphify-out graphify extract '<repo>' --code-only
```

For docs mode, use `--backend <backend>`. If only global registration failed:

```bash
graphify global add '<repo>/.ai/graphify-out/graph.json' --as <repo-tag>
```
