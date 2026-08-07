#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOCAL_OPENCODE_BIN="$ROOT_DIR/node_modules/opencode-ai/bin/opencode.exe"
if [[ -z "${OPENCODE_BIN:-}" && -x "$LOCAL_OPENCODE_BIN" ]]; then
  # pnpm generates a non-exec shell shim in node_modules/.bin. Launch the package's
  # native binary directly so SERVER_PID remains the process that owns all extract children.
  OPENCODE_BIN="$LOCAL_OPENCODE_BIN"
elif [[ -z "${OPENCODE_BIN:-}" && -x "$ROOT_DIR/node_modules/.bin/opencode" ]]; then
  OPENCODE_BIN="$ROOT_DIR/node_modules/.bin/opencode"
else
  OPENCODE_BIN=${OPENCODE_BIN:-$(command -v opencode || true)}
fi
TEST_TIMEOUT_SECONDS=15
POLL_INTERVAL_SECONDS=0.1
PROCESS_TERMINATION_TIMEOUT_SECONDS=2
FAKE_NODE_COUNT=11
STALE_COMMIT=0000000000000000000000000000000000000000
INFO_DURATION_MS=5000
HINT_DURATION_MS=8000
RECOVERY_DURATION_MS=8000
INSTALL_HINT="uv tool install graphifyy (or pipx install graphifyy)"
# The plugin queues toasts until the first bus event or a fallback delay (real default 10s,
# because pre-subscription bus events never reach the TUI). The suite's SSE listener attaches
# right after boot, so a short fallback keeps every toast assertion fast; the two queue tests
# override this to pin each flush trigger separately.
TOAST_FLUSH_DELAY_MS_DEFAULT=200
TOAST_DELAY_MS=$TOAST_FLUSH_DELAY_MS_DEFAULT
# The extract time budget (real default 30 minutes, far past any honest run). Only the timeout
# test shrinks it; the sentinel launches with the variable truly absent everywhere else.
EXTRACT_TIMEOUT_MS="unset"

if [[ -z "$OPENCODE_BIN" ]]; then
  echo "FAIL: opencode is required (set OPENCODE_BIN to override)" >&2
  exit 1
fi

for command in curl git jq python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "FAIL: $command is required" >&2
    exit 1
  fi
done

SUITE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/graphify-init-test.XXXXXX")
SUITE_DIR=$(cd "$SUITE_DIR" && pwd -P)
# Fixture git commands must not read (or depend on) the developer's real git configuration:
# a global commit template, hooks path, or signing requirement would break the fixtures.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
HOME_DIR="$SUITE_DIR/home"
XDG_DIR="$SUITE_DIR/xdg"
XDG_DATA_DIR="$SUITE_DIR/xdg-data"
TARGET_DIR="$XDG_DIR/opencode"
FAKE_BIN_DIR="$SUITE_DIR/bin"
FAKE_LOG="$SUITE_DIR/graphify.log"
GLOBAL_GRAPH="$HOME_DIR/.graphify/global-graph.json"
SERVER_PID=""
LISTENER_PID=""
EVENTS_FILE=""
SERVER_LOG=""
PORT=""

terminate_pid() {
  local pid=$1
  local attempts=$((PROCESS_TERMINATION_TIMEOUT_SECONDS * 10))
  local attempt

  [[ "$pid" =~ ^[0-9]+$ ]] || return
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null || true
    return
  fi

  kill "$pid" 2>/dev/null || true
  for ((attempt = 0; attempt < attempts; attempt++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done

  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup_fake_builders() {
  local pid_file
  local state_dir
  local pid

  while IFS= read -r -d '' pid_file; do
    state_dir=$(dirname "$pid_file")
    pid=$(<"$pid_file")
    : >"$state_dir/release"
    terminate_pid "$pid"
  done < <(find "$SUITE_DIR/repos" -type f -path '*/.fake-graphify/build.pid' -print0 2>/dev/null)
}

cleanup_processes() {
  cleanup_fake_builders
  if [[ -n "$LISTENER_PID" ]]; then
    terminate_pid "$LISTENER_PID"
    LISTENER_PID=""
  fi
  if [[ -n "$SERVER_PID" ]]; then
    terminate_pid "$SERVER_PID"
    SERVER_PID=""
  fi
  cleanup_fake_builders
}

cleanup() {
  cleanup_processes
  rm -rf "$SUITE_DIR"
}
trap cleanup EXIT INT TERM

fail() {
  echo "FAIL: $*" >&2
  if [[ -n "$SERVER_LOG" && -f "$SERVER_LOG" ]]; then
    sed -n '1,160p' "$SERVER_LOG" >&2
  fi
  if [[ -f "$FAKE_LOG" ]]; then
    sed -n '1,160p' "$FAKE_LOG" >&2
  fi
  exit 1
}

wait_for_file() {
  local file=$1
  local attempts=$((TEST_TIMEOUT_SECONDS * 10))
  local attempt
  for ((attempt = 0; attempt < attempts; attempt++)); do
    [[ -e "$file" ]] && return 0
    sleep "$POLL_INTERVAL_SECONDS"
  done
  fail "timed out waiting for file $file"
}

wait_for_pattern() {
  local pattern=$1
  local file=$2
  local attempts=$((TEST_TIMEOUT_SECONDS * 10))
  local attempt
  for ((attempt = 0; attempt < attempts; attempt++)); do
    [[ -f "$file" ]] && grep -Fq "$pattern" "$file" && return 0
    sleep "$POLL_INTERVAL_SECONDS"
  done
  fail "timed out waiting for '$pattern' in $file"
}

wait_for_pid_exit() {
  local pid=$1
  local attempts=$((TEST_TIMEOUT_SECONDS * 10))
  local attempt
  for ((attempt = 0; attempt < attempts; attempt++)); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep "$POLL_INTERVAL_SECONDS"
  done
  fail "timed out waiting for pid $pid to exit"
}

assert_toast() {
  local message=$1
  local variant=$2
  local duration=$3
  local expected_count=${4:-1}

  if ! python3 - "$EVENTS_FILE" "$message" "$variant" "$duration" "$expected_count" <<'PY'
import json
import sys

events_file, expected_message, expected_variant, expected_duration, expected_count = sys.argv[1:]
toasts = []
with open(events_file, encoding="utf-8") as events:
    for line in events:
        if not line.startswith("data: "):
            continue
        try:
            event = json.loads(line.removeprefix("data: "))
        except json.JSONDecodeError:
            continue
        payload = event.get("payload", {})
        if payload.get("type") == "tui.toast.show":
            toasts.append(payload.get("properties", {}))

matches = [toast for toast in toasts if toast.get("message") == expected_message]
valid_matches = [
    toast
    for toast in matches
    if toast.get("variant") == expected_variant
    and toast.get("duration") == int(expected_duration)
]
if len(matches) != int(expected_count) or len(valid_matches) != int(expected_count):
    print(
        f"expected {expected_count} exact toast(s), found {len(matches)}; all toasts: {json.dumps(toasts)}",
        file=sys.stderr,
    )
    raise SystemExit(1)
PY
  then
    fail "toast contract mismatch for: $message"
  fi
}

assert_toast_message_pattern() {
  local message_pattern=$1
  local variant=$2
  local duration=$3
  local expected_count=${4:-1}

  if ! python3 - "$EVENTS_FILE" "$message_pattern" "$variant" "$duration" "$expected_count" <<'PY'
import json
import re
import sys

events_file, message_pattern, expected_variant, expected_duration, expected_count = sys.argv[1:]
toasts = []
with open(events_file, encoding="utf-8") as events:
    for line in events:
        if not line.startswith("data: "):
            continue
        try:
            event = json.loads(line.removeprefix("data: "))
        except json.JSONDecodeError:
            continue
        payload = event.get("payload", {})
        if payload.get("type") == "tui.toast.show":
            toasts.append(payload.get("properties", {}))

matches = [toast for toast in toasts if re.fullmatch(message_pattern, toast.get("message", ""))]
valid_matches = [
    toast
    for toast in matches
    if toast.get("variant") == expected_variant
    and toast.get("duration") == int(expected_duration)
]
if len(matches) != int(expected_count) or len(valid_matches) != int(expected_count):
    print(
        f"expected {expected_count} matching toast(s), found {len(matches)}; all toasts: {json.dumps(toasts)}",
        file=sys.stderr,
    )
    raise SystemExit(1)
PY
  then
    fail "toast contract mismatch for pattern: $message_pattern"
  fi
}

wait_for_url() {
  local url=$1
  local attempts=$((TEST_TIMEOUT_SECONDS * 10))
  local attempt
  for ((attempt = 0; attempt < attempts; attempt++)); do
    curl -fsS --max-time 1 "$url" >/dev/null 2>&1 && return 0
    sleep "$POLL_INTERVAL_SECONDS"
  done
  fail "timed out waiting for $url"
}

free_port() {
  python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

start_server() {
  local name=$1
  local autoinit=$2
  local path_value=$3
  local global_registry=${4:-unset}
  local docs_mode=${5:-unset}
  local docs_backend=${6:-unset}

  cleanup_processes
  PORT=$(free_port)
  EVENTS_FILE="$SUITE_DIR/$name.events"
  SERVER_LOG="$SUITE_DIR/$name.server.log"
  : >"$EVENTS_FILE"

  # The sentinel "unset" launches with OPENCODE_GRAPHIFY_AUTOINIT truly absent (env -u),
  # so an ambient value from the parent shell cannot leak in and mask default-on behavior.
  local -a autoinit_prefix
  if [[ "$autoinit" == unset ]]; then
    autoinit_prefix=(env -u OPENCODE_GRAPHIFY_AUTOINIT)
  else
    autoinit_prefix=(env "OPENCODE_GRAPHIFY_AUTOINIT=$autoinit")
  fi
  # Same sentinel handling for OPENCODE_GRAPHIFY_GLOBAL (global registration default-on).
  local -a global_prefix
  if [[ "$global_registry" == unset ]]; then
    global_prefix=(env -u OPENCODE_GRAPHIFY_GLOBAL)
  else
    global_prefix=(env "OPENCODE_GRAPHIFY_GLOBAL=$global_registry")
  fi
  # OPENCODE_GRAPHIFY_DOCS never decides refresh flags anymore (the per-repo mode file does);
  # it stays injectable so tests can prove the recorded decision beats the environment.
  # OPENCODE_GRAPHIFY_BACKEND is still read as the backend pin when the semantic-marker
  # fallback derives docs mode for a pre-command graph.
  local -a docs_prefix
  if [[ "$docs_mode" == unset ]]; then
    docs_prefix=(env -u OPENCODE_GRAPHIFY_DOCS)
  else
    docs_prefix=(env "OPENCODE_GRAPHIFY_DOCS=$docs_mode")
  fi
  local -a backend_prefix
  if [[ "$docs_backend" == unset ]]; then
    backend_prefix=(env -u OPENCODE_GRAPHIFY_BACKEND)
  else
    backend_prefix=(env "OPENCODE_GRAPHIFY_BACKEND=$docs_backend")
  fi
  # Same sentinel handling for the extract time budget: absent means the plugin's own default.
  local -a extract_timeout_prefix
  if [[ "$EXTRACT_TIMEOUT_MS" == unset ]]; then
    extract_timeout_prefix=(env -u OPENCODE_GRAPHIFY_EXTRACT_TIMEOUT_MS)
  else
    extract_timeout_prefix=(env "OPENCODE_GRAPHIFY_EXTRACT_TIMEOUT_MS=$EXTRACT_TIMEOUT_MS")
  fi

  HOME="$HOME_DIR" \
    XDG_CONFIG_HOME="$XDG_DIR" \
    XDG_DATA_HOME="$XDG_DATA_DIR" \
    PATH="$path_value" \
    FAKE_GRAPHIFY_LOG="$FAKE_LOG" \
    FAKE_GRAPHIFY_NODE_COUNT="$FAKE_NODE_COUNT" \
    OPENCODE_GRAPHIFY_TOAST_DELAY_MS="$TOAST_DELAY_MS" \
    "${autoinit_prefix[@]}" \
    "${global_prefix[@]}" \
    "${docs_prefix[@]}" \
    "${backend_prefix[@]}" \
    "${extract_timeout_prefix[@]}" \
    "$OPENCODE_BIN" serve --hostname 127.0.0.1 --port "$PORT" --print-logs --log-level ERROR \
    >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!

  wait_for_url "http://127.0.0.1:$PORT/global/health"
  curl -NsS --max-time 120 "http://127.0.0.1:$PORT/global/event" >"$EVENTS_FILE" 2>>"$SERVER_LOG" &
  LISTENER_PID=$!
  sleep 0.2
}

request_config() {
  local root=$1
  local output=$2
  curl -fsS --max-time 5 --get --data-urlencode "directory=$root" \
    "http://127.0.0.1:$PORT/config" >"$output"
  jq -e . "$output" >/dev/null
}

# Publishes a client-driven bus event (tui.toast.show) for the root's instance — the cue the
# plugin's event hook needs to flush queued toasts. A synthetic toast is the lightest such
# event: unlike session creation it needs no provider or model resolution, which hangs in
# this suite's hermetic HOME.
publish_client_event() {
  local root=$1
  local encoded_root
  encoded_root=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$root")
  curl -fsS --max-time 5 -X POST -H 'Content-Type: application/json' \
    -d '{"message":"suite client activity probe","variant":"info","duration":100}' \
    "http://127.0.0.1:$PORT/tui/show-toast?directory=$encoded_root" >/dev/null
}

git_init() {
  local root=$1
  git -C "$root" init -q
  git -C "$root" config user.email graphify-test@example.invalid
  git -C "$root" config user.name graphify-test
}

make_repo() {
  local name=$1
  local root="$SUITE_DIR/repos/$name"
  mkdir -p "$root"
  git_init "$root"
  printf '%s\n' "$root"
}

# A repository with one commit, so `git rev-parse HEAD` resolves and the plugin can
# compare it against the commit stamped into graph.json.
make_committed_repo() {
  local name=$1
  local root="$SUITE_DIR/repos/$name"
  mkdir -p "$root"
  git_init "$root"
  : >"$root/tracked"
  git -C "$root" add tracked
  git -C "$root" commit -qm initial
  printf '%s\n' "$root"
}

# Plant a graph.json as if Graphify had built it at $commit. "head" stamps the repo's
# current HEAD (fresh graph); any other value makes the graph stale.
plant_graph() {
  local root=$1
  local commit=$2
  local body=${3:-valid}

  mkdir -p "$root/.ai/graphify-out"
  if [[ "$commit" == head ]]; then
    commit=$(git -C "$root" rev-parse HEAD)
  fi
  if [[ "$body" == corrupt ]]; then
    printf '{"nodes": [ truncated\n' >"$root/.ai/graphify-out/graph.json"
    return
  fi
  python3 - "$root/.ai/graphify-out/graph.json" "$commit" "$FAKE_NODE_COUNT" <<'PY'
import json
import sys

target, commit, count = sys.argv[1:]
graph = {"nodes": [{"id": f"n{i}"} for i in range(int(count))], "links": []}
if commit:
    graph["built_at_commit"] = commit
with open(target, "w", encoding="utf-8") as handle:
    json.dump(graph, handle)
PY
}

# Plant the human consent record written by /graphify-index: its presence is what authorizes
# the plugin to (re)build this repository; its content decides the refresh flags.
plant_mode() {
  local root=$1
  local mode=$2
  local backend=${3:-}
  mkdir -p "$root/.ai/graphify-out"
  if [[ -n "$backend" ]]; then
    printf '{"mode":"%s","backend":"%s"}\n' "$mode" "$backend" >"$root/.ai/graphify-out/.opencode-index-mode"
  else
    printf '{"mode":"%s"}\n' "$mode" >"$root/.ai/graphify-out/.opencode-index-mode"
  fi
}

# Plant the marker real Graphify writes only when a semantic (LLM) docs pass spent tokens:
# the fallback signal for graphs indexed before the mode file existed.
plant_semantic_marker() {
  local root=$1
  mkdir -p "$root/.ai/graphify-out"
  : >"$root/.ai/graphify-out/.graphify_semantic_marker"
}

assert_mode_file() {
  local root=$1
  local expected=$2
  local mode_file="$root/.ai/graphify-out/.opencode-index-mode"
  [[ -f "$mode_file" ]] || fail "index-mode file missing for $root"
  [[ "$(jq -c . "$mode_file")" == "$expected" ]] ||
    fail "index-mode mismatch for $root: expected $expected, found $(cat "$mode_file")"
}

make_linked_worktree() {
  local name=$1
  local primary="$SUITE_DIR/repos/$name-primary"
  local worktree="$SUITE_DIR/repos/$name"
  mkdir -p "$primary"
  git_init "$primary"
  : >"$primary/tracked"
  git -C "$primary" add tracked
  git -C "$primary" commit -qm initial
  git -C "$primary" worktree add -qb "$name-branch" "$worktree"
  printf '%s\n' "$worktree"
}

hold_builds() {
  local root=$1
  mkdir -p "$root/.fake-graphify"
  : >"$root/.fake-graphify/hold"
}

release_builds() {
  local root=$1
  : >"$root/.fake-graphify/release"
}

count_calls() {
  local prefix=$1
  if [[ ! -f "$FAKE_LOG" ]]; then
    printf '0\n'
    return
  fi
  grep -Fc "$prefix" "$FAKE_LOG" || true
}

count_extract_calls() {
  count_calls "extract|$1|"
}

count_global_add_calls() {
  count_calls "global-add|$1/.ai/graphify-out/graph.json|"
}

log_size() {
  local size=0
  [[ -f "$FAKE_LOG" ]] && size=$(wc -c <"$FAKE_LOG" | tr -d ' ')
  printf '%s\n' "$size"
}

mkdir -p "$HOME_DIR" "$TARGET_DIR" "$FAKE_BIN_DIR" "$SUITE_DIR/repos"

cat >"$FAKE_BIN_DIR/graphify" <<'FAKE_GRAPHIFY'
#!/usr/bin/env bash
set -euo pipefail

command_name=${1:-}

register_global() {
  local tag=$1
  local graph=$2
  mkdir -p "$HOME/.graphify"
  printf '%s %s\n' "$tag" "$graph" >>"$HOME/.graphify/global-graph.json"
}

write_graph() {
  local root=$1
  local out_dir=$2
  local head
  head=$(git -C "$root" rev-parse HEAD 2>/dev/null || printf '')
  mkdir -p "$out_dir"
  python3 - "$out_dir/graph.json" "$head" "${FAKE_GRAPHIFY_NODE_COUNT:-11}" <<'PY'
import json
import sys

target, commit, count = sys.argv[1:]
graph = {"nodes": [{"id": f"n{i}"} for i in range(int(count))], "links": []}
if commit:
    graph["built_at_commit"] = commit
with open(target, "w", encoding="utf-8") as handle:
    json.dump(graph, handle)
PY
}

case "$command_name" in
  --version)
    printf 'version||%s\n' "$*" >>"$FAKE_GRAPHIFY_LOG"
    printf 'graphify 0.0.0-fake\n'
    ;;
  global)
    # global add <graph.json> --as <tag>
    printf 'global-add|%s|%s\n' "${3:-}" "${5:-}" >>"$FAKE_GRAPHIFY_LOG"
    [[ "${2:-}" == add ]] || { echo "unexpected global subcommand: ${2:-}" >&2; exit 64; }
    register_global "${5:-}" "${3:-}"
    ;;
  extract)
    root=${2:-$PWD}
    repo_name=$(basename "$root")
    state_dir="$root/.fake-graphify"
    mkdir -p "$state_dir"
    printf '%s|%s|%s\n' "$command_name" "$root" "$*" >>"$FAKE_GRAPHIFY_LOG"
    # Record the inherited GRAPHIFY_OUT so tests can assert the plugin exported it: it is
    # what makes the MCP server resolve a project_path query to the same relocated graph.
    printf 'env|%s|%s\n' "$command_name" "${GRAPHIFY_OUT-<unset>}" >>"$FAKE_GRAPHIFY_LOG"

    # GRAPHIFY_OUT relocates the whole output tree, relative to the indexed root, exactly
    # as the real CLI resolves it. Unset means the CLI default at the repository root.
    out_dir="$root/${GRAPHIFY_OUT:-graphify-out}"
    global_tag=""
    previous=""
    for argument in "$@"; do
      [[ "$previous" == --as ]] && global_tag=$argument
      previous=$argument
    done

    if [[ "$repo_name" == build-fail-repo || "$repo_name" == refresh-fail-repo ]]; then
      echo "synthetic extract failure" >&2
      exit 9
    fi
    # A docs-mode run that dies on backend credentials AFTER the census line: the census
    # reports "0 code, 1 docs" but this is a fixable failure, never an empty corpus.
    if [[ "$repo_name" == credential-fail-repo ]]; then
      printf '[graphify extract] found 0 code, 1 docs, 0 papers, 0 images\n'
      echo "[graphify extract] error: backend 'zen' rejected the request: invalid API key" >&2
      exit 1
    fi
    # Real Graphify reports a corpus with nothing to index as a failure (exit 1), both on a
    # first build and on a refresh after every code file was deleted — in the refresh case it
    # leaves the previous graph on disk untouched. Any *-nocode repository behaves the same,
    # so aggregate fixtures can hold several empty repositories without new arms here.
    # regrow-repo is empty only until a code file appears, then builds normally.
    # The census deliberately reports NONZERO docs: a docs-only repository has documents, and
    # classification must key on the end-of-run "produced no nodes" line, not on the census.
    if [[ "$repo_name" == docs-only-repo || "$repo_name" == shrink-empty-repo || "$repo_name" == *-nocode ]] ||
      [[ "$repo_name" == regrow-repo && ! -f "$root/code.py" ]]; then
      printf '[graphify extract] found 0 code, 2 docs, 0 papers, 0 images\n'
      echo "[graphify extract] graph is empty — extraction produced no nodes." >&2
      exit 1
    fi
    # noisy-empty-repo buries the empty-corpus signal behind kilobytes of progress output on
    # BOTH streams: only a consumer that keeps each stream's tail can still classify it.
    if [[ "$repo_name" == noisy-empty-repo ]]; then
      for line_number in $(seq 1 60); do
        printf '[graphify extract] scanning some/deeply/nested/path/module-%03d.py ... parsed, 0 symbols\n' "$line_number"
        printf '[graphify extract] warning: some/deeply/nested/path/module-%03d.py matched no code language\n' "$line_number" >&2
      done
      printf '[graphify extract] found 0 code, 2 docs, 0 papers, 0 images\n'
      echo "[graphify extract] graph is empty — extraction produced no nodes." >&2
      exit 1
    fi

    # Tests that need to observe an in-flight build pre-create the hold marker; every
    # other repository builds straight through so the common cases stay simple.
    if [[ -f "$state_dir/hold" ]]; then
      printf '%s\n' "$$" >"$state_dir/build.pid"
      trap 'rm -f "$state_dir/build.pid"' EXIT
      : >"$state_dir/build-started"
      until [[ -f "$state_dir/release" ]]; do
        sleep 0.05
      done
    else
      : >"$state_dir/build-started"
    fi

    # head-race-repo lands a commit mid-run, once: like real Graphify, write_graph stamps
    # the HEAD read at export time, so the first graph carries new-HEAD over old content.
    if [[ "$repo_name" == head-race-repo && ! -f "$state_dir/raced" ]]; then
      : >"$state_dir/raced"
      : >"$root/landed-mid-extract.py"
      git -C "$root" add landed-mid-extract.py
      git -C "$root" commit -qm mid-extract
    fi

    # incomplete-repo exits 0 without ever producing a readable graph;
    # zero-node-repo exits 0 with a graph holding no nodes.
    if [[ "$repo_name" != incomplete-repo ]]; then
      if [[ "$repo_name" == zero-node-repo ]]; then
        FAKE_GRAPHIFY_NODE_COUNT=0 write_graph "$root" "$out_dir"
      else
        write_graph "$root" "$out_dir"
      fi
      # `extract --global --as <tag>` merges into the global graph in the same call.
      # global-warn-repo reproduces Graphify 0.9.28 swallowing a failed merge: the
      # warning goes to stderr and the run still exits 0.
      if [[ " $* " == *" --global "* && -n "$global_tag" ]]; then
        if [[ "$repo_name" == global-warn-repo ]]; then
          echo "[graphify global] warning: failed to merge into global graph: synthetic merge failure" >&2
        else
          register_global "$global_tag" "$out_dir/graph.json"
        fi
      fi
    fi
    : >"$state_dir/build-finished"
    ;;
  *)
    printf 'unexpected|%s|%s\n' "$command_name" "$*" >>"$FAKE_GRAPHIFY_LOG"
    echo "unexpected fake Graphify command: $command_name" >&2
    exit 64
    ;;
esac
FAKE_GRAPHIFY
chmod +x "$FAKE_BIN_DIR/graphify"

mkdir -p "$TARGET_DIR"
jq -n --arg plugin "file://$ROOT_DIR/src/server.ts" '{plugin: [$plugin]}' > "$TARGET_DIR/opencode.json"

shouldKeepConfigResponsiveWhileBuildingInBackground() {
  # Given standing consent (mode file) with no graph yet: exactly what a deleted or
  # never-completed first pass leaves behind — the plugin rebuilds automatically.
  local root
  local response="$SUITE_DIR/background.config.json"
  root=$(make_committed_repo success-repo)
  plant_mode "$root" code-only
  hold_builds "$root"
  start_server background 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$response"

  # Then
  wait_for_file "$root/.fake-graphify/build-started"
  [[ ! -e "$root/.fake-graphify/build-finished" ]] || fail "fake build completed before release"
  wait_for_pattern "Graphify is building the code graph for success-repo in the background." "$EVENTS_FILE"
  assert_toast \
    "Graphify is building the code graph for success-repo in the background. You can keep working." \
    info \
    "$INFO_DURATION_MS"

  release_builds "$root"
  wait_for_file "$root/.fake-graphify/build-finished"
  wait_for_pattern "Graphify graph for success-repo is ready: $FAKE_NODE_COUNT nodes" "$EVENTS_FILE"
  assert_toast_message_pattern \
    "Graphify graph for success-repo is ready: $FAKE_NODE_COUNT nodes in [0-9]+\\.[0-9]s\\." \
    success \
    "$INFO_DURATION_MS"
  grep -Fxq '.ai/graphify-out' "$root/.git/info/exclude" || fail "graph output was not Git-excluded"
  [[ $(count_extract_calls "$root") -eq 1 ]] || fail "expected one extract call for background case"
  # A fresh extract relocates output under .ai/ and registers the repo globally inline.
  grep -Fxq "extract|$root|extract $root --code-only --global --as success-repo" "$FAKE_LOG" ||
    fail "extract did not request a relocated code-only build merged into the global graph"
  # The relocation travels as GRAPHIFY_OUT, not --out: only the env var is also read by the
  # MCP server when it resolves a project_path query, so writer and reader stay in agreement.
  grep -Fxq 'env|extract|.ai/graphify-out' "$FAKE_LOG" ||
    fail "extract did not inherit GRAPHIFY_OUT=.ai/graphify-out"
  ! grep -Fq -- '--out' "$FAKE_LOG" || fail "extract still passes the --out flag, which double-nests under GRAPHIFY_OUT"
  [[ -f "$root/.ai/graphify-out/graph.json" ]] || fail "graph was not written under .ai/"
  [[ ! -e "$root/graphify-out" ]] || fail "a root-level graphify-out/ leaked outside .ai/"
  # The extract lock lives only as long as the extract, and the consent record round-trips.
  [[ ! -e "$root/.ai/graphify-out/.opencode-extract-lock" ]] || fail "extract lock was left behind"
  assert_mode_file "$root" '{"mode":"code-only"}'
  cleanup_processes
}

shouldStaySilentWhenGraphMatchesHeadCommit() {
  # Given a graph stamped with the repository's current HEAD.
  local root
  local size_before
  root=$(make_committed_repo fresh-graph-repo)
  plant_graph "$root" head
  size_before=$(log_size)
  start_server fresh-graph 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/fresh-graph.config.json"
  sleep 1

  # Then: planning is local, so an up-to-date repository never even probes the binary.
  [[ $(log_size) -eq "$size_before" ]] || fail "fresh graph still invoked Graphify"
  ! grep -Fq '"type":"tui.toast.show"' "$EVENTS_FILE" || fail "fresh graph emitted a toast"
  cleanup_processes
}

shouldHintOncePerSessionInsteadOfFirstIndexing() {
  # Given a repository that has never been through /graphify-index: no graph, no mode file.
  local root
  local size_before
  root=$(make_committed_repo unindexed-repo)
  size_before=$(log_size)
  start_server unindexed 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/unindexed.config.json"

  # Then: one informative hint, zero Graphify processes (not even the version probe), and
  # no state written — first indexing belongs to the human-run command.
  wait_for_pattern "No Graphify graph exists for unindexed-repo yet." "$EVENTS_FILE"
  assert_toast \
    "No Graphify graph exists for unindexed-repo yet. Run /graphify-index to build one: code-only takes seconds; docs mode takes minutes and spends LLM tokens. Refreshes after that are incremental and automatic." \
    info \
    "$HINT_DURATION_MS"
  [[ $(log_size) -eq "$size_before" ]] || fail "consentless repository still invoked Graphify"
  [[ ! -e "$root/.ai" ]] || fail "the hint created graph state"
  cleanup_processes
}

shouldQueueToastsUntilFirstBusEvent() {
  # Given a fallback delay far beyond the test window: only client activity can flush.
  local root
  root=$(make_committed_repo queue-until-event-repo)
  TOAST_DELAY_MS=60000
  start_server queue-until-event 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  TOAST_DELAY_MS=$TOAST_FLUSH_DELAY_MS_DEFAULT

  # When: the plugin scans and queues its hint, but no client has interacted yet.
  request_config "$root" "$SUITE_DIR/queue-until-event.config.json"
  sleep 1

  # Then: nothing surfaces until the first bus event, which releases the queued hint.
  ! grep -Fq '"type":"tui.toast.show"' "$EVENTS_FILE" || fail "toast surfaced before any client activity"
  publish_client_event "$root"
  wait_for_pattern "No Graphify graph exists for queue-until-event-repo yet." "$EVENTS_FILE"
  cleanup_processes
}

shouldFlushQueuedToastsAfterFallbackDelay() {
  # Given a fallback delay long enough to observe the queue, short enough to wait out.
  local root
  root=$(make_committed_repo queue-fallback-repo)
  TOAST_DELAY_MS=3000
  start_server queue-fallback 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  TOAST_DELAY_MS=$TOAST_FLUSH_DELAY_MS_DEFAULT

  # When: no client ever interacts with the session.
  request_config "$root" "$SUITE_DIR/queue-fallback.config.json"
  sleep 1

  # Then: the hint stays queued during the delay and surfaces on its own after it — the
  # user who opens a TUI and just looks at the home screen still gets the hint.
  ! grep -Fq '"type":"tui.toast.show"' "$EVENTS_FILE" || fail "toast surfaced before the fallback delay"
  wait_for_pattern "No Graphify graph exists for queue-fallback-repo yet." "$EVENTS_FILE"
  cleanup_processes
}

shouldAggregateHintWhenNestedRepositoriesHaveNoConsent() {
  # Given a plain workspace whose nested repositories were never indexed.
  local aggregate_root="$SUITE_DIR/repos/aggregate-hint-root"
  local repo_a="$aggregate_root/gitlab/hint-a"
  local repo_b="$aggregate_root/gitlab/hint-b"
  local size_before
  mkdir -p "$repo_a" "$repo_b"
  git_init "$repo_a"
  git_init "$repo_b"
  size_before=$(log_size)
  start_server aggregate-hint 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$aggregate_root" "$SUITE_DIR/aggregate-hint.config.json"

  # Then: exactly one aggregate hint, zero extracts, no per-repo hints.
  wait_for_pattern "2 repositories under aggregate-hint-root have no Graphify graph yet." "$EVENTS_FILE"
  assert_toast \
    "2 repositories under aggregate-hint-root have no Graphify graph yet. Run /graphify-index from aggregate-hint-root to build them; refreshes after that are incremental and automatic." \
    info \
    "$HINT_DURATION_MS"
  [[ $(log_size) -eq "$size_before" ]] || fail "consentless aggregate still invoked Graphify"
  ! grep -Fq "No Graphify graph exists for" "$EVENTS_FILE" || fail "aggregate emitted a per-repo hint"
  cleanup_processes
}

shouldRefreshStaleGraphWithIncrementalExtract() {
  # Given a stale graph with NO mode file and NO semantic marker: the fallback derivation
  # must classify this legacy graph as code-only.
  local root
  root=$(make_committed_repo stale-graph-repo)
  plant_graph "$root" "$STALE_COMMIT"
  start_server stale-graph 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/stale-graph.config.json"

  # Then: the refresh is one relocated extract call — extract is natively incremental,
  # and `graphify update` (which cannot honour --out) must never run.
  wait_for_pattern "Graphify is updating the stale-graph-repo code graph in the background." "$EVENTS_FILE"
  assert_toast \
    "Graphify is updating the stale-graph-repo code graph in the background. You can keep working." \
    info \
    "$INFO_DURATION_MS"
  wait_for_pattern "Graphify graph for stale-graph-repo is ready: $FAKE_NODE_COUNT nodes" "$EVENTS_FILE"
  [[ $(count_extract_calls "$root") -eq 1 ]] || fail "stale graph was not refreshed by exactly one extract"
  grep -Fxq "extract|$root|extract $root --code-only --global --as stale-graph-repo" "$FAKE_LOG" ||
    fail "refresh did not run as a relocated code-only extract with inline global merge"
  # The inline --global merge replaces the old standalone `global add` step entirely.
  [[ $(count_global_add_calls "$root") -eq 0 ]] || fail "refresh still used a standalone global add"
  grep -Fq "stale-graph-repo $root/.ai/graphify-out/graph.json" "$GLOBAL_GRAPH" ||
    fail "refreshed graph was not re-registered globally"
  [[ ! -e "$root/graphify-out" ]] || fail "refresh recreated a root-level graphify-out/"
  # The fallback-derived decision is persisted, migrating the legacy repo off the derivation.
  assert_mode_file "$root" '{"mode":"code-only"}'
  cleanup_processes
}

shouldReExtractWhenCommitLandsMidExtract() {
  # Given standing consent for a repository where a commit lands while the extract runs:
  # real Graphify stamps built_at_commit at export time, after scanning, so the first
  # graph carries the new HEAD over content read from the old tree.
  local root
  root=$(make_committed_repo head-race-repo)
  plant_mode "$root" code-only
  start_server head-race 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/head-race.config.json"

  # Then: the plugin detects the moved HEAD and runs exactly one incremental re-extract,
  # ending with a graph honestly stamped at the commit whose content it read.
  wait_for_pattern "Graphify graph for head-race-repo is ready" "$EVENTS_FILE"
  [[ $(count_extract_calls "$root") -eq 2 ]] || fail "mid-extract commit did not trigger a re-extract"
  [[ "$(jq -r .built_at_commit "$root/.ai/graphify-out/graph.json")" == "$(git -C "$root" rev-parse HEAD)" ]] ||
    fail "final graph is not stamped at the current HEAD"
  cleanup_processes
}

shouldRefreshCodeOnlyDespiteAmbientDocsEnvironment() {
  # Given a stale code-only graph while the shell exports docs-mode variables: the recorded
  # per-repo decision must win over the environment on every refresh.
  local root
  root=$(make_committed_repo env-loses-repo)
  plant_graph "$root" "$STALE_COMMIT"
  plant_mode "$root" code-only
  start_server env-loses 1 "$FAKE_BIN_DIR:/usr/bin:/bin" unset 1 opencode

  # When
  request_config "$root" "$SUITE_DIR/env-loses.config.json"

  # Then
  wait_for_pattern "Graphify graph for env-loses-repo is ready" "$EVENTS_FILE"
  grep -Fxq "extract|$root|extract $root --code-only --global --as env-loses-repo" "$FAKE_LOG" ||
    fail "ambient docs environment overrode the recorded code-only mode"
  cleanup_processes
}

shouldRefreshWithDocsBackendWhenModeFileRecordsDocs() {
  # Given a stale graph whose mode file records the docs decision with a pinned backend.
  local root
  root=$(make_committed_repo docs-refresh-repo)
  plant_graph "$root" "$STALE_COMMIT"
  plant_mode "$root" docs zen
  start_server docs-refresh 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/docs-refresh.config.json"

  # Then the refresh keeps the docs pass and the recorded backend, without any env help.
  wait_for_pattern "Graphify graph for docs-refresh-repo is ready" "$EVENTS_FILE"
  grep -Fxq "extract|$root|extract $root --backend zen --global --as docs-refresh-repo" "$FAKE_LOG" ||
    fail "docs refresh did not honour the recorded backend"
  cleanup_processes
}

shouldDeriveDocsRefreshFromSemanticMarkerWhenModeFileIsAbsent() {
  # Given a pre-command docs graph: stale, no mode file, but the semantic marker Graphify
  # writes when an LLM pass spent tokens. The backend pin comes from the same env var that
  # built the graph, so credentials keep routing to the original backend.
  local root
  root=$(make_committed_repo legacy-docs-repo)
  plant_graph "$root" "$STALE_COMMIT"
  plant_semantic_marker "$root"
  start_server legacy-docs 1 "$FAKE_BIN_DIR:/usr/bin:/bin" unset unset opencode

  # When
  request_config "$root" "$SUITE_DIR/legacy-docs.config.json"

  # Then the refresh runs in docs mode and the derived decision is persisted.
  wait_for_pattern "Graphify graph for legacy-docs-repo is ready" "$EVENTS_FILE"
  grep -Fxq "extract|$root|extract $root --backend opencode --global --as legacy-docs-repo" "$FAKE_LOG" ||
    fail "semantic marker did not derive a docs refresh"
  assert_mode_file "$root" '{"mode":"docs","backend":"opencode"}'
  cleanup_processes
}

shouldRebuildWhenGraphFileIsUnreadable() {
  # Given a truncated graph.json next to a mode file: worse than no graph, and the recorded
  # consent authorizes the automatic full rebuild.
  local root
  root=$(make_committed_repo corrupt-graph-repo)
  plant_graph "$root" head corrupt
  plant_mode "$root" code-only
  start_server corrupt-graph 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/corrupt-graph.config.json"

  # Then
  wait_for_pattern "Graphify graph for corrupt-graph-repo is ready" "$EVENTS_FILE"
  [[ $(count_extract_calls "$root") -eq 1 ]] || fail "corrupt graph was not rebuilt from scratch"
  cleanup_processes
}

shouldKeepExistingGraphWhenRepositoryHasNoCommits() {
  # Given a repository with a graph but no HEAD to compare against.
  local root
  local size_before
  root=$(make_repo uncommitted-repo)
  plant_graph "$root" ""
  size_before=$(log_size)
  start_server uncommitted 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/uncommitted.config.json"
  sleep 1

  # Then: no commit signal means no evidence of staleness, so the graph is left alone.
  [[ $(log_size) -eq "$size_before" ]] || fail "repository without commits triggered a rebuild"
  ! grep -Fq '"type":"tui.toast.show"' "$EVENTS_FILE" || fail "repository without commits emitted a toast"
  cleanup_processes
}

shouldToastErrorWhenBuildFails() {
  # Given standing consent for a repository whose extract will fail.
  local root
  root=$(make_committed_repo build-fail-repo)
  plant_mode "$root" code-only
  start_server build-fail 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/build-fail.config.json"

  # Then
  wait_for_pattern "Graphify indexing failed for build-fail-repo, but this session is still operational." "$EVENTS_FILE"
  assert_toast \
    "Graphify indexing failed for build-fail-repo, but this session is still operational. Run: GRAPHIFY_OUT=.ai/graphify-out graphify extract '$root' --code-only" \
    error \
    "$RECOVERY_DURATION_MS"
  [[ $(count_global_add_calls "$root") -eq 0 ]] || fail "failed build was registered globally"
  cleanup_processes
}

shouldToastErrorWhenRefreshFails() {
  # Given a stale graph whose refreshing extract will fail.
  local root
  root=$(make_committed_repo refresh-fail-repo)
  plant_graph "$root" "$STALE_COMMIT"
  start_server refresh-fail 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/refresh-fail.config.json"

  # Then: recovery advertises the manual rebuild, and nothing is registered globally.
  wait_for_pattern "Graphify is updating the refresh-fail-repo code graph in the background." "$EVENTS_FILE"
  wait_for_pattern "Graphify indexing failed for refresh-fail-repo, but this session is still operational." "$EVENTS_FILE"
  assert_toast \
    "Graphify indexing failed for refresh-fail-repo, but this session is still operational. Run: GRAPHIFY_OUT=.ai/graphify-out graphify extract '$root' --code-only" \
    error \
    "$RECOVERY_DURATION_MS"
  [[ $(count_extract_calls "$root") -eq 1 ]] || fail "expected exactly one refresh attempt"
  ! grep -Fq "refresh-fail-repo " "$GLOBAL_GRAPH" 2>/dev/null || fail "failed refresh was registered globally"
  cleanup_processes
}

shouldReportEmptyWhenRepositoryLosesAllCode() {
  # Given a stale graph in a repository whose code was since all deleted: real Graphify
  # reports the refreshing extract as an empty corpus (exit 1) and leaves the old graph
  # on disk with its stale stamp.
  local root
  root=$(make_committed_repo shrink-empty-repo)
  plant_graph "$root" "$STALE_COMMIT"
  start_server shrink-empty 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/shrink-empty.config.json"

  # Then: the shrink is information, not a success, and stays out of the global graph.
  wait_for_pattern "Graphify found no indexable code in shrink-empty-repo" "$EVENTS_FILE"
  assert_toast \
    "Graphify found no indexable code in shrink-empty-repo; skipping the code graph." \
    info \
    "$INFO_DURATION_MS"
  ! grep -Fq '"variant":"success"' "$EVENTS_FILE" || fail "shrunk repository produced a success toast"
  ! grep -Fq '"variant":"error"' "$EVENTS_FILE" || fail "shrunk repository produced an error toast"
  ! grep -Fq "shrink-empty-repo " "$GLOBAL_GRAPH" 2>/dev/null || fail "shrunk repository was registered globally"
  [[ -f "$root/.ai/graphify-out/.opencode-empty-corpus" ]] || fail "empty-corpus marker was not recorded"
  [[ -f "$root/.ai/graphify-out/graph.json" ]] || fail "shrink unexpectedly deleted the previous graph"

  # And reopening stays silent even though the stale-stamped graph is still on disk:
  # the empty-corpus marker wins, so the shrunk repo is not retried every session.
  start_server shrink-empty-reopen 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  request_config "$root" "$SUITE_DIR/shrink-empty-reopen.config.json"
  sleep 1
  [[ $(count_extract_calls "$root") -eq 1 ]] || fail "shrunk repository was retried on reopen"
  ! grep -Fq '"type":"tui.toast.show"' "$EVENTS_FILE" || fail "reopened shrunk repository emitted a toast"
  cleanup_processes
}

shouldReportEmptyWhenBuildProducesZeroNodeGraph() {
  # Given a repository whose extract exits zero yet writes a graph holding no nodes —
  # not observed from the real binary, but the plugin guards it defensively.
  local root
  root=$(make_committed_repo zero-node-repo)
  plant_mode "$root" code-only
  start_server zero-node 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/zero-node.config.json"

  # Then: an empty graph is reported as information, never celebrated as a success —
  # and unlike the exit-1 empty corpus, a graph WAS written, so nothing is "skipped".
  wait_for_pattern "Graphify found no indexable code left in zero-node-repo" "$EVENTS_FILE"
  assert_toast \
    "Graphify found no indexable code left in zero-node-repo; the graph is now empty." \
    info \
    "$INFO_DURATION_MS"
  ! grep -Fq '"variant":"success"' "$EVENTS_FILE" || fail "0-node graph produced a success toast"

  # No marker is needed here: the 0-node graph carries a fresh built_at_commit stamp,
  # so reopening the same commit is already silent.
  start_server zero-node-reopen 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  request_config "$root" "$SUITE_DIR/zero-node-reopen.config.json"
  sleep 1
  [[ $(count_extract_calls "$root") -eq 1 ]] || fail "0-node repository was rebuilt on reopen"
  ! grep -Fq '"type":"tui.toast.show"' "$EVENTS_FILE" || fail "reopened 0-node repository emitted a toast"
  cleanup_processes
}

shouldWarnWhenGraphIsMissingAfterSuccessfulBuild() {
  # Given a build that exits zero but never produces a readable graph.
  local root
  root=$(make_committed_repo incomplete-repo)
  plant_mode "$root" code-only
  start_server incomplete 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/incomplete.config.json"

  # Then
  wait_for_pattern "Graphify graph for incomplete-repo is incomplete" "$EVENTS_FILE"
  assert_toast \
    "Graphify graph for incomplete-repo is incomplete (.ai/graphify-out/graph.json is missing or unreadable). Run: GRAPHIFY_OUT=.ai/graphify-out graphify extract '$root' --code-only" \
    warning \
    "$RECOVERY_DURATION_MS"
  cleanup_processes
}

shouldNotRetryARepositoryWithNothingToIndex() {
  # Given a consented repository holding no code Graphify can index.
  local root
  local calls_after_first
  root=$(make_committed_repo docs-only-repo)
  plant_mode "$root" code-only
  start_server docs-only 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/docs-only.config.json"

  # Then the empty result is reported once, as information rather than as a failure.
  wait_for_pattern "Graphify found no indexable code in docs-only-repo" "$EVENTS_FILE"
  assert_toast \
    "Graphify found no indexable code in docs-only-repo; skipping the code graph." \
    info \
    "$INFO_DURATION_MS"
  ! grep -Fq '"variant":"error"' "$EVENTS_FILE" || fail "empty repository produced an error toast"
  [[ -f "$root/.ai/graphify-out/.opencode-empty-corpus" ]] || fail "empty-corpus marker was not recorded"
  calls_after_first=$(count_extract_calls "$root")

  # And reopening the same commit stays silent instead of rebuilding forever.
  start_server docs-only-reopen 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  request_config "$root" "$SUITE_DIR/docs-only-reopen.config.json"
  sleep 1
  [[ $(count_extract_calls "$root") -eq "$calls_after_first" ]] || fail "empty repository was retried on reopen"
  ! grep -Fq '"type":"tui.toast.show"' "$EVENTS_FILE" || fail "reopened empty repository emitted a toast"

  # And a new commit earns a fresh attempt.
  : >"$root/added"
  git -C "$root" add added
  git -C "$root" commit -qm "add a file"
  start_server docs-only-newcommit 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  request_config "$root" "$SUITE_DIR/docs-only-newcommit.config.json"
  wait_for_pattern "Graphify found no indexable code in docs-only-repo" "$EVENTS_FILE"
  [[ $(count_extract_calls "$root") -gt "$calls_after_first" ]] || fail "new commit did not earn a fresh attempt"
  cleanup_processes
}

shouldRecordSentinelMarkerForEmptyRootWithoutHead() {
  # Given a consented plain directory (no git, no nested repositories) with nothing to index:
  # `git rev-parse HEAD` resolves nothing, so the marker must fall back to its sentinel
  # instead of being skipped — skipping it would re-extract and re-toast every session.
  local root="$SUITE_DIR/repos/plain-nocode"
  mkdir -p "$root"
  : >"$root/README.md"
  plant_mode "$root" code-only
  start_server plain-nocode 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/plain-nocode.config.json"

  # Then: reported once as information, with the sentinel recorded in the marker.
  wait_for_pattern "Graphify found no indexable code in plain-nocode" "$EVENTS_FILE"
  assert_toast \
    "Graphify found no indexable code in plain-nocode; skipping the code graph." \
    info \
    "$INFO_DURATION_MS"
  [[ -f "$root/.ai/graphify-out/.opencode-empty-corpus" ]] || fail "HEAD-less empty root did not record a marker"
  grep -Fxq none "$root/.ai/graphify-out/.opencode-empty-corpus" || fail "HEAD-less marker does not hold the sentinel"

  # And reopening stays silent instead of retrying the same empty corpus forever.
  start_server plain-nocode-reopen 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  request_config "$root" "$SUITE_DIR/plain-nocode-reopen.config.json"
  sleep 1
  [[ $(count_extract_calls "$root") -eq 1 ]] || fail "HEAD-less empty root was retried on reopen"
  ! grep -Fq '"type":"tui.toast.show"' "$EVENTS_FILE" || fail "reopened HEAD-less empty root emitted a toast"
  cleanup_processes
}

shouldClassifyEmptyCorpusBehindVerboseOutput() {
  # Given an extract that buries the empty-corpus signal behind kilobytes of progress
  # output on both streams; only the stream TAILS reveal the classification, so a
  # head-truncating capture would misread this as a hard failure and retry forever.
  local root
  root=$(make_committed_repo noisy-empty-repo)
  plant_mode "$root" code-only
  start_server noisy-empty 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/noisy-empty.config.json"

  # Then: still classified as information, never as a failure.
  wait_for_pattern "Graphify found no indexable code in noisy-empty-repo" "$EVENTS_FILE"
  assert_toast \
    "Graphify found no indexable code in noisy-empty-repo; skipping the code graph." \
    info \
    "$INFO_DURATION_MS"
  ! grep -Fq '"variant":"error"' "$EVENTS_FILE" || fail "verbose empty corpus was misclassified as a failure"
  [[ -f "$root/.ai/graphify-out/.opencode-empty-corpus" ]] || fail "verbose empty corpus did not record the marker"
  cleanup_processes
}

shouldTreatDocsCensusWithBackendErrorAsFailureNotEmptyCorpus() {
  # Given a docs-mode run that dies on backend credentials after a census reporting
  # "0 code, 1 docs": a fixable failure. Classifying it by the census would brand the
  # repository an empty corpus and suppress every retry at this commit.
  local root
  root=$(make_committed_repo credential-fail-repo)
  plant_mode "$root" docs zen
  start_server credential-fail 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/credential-fail.config.json"

  # Then: reported as a failure with the docs recovery command, never as an empty corpus.
  wait_for_pattern "Graphify indexing failed for credential-fail-repo" "$EVENTS_FILE"
  assert_toast \
    "Graphify indexing failed for credential-fail-repo, but this session is still operational. Run: GRAPHIFY_OUT=.ai/graphify-out graphify extract '$root' --backend zen" \
    error \
    "$RECOVERY_DURATION_MS"
  [[ ! -e "$root/.ai/graphify-out/.opencode-empty-corpus" ]] || fail "backend failure recorded an empty-corpus marker"

  # And the next session retries instead of honoring a marker that should not exist.
  start_server credential-fail-retry 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  request_config "$root" "$SUITE_DIR/credential-fail-retry.config.json"
  wait_for_pattern "Graphify indexing failed for credential-fail-repo" "$EVENTS_FILE"
  [[ $(count_extract_calls "$root") -eq 2 ]] || fail "backend failure was not retried on the next session"
  cleanup_processes
}

shouldClearEmptyMarkerOnceRepositoryGainsCode() {
  # Given a consented repository that is empty at its first commit.
  local root
  local empty_commit
  root=$(make_committed_repo regrow-repo)
  plant_mode "$root" code-only
  empty_commit=$(git -C "$root" rev-parse HEAD)
  start_server regrow-empty 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  request_config "$root" "$SUITE_DIR/regrow-empty.config.json"
  wait_for_pattern "Graphify found no indexable code in regrow-repo" "$EVENTS_FILE"
  [[ -f "$root/.ai/graphify-out/.opencode-empty-corpus" ]] || fail "empty phase did not record the marker"

  # When a later commit adds code and the repository is reopened.
  : >"$root/code.py"
  git -C "$root" add code.py
  git -C "$root" commit -qm "add code"
  start_server regrow-build 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  request_config "$root" "$SUITE_DIR/regrow-build.config.json"

  # Then the build succeeds and clears the now-stale marker...
  wait_for_pattern "Graphify graph for regrow-repo is ready: $FAKE_NODE_COUNT nodes" "$EVENTS_FILE"
  [[ ! -e "$root/.ai/graphify-out/.opencode-empty-corpus" ]] || fail "successful build left the empty-corpus marker behind"

  # ...so checking the empty commit out again is re-examined instead of silently
  # serving the newer graph as if it matched.
  git -C "$root" checkout -q "$empty_commit"
  start_server regrow-recheckout 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  request_config "$root" "$SUITE_DIR/regrow-recheckout.config.json"
  wait_for_pattern "Graphify found no indexable code in regrow-repo" "$EVENTS_FILE"
  [[ $(count_extract_calls "$root") -eq 3 ]] || fail "re-checkout of the empty commit was not re-examined"
  cleanup_processes
}

shouldSummarizeAggregateWhenAllNestedRepositoriesAreEmpty() {
  # Given a plain workspace whose every consented nested repository has nothing to index.
  local aggregate_root="$SUITE_DIR/repos/aggregate-empty-root"
  local repo_a="$aggregate_root/gitlab/alpha-nocode"
  local repo_b="$aggregate_root/gitlab/beta-nocode"
  mkdir -p "$repo_a" "$repo_b"
  git_init "$repo_a"
  git_init "$repo_b"
  plant_mode "$repo_a" code-only
  plant_mode "$repo_b" code-only
  start_server aggregate-empty 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$aggregate_root" "$SUITE_DIR/aggregate-empty.config.json"

  # Then the start toast resolves into an aggregate empty summary instead of silence.
  wait_for_pattern "Graphify is building code graphs for 2 repositories under aggregate-empty-root in the background." "$EVENTS_FILE"
  wait_for_pattern "Graphify found no indexable code in the repositories under aggregate-empty-root" "$EVENTS_FILE"
  assert_toast \
    "Graphify found no indexable code in the repositories under aggregate-empty-root; skipping the code graphs." \
    info \
    "$INFO_DURATION_MS"
  ! grep -Fq '"variant":"success"' "$EVENTS_FILE" || fail "all-empty aggregate produced a success toast"
  ! grep -Fq '"variant":"error"' "$EVENTS_FILE" || fail "all-empty aggregate produced an error toast"
  cleanup_processes
}

shouldSummarizeAggregateFailuresWithIndexCommandHint() {
  # Given a plain workspace where one consented nested repository builds and another fails.
  local aggregate_root="$SUITE_DIR/repos/aggregate-fail-root"
  local repo_ok="$aggregate_root/gitlab/repo-ok"
  local repo_fail="$aggregate_root/gitlab/build-fail-repo"
  mkdir -p "$repo_ok" "$repo_fail"
  git_init "$repo_ok"
  git_init "$repo_fail"
  plant_mode "$repo_ok" code-only
  plant_mode "$repo_fail" code-only
  start_server aggregate-fail 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$aggregate_root" "$SUITE_DIR/aggregate-fail.config.json"

  # Then one warning summary names the failed repository and points back at the command.
  wait_for_pattern "Graphify built 1 of 2 code graphs under aggregate-fail-root." "$EVENTS_FILE"
  assert_toast \
    "Graphify built 1 of 2 code graphs under aggregate-fail-root. Failed: gitlab/build-fail-repo. Reopen the session to retry, or run /graphify-index." \
    warning \
    "$RECOVERY_DURATION_MS"
  [[ $(count_extract_calls "$repo_ok") -eq 1 ]] || fail "healthy sibling was not indexed"
  cleanup_processes
}

shouldBuildDocsGraphWhenModeFileRequestsDocsWithBackend() {
  # Given a first build (graph deleted after /graphify-index, say) whose recorded decision
  # is docs mode with a pinned backend — no docs env vars anywhere.
  local root
  root=$(make_committed_repo docs-mode-repo)
  plant_mode "$root" docs opencode
  start_server docs-mode 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/docs-mode.config.json"

  # Then extract drops --code-only (the semantic docs pass is on) and pins the backend.
  wait_for_pattern "Graphify graph for docs-mode-repo is ready: $FAKE_NODE_COUNT nodes" "$EVENTS_FILE"
  grep -Fxq "extract|$root|extract $root --backend opencode --global --as docs-mode-repo" "$FAKE_LOG" ||
    fail "docs mode did not run a full extract with the recorded backend"
  assert_mode_file "$root" '{"mode":"docs","backend":"opencode"}'
  cleanup_processes
}

shouldBuildDocsGraphWithAutoDetectedBackendWhenUnpinned() {
  # Given a recorded docs decision without a backend pin: Graphify auto-detects one.
  local root
  root=$(make_committed_repo docs-auto-repo)
  plant_mode "$root" docs
  start_server docs-auto 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/docs-auto.config.json"

  # Then extract carries neither --code-only nor --backend.
  wait_for_pattern "Graphify graph for docs-auto-repo is ready: $FAKE_NODE_COUNT nodes" "$EVENTS_FILE"
  grep -Fxq "extract|$root|extract $root --global --as docs-auto-repo" "$FAKE_LOG" ||
    fail "unpinned docs mode did not run a plain full extract"
  assert_mode_file "$root" '{"mode":"docs"}'
  cleanup_processes
}

shouldMirrorDocsModeInRecoveryCommand() {
  # Given a failing build under a recorded docs decision: the advertised manual command must
  # reproduce what the plugin ran, not fall back to --code-only.
  local root="$SUITE_DIR/repos/docs-fail/build-fail-repo"
  mkdir -p "$root"
  git_init "$root"
  : >"$root/tracked"
  git -C "$root" add tracked
  git -C "$root" commit -qm initial
  plant_mode "$root" docs opencode
  start_server docs-fail 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/docs-fail.config.json"

  # Then
  wait_for_pattern "Graphify indexing failed for build-fail-repo" "$EVENTS_FILE"
  assert_toast \
    "Graphify indexing failed for build-fail-repo, but this session is still operational. Run: GRAPHIFY_OUT=.ai/graphify-out graphify extract '$root' --backend opencode" \
    error \
    "$RECOVERY_DURATION_MS"
  cleanup_processes
}

shouldRunByDefaultWithoutEnvironmentFlag() {
  # Given
  local root
  root=$(make_committed_repo default-on-repo)
  plant_mode "$root" code-only
  start_server default-on unset "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/default-on.config.json"

  # Then: the initializer runs with OPENCODE_GRAPHIFY_AUTOINIT absent (default-on).
  wait_for_pattern "Graphify is building the code graph for default-on-repo in the background." "$EVENTS_FILE"
  wait_for_pattern "Graphify graph for default-on-repo is ready: $FAKE_NODE_COUNT nodes" "$EVENTS_FILE"
  [[ $(count_extract_calls "$root") -eq 1 ]] || fail "default-on did not build exactly once"
  cleanup_processes
}

shouldDoNothingWhenOptedOut() {
  # Given an unindexed repository with the initializer opted out: not even the hint fires.
  local root
  local size_before
  root=$(make_committed_repo opt-out-repo)
  size_before=$(log_size)
  start_server opt-out 0 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/opt-out.config.json"
  sleep 1

  # Then
  [[ $(log_size) -eq "$size_before" ]] || fail "opt-out called Graphify"
  ! grep -Fq '"type":"tui.toast.show"' "$EVENTS_FILE" || fail "opt-out emitted a toast"
  cleanup_processes
}

shouldSkipGlobalRegistrationWhenOptedOut() {
  # Given OPENCODE_GRAPHIFY_GLOBAL=0 with the initializer itself still on.
  local root
  root=$(make_committed_repo global-opt-out-repo)
  plant_mode "$root" code-only
  start_server global-opt-out 1 "$FAKE_BIN_DIR:/usr/bin:/bin" 0

  # When
  request_config "$root" "$SUITE_DIR/global-opt-out.config.json"

  # Then: the graph is built for local use only.
  wait_for_pattern "Graphify graph for global-opt-out-repo is ready" "$EVENTS_FILE"
  grep -Fxq "extract|$root|extract $root --code-only" "$FAKE_LOG" ||
    fail "opted-out build did not run as a plain local extract"
  [[ $(count_global_add_calls "$root") -eq 0 ]] || fail "opted-out build still registered globally"
  ! grep -Fq "global-opt-out-repo $root/.ai/graphify-out/graph.json" "$GLOBAL_GRAPH" 2>/dev/null ||
    fail "opted-out build still reached the global graph"
  cleanup_processes
}

shouldRegisterEveryRepositoryInTheGlobalGraph() {
  # Given two independent consented repositories indexed in separate sessions.
  local first
  local second
  first=$(make_committed_repo global-first-repo)
  second=$(make_committed_repo global-second-repo)
  plant_mode "$first" code-only
  plant_mode "$second" code-only
  start_server global-registry 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$first" "$SUITE_DIR/global-first.config.json"
  wait_for_pattern "Graphify graph for global-first-repo is ready" "$EVENTS_FILE"
  request_config "$second" "$SUITE_DIR/global-second.config.json"
  wait_for_pattern "Graphify graph for global-second-repo is ready" "$EVENTS_FILE"

  # Then: both land in one global graph, each under its own repository tag.
  wait_for_file "$GLOBAL_GRAPH"
  grep -Fq "global-first-repo $first/.ai/graphify-out/graph.json" "$GLOBAL_GRAPH" ||
    fail "first repository is missing from the global graph"
  grep -Fq "global-second-repo $second/.ai/graphify-out/graph.json" "$GLOBAL_GRAPH" ||
    fail "second repository is missing from the global graph"
  cleanup_processes
}

shouldWarnWhenGlobalMergeFailsDespiteExitZero() {
  # Given an extract whose --global merge fails: real Graphify 0.9.28 prints the warning
  # to stderr and still exits 0, so a success-only reading would stamp the local graph
  # fresh and never retry the registration.
  local root
  root=$(make_committed_repo global-warn-repo)
  plant_mode "$root" code-only
  start_server global-warn 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/global-warn.config.json"

  # Then: the local graph is honestly ready, AND the swallowed merge failure surfaces
  # with the human-lifecycle recovery command.
  wait_for_pattern "Graphify graph for global-warn-repo is ready" "$EVENTS_FILE"
  wait_for_pattern "Graphify could not merge global-warn-repo into the global graph" "$EVENTS_FILE"
  assert_toast \
    "Graphify could not merge global-warn-repo into the global graph; cross-repository queries stay stale. Run: graphify global add '$root/.ai/graphify-out/graph.json' --as global-warn-repo" \
    warning \
    "$RECOVERY_DURATION_MS"
  ! grep -Fq "global-warn-repo " "$GLOBAL_GRAPH" 2>/dev/null || fail "failed merge unexpectedly landed in the global graph"
  cleanup_processes
}

shouldExcludeGraphOutputFromLinkedWorktreeGitMetadata() {
  # Given
  local root
  local exclude_path
  root=$(make_linked_worktree linked-worktree-repo)
  plant_mode "$root" code-only
  exclude_path=$(git -C "$root" rev-parse --git-path info/exclude)
  [[ "$exclude_path" == /* ]] || exclude_path="$root/$exclude_path"
  start_server linked-worktree 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/linked-worktree.config.json"

  # Then
  wait_for_pattern "Graphify graph for linked-worktree-repo is ready" "$EVENTS_FILE"
  grep -Fxq '.ai/graphify-out' "$exclude_path" || fail "linked worktree output was not added to the real Git exclude file"
  [[ ! -d "$root/.git" ]] || fail "linked worktree fixture unexpectedly used a .git directory"
  cleanup_processes
}

shouldAggregateNestedRepositoriesUnderPlainRoot() {
  # Given a plain (non-git) workspace root holding consented git repositories two levels deep.
  local aggregate_root="$SUITE_DIR/repos/aggregate-root"
  local repo_a="$aggregate_root/gitlab/repo-a"
  local repo_b="$aggregate_root/gitlab/repo-b"
  local dep_repo="$aggregate_root/node_modules/dep-repo"
  local hidden_repo="$aggregate_root/.hidden/secret-repo"
  mkdir -p "$repo_a" "$repo_b" "$dep_repo" "$hidden_repo"
  git_init "$repo_a"
  git_init "$repo_b"
  git_init "$dep_repo"
  git_init "$hidden_repo"
  plant_mode "$repo_a" code-only
  plant_mode "$repo_b" code-only
  hold_builds "$repo_a"
  hold_builds "$repo_b"
  start_server aggregate 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$aggregate_root" "$SUITE_DIR/aggregate.config.json"

  # Then: one aggregate start toast naming exactly the two discoverable repositories.
  wait_for_pattern "Graphify is building code graphs for 2 repositories under aggregate-root in the background." "$EVENTS_FILE"
  assert_toast \
    "Graphify is building code graphs for 2 repositories under aggregate-root in the background. You can keep working." \
    info \
    "$INFO_DURATION_MS"

  # Repositories are indexed sequentially: repo-b must not start until repo-a is released.
  wait_for_file "$repo_a/.fake-graphify/build-started"
  sleep 0.3
  [[ ! -e "$repo_b/.fake-graphify/build-started" ]] || fail "aggregate indexing was not sequential"
  release_builds "$repo_a"
  wait_for_file "$repo_a/.fake-graphify/build-finished"
  wait_for_file "$repo_b/.fake-graphify/build-started"
  release_builds "$repo_b"
  wait_for_file "$repo_b/.fake-graphify/build-finished"

  # And one aggregate summary toast.
  wait_for_pattern "Graphify built code graphs for 2 repositories under aggregate-root in" "$EVENTS_FILE"
  assert_toast_message_pattern \
    "Graphify built code graphs for 2 repositories under aggregate-root in [0-9]+\\.[0-9]s\\." \
    success \
    "$INFO_DURATION_MS"

  # Only the two gitlab repos were touched; node_modules, hidden dirs, and the root were skipped.
  [[ $(count_extract_calls "$repo_a") -eq 1 ]] || fail "repo-a was not indexed"
  [[ $(count_extract_calls "$repo_b") -eq 1 ]] || fail "repo-b was not indexed"
  [[ $(count_extract_calls "$dep_repo") -eq 0 ]] || fail "node_modules repo was indexed"
  [[ $(count_extract_calls "$hidden_repo") -eq 0 ]] || fail "hidden repo was indexed"
  [[ $(count_extract_calls "$aggregate_root") -eq 0 ]] || fail "plain workspace root was indexed"
  grep -Fxq '.ai/graphify-out' "$repo_a/.git/info/exclude" || fail "repo-a output was not Git-excluded"
  grep -Fxq '.ai/graphify-out' "$repo_b/.git/info/exclude" || fail "repo-b output was not Git-excluded"
  # Each nested repository is registered under its own tag, not the aggregate root's,
  # and each keeps its output under its own .ai/.
  grep -Fxq "extract|$repo_a|extract $repo_a --code-only --global --as repo-a" "$FAKE_LOG" ||
    fail "repo-a was not registered under its own global tag"
  grep -Fxq "extract|$repo_b|extract $repo_b --code-only --global --as repo-b" "$FAKE_LOG" ||
    fail "repo-b was not registered under its own global tag"
  ! grep -Fq "Graphify is building the code graph for repo-a" "$EVENTS_FILE" || fail "aggregate emitted a per-repo start toast"
  cleanup_processes
}

shouldFallBackToSingleRootWhenPlainDirHasNoNestedRepos() {
  # Given a consented plain (non-git) directory with no nested repositories.
  local root="$SUITE_DIR/repos/plain-fallback"
  mkdir -p "$root"
  : >"$root/loose-file"
  plant_mode "$root" code-only
  start_server plain-fallback 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/plain-fallback.config.json"

  # Then: the folder root itself is indexed as a single root.
  wait_for_pattern "Graphify is building the code graph for plain-fallback in the background." "$EVENTS_FILE"
  wait_for_pattern "Graphify graph for plain-fallback is ready: $FAKE_NODE_COUNT nodes" "$EVENTS_FILE"
  [[ $(count_extract_calls "$root") -eq 1 ]] || fail "plain fallback did not index the folder root once"
  cleanup_processes
}

shouldSkipExtractWhileAnotherLiveSessionHoldsTheLock() {
  # Given a stale consented graph whose lock names a LIVE process (this test shell).
  local root
  root=$(make_committed_repo locked-repo)
  plant_graph "$root" "$STALE_COMMIT"
  plant_mode "$root" code-only
  printf '%s\n' "$$" >"$root/.ai/graphify-out/.opencode-extract-lock"
  start_server locked 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/locked.config.json"
  sleep 1

  # Then: no concurrent extract, no toasts (the lock-holding session owns them), and the
  # live lock is left untouched.
  [[ $(count_extract_calls "$root") -eq 0 ]] || fail "live lock did not prevent a concurrent extract"
  ! grep -Fq '"type":"tui.toast.show"' "$EVENTS_FILE" || fail "locked repository emitted a toast"
  grep -Fxq "$$" "$root/.ai/graphify-out/.opencode-extract-lock" || fail "live lock was clobbered"
  cleanup_processes
}

shouldReplaceStaleLockLeftByDeadSession() {
  # Given a stale graph whose lock names a PID that no longer exists (crashed session).
  local root
  local dead_pid
  root=$(make_committed_repo stale-lock-repo)
  plant_graph "$root" "$STALE_COMMIT"
  plant_mode "$root" code-only
  ( : ) &
  dead_pid=$!
  wait "$dead_pid"
  printf '%s\n' "$dead_pid" >"$root/.ai/graphify-out/.opencode-extract-lock"
  start_server stale-lock 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/stale-lock.config.json"

  # Then the dead lock is replaced, the refresh runs, and the lock is released after it.
  wait_for_pattern "Graphify graph for stale-lock-repo is ready" "$EVENTS_FILE"
  [[ $(count_extract_calls "$root") -eq 1 ]] || fail "stale lock blocked the refresh"
  [[ ! -e "$root/.ai/graphify-out/.opencode-extract-lock" ]] || fail "lock was not released after the refresh"
  cleanup_processes
}

shouldKeepLockWhileOrphanedExtractChildIsAlive() {
  # Given a lock naming a dead server PID plus a LIVE extract child: exactly what a
  # SIGKILLed server leaves behind (shutdown hooks cannot run). Treating it as stale
  # would start a duplicate, token-spending extraction beside the orphan.
  local root
  local dead_pid
  local child_pid
  root=$(make_committed_repo orphan-lock-repo)
  plant_graph "$root" "$STALE_COMMIT"
  plant_mode "$root" code-only
  ( : ) &
  dead_pid=$!
  wait "$dead_pid"
  sleep 60 &
  child_pid=$!
  printf '%s\n%s\n' "$dead_pid" "$child_pid" >"$root/.ai/graphify-out/.opencode-extract-lock"
  start_server orphan-lock 1 "$FAKE_BIN_DIR:/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/orphan-lock.config.json"
  sleep 1

  # Then: the live child keeps the lock authoritative — no extract, no toast, lock intact.
  [[ $(count_extract_calls "$root") -eq 0 ]] || fail "live orphan child did not prevent a concurrent extract"
  ! grep -Fq '"type":"tui.toast.show"' "$EVENTS_FILE" || fail "orphan-locked repository emitted a toast"
  grep -Fq "$child_pid" "$root/.ai/graphify-out/.opencode-extract-lock" || fail "orphan lock was clobbered"
  terminate_pid "$child_pid"
  cleanup_processes
}

shouldKillRunningExtractWhenServerIsTerminated() {
  # Given a held extract in flight.
  local root
  local builder_pid
  root=$(make_committed_repo shutdown-repo)
  plant_mode "$root" code-only
  hold_builds "$root"
  start_server shutdown-kill 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  request_config "$root" "$SUITE_DIR/shutdown-kill.config.json"
  wait_for_file "$root/.fake-graphify/build.pid"
  builder_pid=$(<"$root/.fake-graphify/build.pid")
  kill -0 "$builder_pid" 2>/dev/null || fail "fake builder was not running before shutdown"

  # When the OpenCode server itself is terminated — never the builder directly.
  kill -TERM "$SERVER_PID" 2>/dev/null || fail "could not signal the server"

  # Then the plugin's shutdown hooks kill the spawned extract instead of orphaning it.
  wait_for_pid_exit "$builder_pid"
  cleanup_processes
}

shouldKillExtractThatExceedsItsTimeBudget() {
  # Given a build that never finishes on its own and a 1s extract budget: the wedged docs-mode
  # run that used to hold the per-repo lock until the whole server process died.
  local root
  local builder_pid
  root=$(make_committed_repo timeout-repo)
  plant_mode "$root" code-only
  hold_builds "$root"
  EXTRACT_TIMEOUT_MS=1000
  start_server extract-timeout 1 "$FAKE_BIN_DIR:/usr/bin:/bin"
  EXTRACT_TIMEOUT_MS="unset"

  # When
  request_config "$root" "$SUITE_DIR/extract-timeout.config.json"
  wait_for_file "$root/.fake-graphify/build.pid"
  builder_pid=$(<"$root/.fake-graphify/build.pid")
  kill -0 "$builder_pid" 2>/dev/null || fail "fake builder was not running before the budget expired"

  # Then the budget kills the child, the failure is reported, and the lock is free for the
  # next session instead of outliving it.
  wait_for_pid_exit "$builder_pid"
  wait_for_pattern "Graphify indexing failed for timeout-repo" "$EVENTS_FILE"
  [[ ! -e "$root/.ai/graphify-out/.opencode-extract-lock" ]] || fail "timed-out extract did not release the lock"
  cleanup_processes
}

shouldWarnWhenBinaryIsMissing() {
  # Given a consented repository with real work but no graphify on PATH.
  local root
  root=$(make_committed_repo missing-binary-repo)
  plant_mode "$root" code-only
  start_server missing-binary 1 "/usr/bin:/bin"

  # When
  request_config "$root" "$SUITE_DIR/missing.config.json"

  # Then
  wait_for_pattern "Graphify CLI was not found. Run: $INSTALL_HINT" "$EVENTS_FILE"
  assert_toast \
    "Graphify CLI was not found. Run: $INSTALL_HINT" \
    warning \
    "$RECOVERY_DURATION_MS"
  cleanup_processes
}

shouldKeepConfigResponsiveWhileBuildingInBackground
shouldStaySilentWhenGraphMatchesHeadCommit
shouldHintOncePerSessionInsteadOfFirstIndexing
shouldQueueToastsUntilFirstBusEvent
shouldFlushQueuedToastsAfterFallbackDelay
shouldAggregateHintWhenNestedRepositoriesHaveNoConsent
shouldRefreshStaleGraphWithIncrementalExtract
shouldReExtractWhenCommitLandsMidExtract
shouldRefreshCodeOnlyDespiteAmbientDocsEnvironment
shouldRefreshWithDocsBackendWhenModeFileRecordsDocs
shouldDeriveDocsRefreshFromSemanticMarkerWhenModeFileIsAbsent
shouldRebuildWhenGraphFileIsUnreadable
shouldKeepExistingGraphWhenRepositoryHasNoCommits
shouldToastErrorWhenBuildFails
shouldToastErrorWhenRefreshFails
shouldReportEmptyWhenRepositoryLosesAllCode
shouldReportEmptyWhenBuildProducesZeroNodeGraph
shouldWarnWhenGraphIsMissingAfterSuccessfulBuild
shouldNotRetryARepositoryWithNothingToIndex
shouldRecordSentinelMarkerForEmptyRootWithoutHead
shouldClassifyEmptyCorpusBehindVerboseOutput
shouldTreatDocsCensusWithBackendErrorAsFailureNotEmptyCorpus
shouldClearEmptyMarkerOnceRepositoryGainsCode
shouldSummarizeAggregateWhenAllNestedRepositoriesAreEmpty
shouldSummarizeAggregateFailuresWithIndexCommandHint
shouldBuildDocsGraphWhenModeFileRequestsDocsWithBackend
shouldBuildDocsGraphWithAutoDetectedBackendWhenUnpinned
shouldMirrorDocsModeInRecoveryCommand
shouldRunByDefaultWithoutEnvironmentFlag
shouldDoNothingWhenOptedOut
shouldSkipGlobalRegistrationWhenOptedOut
shouldRegisterEveryRepositoryInTheGlobalGraph
shouldWarnWhenGlobalMergeFailsDespiteExitZero
shouldExcludeGraphOutputFromLinkedWorktreeGitMetadata
shouldAggregateNestedRepositoriesUnderPlainRoot
shouldFallBackToSingleRootWhenPlainDirHasNoNestedRepos
shouldSkipExtractWhileAnotherLiveSessionHoldsTheLock
shouldReplaceStaleLockLeftByDeadSession
shouldKeepLockWhileOrphanedExtractChildIsAlive
shouldKillRunningExtractWhenServerIsTerminated
shouldKillExtractThatExceedsItsTimeBudget
shouldWarnWhenBinaryIsMissing

echo "PASS: graphify-init consent, refresh, and notification contracts"
