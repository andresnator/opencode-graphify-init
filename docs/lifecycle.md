# Understand the code-only graph lifecycle

First indexing requires `/graphify-index` consent. Thereafter the plugin extracts **code only**, including source comments/docstrings normally handled by Graphify. It does not delete repository documentation or run a documentation backend.

## State and refresh

| Path | Purpose |
| --- | --- |
| `.ai/graphify-out/graph.json` | Active local graph |
| `.ai/graphify-out/.opencode-index-mode` | Consent; `policyVersion: 1` proves successful code-only extraction or confirmed empty outcome |
| `.ai/graphify-out/.opencode-extract-lock` | Exclusive local owner and direct Graphify child PID; retained on uncertainty |
| `.ai/graphify-out/.opencode-empty-corpus` | Commit confirmed to contain no indexable code |
| `~/.graphify/global-manifest.json` | Source-path owners for optional global contributions |
| `~/.graphify/.opencode-global-lock` | Exclusive plugin global mutation owner and direct CLI child PID |

Every Graphify call carries `GRAPHIFY_OUT=.ai/graphify-out`. Never combine it with `--out`: the MCP reader would look in a different path.

Previously authorized graphs without code-only policy proof are reconstructed **once from clean generated extraction artifacts**, even when their commit matches HEAD, their old mode said code-only, or an old empty marker is present. Consent and locks survive cleanup. Failed or interrupted reconstruction leaves consent intact but does not certify the old graph as code-only. A confirmed empty corpus removes obsolete active local nodes and does not retry at the same commit. A later commit triggers another attempt. Unknown historical modes with a readable graph or empty marker follow the same conservative reconstruction path; without recognized consent or index, `/graphify-index` still gates first indexing.

After reconstruction, matching graph/empty commit is locally ready; changed HEAD triggers incremental code-only extraction. The plugin runs asynchronously, exclusively creates a per-repository lock, and enforces a 30-minute extraction budget. A normal verified extraction releases its own lock. An interrupted or failed CLI may leave unknown writers, so its lock remains even after a timeout. If the lock or generated state cannot be validated, the plugin refuses destructive cleanup. A session with no Graphify binary shows an install hint rather than modifying the graph.

## Global reconciliation

With global integration enabled, the plugin checks the existing manifest's canonical `source_path` before running `graphify global add` or `global remove` for its own tag. A foreign collision, malformed manifest or graph, unsafe path, or contested global lock prevents mutation and retains a pending reconciliation record. Successful nonempty graphs replace the owned contribution; empty graphs remove only an owned contribution. Global failures warn even when the local code graph is ready, and a later unchanged session retries.

`OPENCODE_GRAPHIFY_GLOBAL=0` leaves the shared store untouched. Pending work retries when integration is re-enabled, including for a fresh local graph or confirmed empty corpus. The plugin's separately held global lock serializes **plugin-controlled** global mutations only. The direct global CLI child PID is written into that global lock, not the local lock. An interrupted or failed mutation retains the global lock. External Graphify processes do not honor plugin locks, and Graphify writes its global graph and manifest separately. Do not interpret this as a universal transaction or manually run a tag-based replacement without verifying its owner.

## Recover

An existing local or global lock is **never** reclaimed from PID checks, including dead PIDs: a child or descendant can outlive its recorded parent, and a read–unlink–create attempt could erase another session's new lock. Stop all affected OpenCode sessions and Graphify processes first, including direct CLI children and any wrappers or descendants. Confirm none can still write, then inspect the exact lock and remove **only** the relevant `.ai/graphify-out/.opencode-extract-lock` for this repository or `~/.graphify/.opencode-global-lock` for global reconciliation. Do not purge graph artifacts, consent, other repositories' locks, or the global store. If process quiescence or lock ownership is uncertain, leave the lock and escalate to an operator; PID metadata alone cannot authorize removal. A hard-killed parent can conservatively leave a global lock even after its direct child exits. Reopen the session only after this manual recovery.

An error toast shows the local extraction command, always with `--code-only`:

```bash
GRAPHIFY_OUT=.ai/graphify-out graphify extract '<repo>' --code-only
```

That raw command is diagnostic, not a substitute for the plugin's locked cleanup and policy recording on an unversioned legacy graph. If a global warning persists, inspect the manifest owner and the local graph; never delete the shared global graph or override an unrelated repository's tag.
