import { spawnSync } from "node:child_process"

const root = new URL("../", import.meta.url)
const environment = { ...process.env }
const pnpmOnlyNpmConfigKeys = [
  "npm_config__jsr_registry",
  "npm_config_block_exotic_subdeps",
  "npm_config_minimum_release_age",
  "npm_config_node_version",
  "npm_config_npm_globalconfig",
  "npm_config_overrides",
  "npm_config_package_manager_strict",
  "npm_config_package_manager_strict_version",
  "npm_config_strict_dep_builds",
  "npm_config_trust_policy",
  "npm_config_verify_deps_before_run",
]

for (const key of pnpmOnlyNpmConfigKeys) {
  delete environment[key]
}

const audit = spawnSync("npm", ["audit", "signatures"], {
  cwd: root,
  env: environment,
  stdio: "inherit",
})

if (audit.error) throw audit.error
process.exitCode = audit.status ?? 1
