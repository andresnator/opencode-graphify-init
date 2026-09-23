You are running `/graphify-index` with raw arguments:
`$ARGUMENTS`

Authorize the first **code-only** Graphify index for a repository or a confirmed set of repositories under a workspace. The plugin automatically rebuilds previously authorized unversioned indexes and refreshes later changes. Never offer documentation indexing or a backend selection. Source documents and code comments remain untouched.

## Boundaries

- Use only `GRAPHIFY_OUT=.ai/graphify-out graphify extract <root> --code-only`. Never run `graphify update` or `graphify watch`; never use `--out`, `--backend`, or inline `--global`.
- Refuse the filesystem root, home directory, and ancestors of home. Refuse symlinked `.ai` or `.ai/graphify-out` state directories. Never delete an existing consent file or lock.
- Hidden `.ai/` paths require explicit inspection; ordinary globs omit them.
- Ask for consent in chat. Do not assume a question tool exists.

## Workflow

1. Resolve the argument or project root to its canonical path. For a root with `.git`, use that repository. Otherwise find Git repositories up to two directory levels below it, excluding hidden paths, `node_modules`, and symlinked directories. List the resulting repositories and confirm the set with the human.
2. Probe `GRAPHIFY_OUT=.ai/graphify-out graphify --version`; if unavailable, stop and suggest `uv tool install graphifyy` or `pipx install graphifyy`.
3. Inspect each `.ai/graphify-out/graph.json`, `.opencode-index-mode`, `.opencode-empty-corpus`, and `.opencode-extract-lock` explicitly. A versioned state `{"mode":"code-only","policyVersion":1}` records successful local reconstruction; a historical `mode` value alone does **not** prove a clean graph. For previously authorized repos, do not run a competing extract: the plugin cleans generated state under its exclusive lock, even when HEAD is fresh or an old empty marker exists. Existing locks, **including dead-PID locks**, are never reclaimed automatically. Follow the manual recovery preconditions in `docs/lifecycle.md` rather than retrying blindly. Do not remove or replace a global contribution manually; tag collisions can destroy unrelated data.
4. For each repository with no prior authorization, ask whether to start local code-only indexing. The first pass is local and free; subsequent refreshes are incremental. Before indexing, add `.ai/graphify-out` to `git rev-parse --git-path info/exclude` if missing. Run the following *as one foreground shell invocation from that repository*. Check every command's result; on failure, report it and leave the unversioned consent file for a plugin retry. Do not overwrite a pre-existing lock or state directory, and never use an unlocked purge:

   ```bash
   test ! -L .ai && { test ! -e .ai || test -d .ai; } || exit 1
   mkdir -p .ai
   test ! -L .ai/graphify-out && { test ! -e .ai/graphify-out || test -d .ai/graphify-out; } || exit 1
   mkdir -p .ai/graphify-out
   lock=.ai/graphify-out/.opencode-extract-lock
   ( set -C; printf '%s\n' "$$" > "$lock" ) || { echo 'Index lock held or unsafe; stop for manual recovery' >&2; exit 1; }
   child=
   safe_release=0
   on_interrupt() {
     trap - HUP INT TERM
     if test -n "$child"; then kill -TERM "$child" 2>/dev/null || :; fi
     echo 'Interrupted: retaining lock until every extractor and descendant is quiescent' >&2
     exit 1
   }
   on_exit() {
     trap - EXIT
     if test "$safe_release" = 1; then rm -f -- "$lock"; fi
   }
   trap on_interrupt HUP INT TERM
   trap on_exit EXIT
   printf '%s\n' '{"mode":"code-only"}' > .ai/graphify-out/.opencode-index-mode || exit 1
   GRAPHIFY_OUT=.ai/graphify-out graphify extract . --code-only & child=$!
   printf '%s\n%s\n' "$$" "$child" > "$lock" || exit 1
   wait "$child" || exit 1
   test -f .ai/graphify-out/graph.json || exit 1
   printf '%s\n' '{"mode":"code-only","policyVersion":1,"pendingGlobal":true}' > .ai/graphify-out/.opencode-index-mode || exit 1
   safe_release=1
   ```

   This recipe is for a direct, foreground Graphify CLI, not a daemonizing wrapper. An interrupted `wait`, a successful `kill` request, or a failed extract does **not** prove its process tree stopped: the EXIT handler deliberately retains the lock unless a normal exit-0 build and policy write completed. If the CLI can spawn untracked writers, stop and use the lifecycle guide's quiescence-based manual recovery; do not assume the direct PID covers descendants. If Graphify confirms `extraction produced no nodes`, it may exit nonzero without a graph: do **not** write a successful version marker manually. Keep consent; after verifying all affected processes have stopped, remove only the relevant lock according to `docs/lifecycle.md`, then reopen for the plugin's confirmed empty outcome. Never run the snippet if graph, mode file, or empty marker already exists. The plugin later reconciles global registration under its own lock and verifies manifest ownership first. `OPENCODE_GRAPHIFY_GLOBAL=0` leaves the shared store untouched and retains pending reconciliation until re-enabled.
5. Report each outcome and node count from `graph.json`. An incomplete or interrupted first pass retains consent and its lock; only after quiescence-based manual recovery can the plugin retry. An unversioned historical graph is not safe to serve as code-only until reconstruction finishes. External Graphify processes do not honor plugin locks, so never promise universal cross-tool serialization.
