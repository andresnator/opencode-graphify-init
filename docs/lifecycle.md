# Graph lifecycle contract

The lifecycle deliberately separates a human decision from automatic maintenance.

1. `/graphify-index` asks whether to index and whether to use code-only or docs mode.
2. Before extraction it writes `.ai/graphify-out/.opencode-index-mode` while holding `.opencode-extract-lock`.
3. On later OpenCode sessions the plugin reads that recorded mode. It refreshes stale or damaged graphs but never overrides the decision from environment variables.
4. A project with neither a readable graph nor a mode file receives one hint and no Graphify process.

## State

| Path | Meaning |
|---|---|
| `.ai/graphify-out/graph.json` | Current local graph |
| `.ai/graphify-out/.opencode-index-mode` | Standing consent and `code-only` or `docs` mode |
| `.ai/graphify-out/.opencode-extract-lock` | Live OpenCode/extract process IDs |
| `.ai/graphify-out/.opencode-empty-corpus` | Commit known to contain no indexable nodes |
| `~/.graphify/global-graph.json` | Optional cross-repository graph |

Every Graphify invocation receives `GRAPHIFY_OUT=.ai/graphify-out`. Do not combine that variable with `--out`: Graphify concatenates them and the writer no longer agrees with the MCP lookup path.

## Refresh decisions

- A graph whose `built_at_commit` equals `HEAD` is left untouched.
- A different commit triggers an incremental `graphify extract` in the recorded mode.
- An unreadable or deleted graph is rebuilt only when a mode file records prior consent.
- Legacy graphs without a mode file infer docs mode from `.graphify_semantic_marker`, then persist an explicit mode after a successful refresh.
- An empty corpus is informational and recorded at the current commit, preventing a retry loop until the repository changes.

## Process safety

The lock contains the OpenCode PID and, once spawned, the Graphify child PID. A second session skips a repository while either PID is alive. Stale locks are repaired only after every recorded process is gone.

Extract children receive a 30-minute default budget, terminate with OpenCode on normal shutdown, and escalate from `SIGTERM` to `SIGKILL` when necessary. Closing a session therefore cannot normally leave a docs-mode process spending tokens in the background.

See the root README for environment variables, installation, and recovery commands.
