import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"

const ROOT = new URL("../", import.meta.url)
const PACKAGE_NAME = "opencode-graphify-init"
const NPM_REGISTRY = "https://registry.npmjs.org/"
const OPENCODE_RANGE = ">=1.17.15 <2"
const NPM_LIFECYCLE_SCRIPTS = [
  "dependencies",
  "install",
  "postinstall",
  "postpack",
  "postprepare",
  "postpublish",
  "postversion",
  "preinstall",
  "prepack",
  "prepare",
  "preprepare",
  "prepublish",
  "prepublishOnly",
  "preversion",
  "publish",
  "version",
]
const EXPECTED_PACKAGE_FILES = [
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "commands/graphify-index.md",
  "dist/server.d.ts",
  "dist/server.js",
  "docs/lifecycle.md",
  "package.json",
]

const packageJson = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"))

function shouldExposeOnlyTheServerPluginWhenPackageIsPublished() {
  // Given
  const lifecycleScripts = NPM_LIFECYCLE_SCRIPTS.filter((script) => packageJson.scripts?.[script] !== undefined)

  // When
  const actual = {
    name: packageJson.name,
    main: packageJson.main,
    private: packageJson.private,
    publishConfig: packageJson.publishConfig,
    exports: packageJson.exports,
    opencodeEngine: packageJson.engines?.opencode,
    dependencies: packageJson.dependencies,
    optionalDependencies: packageJson.optionalDependencies,
    peerDependencies: packageJson.peerDependencies,
    bundledDependencies: packageJson.bundledDependencies ?? packageJson.bundleDependencies,
    bin: packageJson.bin,
    lifecycleScripts,
  }

  // Then
  assert.deepEqual(actual, {
    name: PACKAGE_NAME,
    main: "./dist/server.js",
    private: undefined,
    publishConfig: { access: "public", registry: NPM_REGISTRY },
    exports: {
      "./server": {
        types: "./dist/server.d.ts",
        import: "./dist/server.js",
      },
    },
    opencodeEngine: OPENCODE_RANGE,
    dependencies: undefined,
    optionalDependencies: undefined,
    peerDependencies: undefined,
    bundledDependencies: undefined,
    bin: undefined,
    lifecycleScripts: [],
  })
}

function shouldContainOnlyTheExpectedFilesWhenPackageIsPacked() {
  // Given
  const expected = {
    name: PACKAGE_NAME,
    version: packageJson.version,
    filename: `${PACKAGE_NAME}-${packageJson.version}.tgz`,
    files: [...EXPECTED_PACKAGE_FILES].sort(),
  }

  // When
  const packed = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  })
  assert.equal(packed.status, 0, packed.stderr || packed.stdout)
  const report = JSON.parse(packed.stdout)
  const actual = {
    name: report.name,
    version: report.version,
    filename: report.filename,
    files: report.files.map((entry) => entry.path).sort(),
  }

  // Then
  assert.deepEqual(actual, expected)
}

shouldExposeOnlyTheServerPluginWhenPackageIsPublished()
shouldContainOnlyTheExpectedFilesWhenPackageIsPacked()
process.stdout.write("PASS: 2 npm publication contracts.\n")
