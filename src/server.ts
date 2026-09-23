import { spawn, type ChildProcess } from "node:child_process"
import fs, { type FileHandle } from "node:fs/promises"
import path from "node:path"
import type { Config, Plugin } from "@opencode-ai/plugin"

export const GRAPHIFY_INIT_PLUGIN_ID = "andresnator.graphify-init"
const LOG_PREFIX = "[graphify-init]"
const GRAPHIFY_BINARY = "graphify"
const GRAPHIFY_INSTALL_HINT = "uv tool install graphifyy (or pipx install graphifyy)"
const GIT_BINARY = "git"
const AUTOINIT_ENV = "OPENCODE_GRAPHIFY_AUTOINIT"
const GLOBAL_ENV = "OPENCODE_GRAPHIFY_GLOBAL"
const AUTOINIT_OPT_OUT = "0"
const GLOBAL_OPT_OUT = "0"
// Local tool state lives under .ai/ by convention. GRAPHIFY_OUT relocates Graphify's whole
// output tree relative to the indexed root. It is the env var rather than the --out flag on
// purpose: --out only moves where extract WRITES, while the MCP server reads GRAPHIFY_OUT to
// resolve a project_path query (`<project_path>/<GRAPHIFY_OUT>/graph.json`). With --out alone
// the writer and the reader disagree and every project_path query misses the graph. The two
// never combine — the CLI appends GRAPHIFY_OUT under --out, yielding .ai/.ai/graphify-out.
const OUT_BASE = ".ai"
const OUT_DIR = "graphify-out"
const GRAPHIFY_OUT_ENV = "GRAPHIFY_OUT"
const OUT_RELATIVE = `${OUT_BASE}/${OUT_DIR}`
const GRAPH_FILE = "graph.json"
const EMPTY_MARKER_FILE = ".opencode-empty-corpus"
// This legacy location remains the consent record. Only a successful clean extraction or
// confirmed empty result may set policyVersion; pendingGlobal is independent of local readiness.
const MODE_FILE = ".opencode-index-mode"
const MODE_CODE_ONLY = "code-only"
const POLICY_VERSION = 1
const GENERATED_ARTIFACTS = ["graph.json", "manifest.json", ".graphify_root", ".graphify_semantic_marker", ".opencode-empty-corpus", "cache"] as const
const GLOBAL_MANIFEST = "global-manifest.json"
const GLOBAL_GRAPH = "global-graph.json"
const GLOBAL_LOCK = ".opencode-global-lock"
// Guards against two OpenCode sessions extracting the same repository at once. Holds the
// session's PID plus, once spawned, the extract child's PID (one per line): a SIGKILLed
// server orphans a still-running child, so the lock is stale only when EVERY recorded PID
// is dead — then it belonged to a fully crashed session and is silently replaced.
const LOCK_FILE = ".opencode-extract-lock"
const INDEX_COMMAND = "/graphify-index"
const INDEX_COMMAND_NAME = "graphify-index"
const INDEX_COMMAND_DESCRIPTION =
  "First-time code-only Graphify indexing with explicit human consent and automatic refreshes."
const INDEX_COMMAND_FILE = new URL("../commands/graphify-index.md", import.meta.url)
// Marker value for roots where `git rev-parse HEAD` resolves nothing (plain directories,
// repositories with no commits): the marker must still be written there, or the plugin
// would re-extract and re-toast the same empty corpus every session.
const EMPTY_MARKER_NO_COMMIT = "none"
// A repository holding no indexable code is not a failure, but Graphify reports it as one
// (exit 1, no graph.json). Only the end-of-run empty-graph line is unambiguous;
// a census line can also appear before a fixable error.
const EMPTY_CORPUS_PATTERN = /produced no nodes/i
// Graphify 0.9.28 swallows a failed global merge: it prints this warning to stderr and
// still exits 0, so a successful local build can silently skip global registration.
const GLOBAL_MERGE_WARNING_PATTERN = /\[graphify global\] warning/i
const EXTRACT_ARGS = ["extract"] as const
const CODE_ONLY_FLAG = "--code-only"
const AS_FLAG = "--as"
const VERSION_ARGS = ["--version"] as const
const GIT_EXCLUDE_ARGS = ["rev-parse", "--is-inside-work-tree", "--git-path", "info/exclude"] as const
const GIT_HEAD_ARGS = ["rev-parse", "HEAD"] as const
const GIT_HEAD_TIME_ARGS = ["log", "-1", "--format=%ct"] as const
const GIT_WORK_TREE_RESULT = "true"
const NOT_GIT_REPOSITORY_ERROR = "not a git repository"
const IGNORED_DIRECTORY_NAMES = new Set(["node_modules"])
const NESTED_REPO_MAX_DEPTH = 2
const MAX_SUMMARY_FAILURES = 3
const MAX_CAPTURED_OUTPUT_LENGTH = 1_000
const INFO_DURATION_MS = 5_000
const HINT_DURATION_MS = 8_000
const WARNING_DURATION_MS = 8_000
const ERROR_DURATION_MS = 8_000
// Toasts ride the event bus (`tui.toast.show`), and bus events published before a subscriber
// attaches are dropped. The TUI subscribes to /event a second or two AFTER the instance
// bootstraps — after this plugin has already scanned and toasted — and `server.connected` is
// written straight to the new subscriber's SSE stream, never through the bus, so a plugin
// cannot observe the TUI attaching. Toasts therefore queue until the first bus event this
// plugin receives (a client is interacting, so it is subscribed) or until a fallback delay
// comfortably past any real TUI subscription, whichever comes first. The env override exists
// solely so the test suite can shrink or stretch the delay; it never changes behavior shape.
const TOAST_READY_FALLBACK_MS = 10_000
const TOAST_DELAY_ENV = "OPENCODE_GRAPHIFY_TOAST_DELAY_MS"
// No spawn may hang forever. The extract holds the per-repo lock for its whole run, and the
// lock is only released when the call resolves — so a wedged child (a docs-mode backend call
// that never answers, a git probe on an unreachable network mount) blocks every later session
// in that repository until the server process itself dies. On expiry the child is killed and
// the call resolves as a failure, taking the normal failure path that releases the lock.
// Probes are sub-second in practice; extract is minutes in docs mode, so its budget is wide
// enough that only a genuinely stuck run hits it. The env override exists solely so the test
// suite can shrink the extract budget; it never changes behavior shape.
const PROBE_TIMEOUT_MS = 15_000
const EXTRACT_TIMEOUT_MS = 30 * 60 * 1_000
const EXTRACT_TIMEOUT_ENV = "OPENCODE_GRAPHIFY_EXTRACT_TIMEOUT_MS"
// SIGTERM first, so Graphify can unwind; SIGKILL is the backstop for a child that ignores it.
const KILL_GRACE_MS = 2_000
const timedOutMessage = (binary: string, timeoutMs: number) =>
  `${binary} exceeded its ${Math.round(timeoutMs / 1_000)}s budget and was terminated`

const TOAST_VARIANTS = {
  ERROR: "error",
  INFO: "info",
  SUCCESS: "success",
  WARNING: "warning",
} as const

type ToastVariant = (typeof TOAST_VARIANTS)[keyof typeof TOAST_VARIANTS]

type CommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  error?: Error
}

type ToastClient = {
  tui: {
    showToast(options: {
      body: {
        message: string
        variant: ToastVariant
        duration: number
      }
      query: {
        directory: string
      }
    }): Promise<unknown>
  }
}

type ToastInput = {
  client: ToastClient
  directory: string
}

type RepoAction = "build" | "update"

type IndexState = { mode: typeof MODE_CODE_ONLY; policyVersion?: number; pendingGlobal?: boolean }

const buildStartMessage = (repo: string) =>
  `Graphify is building the code graph for ${repo} in the background. You can keep working.`

const updateStartMessage = (repo: string) =>
  `Graphify is updating the ${repo} code graph in the background. You can keep working.`

const successMessage = (repo: string, nodeCount: number | undefined, elapsed: string) =>
  nodeCount === undefined
    ? `Graphify graph for ${repo} is ready in ${elapsed}.`
    : `Graphify graph for ${repo} is ready: ${nodeCount} nodes in ${elapsed}.`

const emptyCorpusMessage = (repo: string) =>
  `Graphify found no indexable code in ${repo}; skipping the code graph.`

// Exit-0 shrink: unlike the exit-1 empty corpus, a graph WAS written (0 nodes) and, with
// the global merge inline, already registered globally — "skipping" would be inaccurate.
const zeroNodeMessage = (repo: string) =>
  `Graphify found no indexable code left in ${repo}; the graph is now empty.`

const aggregateEmptyMessage = (rootName: string) =>
  `Graphify found no indexable code in the repositories under ${rootName}; skipping the code graphs.`

// The local graph IS ready in this case — only its cross-repository registration failed,
// and Graphify exits 0 after that failure, so without this toast it would go unnoticed.
const globalMergeWarningMessage = (repo: string, command: string) =>
  `Graphify could not merge ${repo} into the global graph; cross-repository queries stay stale. Run: ${command}`

const missingBinaryMessage = () => `Graphify CLI was not found. Run: ${GRAPHIFY_INSTALL_HINT}`

const incompleteMessage = (repo: string, command: string) =>
  `Graphify graph for ${repo} is incomplete (${OUT_BASE}/${OUT_DIR}/${GRAPH_FILE} is missing or unreadable). Run: ${command}`

const processFailureMessage = (repo: string, command: string) =>
  `Graphify indexing failed for ${repo}, but this session is still operational. Run: ${command}`

// First indexing is human-gated: these hints are the only thing the plugin does for a
// repository that has never been through /graphify-index.
const noGraphMessage = (repo: string) =>
  `No Graphify graph exists for ${repo} yet. Run ${INDEX_COMMAND} to authorize code-only indexing. Refreshes after that are incremental and automatic.`

const repositoriesLabel = (count: number) => `${count} ${count === 1 ? "repository" : "repositories"}`

const aggregateNoGraphMessage = (count: number, rootName: string) =>
  `${repositoriesLabel(count)} under ${rootName} ${count === 1 ? "has" : "have"} no Graphify graph yet. Run ${INDEX_COMMAND} from ${rootName} to build them; refreshes after that are incremental and automatic.`

const aggregateStartMessage = (count: number, rootName: string) =>
  `Graphify is building code graphs for ${repositoriesLabel(count)} under ${rootName} in the background. You can keep working.`

const aggregateSuccessMessage = (count: number, rootName: string, elapsed: string) =>
  `Graphify built code graphs for ${repositoriesLabel(count)} under ${rootName} in ${elapsed}.`

const aggregateFailureMessage = (okCount: number, total: number, rootName: string, failedNames: string[]) => {
  const shown = failedNames.slice(0, MAX_SUMMARY_FAILURES)
  const overflow = failedNames.length - shown.length
  const list = overflow > 0 ? `${shown.join(", ")}, +${overflow} more` : shown.join(", ")
  return `Graphify built ${okCount} of ${total} code graphs under ${rootName}. Failed: ${list}. Reopen the session to retry, or run ${INDEX_COMMAND}.`
}

function projectRoot(input: { worktree?: string; directory: string }) {
  const reportedWorktree = input.worktree ?? ""
  if (!reportedWorktree || reportedWorktree === path.parse(reportedWorktree).root) return input.directory
  return reportedWorktree
}

function repoName(root: string) {
  return path.basename(root) || root
}

function quoteForDisplay(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

// The recovery command must carry the same GRAPHIFY_OUT the plugin uses; without it a
// user-run extract would rebuild under the CLI's default graphify-out/ at the repo root.
function outEnvPrefix() {
  return `${GRAPHIFY_OUT_ENV}=${OUT_RELATIVE}`
}

function recoveryBuildCommand(root: string) {
  return [outEnvPrefix(), GRAPHIFY_BINARY, EXTRACT_ARGS[0], quoteForDisplay(root), CODE_ONLY_FLAG].join(" ")
}

function formatElapsed(elapsedMs: number) {
  return `${Math.max(0.1, elapsedMs / 1_000).toFixed(1)}s`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

let indexCommandTemplate: Promise<string> | undefined

function loadIndexCommandTemplate() {
  indexCommandTemplate ??= fs.readFile(INDEX_COMMAND_FILE, "utf8").then((template) => template.trim())
  return indexCommandTemplate
}

export async function registerGraphifyIndexCommand(config: Config) {
  config.command ??= {}
  if (config.command[INDEX_COMMAND_NAME]) {
    return
  }

  config.command[INDEX_COMMAND_NAME] = {
    template: await loadIndexCommandTemplate(),
    description: INDEX_COMMAND_DESCRIPTION,
    agent: "build",
  }
}

// Keep the TAIL of each stream: Graphify's decisive lines — the empty-corpus signal and
// any exception message — are emitted at the end of a run, after arbitrary progress output.
function appendBoundedOutput(current: string, chunk: unknown) {
  return `${current}${String(chunk)}`.slice(-MAX_CAPTURED_OUTPUT_LENGTH)
}

// A Graphify extract spawned without shutdown hooks outlives the OpenCode process — the
// child is re-parented to PID 1 and keeps burning CPU (and, in docs mode, LLM tokens)
// after the session is gone. Shutdown hooks request termination; they cannot prove
// that a process tree stopped. A SIGKILLed parent leaves the lock for manual recovery.
const liveChildren = new Set<ChildProcess>()
let shutdownHooksInstalled = false
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const

function killLiveChildren() {
  for (const child of liveChildren) {
    try {
      child.kill("SIGTERM")
    } catch (error) {
      console.error(`${LOG_PREFIX} cannot kill child process: ${errorMessage(error)}`)
    }
  }
  liveChildren.clear()
}

function installShutdownHooks() {
  if (shutdownHooksInstalled) return
  shutdownHooksInstalled = true
  process.once("exit", killLiveChildren)
  for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
    process.once(signal as NodeJS.Signals, () => {
      killLiveChildren()
      // Mimic the signal's default disposition only when nothing else handles it; when the
      // host has its own graceful-shutdown handler, that handler decides when the process ends.
      if (process.listenerCount(signal) === 0) process.exit(exitCode)
    })
  }
}

function extractTimeoutMs() {
  const raw = process.env[EXTRACT_TIMEOUT_ENV]
  if (raw !== undefined) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return EXTRACT_TIMEOUT_MS
}

type RunOptions = {
  env?: Record<string, string>
  onSpawn?: (child: ChildProcess) => void
  timeoutMs?: number
}

function runCommand(
  binary: string,
  args: readonly string[],
  root: string,
  options: RunOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    installShutdownHooks()
    const child = spawn(binary, [...args], {
      cwd: root,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    liveChildren.add(child)
    options.onSpawn?.(child)
    let stdout = ""
    let stderr = ""
    let spawnError: Error | undefined

    const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal)
      } catch (error) {
        console.error(`${LOG_PREFIX} cannot terminate ${binary}: ${errorMessage(error)}`)
      }
    }
    // Reported as a spawn error, not a non-zero exit: a terminated run has no output to
    // classify, so it must never be mistaken for an empty corpus.
    const budgetTimer = setTimeout(() => {
      spawnError = new Error(timedOutMessage(binary, timeoutMs))
      kill("SIGTERM")
      killTimer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS)
      killTimer.unref?.()
    }, timeoutMs)
    // Timers must never keep the host process alive on their own.
    budgetTimer.unref?.()

    child.stdout?.on("data", (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk)
    })
    child.once("error", (error) => {
      spawnError = error
    })
    child.once("close", (exitCode) => {
      clearTimeout(budgetTimer)
      if (killTimer) clearTimeout(killTimer)
      liveChildren.delete(child)
      resolve({ exitCode, stdout, stderr, error: spawnError })
    })
  })
}

// Every Graphify call carries GRAPHIFY_OUT, including the --version probe: the value is what
// makes the CLI and the MCP server agree on where this repository's graph lives.
function runGraphify(args: readonly string[], root: string, options: Omit<RunOptions, "env"> = {}) {
  return runCommand(GRAPHIFY_BINARY, args, root, { ...options, env: { [GRAPHIFY_OUT_ENV]: OUT_RELATIVE } })
}

function isMissingBinary(result: CommandResult) {
  return Boolean(result.error && "code" in result.error && result.error.code === "ENOENT")
}

// Only ENOENT matters here: a Graphify build is expensive and a whole aggregate run
// should surface one install hint instead of N failures. A non-zero exit still counts
// as "present" so an unrecognized probe flag never blocks indexing.
async function isBinaryMissing(root: string) {
  return isMissingBinary(await runGraphify(VERSION_ARGS, root))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function outBasePath(root: string) {
  return path.join(root, OUT_BASE)
}

function outDirPath(root: string) {
  return path.join(outBasePath(root), OUT_DIR)
}

function graphFilePath(root: string) {
  return path.join(outDirPath(root), GRAPH_FILE)
}

function nodeCountOf(payload: unknown) {
  if (!isRecord(payload)) return undefined
  if (Array.isArray(payload.nodes)) return payload.nodes.length
  if (isRecord(payload.stats) && typeof payload.stats.nodes === "number") return payload.stats.nodes
  return undefined
}

type GraphSnapshot = { mtimeMs: number; builtAtCommit: string | undefined; nodeCount: number | undefined }

// A graph that cannot be parsed is treated as absent: a truncated or half-written
// graph.json is worse than no graph, and a full rebuild is the only safe repair.
async function readGraph(root: string): Promise<GraphSnapshot | undefined> {
  const graphPath = graphFilePath(root)
  try {
    const stat = await fs.stat(graphPath)
    if (!stat.isFile()) return undefined
    const payload: unknown = JSON.parse(await fs.readFile(graphPath, "utf8"))
    if (!isRecord(payload)) return undefined
    const builtAtCommit = typeof payload.built_at_commit === "string" ? payload.built_at_commit : undefined
    return { mtimeMs: stat.mtimeMs, builtAtCommit, nodeCount: nodeCountOf(payload) }
  } catch {
    return undefined
  }
}

async function gitValue(root: string, args: readonly string[]) {
  const result = await runCommand(GIT_BINARY, args, root)
  if (result.error || result.exitCode !== 0) return undefined
  return result.stdout.trim() || undefined
}

// Graphify stamps the commit it indexed into graph.json, so freshness is an exact
// comparison rather than a guess. Older graphs (or builds made outside Git) carry no
// stamp; those fall back to comparing file mtime against the last commit time, which
// is coarser but still catches a graph left behind by newer work.
async function isGraphStale(root: string, graph: GraphSnapshot) {
  const head = await gitValue(root, GIT_HEAD_ARGS)
  if (!head) return false
  if (graph.builtAtCommit) return graph.builtAtCommit !== head

  const headTime = Number.parseInt((await gitValue(root, GIT_HEAD_TIME_ARGS)) ?? "", 10)
  if (!Number.isFinite(headTime)) return false
  return graph.mtimeMs < headTime * 1_000
}

function emptyMarkerPath(root: string) {
  return path.join(outDirPath(root), EMPTY_MARKER_FILE)
}

// A documentation-only repository produces no graph and no toast, but Graphify still exits
// non-zero every time it is asked. The marker records the commit that had nothing to index so
// reopening that repository stays quiet, while any new commit earns a fresh attempt.
async function readEmptyMarker(root: string) {
  try {
    return (await fs.readFile(emptyMarkerPath(root), "utf8")).trim() || undefined
  } catch {
    return undefined
  }
}

async function writeEmptyMarker(root: string, commit: string | undefined) {
  try {
    await fs.writeFile(emptyMarkerPath(root), `${commit ?? EMPTY_MARKER_NO_COMMIT}\n`)
    return true
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot record empty-corpus marker for ${root}: ${errorMessage(error)}`)
    return false
  }
}

// A successful build invalidates any earlier empty-corpus marker; leaving it behind would
// make a later checkout of the once-empty commit silently serve the newer graph as current.
async function clearEmptyMarker(root: string) {
  try {
    await fs.unlink(emptyMarkerPath(root))
    return true
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return true
    console.error(`${LOG_PREFIX} cannot clear empty-corpus marker for ${root}: ${errorMessage(error)}`)
    return false
  }
}

function modeFilePath(root: string) {
  return path.join(outDirPath(root), MODE_FILE)
}

async function readIndexState(root: string): Promise<IndexState | undefined> {
  try {
    const payload: unknown = JSON.parse(await fs.readFile(modeFilePath(root), "utf8"))
    if (!isRecord(payload) || (payload.mode !== MODE_CODE_ONLY && payload.mode !== "docs")) return undefined
    return { mode: MODE_CODE_ONLY,
      policyVersion: payload.mode === MODE_CODE_ONLY && payload.policyVersion === POLICY_VERSION ? POLICY_VERSION : undefined,
      pendingGlobal: payload.pendingGlobal === true }
  } catch {
    return undefined
  }
}

async function persistIndexState(root: string, state: IndexState) {
  const target = modeFilePath(root)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx" })
    await fs.rename(temporary, target)
    return true
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot record indexing policy for ${root}: ${errorMessage(error)}`)
    await fs.rm(temporary, { force: true }).catch(() => {})
    return false
  }
}

function lockFilePath(root: string) {
  return path.join(outDirPath(root), LOCK_FILE)
}

async function safeStateDirectory(root: string) {
  for (const dir of [outBasePath(root), outDirPath(root)]) {
    try {
      const stat = await fs.lstat(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") return false
      try { await fs.mkdir(dir) } catch { return false }
    }
  }
  return true
}

// Exclusive creation is the only portable claim. Never read/unlink an existing lock:
// even a dead PID is not proof that another claimant has not just replaced it.
async function acquireLock(lockPath: string): Promise<FileHandle | undefined> {
  try {
    const handle = await fs.open(lockPath, "wx", 0o600)
    try {
      await handle.writeFile(`${process.pid}\n`)
      return handle
    } catch (error) {
      await handle.close()
      console.error(`${LOG_PREFIX} cannot initialize lock ${lockPath}: ${errorMessage(error)}`)
      return undefined // Retain the uncertain lock for explicit recovery.
    }
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      console.error(`${LOG_PREFIX} lock already exists at ${lockPath}; refusing automatic takeover`)
    } else console.error(`${LOG_PREFIX} cannot acquire lock ${lockPath}: ${errorMessage(error)}`)
    return undefined
  }
}

async function acquireExtractLock(root: string) {
  if (!(await safeStateDirectory(root))) return undefined
  return acquireLock(lockFilePath(root))
}

// Record the *correct lock's* direct CLI PID before deciding whether it can be released.
// The lock remains authoritative even when the parent PID is dead or PID reuse occurs.
async function recordLockChildPid(lock: FileHandle, childPid: number | undefined) {
  if (childPid === undefined) return false
  try {
    const bytes = Buffer.from(`${process.pid}\n${childPid}\n`)
    const result = await lock.write(bytes, 0, bytes.length, 0)
    if (result.bytesWritten !== bytes.length) return false
    await lock.truncate(bytes.length)
    return true
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot record CLI child PID: ${errorMessage(error)}`)
    return false
  }
}

async function releaseLock(lockPath: string, lock: FileHandle, safeToRelease: boolean) {
  try {
    if (!safeToRelease) return // A failed/interrupted CLI may have surviving writers.
    const [held, current] = await Promise.all([lock.stat(), fs.lstat(lockPath)])
    if (current.isFile() && !current.isSymbolicLink() && held.dev === current.dev && held.ino === current.ino) {
      await fs.unlink(lockPath)
    } else console.error(`${LOG_PREFIX} lock owner changed at ${lockPath}; retaining it`)
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot release lock ${lockPath}: ${errorMessage(error)}`)
  } finally {
    await lock.close().catch(() => {})
  }
}

async function cleanGeneratedArtifacts(root: string) {
  const directory = outDirPath(root)
  // Preflight all targets before touching any; never follow an unexpected symlink.
  for (const name of GENERATED_ARTIFACTS) {
    try {
      const stat = await fs.lstat(path.join(directory, name))
      if (stat.isSymbolicLink() || (name === "cache" ? !stat.isDirectory() : !stat.isFile())) return false
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") return false
    }
  }
  for (const name of GENERATED_ARTIFACTS) {
    const target = path.join(directory, name)
    if (name === "cache") {
      // A recursive removal can traverse an attacker-swapped path; refuse nested symlinks.
      const scan = async (dir: string): Promise<boolean> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) return false
          if (entry.isDirectory() && !(await scan(path.join(dir, entry.name)))) return false
        }
        return true
      }
      try { if (!(await scan(target))) return false } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") return false
      }
    }
    try { await fs.rm(target, { recursive: name === "cache", force: true }) } catch { return false }
  }
  return true
}

function globalDirectory() {
  return path.join(process.env.HOME ?? "", ".graphify")
}

async function reconcileGlobal(root: string, empty: boolean) {
  if (!isGlobalEnabled()) return false
  const home = process.env.HOME
  if (!home || !path.isAbsolute(home)) return false
  const dir = globalDirectory()
  try {
    const stat = await fs.lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") return false
    try { await fs.mkdir(dir) } catch { return false }
  }
  const lockPath = path.join(dir, GLOBAL_LOCK)
  const lock = await acquireLock(lockPath)
  if (!lock) return false
  let safeToRelease = true
  try {
    const manifestPath = path.join(dir, GLOBAL_MANIFEST)
    const graphPath = path.join(dir, GLOBAL_GRAPH)
    const existing = await Promise.all([manifestPath, graphPath].map(async (file) => {
      try {
        const stat = await fs.lstat(file)
        return stat.isFile() && !stat.isSymbolicLink() ? "file" : "unsafe"
      } catch (error) { return isRecord(error) && error.code === "ENOENT" ? "absent" : "unsafe" }
    }))
    if (existing.includes("unsafe") || (existing[0] === "absent" && existing[1] === "file") ||
      (existing[0] === "file" && existing[1] === "absent")) return false
    let repos: Record<string, unknown> = {}
    if (existing[0] === "file") {
        const data: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"))
      if (!isRecord(data) || !isRecord(data.repos)) return false
      repos = data.repos
      const graph: unknown = JSON.parse(await fs.readFile(graphPath, "utf8"))
      if (!isRecord(graph) || !Array.isArray(graph.nodes) ||
        !(Array.isArray(graph.links) || Array.isArray(graph.edges))) return false
      // A malformed entry could conceal a conflicting owner: never pass it to the CLI.
      if (Object.values(repos).some((entry) => !isRecord(entry) || typeof entry.source_path !== "string")) return false
    }
    const tag = slugify(repoName(await realRoot(root)))
    const owner = repos[tag]
    const ownedPath = await fs.realpath(outDirPath(root))
    const expected = path.join(ownedPath, GRAPH_FILE)
    if (owner && (!isRecord(owner) || owner.source_path !== expected)) return false
    if (!empty) {
      const stat = await fs.lstat(graphFilePath(root))
      if (!stat.isFile() || stat.isSymbolicLink() || (await fs.realpath(graphFilePath(root))) !== expected) return false
    }
    if (empty && !owner) return true
    const args = empty ? ["global", "remove", tag] : ["global", "add", expected, AS_FLAG, tag]
    let childPidRecorded: Promise<boolean> = Promise.resolve(false)
    const run = await runGraphify(args, root, {
      onSpawn: (child) => {
        safeToRelease = false
        childPidRecorded = recordLockChildPid(lock, child.pid)
      },
      timeoutMs: extractTimeoutMs(),
    })
    if (!(await childPidRecorded) || run.error || run.exitCode !== 0 || GLOBAL_MERGE_WARNING_PATTERN.test(run.stderr)) return false
    safeToRelease = true
    return true
  } catch (error) {
    console.error(`${LOG_PREFIX} global reconciliation refused: ${errorMessage(error)}`)
    return false
  } finally {
    await releaseLock(lockPath, lock, safeToRelease)
  }
}

type RepoPlan = { kind: "none" | "needs-consent" } | { kind: RepoAction | "reconcile" }

async function planRepo(root: string): Promise<RepoPlan> {
  const state = await readIndexState(root)
  const graph = await readGraph(root)
  const emptyAtCommit = await readEmptyMarker(root)
  // A readable legacy graph or empty marker is previously accepted authorization, even
  // without a mode file. Neither an old code-only label nor a fresh HEAD proves purity.
  if (!state && !graph && !emptyAtCommit) return { kind: "needs-consent" }
  if (state?.policyVersion !== POLICY_VERSION) return { kind: "build" }
  const head = (await gitValue(root, GIT_HEAD_ARGS)) ?? EMPTY_MARKER_NO_COMMIT
  if (emptyAtCommit === head || (graph && !(await isGraphStale(root, graph)))) {
    return state.pendingGlobal && isGlobalEnabled() ? { kind: "reconcile" } : { kind: "none" }
  }
  return { kind: graph ? "update" : "build" }
}

async function realRoot(dir: string) {
  try {
    return await fs.realpath(dir)
  } catch {
    return path.resolve(dir)
  }
}

function slugify(value: string) {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, "-")
}

function isGlobalEnabled() {
  return process.env[GLOBAL_ENV] !== GLOBAL_OPT_OUT
}

type PendingToast = {
  input: ToastInput
  message: string
  variant: ToastVariant
  duration: number
}

let toastClientReady = false
let toastFallbackTimer: ReturnType<typeof setTimeout> | undefined
const pendingToasts: PendingToast[] = []

function toastFallbackDelayMs() {
  const raw = process.env[TOAST_DELAY_ENV]
  if (raw !== undefined) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return TOAST_READY_FALLBACK_MS
}

async function sendToast(input: ToastInput, message: string, variant: ToastVariant, duration: number) {
  try {
    await input.client.tui.showToast({
      body: { message, variant, duration },
      query: { directory: input.directory },
    })
  } catch (error) {
    console.error(`${LOG_PREFIX} toast failed: ${errorMessage(error)}`)
  }
}

// Only events a connected client causes prove the TUI is subscribed. Server housekeeping
// (file watcher, VCS branch detection, LSP) also rides the bus during boot, before any
// subscriber exists — flushing on those would lose the queue all over again.
const CLIENT_EVENT_PREFIXES = ["session.", "message.", "permission.", "tui.", "command."] as const

function isClientDrivenEvent(type: string) {
  return CLIENT_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix))
}

async function releaseQueuedToasts() {
  if (toastClientReady) return
  toastClientReady = true
  if (toastFallbackTimer !== undefined) {
    clearTimeout(toastFallbackTimer)
    toastFallbackTimer = undefined
  }
  for (const toast of pendingToasts.splice(0)) {
    await sendToast(toast.input, toast.message, toast.variant, toast.duration)
  }
}

// unref keeps the timer from holding the server process open at shutdown; pending toasts
// simply die with the process, which is the right outcome for a session nobody ever saw.
function armToastFallback() {
  if (toastClientReady || toastFallbackTimer !== undefined) return
  toastFallbackTimer = setTimeout(() => {
    toastFallbackTimer = undefined
    void releaseQueuedToasts()
  }, toastFallbackDelayMs())
  toastFallbackTimer.unref?.()
}

async function showToastBestEffort(
  input: ToastInput,
  message: string,
  variant: ToastVariant,
  duration: number,
) {
  if (!toastClientReady) {
    pendingToasts.push({ input, message, variant, duration })
    return
  }
  await sendToast(input, message, variant, duration)
}

async function resolveGitExcludePath(root: string) {
  const result = await runCommand(GIT_BINARY, GIT_EXCLUDE_ARGS, root)
  const stderr = result.stderr.trim()
  if (result.error || result.exitCode !== 0) {
    if (!result.error && stderr.toLowerCase().includes(NOT_GIT_REPOSITORY_ERROR)) return
    const detail = result.error ? errorMessage(result.error) : stderr || `exit ${result.exitCode}`
    console.error(`${LOG_PREFIX} cannot resolve Git exclude path: ${detail}`)
    return
  }

  const [insideWorkTree, excludePath] = result.stdout.trim().split(/\r?\n/, 2)
  if (insideWorkTree !== GIT_WORK_TREE_RESULT) return
  if (!excludePath) {
    console.error(`${LOG_PREFIX} Git did not return an exclude path`)
    return
  }
  return path.resolve(root, excludePath)
}

async function ensureGitExclude(root: string, artifactPath: string) {
  const relativeArtifactPath = path.relative(root, artifactPath)
  if (!relativeArtifactPath || relativeArtifactPath.startsWith("..") || path.isAbsolute(relativeArtifactPath)) {
    console.error(`${LOG_PREFIX} cannot exclude artifact path outside project: ${artifactPath}`)
    return
  }

  const entry = relativeArtifactPath.split(path.sep).join("/").replace(/\/$/, "")
  const excludePath = await resolveGitExcludePath(root)
  if (!excludePath) return

  let text: string
  try {
    text = await fs.readFile(excludePath, "utf8")
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot read Git exclude file: ${errorMessage(error)}`)
    return
  }
  if (text.split(/\r?\n/).includes(entry)) return

  try {
    await fs.appendFile(excludePath, text.endsWith("\n") ? `${entry}\n` : `\n${entry}\n`)
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot update Git exclude file: ${errorMessage(error)}`)
  }
}

type RepoOutcome =
  | { kind: "reconciled"; globalRecovery?: string }
  | { kind: "ready"; action: RepoAction; nodeCount: number | undefined; globalRecovery?: string }
  | { kind: "empty"; globalRecovery?: string }
  | { kind: "zero-nodes"; globalRecovery?: string }
  | { kind: "locked" }
  | { kind: "action-failed"; action: RepoAction }
  | { kind: "incomplete"; action: RepoAction }

// Manual recovery must first inspect the global manifest owner; this is a hint, not permission.
function recoveryGlobalCommand(root: string, tag: string, empty: boolean) {
  if (empty) return `${GRAPHIFY_BINARY} global remove ${quoteForDisplay(tag)}`
  const graphPath = path.join(root, OUT_RELATIVE, GRAPH_FILE)
  return [GRAPHIFY_BINARY, "global", "add", quoteForDisplay(graphPath), AS_FLAG, tag].join(" ")
}

// Build or refresh one repository's graph. The caller emits toasts; onStart runs immediately
// before the Graphify process spawns so a presenter can time it and announce it.
async function buildRepoGraph(
  root: string,
  action: RepoAction,
  onStart: (action: RepoAction) => Promise<void>,
): Promise<RepoOutcome> {
  const lock = await acquireExtractLock(root)
  if (!lock) return { kind: "locked" }
  let safeToRelease = true
  try {
    // Replan under exclusive ownership: another session may have completed the migration.
    const current = await planRepo(root)
    if (current.kind === "none" || current.kind === "needs-consent") return { kind: "locked" }
    const tag = slugify(repoName(await realRoot(root)))
    const state = await readIndexState(root)
    const migrate = state?.policyVersion !== POLICY_VERSION
    if (migrate && !(await cleanGeneratedArtifacts(root))) {
      console.error(`${LOG_PREFIX} unsafe generated artifacts; refusing migration for ${root}`)
      return { kind: "action-failed", action }
    }
    const args = [...EXTRACT_ARGS, root, CODE_ONLY_FLAG]
    await ensureGitExclude(root, outDirPath(root))
    const reconcile = async (empty: boolean) => {
      const ok = await reconcileGlobal(root, empty)
      const saved = ok && await persistIndexState(root, { mode: MODE_CODE_ONLY, policyVersion: POLICY_VERSION, pendingGlobal: false })
      if (!saved && isGlobalEnabled()) console.error(`${LOG_PREFIX} global reconciliation pending for ${root}`)
      return saved ? undefined : isGlobalEnabled() ? recoveryGlobalCommand(root, tag, empty) : undefined
    }
    if (current.kind === "reconcile") {
      const empty = (await readEmptyMarker(root)) !== undefined || (await readGraph(root))?.nodeCount === 0
      const recovery = await reconcile(empty)
      return { kind: "reconciled", globalRecovery: recovery }
    }
    await onStart(action)
    // Graphify stamps built_at_commit at EXPORT time, after scanning: a commit landing
    // mid-extract yields old content under a fresh stamp, which the staleness check would
    // then trust forever. Comparing HEAD around the run catches that; one bounded retry
    // (incremental, so cheap) absorbs the common single-commit race.
    for (let attempt = 0; ; attempt += 1) {
      const headBefore = await gitValue(root, GIT_HEAD_ARGS)
      // Awaited after the run so releasing the lock can never race a still-pending write.
      let childPidRecorded: Promise<boolean> = Promise.resolve(false)
      const run = await runGraphify(args, root, {
        onSpawn: (child) => {
          safeToRelease = false
          childPidRecorded = recordLockChildPid(lock, child.pid)
        },
        timeoutMs: extractTimeoutMs(),
      })
      if (!(await childPidRecorded)) return { kind: "action-failed", action }
      if (run.error || run.exitCode !== 0) {
        if (!run.error && EMPTY_CORPUS_PATTERN.test(`${run.stdout}\n${run.stderr}`)) {
          if (headBefore !== (await gitValue(root, GIT_HEAD_ARGS))) return { kind: "action-failed", action }
          // An incremental empty result leaves old graph.json untouched; remove it too.
          if (!(await cleanGeneratedArtifacts(root))) return { kind: "action-failed", action }
          if (!(await writeEmptyMarker(root, headBefore))) return { kind: "action-failed", action }
          if (!(await persistIndexState(root, { mode: MODE_CODE_ONLY, policyVersion: POLICY_VERSION, pendingGlobal: true }))) return { kind: "action-failed", action }
          safeToRelease = true
          return { kind: "empty", globalRecovery: await reconcile(true) }
        }
        const detail = run.error ? errorMessage(run.error) : run.stderr.trim()
        if (detail) console.error(`${LOG_PREFIX} ${action} failed for ${root}: ${detail}`)
        return { kind: "action-failed", action }
      }

      const graph = await readGraph(root)
      if (!graph) return { kind: "incomplete", action }
      if (headBefore !== (await gitValue(root, GIT_HEAD_ARGS))) {
        if (attempt === 0) continue
        console.error(`${LOG_PREFIX} HEAD kept moving during extraction of ${root}; giving up for this session`)
        return { kind: "action-failed", action }
      }

      if (!(await clearEmptyMarker(root))) return { kind: "action-failed", action }
      if (!(await persistIndexState(root, { mode: MODE_CODE_ONLY, policyVersion: POLICY_VERSION, pendingGlobal: true }))) return { kind: "action-failed", action }
      safeToRelease = true
      const globalRecovery = await reconcile(graph.nodeCount === 0)
      if (graph.nodeCount === 0) return { kind: "zero-nodes", globalRecovery }
      return { kind: "ready", action, nodeCount: graph.nodeCount, globalRecovery }
    }
  } finally {
    await releaseLock(lockFilePath(root), lock, safeToRelease)
  }
}

async function presentSingleRoot(input: ToastInput, root: string, action: RepoAction) {
  const repo = repoName(root)
  let startedAt = Date.now()
  const onStart = async (started: RepoAction) => {
    startedAt = Date.now()
    const message = started === "update" ? updateStartMessage(repo) : buildStartMessage(repo)
    await showToastBestEffort(input, message, TOAST_VARIANTS.INFO, INFO_DURATION_MS)
  }

  const outcome = await buildRepoGraph(root, action, onStart)
  const warnGlobalMerge = async (recovery: string | undefined) => {
    if (!recovery) return
    await showToastBestEffort(input, globalMergeWarningMessage(repo, recovery), TOAST_VARIANTS.WARNING, WARNING_DURATION_MS)
  }
  switch (outcome.kind) {
    case "reconciled":
      await warnGlobalMerge(outcome.globalRecovery)
      return
    case "empty":
      await showToastBestEffort(input, emptyCorpusMessage(repo), TOAST_VARIANTS.INFO, INFO_DURATION_MS)
      await warnGlobalMerge(outcome.globalRecovery)
      return
    case "zero-nodes":
      await showToastBestEffort(input, zeroNodeMessage(repo), TOAST_VARIANTS.INFO, INFO_DURATION_MS)
      await warnGlobalMerge(outcome.globalRecovery)
      return
    case "locked":
      // Another live session is already extracting this repository; it owns the toasts.
      return
    case "action-failed":
      await showToastBestEffort(
        input,
        processFailureMessage(repo, recoveryBuildCommand(root)),
        TOAST_VARIANTS.ERROR,
        ERROR_DURATION_MS,
      )
      return
    case "incomplete":
      await showToastBestEffort(
        input,
        incompleteMessage(repo, recoveryBuildCommand(root)),
        TOAST_VARIANTS.WARNING,
        WARNING_DURATION_MS,
      )
      return
    case "ready":
      await showToastBestEffort(
        input,
        successMessage(repo, outcome.nodeCount, formatElapsed(Date.now() - startedAt)),
        TOAST_VARIANTS.SUCCESS,
        INFO_DURATION_MS,
      )
      await warnGlobalMerge(outcome.globalRecovery)
      return
  }
}

type WorkItem = { root: string; action: RepoAction }

async function presentAggregate(input: ToastInput, root: string, work: WorkItem[]) {
  const rootName = repoName(root)
  await showToastBestEffort(input, aggregateStartMessage(work.length, rootName), TOAST_VARIANTS.INFO, INFO_DURATION_MS)
  const startedAt = Date.now()
  const failed: string[] = []
  let built = 0
  let locked = 0
  for (const item of work) {
    // A nested repository with nothing to index is skipped, not counted as a failure.
    const outcome = await buildRepoGraph(item.root, item.action, async () => {})
    if (outcome.kind === "ready") built += 1
    else if (outcome.kind === "locked" || outcome.kind === "reconciled") locked += 1
    else if (outcome.kind !== "empty" && outcome.kind !== "zero-nodes") failed.push(item.root)
    // A failed global merge exits 0, so it never lands in `failed`; it gets its own toast.
    if ((outcome.kind === "ready" || outcome.kind === "zero-nodes" || outcome.kind === "empty" || outcome.kind === "reconciled") && outcome.globalRecovery) {
      await showToastBestEffort(
        input,
        globalMergeWarningMessage(repoName(item.root), outcome.globalRecovery),
        TOAST_VARIANTS.WARNING,
        WARNING_DURATION_MS,
      )
    }
  }

  if (failed.length === 0) {
    if (built === 0) {
      // Everything was locked by another session: that session owns the outcome toasts.
      if (locked > 0) return
      // Every nested repository turned out empty: say so instead of leaving the start
      // toast dangling with no resolution.
      await showToastBestEffort(input, aggregateEmptyMessage(rootName), TOAST_VARIANTS.INFO, INFO_DURATION_MS)
      return
    }
    await showToastBestEffort(
      input,
      aggregateSuccessMessage(built, rootName, formatElapsed(Date.now() - startedAt)),
      TOAST_VARIANTS.SUCCESS,
      INFO_DURATION_MS,
    )
    return
  }

  await showToastBestEffort(
    input,
    aggregateFailureMessage(
      built,
      work.length,
      rootName,
      failed.map((repo) => path.relative(root, repo)),
    ),
    TOAST_VARIANTS.WARNING,
    WARNING_DURATION_MS,
  )
}

async function hasGitEntry(dir: string) {
  try {
    const stat = await fs.stat(path.join(dir, ".git"))
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

// Find git repositories nested up to NESTED_REPO_MAX_DEPTH directory levels below a non-git
// workspace root. Symlinked directories are skipped (no cycle/escape risk); a directory holding
// a .git entry is a repository and is not descended into (its children are submodule territory).
async function discoverNestedRepos(root: string) {
  const repos: string[] = []

  async function scan(dir: string, depth: number) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".") || IGNORED_DIRECTORY_NAMES.has(entry.name)) continue
      const child = path.join(dir, entry.name)
      if (await hasGitEntry(child)) {
        repos.push(child)
        continue
      }
      if (depth < NESTED_REPO_MAX_DEPTH) await scan(child, depth + 1)
    }
  }

  await scan(root, 1)
  return repos.sort((a, b) => a.localeCompare(b))
}

// Planning is local (filesystem plus `git log`), so an already-indexed session never spawns
// Graphify at all and the binary probe happens exactly once, only when there is real work.
// No unsafe-root guard here: the plugin never indexes without a recorded mode file, so the
// worst a home-directory session can produce is a hint toast — /graphify-index (the only
// entry point that spends resources) keeps its own refusal of home and filesystem roots.
async function collectWork(roots: string[]) {
  const work: WorkItem[] = []
  const needsConsent: string[] = []
  for (const root of roots) {
    const plan = await planRepo(root)
    if (plan.kind === "needs-consent") needsConsent.push(root)
    else if (plan.kind !== "none") work.push({ root, action: plan.kind === "reconcile" ? "update" : plan.kind })
  }
  return { work, needsConsent }
}

async function initializeGraphify(input: ToastInput & { root: string }) {
  if (process.env[AUTOINIT_ENV] === AUTOINIT_OPT_OUT) return

  const { root } = input
  const aggregated = (await hasGitEntry(root)) ? [] : await discoverNestedRepos(root)
  const roots = aggregated.length > 0 ? aggregated : [root]

  const { work, needsConsent } = await collectWork(roots)

  // First indexing is human-gated: never-indexed roots get exactly one hint toast per
  // session (this initializer runs once per session) and zero Graphify processes.
  if (needsConsent.length > 0) {
    const message =
      aggregated.length === 0
        ? noGraphMessage(repoName(needsConsent[0]))
        : aggregateNoGraphMessage(needsConsent.length, repoName(root))
    await showToastBestEffort(input, message, TOAST_VARIANTS.INFO, HINT_DURATION_MS)
  }

  if (work.length === 0) return

  if (await isBinaryMissing(root)) {
    await showToastBestEffort(input, missingBinaryMessage(), TOAST_VARIANTS.WARNING, WARNING_DURATION_MS)
    return
  }

  if (aggregated.length === 0) return presentSingleRoot(input, work[0].root, work[0].action)
  return presentAggregate(input, root, work)
}

export const GraphifyInitPlugin: Plugin = async (input) => {
  const root = projectRoot(input)
  armToastFallback()
  void initializeGraphify({ client: input.client, directory: input.directory, root }).catch((error) => {
    console.error(`${LOG_PREFIX} ${errorMessage(error)}`)
  })
  return {
    config: registerGraphifyIndexCommand,
    // A client-driven bus event means a subscribed client is interacting, so queued
    // toasts can land; boot-time housekeeping events must not trip the latch.
    event: async ({ event }) => {
      if (isClientDrivenEvent(event?.type ?? "")) await releaseQueuedToasts()
    },
  }
}

export default {
  id: GRAPHIFY_INIT_PLUGIN_ID,
  server: GraphifyInitPlugin,
}
