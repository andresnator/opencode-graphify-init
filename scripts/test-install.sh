#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
INSTALLER="$ROOT_DIR/scripts/install.sh"
COMMAND_SOURCE="$ROOT_DIR/commands/graphify-index.md"
SUITE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/graphify-init-install-test.XXXXXX")
FAKE_BIN_DIR="$SUITE_DIR/bin"
FAKE_OPENCODE_LOG="$SUITE_DIR/opencode.log"
SYSTEM_PATH=$PATH

cleanup() {
  rm -rf "$SUITE_DIR"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p "$FAKE_BIN_DIR"
cat >"$FAKE_BIN_DIR/opencode" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == debug && "${2:-}" == paths ]]; then
  if [[ "${FAKE_OPENCODE_NO_CONFIG:-0}" == 1 ]]; then
    printf 'cache      /tmp/opencode-cache\n'
    exit 0
  fi
  printf 'config     %s\n' "$FAKE_CONFIG_DIR"
  exit 0
fi
printf '%s\n' "$1" "$2" "$3" >>"$FAKE_OPENCODE_LOG"
if [[ "${FAKE_OPENCODE_FAIL:-0}" == 1 ]]; then
  exit 23
fi
mkdir -p "$FAKE_CONFIG_DIR"
printf '{"plugin":["%s"]}\n' "$2" >"$FAKE_CONFIG_DIR/opencode.json"
EOF
chmod +x "$FAKE_BIN_DIR/opencode"

run_installer() {
  local config_dir=$1
  FAKE_CONFIG_DIR="$config_dir" \
    FAKE_OPENCODE_LOG="$FAKE_OPENCODE_LOG" \
    PATH="$FAKE_BIN_DIR:$SYSTEM_PATH" \
    "$INSTALLER"
}

assert_last_registration() {
  local line_count
  line_count=$(wc -l <"$FAKE_OPENCODE_LOG" | tr -d ' ')
  [[ $line_count -ge 3 ]] || fail "OpenCode registration was not recorded"
  [[ $(tail -n 3 "$FAKE_OPENCODE_LOG" | sed -n '1p') == plugin ]] || fail "installer did not call opencode plugin"
  [[ $(tail -n 3 "$FAKE_OPENCODE_LOG" | sed -n '2p') == "$ROOT_DIR" ]] || fail "installer registered the wrong checkout"
  [[ $(tail -n 3 "$FAKE_OPENCODE_LOG" | sed -n '3p') == --global ]] || fail "installer did not use global scope"
}

shouldInstallPluginAndCommandWhenTargetIsEmpty() {
  # Given
  local config_dir="$SUITE_DIR/fresh-config"
  local target="$config_dir/commands/graphify-index.md"
  : >"$FAKE_OPENCODE_LOG"

  # When
  run_installer "$config_dir" >/dev/null

  # Then
  [[ -L "$target" ]] || fail "installer did not create the command link"
  [[ "$target" -ef "$COMMAND_SOURCE" ]] || fail "command link points to the wrong source"
  assert_last_registration
}

shouldRemainIdempotentWhenInstallerRunsAgain() {
  # Given
  local config_dir="$SUITE_DIR/idempotent-config"
  local target="$config_dir/commands/graphify-index.md"
  : >"$FAKE_OPENCODE_LOG"
  run_installer "$config_dir" >/dev/null
  local first_target
  first_target=$(readlink "$target")

  # When
  run_installer "$config_dir" >/dev/null

  # Then
  [[ $(readlink "$target") == "$first_target" ]] || fail "rerun changed the managed command link"
  [[ $(grep -c '^plugin$' "$FAKE_OPENCODE_LOG") -eq 1 ]] || fail "rerun repeated plugin registration"
  assert_last_registration
}

shouldRefuseForeignCommandWhenTargetAlreadyExists() {
  # Given
  local config_dir="$SUITE_DIR/foreign-config"
  local target="$config_dir/commands/graphify-index.md"
  mkdir -p "$(dirname "$target")"
  printf 'foreign command\n' >"$target"
  : >"$FAKE_OPENCODE_LOG"

  # When
  if run_installer "$config_dir" >/dev/null 2>&1; then
    fail "installer accepted a foreign command"
  fi

  # Then
  [[ $(<"$target") == "foreign command" ]] || fail "installer modified a foreign command"
  [[ ! -s "$FAKE_OPENCODE_LOG" ]] || fail "installer mutated OpenCode after a failed preflight"
}

shouldRollbackCommandLinkWhenPluginRegistrationFails() {
  # Given
  local config_dir="$SUITE_DIR/failing-config"
  local target="$config_dir/commands/graphify-index.md"
  : >"$FAKE_OPENCODE_LOG"

  # When
  if FAKE_CONFIG_DIR="$config_dir" \
    FAKE_OPENCODE_LOG="$FAKE_OPENCODE_LOG" \
    FAKE_OPENCODE_FAIL=1 \
    PATH="$FAKE_BIN_DIR:$SYSTEM_PATH" \
    "$INSTALLER" >/dev/null 2>&1; then
    fail "installer ignored a plugin registration failure"
  fi

  # Then
  [[ ! -e "$target" && ! -L "$target" ]] || fail "installer retained a command link after registration failed"
  assert_last_registration
}

shouldPrintUsageWithoutMutationWhenHelpIsRequested() {
  # Given
  local config_dir="$SUITE_DIR/help-config"
  : >"$FAKE_OPENCODE_LOG"

  # When
  local output
  output=$(FAKE_CONFIG_DIR="$config_dir" \
    FAKE_OPENCODE_LOG="$FAKE_OPENCODE_LOG" \
    PATH="$FAKE_BIN_DIR:$SYSTEM_PATH" \
    "$INSTALLER" --help)

  # Then
  [[ $output == *"Usage: ./scripts/install.sh"* ]] || fail "installer help omitted its usage"
  [[ ! -e "$config_dir" ]] || fail "help created a configuration directory"
  [[ ! -s "$FAKE_OPENCODE_LOG" ]] || fail "help invoked OpenCode"
}

shouldRefuseInstallWhenOpenCodeDoesNotReportConfig() {
  # Given
  local config_dir="$SUITE_DIR/missing-config-path"
  : >"$FAKE_OPENCODE_LOG"

  # When
  if FAKE_CONFIG_DIR="$config_dir" \
    FAKE_OPENCODE_LOG="$FAKE_OPENCODE_LOG" \
    FAKE_OPENCODE_NO_CONFIG=1 \
    PATH="$FAKE_BIN_DIR:$SYSTEM_PATH" \
    "$INSTALLER" >/dev/null 2>&1; then
    fail "installer accepted OpenCode paths without a config directory"
  fi

  # Then
  [[ ! -e "$config_dir" ]] || fail "missing path preflight created a configuration directory"
  [[ ! -s "$FAKE_OPENCODE_LOG" ]] || fail "missing path preflight attempted plugin registration"
}

shouldRepairCommandLinkWhenPluginIsAlreadyRegistered() {
  # Given
  local config_dir="$SUITE_DIR/registered-config"
  local target="$config_dir/commands/graphify-index.md"
  mkdir -p "$config_dir"
  printf '{"plugin":["%s"]}\n' "$ROOT_DIR" >"$config_dir/opencode.jsonc"
  : >"$FAKE_OPENCODE_LOG"

  # When
  run_installer "$config_dir" >/dev/null

  # Then
  [[ -L "$target" && "$target" -ef "$COMMAND_SOURCE" ]] || fail "installer did not repair a missing command link"
  [[ ! -s "$FAKE_OPENCODE_LOG" ]] || fail "installer repeated an existing plugin registration"
}

shouldCompleteRegistrationWhenManagedLinkExistsWithoutConfig() {
  # Given
  local config_dir="$SUITE_DIR/partial-config"
  local target="$config_dir/commands/graphify-index.md"
  mkdir -p "$(dirname "$target")"
  ln -s "$COMMAND_SOURCE" "$target"
  : >"$FAKE_OPENCODE_LOG"

  # When
  run_installer "$config_dir" >/dev/null

  # Then
  [[ -L "$target" && "$target" -ef "$COMMAND_SOURCE" ]] || fail "installer replaced the managed command link"
  [[ $(grep -c '^plugin$' "$FAKE_OPENCODE_LOG") -eq 1 ]] || fail "installer did not repair missing plugin registration"
  assert_last_registration
}

shouldIgnoreInactiveJsoncWhenJsonConfigExists() {
  # Given
  local config_dir="$SUITE_DIR/config-precedence"
  local target="$config_dir/commands/graphify-index.md"
  mkdir -p "$config_dir"
  printf '{"plugin":[]}\n' >"$config_dir/opencode.json"
  printf '{"plugin":["%s"]}\n' "$ROOT_DIR" >"$config_dir/opencode.jsonc"
  : >"$FAKE_OPENCODE_LOG"

  # When
  run_installer "$config_dir" >/dev/null

  # Then
  [[ -L "$target" && "$target" -ef "$COMMAND_SOURCE" ]] || fail "installer did not create the command link"
  [[ $(grep -c '^plugin$' "$FAKE_OPENCODE_LOG") -eq 1 ]] || fail "installer treated the inactive JSONC file as authoritative"
  assert_last_registration
}

shouldInstallPluginAndCommandWhenTargetIsEmpty
shouldRemainIdempotentWhenInstallerRunsAgain
shouldRefuseForeignCommandWhenTargetAlreadyExists
shouldRollbackCommandLinkWhenPluginRegistrationFails
shouldPrintUsageWithoutMutationWhenHelpIsRequested
shouldRefuseInstallWhenOpenCodeDoesNotReportConfig
shouldRepairCommandLinkWhenPluginIsAlreadyRegistered
shouldCompleteRegistrationWhenManagedLinkExistsWithoutConfig
shouldIgnoreInactiveJsoncWhenJsonConfigExists

printf 'PASS: 9 installer contracts.\n'
