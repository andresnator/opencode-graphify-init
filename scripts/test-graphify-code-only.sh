#!/usr/bin/env bash
set -euo pipefail

# Resolve the installed CLI before replacing HOME/PATH. Every fixture, log, and output
# (including any Graphify temp/cache record) is rooted in the one disposable sandbox.
GRAPHIFY_BIN=$(command -v graphify || true)
[[ -n "$GRAPHIFY_BIN" && "$GRAPHIFY_BIN" == /* ]] || { echo 'FAIL: installed graphify CLI unavailable' >&2; exit 1; }
for tool in jq python3; do command -v "$tool" >/dev/null || exit 1; done
sandbox=$(mktemp -d "${TMPDIR:-/tmp}/graphify-code-only.XXXXXX")
sandbox=$(cd "$sandbox" && pwd -P)
mkdir -p "$sandbox/home" "$sandbox/cache" "$sandbox/config" "$sandbox/data" "$sandbox/tmp" "$sandbox/records" \
  "$sandbox/mixed" "$sandbox/second" "$sandbox/docs-only"
export HOME="$sandbox/home" XDG_CACHE_HOME="$sandbox/cache" XDG_CONFIG_HOME="$sandbox/config" \
  XDG_DATA_HOME="$sandbox/data" TMPDIR="$sandbox/tmp" GRAPHIFY_OUT=.ai/graphify-out
export PATH=/usr/bin:/bin

"$GRAPHIFY_BIN" --version >"$sandbox/records/version.txt"
grep -Eq '0\.9\.32' "$sandbox/records/version.txt" || { echo 'FAIL: Graphify 0.9.32 required' >&2; exit 1; }
cat >"$sandbox/mixed/module.py" <<'PY'
def hello(name):
    """Keep source docstrings intact."""
    return f"Hello {name}"
PY
printf '# Documentation\n\nThis page is not code.\n' >"$sandbox/mixed/guide.md"
printf 'def another():\n    return 42\n' >"$sandbox/second/module.py"
printf '# Documentation only\n' >"$sandbox/docs-only/guide.md"

"$GRAPHIFY_BIN" extract "$sandbox/mixed" --code-only >"$sandbox/records/initial.log" 2>&1
original="$sandbox/mixed/.ai/graphify-out/graph.json"
jq -e '.nodes | length > 0' "$original" >/dev/null || { echo 'FAIL: mixed corpus produced no code nodes' >&2; exit 1; }

# Simulate a legacy document node: incremental extraction retains it, so the plugin must
# remove graph.json (not just manifest.json) before its actual code-only migration.
python3 - "$original" <<'PY'
import json
from pathlib import Path
import sys
file = Path(sys.argv[1])
graph = json.loads(file.read_text())
graph['nodes'].append({'id': 'synthetic-old-document', 'type': 'document', 'label': 'Legacy docs'})
file.write_text(json.dumps(graph))
PY
"$GRAPHIFY_BIN" extract "$sandbox/mixed" --code-only >"$sandbox/records/incremental.log" 2>&1
jq -e 'any(.nodes[]; .id == "synthetic-old-document")' "$original" >/dev/null || {
  echo 'FAIL: incremental retention contract changed' >&2; exit 1;
}

GRAPHIFY_OUT=.ai/clean-code "$GRAPHIFY_BIN" extract "$sandbox/mixed" --code-only >"$sandbox/records/clean.log" 2>&1
clean="$sandbox/mixed/.ai/clean-code/graph.json"
jq -e '(.nodes | length > 0) and (any(.nodes[]; .id == "synthetic-old-document") | not)' "$clean" >/dev/null || {
  echo 'FAIL: clean extraction retained old document node' >&2; exit 1;
}
if "$GRAPHIFY_BIN" extract "$sandbox/docs-only" --code-only >"$sandbox/records/docs-only.log" 2>&1; then
  if [[ -f "$sandbox/docs-only/.ai/graphify-out/graph.json" ]]; then
    jq -e '.nodes | length == 0' "$sandbox/docs-only/.ai/graphify-out/graph.json" >/dev/null || exit 1
  fi
else
  grep -qi 'produced no nodes' "$sandbox/records/docs-only.log" || { echo 'FAIL: docs-only extract failed unexpectedly' >&2; exit 1; }
fi

"$GRAPHIFY_BIN" extract "$sandbox/second" --code-only >"$sandbox/records/second.log" 2>&1
"$GRAPHIFY_BIN" global add "$sandbox/second/.ai/graphify-out/graph.json" --as second >"$sandbox/records/second-add.log" 2>&1
"$GRAPHIFY_BIN" global add "$original" --as mixed >"$sandbox/records/old-add.log" 2>&1
jq -e --arg path "$original" '.repos.mixed.source_path == $path and .repos.second != null' \
  "$HOME/.graphify/global-manifest.json" >/dev/null || exit 1
"$GRAPHIFY_BIN" global add "$clean" --as mixed >"$sandbox/records/replace.log" 2>&1
jq -e --arg path "$clean" '.repos.mixed.source_path == $path and .repos.second != null' \
  "$HOME/.graphify/global-manifest.json" >/dev/null || { echo 'FAIL: replacement affected second repo' >&2; exit 1; }
if jq -e 'any(.nodes[]; (.id | tostring | contains("synthetic-old-document")))' \
  "$HOME/.graphify/global-graph.json" >/dev/null; then
  echo 'FAIL: global replacement retained synthetic legacy document' >&2; exit 1
fi
"$GRAPHIFY_BIN" global remove mixed >"$sandbox/records/remove.log" 2>&1
jq -e '.repos.mixed == null and .repos.second != null' "$HOME/.graphify/global-manifest.json" >/dev/null || {
  echo 'FAIL: removal affected second repo' >&2; exit 1;
}
echo 'PASS: isolated Graphify 0.9.32 code-only, empty, incremental, clean and scoped global contracts'
