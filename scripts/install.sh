#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
COMMAND_NAME=graphify-index.md
COMMAND_SOURCE="$ROOT_DIR/commands/$COMMAND_NAME"

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh

Register this checkout as a global OpenCode plugin and expose /graphify-index.
The command link is written to the config directory reported by OpenCode.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi

case "${1:-}" in
  "") ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

command -v opencode >/dev/null 2>&1 || fail "OpenCode is required and must be available on PATH."
[[ -f "$COMMAND_SOURCE" ]] || fail "Missing command source: $COMMAND_SOURCE"

if ! PATHS_OUTPUT=$(opencode debug paths); then
  fail "OpenCode could not report its global paths."
fi
CONFIG_DIR=$(printf '%s\n' "$PATHS_OUTPUT" | awk '$1 == "config" { sub(/^[^[:space:]]+[[:space:]]+/, ""); print; exit }')
[[ -n "$CONFIG_DIR" ]] || fail "OpenCode did not report its global configuration directory."
COMMAND_DIR="$CONFIG_DIR/commands"
COMMAND_TARGET="$COMMAND_DIR/$COMMAND_NAME"
LINK_CREATED=0

if [[ -e "$COMMAND_TARGET" || -L "$COMMAND_TARGET" ]]; then
  if [[ ! -e "$COMMAND_TARGET" || ! "$COMMAND_TARGET" -ef "$COMMAND_SOURCE" ]]; then
    fail "$COMMAND_TARGET already exists and is not managed by this checkout."
  fi
else
  mkdir -p "$COMMAND_DIR"
  ln -s "$COMMAND_SOURCE" "$COMMAND_TARGET"
  LINK_CREATED=1
fi

if ! opencode plugin "$ROOT_DIR" --global; then
  if [[ $LINK_CREATED -eq 1 && -L "$COMMAND_TARGET" && -e "$COMMAND_TARGET" && "$COMMAND_TARGET" -ef "$COMMAND_SOURCE" ]]; then
    rm "$COMMAND_TARGET"
  fi
  fail "OpenCode could not register the plugin; no new command link was retained."
fi

printf 'Installed OpenCode Graphify Init from %s\n' "$ROOT_DIR"
printf 'Command link: %s\n' "$COMMAND_TARGET"
printf 'Restart OpenCode, open a repository, and run /graphify-index.\n'
