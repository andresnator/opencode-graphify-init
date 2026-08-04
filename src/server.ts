import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

export const GRAPHIFY_INIT_PLUGIN_ID = "andresnator.graphify-init"
const LOG_PREFIX = "[graphify-init]"
const GRAPHIFY_BINARY = "graphify"
const GRAPHIFY_INSTALL_HINT = "uv tool install graphifyy (or pipx install graphifyy)"
const GIT_BINARY = "git"
const AUTOINIT_ENV = "OPENCODE_GRAPHIFY_AUTOINIT"
const GLOBAL_ENV = "OPENCODE_GRAPHIFY_GLOBAL"
const BACKEND_ENV = "OPENCODE_GRAPHIFY_BACKEND"
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
// The durable record of the human's /graphify-index decision for one repository. Its presence
// is what authorizes the plugin to (re)build; its content decides the extract flags on every
// refresh. Written by the command, and re-persisted by the plugin after each successful run so
// pre-command repositories migrate off the fallback derivation.
const MODE_FILE = ".opencode-index-mode"
const MODE_CODE_ONLY = "code-only"
const MODE_DOCS = "docs"
// Graphify writes this marker only when a semantic (LLM) pass actually spent output tokens,
// which makes it a reliable "this graph was built in docs mode" signal for repositories
// indexed before MODE_FILE existed.
const SEMANTIC_MARKER_FILE = ".graphify_semantic_marker"
// Guards against two OpenCode sessions extracting the same repository at once. Holds the
// session's PID plus, once spawned, the extract child's PID (one per line): a SIGKILLed
// server orphans a still-running child, so the lock is stale only when EVERY recorded PID
// is dead — then it belonged to a fully crashed session and is silently replaced.
const LOCK_FILE = ".opencode-extract-lock"
const INDEX_COMMAND = "/graphify-index"
// Marker value for roots where `git rev-parse HEAD` resolves nothing (plain directories,
// repositories with no commits): the marker must still be written there, or the plugin
// would re-extract and re-toast the same empty corpus every session.
const EMPTY_MARKER_NO_COMMIT = "none"
// A repository holding no indexable code is not a failure, but Graphify reports it as one
// (exit 1, no graph.json). Only the end-of-run empty-graph line is unambiguous: the census
// line ("found N code, N docs, ...") also appears when a docs-mode run dies later on a
// backend/credential error, and matching it would suppress retries of a fixable failure.
const EMPTY_CORPUS_PATTERN = /produced no nodes/i
// Graphify 0.9.28 swallows a failed global merge: it prints this warning to stderr and
// still exits 0, so a successful local build can silently skip global registration.
const GLOBAL_MERGE_WARNING_PATTERN = /\[graphify global\] warning/i
const EXTRACT_ARGS = ["extract"] as const
const CODE_ONLY_FLAG = "--code-only"
const BACKEND_FLAG = "--backend"
const GLOBAL_FLAG = "--global"
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

type IndexMode = { mode: typeof MODE_CODE_ONLY | typeof MODE_DOCS; backend?: string }

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
  `No Graphify graph exists for ${repo} yet. Run ${INDEX_COMMAND} to build one: code-only takes seconds; docs mode takes minutes and spends LLM tokens. Refreshes after that are incremental and automatic.`

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
  const worktree = input.worktree ?? ""
  if (!worktree || worktree === path.parse(worktree).root) return input.directory
  return worktree
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

function recoveryBuildCommand(root: string, mode: IndexMode) {
  return [outEnvPrefix(), GRAPHIFY_BINARY, EXTRACT_ARGS[0], quoteForDisplay(root), ...modeArgs(mode)].join(" ")
}

function formatElapsed(elapsedMs: number) {
  return `${Math.max(0.1, elapsedMs / 1_000).toFixed(1)}s`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// Keep the TAIL of each stream: Graphify's decisive lines — the empty-corpus signal and
// any exception message — are emitted at the end of a run, after arbitrary progress output.
function appendBoundedOutput(current: string, chunk: unknown) {
  return `${current}${String(chunk)}`.slice(-MAX_CAPTURED_OUTPUT_LENGTH)
}

// A Graphify extract spawned without shutdown hooks outlives the OpenCode process — the
// child is re-parented to PID 1 and keeps burning CPU (and, in docs mode, LLM tokens)
// after the session is gone. Killing tracked children on exit and on termination signals
// closes that leak; a SIGKILLed server still orphans the child, which the stale-lock
// check repairs on the next session.
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
    await fs.mkdir(outDirPath(root), { recursive: true })
    await fs.writeFile(emptyMarkerPath(root), `${commit ?? EMPTY_MARKER_NO_COMMIT}\n`)
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot record empty-corpus marker for ${root}: ${errorMessage(error)}`)
  }
}

// A successful build invalidates any earlier empty-corpus marker; leaving it behind would
// make a later checkout of the once-empty commit silently serve the newer graph as current.
async function clearEmptyMarker(root: string) {
  try {
    await fs.rm(emptyMarkerPath(root), { force: true })
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot clear empty-corpus marker for ${root}: ${errorMessage(error)}`)
  }
}

function modeFilePath(root: string) {
  return path.join(outDirPath(root), MODE_FILE)
}

async function readIndexMode(root: string): Promise<IndexMode | undefined> {
  try {
    const payload: unknown = JSON.parse(await fs.readFile(modeFilePath(root), "utf8"))
    if (!isRecord(payload)) return undefined
    if (payload.mode === MODE_CODE_ONLY) return { mode: MODE_CODE_ONLY }
    if (payload.mode === MODE_DOCS) {
      const backend = typeof payload.backend === "string" ? payload.backend.trim() : ""
      return backend ? { mode: MODE_DOCS, backend } : { mode: MODE_DOCS }
    }
    return undefined
  } catch {
    return undefined
  }
}

// Repositories indexed before the mode file existed still deserve mode-faithful refreshes:
// the semantic marker only appears when an LLM pass spent tokens, so marker ⇒ docs mode,
// no marker ⇒ code-only. For legacy docs graphs the backend pin comes from the same env var
// that built them, so stray credentials in the shell never re-route the corpus.
async function fallbackIndexMode(root: string): Promise<IndexMode> {
  try {
    await fs.stat(path.join(outDirPath(root), SEMANTIC_MARKER_FILE))
    const backend = process.env[BACKEND_ENV]?.trim()
    return backend ? { mode: MODE_DOCS, backend } : { mode: MODE_DOCS }
  } catch {
    return { mode: MODE_CODE_ONLY }
  }
}

// Re-persisted after every successful run so pre-command repositories migrate off the
// fallback derivation; for command-indexed repositories this round-trips the same content.
async function persistIndexMode(root: string, mode: IndexMode) {
  try {
    await fs.mkdir(outDirPath(root), { recursive: true })
    const payload = mode.backend ? { mode: mode.mode, backend: mode.backend } : { mode: mode.mode }
    await fs.writeFile(modeFilePath(root), `${JSON.stringify(payload)}\n`)
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot record index mode for ${root}: ${errorMessage(error)}`)
  }
}

// Refresh flags derive from the recorded decision, never from the environment: a repository
// indexed code-only stays code-only even when the shell exports docs-mode variables.
function modeArgs(mode: IndexMode) {
  if (mode.mode !== MODE_DOCS) return [CODE_ONLY_FLAG]
  return mode.backend ? [BACKEND_FLAG, mode.backend] : []
}

function lockFilePath(root: string) {
  return path.join(outDirPath(root), LOCK_FILE)
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return isRecord(error) && error.code === "EPERM"
  }
}

// Best-effort mutual exclusion between sessions: only a lock held by a LIVE process blocks;
// any filesystem trouble here must never block indexing itself. The lock lists the holding
// session's PID and its extract child's PID; a lock is stale only when all of them are dead,
// so a SIGKILLed server whose orphaned child is still extracting keeps blocking new sessions.
async function acquireExtractLock(root: string) {
  const lockPath = lockFilePath(root)
  try {
    await fs.mkdir(outDirPath(root), { recursive: true })
  } catch {
    return true
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(lockPath, `${process.pid}\n`, { flag: "wx" })
      return true
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") return true
      const pids = (await fs.readFile(lockPath, "utf8").catch(() => ""))
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value))
      const livePid = pids.find(isPidAlive)
      if (livePid !== undefined) {
        console.error(`${LOG_PREFIX} another session (pid ${livePid}) is already extracting ${root}; skipping`)
        return false
      }
      await fs.rm(lockPath, { force: true }).catch(() => {})
    }
  }
  return true
}

// Called once the extract child exists: from then on the lock survives a SIGKILL of the
// server, because the orphaned child's PID keeps it live until the extract itself ends.
async function recordLockChildPid(root: string, childPid: number | undefined) {
  if (childPid === undefined) return
  try {
    await fs.writeFile(lockFilePath(root), `${process.pid}\n${childPid}\n`)
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot record extract child pid: ${errorMessage(error)}`)
  }
}

async function releaseExtractLock(root: string) {
  await fs.rm(lockFilePath(root), { force: true }).catch(() => {})
}

type RepoPlan =
  | { kind: "none" }
  | { kind: "needs-consent" }
  | { kind: RepoAction; mode: IndexMode }

async function planRepo(root: string): Promise<RepoPlan> {
  // The marker wins even over an existing stale graph: a repository whose code was all
  // deleted keeps its last graph on disk while every re-extract at that commit keeps
  // reporting an empty corpus, so retrying before a new commit would loop forever.
  const emptyAtCommit = await readEmptyMarker(root)
  if (emptyAtCommit && emptyAtCommit === ((await gitValue(root, GIT_HEAD_ARGS)) ?? EMPTY_MARKER_NO_COMMIT)) {
    return { kind: "none" }
  }

  const graph = await readGraph(root)
  if (graph) {
    if (!(await isGraphStale(root, graph))) return { kind: "none" }
    return { kind: "update", mode: (await readIndexMode(root)) ?? (await fallbackIndexMode(root)) }
  }

  // No readable graph: the recorded mode file is standing consent, so a deleted or corrupt
  // graph rebuilds automatically. Without it the first indexing belongs to /graphify-index —
  // the plugin never starts one on its own.
  const mode = await readIndexMode(root)
  if (mode) return { kind: "build", mode }
  return { kind: "needs-consent" }
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
  | { kind: "ready"; action: RepoAction; nodeCount: number | undefined; globalRecovery?: string }
  | { kind: "empty" }
  | { kind: "zero-nodes"; globalRecovery?: string }
  | { kind: "locked" }
  | { kind: "action-failed"; action: RepoAction }
  | { kind: "incomplete"; action: RepoAction }

// `graphify global add` is a human-lifecycle verb, so it belongs only in recovery text.
function recoveryGlobalAddCommand(root: string, tag: string) {
  const graphPath = path.join(root, OUT_RELATIVE, GRAPH_FILE)
  return [GRAPHIFY_BINARY, "global", "add", quoteForDisplay(graphPath), AS_FLAG, tag].join(" ")
}

// Build or refresh one repository's graph. The caller emits toasts; onStart runs immediately
// before the Graphify process spawns so a presenter can time it and announce it.
async function buildRepoGraph(
  root: string,
  action: RepoAction,
  mode: IndexMode,
  onStart: (action: RepoAction) => Promise<void>,
): Promise<RepoOutcome> {
  if (!(await acquireExtractLock(root))) return { kind: "locked" }
  try {
    // Both rebuilds and refreshes go through `extract`: it is natively incremental
    // (manifest gate) and it honours GRAPHIFY_OUT, which keeps every artifact under .ai/.
    // `graphify update` would recreate graphify-out/ at the root regardless.
    // --global --as merges the result into ~/.graphify/global-graph.json inline.
    const tag = slugify(repoName(await realRoot(root)))
    const args = [...EXTRACT_ARGS, root, ...modeArgs(mode), ...(isGlobalEnabled() ? [GLOBAL_FLAG, AS_FLAG, tag] : [])]

    // Exclude before indexing, not after: Graphify honours .git/info/exclude, so the entry
    // is what keeps a rebuild from walking its own previous output.
    await ensureGitExclude(root, outDirPath(root))

    await onStart(action)
    // Graphify stamps built_at_commit at EXPORT time, after scanning: a commit landing
    // mid-extract yields old content under a fresh stamp, which the staleness check would
    // then trust forever. Comparing HEAD around the run catches that; one bounded retry
    // (incremental, so cheap) absorbs the common single-commit race.
    for (let attempt = 0; ; attempt += 1) {
      const headBefore = await gitValue(root, GIT_HEAD_ARGS)
      // Awaited after the run so releasing the lock can never race a still-pending write.
      let childPidRecorded: Promise<void> = Promise.resolve()
      const run = await runGraphify(args, root, {
        onSpawn: (child) => {
          childPidRecorded = recordLockChildPid(root, child.pid)
        },
        timeoutMs: extractTimeoutMs(),
      })
      await childPidRecorded
      if (run.error || run.exitCode !== 0) {
        if (!run.error && EMPTY_CORPUS_PATTERN.test(`${run.stdout}\n${run.stderr}`)) {
          await writeEmptyMarker(root, await gitValue(root, GIT_HEAD_ARGS))
          return { kind: "empty" }
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

      const globalRecovery = GLOBAL_MERGE_WARNING_PATTERN.test(`${run.stdout}\n${run.stderr}`)
        ? recoveryGlobalAddCommand(root, tag)
        : undefined
      await persistIndexMode(root, mode)
      // A repository whose code was all deleted refreshes to a 0-node graph with exit 0; that is
      // "nothing to index", not a success. No marker: the freshly stamped graph keeps reopens quiet.
      if (graph.nodeCount === 0) return { kind: "zero-nodes", globalRecovery }

      await clearEmptyMarker(root)
      return { kind: "ready", action, nodeCount: graph.nodeCount, globalRecovery }
    }
  } finally {
    await releaseExtractLock(root)
  }
}

async function presentSingleRoot(input: ToastInput, root: string, action: RepoAction, mode: IndexMode) {
  const repo = repoName(root)
  let startedAt = Date.now()
  const onStart = async (started: RepoAction) => {
    startedAt = Date.now()
    const message = started === "update" ? updateStartMessage(repo) : buildStartMessage(repo)
    await showToastBestEffort(input, message, TOAST_VARIANTS.INFO, INFO_DURATION_MS)
  }

  const outcome = await buildRepoGraph(root, action, mode, onStart)
  const warnGlobalMerge = async (recovery: string | undefined) => {
    if (!recovery) return
    await showToastBestEffort(input, globalMergeWarningMessage(repo, recovery), TOAST_VARIANTS.WARNING, WARNING_DURATION_MS)
  }
  switch (outcome.kind) {
    case "empty":
      await showToastBestEffort(input, emptyCorpusMessage(repo), TOAST_VARIANTS.INFO, INFO_DURATION_MS)
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
        processFailureMessage(repo, recoveryBuildCommand(root, mode)),
        TOAST_VARIANTS.ERROR,
        ERROR_DURATION_MS,
      )
      return
    case "incomplete":
      await showToastBestEffort(
        input,
        incompleteMessage(repo, recoveryBuildCommand(root, mode)),
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

type WorkItem = { root: string; action: RepoAction; mode: IndexMode }

async function presentAggregate(input: ToastInput, root: string, work: WorkItem[]) {
  const rootName = repoName(root)
  await showToastBestEffort(input, aggregateStartMessage(work.length, rootName), TOAST_VARIANTS.INFO, INFO_DURATION_MS)
  const startedAt = Date.now()
  const failed: string[] = []
  let built = 0
  let locked = 0
  for (const item of work) {
    // A nested repository with nothing to index is skipped, not counted as a failure.
    const outcome = await buildRepoGraph(item.root, item.action, item.mode, async () => {})
    if (outcome.kind === "ready") built += 1
    else if (outcome.kind === "locked") locked += 1
    else if (outcome.kind !== "empty" && outcome.kind !== "zero-nodes") failed.push(item.root)
    // A failed global merge exits 0, so it never lands in `failed`; it gets its own toast.
    if ((outcome.kind === "ready" || outcome.kind === "zero-nodes") && outcome.globalRecovery) {
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
    else if (plan.kind !== "none") work.push({ root, action: plan.kind, mode: plan.mode })
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

  if (aggregated.length === 0) return presentSingleRoot(input, work[0].root, work[0].action, work[0].mode)
  return presentAggregate(input, root, work)
}

export const GraphifyInitPlugin: Plugin = async (input) => {
  const root = projectRoot(input)
  armToastFallback()
  void initializeGraphify({ client: input.client, directory: input.directory, root }).catch((error) => {
    console.error(`${LOG_PREFIX} ${errorMessage(error)}`)
  })
  return {
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
