You are running `/graphify-index` with raw arguments:
`$ARGUMENTS`

Build the first Graphify code graph for one repository — or for every repository under an aggregator workspace folder — with the human deciding whether to index and in which mode. After this command succeeds, the `graphify-init` plugin refreshes the graph automatically and incrementally on later sessions; it never performs a first indexing on its own.

## Hard constraints

- Use `graphify extract` only. Never run `graphify update` or `graphify watch`: both recreate `graphify-out/` at the repo root, outside `.ai/`.
- Every `graphify` invocation (including probes) must carry the environment variable `GRAPHIFY_OUT=.ai/graphify-out`. Never use the `--out` flag: it does not combine with `GRAPHIFY_OUT` (you would get `.ai/.ai/graphify-out`) and the MCP server would stop finding the graph.
- `.ai/` is a HIDDEN directory: default file globs skip dotfiles. When checking Graphify state, list or read explicit paths (`ls -la .ai/graphify-out`, `cat .ai/graphify-out/graph.json`) or search with hidden files enabled (`rg --hidden`). Never conclude state is missing based on a dot-skipping glob.
- Refuse to index unsafe roots: the filesystem root, the home directory, or any ancestor of the home directory. Suggest opening a concrete project folder instead.
- Ask questions in chat using plain conversational messages; do not assume a runtime-specific question tool is available.

## Workflow

1. **Resolve the target root.** Use the argument path if given, else the current project root. If the root contains a `.git` entry it is a single repository. Otherwise treat it as an aggregator workspace: discover git repositories nested up to 2 directory levels below it, skipping hidden directories, `node_modules`, and symlinked directories. List what you found and confirm the set with the human before doing anything.
2. **Check preconditions.** Run `GRAPHIFY_OUT=.ai/graphify-out graphify --version`; if the binary is missing, stop and tell the human to install it (`uv tool install graphifyy` or `pipx install graphifyy`). For each target repo, check `.ai/graphify-out/graph.json`: if a healthy graph already exists, report it and skip that repo (the plugin keeps it fresh; re-indexing is only worth it if the human explicitly wants to change mode). When the human DOES want to change an existing repo's mode, direction matters:
   - **docs → code-only**: an incremental `--code-only` extract deliberately preserves the old document/paper/image nodes (Graphify design), so the recorded mode would lie about the graph's contents. Purge first: run `graphify global remove <tag>` (skip when `OPENCODE_GRAPHIFY_GLOBAL=0` or the tag is not in `graphify global list`), delete the contents of `.ai/graphify-out/` (graph.json, manifest.json, `.graphify_semantic_marker`, `.opencode-index-mode`), then run the full extract below as if it were a first indexing.
   - **code-only → docs**: no purge needed — the incremental semantic pass adds the document nodes on top of the unchanged code; just run the extract below with the docs flags.
3. **Ask the indexing mode** (one question in chat, covering all target repos; offer per-repo overrides only if the human asks). If `OPENCODE_GRAPHIFY_DOCS=1` is exported, mention that the human's shell defaults to docs mode — but still ask; the environment never replaces the answer:
   - **Code-only (recommended):** pure local AST extraction. Takes seconds to a couple of minutes even on large repos. No credentials, no cost.
   - **Docs + code:** also routes documentation (Markdown, PDFs, images) through an LLM backend. Takes minutes (~8 minutes on a ~300-file repo) and spends real tokens (a reference run on this repo billed ~184k output tokens). Needs a configured backend: use `OPENCODE_GRAPHIFY_BACKEND` if set, otherwise ask which backend to pass to `--backend`.
   - Either way, tell the human the first pass is the slow one: later refreshes are incremental (unchanged files are never re-parsed; unchanged docs are never re-billed) and the plugin runs them automatically.
4. **Index each repo** (from that repo's root):
   - Ensure the exclude entry: append `.ai/graphify-out` to the file returned by `git rev-parse --git-path info/exclude` (this covers linked worktrees) if the entry is not already present.
   - State the expected duration for the chosen mode, then run the lock + mode file + extract as ONE shell invocation. This matters twice over: the mode file is the plugin's standing consent, so a second OpenCode session opened mid-extract would see consent plus no graph and start a duplicate (token-spending) extraction unless the same `.opencode-extract-lock` the plugin honors is already held — and the lock must be taken BEFORE the mode file is written and hold a PID that stays alive for the extract's whole duration, which is only true of the shell that runs the extract itself (each tool-run shell dies with its invocation):

     ```bash
     mkdir -p .ai/graphify-out
     lock=.ai/graphify-out/.opencode-extract-lock
     if ! (set -o noclobber; echo $$ > "$lock") 2>/dev/null; then
       while read -r pid; do
         kill -0 "$pid" 2>/dev/null && { echo "another session (pid $pid) is already extracting; aborting" >&2; exit 1; }
       done < "$lock"
       rm -f "$lock" && echo $$ > "$lock"   # every recorded PID is dead: stale lock, take over
     fi
     trap 'rm -f "$lock"' EXIT
     printf '%s\n' '<mode-json>' > .ai/graphify-out/.opencode-index-mode
     GRAPHIFY_OUT=.ai/graphify-out graphify extract . [--code-only | --backend <backend>] --global --as <tag>
     ```

     where `<mode-json>` is one JSON line — `{"mode":"code-only"}` or `{"mode":"docs","backend":"<backend>"}` (omit `backend` if none was passed) — and `<tag>` is the repo directory basename with every character outside `[A-Za-z0-9_-]` replaced by `-`. Omit `--global --as <tag>` when `OPENCODE_GRAPHIFY_GLOBAL=0`. If the lock is held by a live PID, tell the human another session is indexing this repo and stop. Writing the mode file before the extract (but after the lock) means an interrupted first pass is resumed automatically (and incrementally) by the plugin next session; a killed shell leaves a dead-PID lock the plugin replaces on its own.
5. **Report.** For each repo: node count from `graph.json`, elapsed time, and mode recorded. Remind the human that refreshes now happen automatically each session and stay in the chosen mode regardless of environment variables.
