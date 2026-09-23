// src/server.ts
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
var GRAPHIFY_INIT_PLUGIN_ID = "andresnator.graphify-init";
var LOG_PREFIX = "[graphify-init]";
var GRAPHIFY_BINARY = "graphify";
var GRAPHIFY_INSTALL_HINT = "uv tool install graphifyy (or pipx install graphifyy)";
var GIT_BINARY = "git";
var AUTOINIT_ENV = "OPENCODE_GRAPHIFY_AUTOINIT";
var GLOBAL_ENV = "OPENCODE_GRAPHIFY_GLOBAL";
var AUTOINIT_OPT_OUT = "0";
var GLOBAL_OPT_OUT = "0";
var OUT_BASE = ".ai";
var OUT_DIR = "graphify-out";
var GRAPHIFY_OUT_ENV = "GRAPHIFY_OUT";
var OUT_RELATIVE = `${OUT_BASE}/${OUT_DIR}`;
var GRAPH_FILE = "graph.json";
var EMPTY_MARKER_FILE = ".opencode-empty-corpus";
var MODE_FILE = ".opencode-index-mode";
var MODE_CODE_ONLY = "code-only";
var POLICY_VERSION = 1;
var GENERATED_ARTIFACTS = ["graph.json", "manifest.json", ".graphify_root", ".graphify_semantic_marker", ".opencode-empty-corpus", "cache"];
var GLOBAL_MANIFEST = "global-manifest.json";
var GLOBAL_GRAPH = "global-graph.json";
var GLOBAL_LOCK = ".opencode-global-lock";
var LOCK_FILE = ".opencode-extract-lock";
var INDEX_COMMAND = "/graphify-index";
var INDEX_COMMAND_NAME = "graphify-index";
var INDEX_COMMAND_DESCRIPTION = "First-time code-only Graphify indexing with explicit human consent and automatic refreshes.";
var INDEX_COMMAND_FILE = new URL("../commands/graphify-index.md", import.meta.url);
var EMPTY_MARKER_NO_COMMIT = "none";
var EMPTY_CORPUS_PATTERN = /produced no nodes/i;
var GLOBAL_MERGE_WARNING_PATTERN = /\[graphify global\] warning/i;
var EXTRACT_ARGS = ["extract"];
var CODE_ONLY_FLAG = "--code-only";
var AS_FLAG = "--as";
var VERSION_ARGS = ["--version"];
var GIT_EXCLUDE_ARGS = ["rev-parse", "--is-inside-work-tree", "--git-path", "info/exclude"];
var GIT_HEAD_ARGS = ["rev-parse", "HEAD"];
var GIT_HEAD_TIME_ARGS = ["log", "-1", "--format=%ct"];
var GIT_WORK_TREE_RESULT = "true";
var NOT_GIT_REPOSITORY_ERROR = "not a git repository";
var IGNORED_DIRECTORY_NAMES = /* @__PURE__ */ new Set(["node_modules"]);
var NESTED_REPO_MAX_DEPTH = 2;
var MAX_SUMMARY_FAILURES = 3;
var MAX_CAPTURED_OUTPUT_LENGTH = 1e3;
var INFO_DURATION_MS = 5e3;
var HINT_DURATION_MS = 8e3;
var WARNING_DURATION_MS = 8e3;
var ERROR_DURATION_MS = 8e3;
var TOAST_READY_FALLBACK_MS = 1e4;
var TOAST_DELAY_ENV = "OPENCODE_GRAPHIFY_TOAST_DELAY_MS";
var PROBE_TIMEOUT_MS = 15e3;
var EXTRACT_TIMEOUT_MS = 30 * 60 * 1e3;
var EXTRACT_TIMEOUT_ENV = "OPENCODE_GRAPHIFY_EXTRACT_TIMEOUT_MS";
var KILL_GRACE_MS = 2e3;
var timedOutMessage = (binary, timeoutMs) => `${binary} exceeded its ${Math.round(timeoutMs / 1e3)}s budget and was terminated`;
var TOAST_VARIANTS = {
  ERROR: "error",
  INFO: "info",
  SUCCESS: "success",
  WARNING: "warning"
};
var buildStartMessage = (repo) => `Graphify is building the code graph for ${repo} in the background. You can keep working.`;
var updateStartMessage = (repo) => `Graphify is updating the ${repo} code graph in the background. You can keep working.`;
var successMessage = (repo, nodeCount, elapsed) => nodeCount === void 0 ? `Graphify graph for ${repo} is ready in ${elapsed}.` : `Graphify graph for ${repo} is ready: ${nodeCount} nodes in ${elapsed}.`;
var emptyCorpusMessage = (repo) => `Graphify found no indexable code in ${repo}; skipping the code graph.`;
var zeroNodeMessage = (repo) => `Graphify found no indexable code left in ${repo}; the graph is now empty.`;
var aggregateEmptyMessage = (rootName) => `Graphify found no indexable code in the repositories under ${rootName}; skipping the code graphs.`;
var globalMergeWarningMessage = (repo, command) => `Graphify could not merge ${repo} into the global graph; cross-repository queries stay stale. Run: ${command}`;
var missingBinaryMessage = () => `Graphify CLI was not found. Run: ${GRAPHIFY_INSTALL_HINT}`;
var incompleteMessage = (repo, command) => `Graphify graph for ${repo} is incomplete (${OUT_BASE}/${OUT_DIR}/${GRAPH_FILE} is missing or unreadable). Run: ${command}`;
var processFailureMessage = (repo, command) => `Graphify indexing failed for ${repo}, but this session is still operational. Run: ${command}`;
var noGraphMessage = (repo) => `No Graphify graph exists for ${repo} yet. Run ${INDEX_COMMAND} to authorize code-only indexing. Refreshes after that are incremental and automatic.`;
var repositoriesLabel = (count) => `${count} ${count === 1 ? "repository" : "repositories"}`;
var aggregateNoGraphMessage = (count, rootName) => `${repositoriesLabel(count)} under ${rootName} ${count === 1 ? "has" : "have"} no Graphify graph yet. Run ${INDEX_COMMAND} from ${rootName} to build them; refreshes after that are incremental and automatic.`;
var aggregateStartMessage = (count, rootName) => `Graphify is building code graphs for ${repositoriesLabel(count)} under ${rootName} in the background. You can keep working.`;
var aggregateSuccessMessage = (count, rootName, elapsed) => `Graphify built code graphs for ${repositoriesLabel(count)} under ${rootName} in ${elapsed}.`;
var aggregateFailureMessage = (okCount, total, rootName, failedNames) => {
  const shown = failedNames.slice(0, MAX_SUMMARY_FAILURES);
  const overflow = failedNames.length - shown.length;
  const list = overflow > 0 ? `${shown.join(", ")}, +${overflow} more` : shown.join(", ");
  return `Graphify built ${okCount} of ${total} code graphs under ${rootName}. Failed: ${list}. Reopen the session to retry, or run ${INDEX_COMMAND}.`;
};
function projectRoot(input) {
  const reportedWorktree = input.worktree ?? "";
  if (!reportedWorktree || reportedWorktree === path.parse(reportedWorktree).root) return input.directory;
  return reportedWorktree;
}
function repoName(root) {
  return path.basename(root) || root;
}
function quoteForDisplay(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
function outEnvPrefix() {
  return `${GRAPHIFY_OUT_ENV}=${OUT_RELATIVE}`;
}
function recoveryBuildCommand(root) {
  return [outEnvPrefix(), GRAPHIFY_BINARY, EXTRACT_ARGS[0], quoteForDisplay(root), CODE_ONLY_FLAG].join(" ");
}
function formatElapsed(elapsedMs) {
  return `${Math.max(0.1, elapsedMs / 1e3).toFixed(1)}s`;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
var indexCommandTemplate;
function loadIndexCommandTemplate() {
  indexCommandTemplate ??= fs.readFile(INDEX_COMMAND_FILE, "utf8").then((template) => template.trim());
  return indexCommandTemplate;
}
async function registerGraphifyIndexCommand(config) {
  config.command ??= {};
  if (config.command[INDEX_COMMAND_NAME]) {
    return;
  }
  config.command[INDEX_COMMAND_NAME] = {
    template: await loadIndexCommandTemplate(),
    description: INDEX_COMMAND_DESCRIPTION,
    agent: "build"
  };
}
function appendBoundedOutput(current, chunk) {
  return `${current}${String(chunk)}`.slice(-MAX_CAPTURED_OUTPUT_LENGTH);
}
var liveChildren = /* @__PURE__ */ new Set();
var shutdownHooksInstalled = false;
var SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
function killLiveChildren() {
  for (const child of liveChildren) {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      console.error(`${LOG_PREFIX} cannot kill child process: ${errorMessage(error)}`);
    }
  }
  liveChildren.clear();
}
function installShutdownHooks() {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;
  process.once("exit", killLiveChildren);
  for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
    process.once(signal, () => {
      killLiveChildren();
      if (process.listenerCount(signal) === 0) process.exit(exitCode);
    });
  }
}
function extractTimeoutMs() {
  const raw = process.env[EXTRACT_TIMEOUT_ENV];
  if (raw !== void 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return EXTRACT_TIMEOUT_MS;
}
function runCommand(binary, args, root, options = {}) {
  return new Promise((resolve) => {
    installShutdownHooks();
    const child = spawn(binary, [...args], {
      cwd: root,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    liveChildren.add(child);
    options.onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    let spawnError;
    const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    let killTimer;
    const kill = (signal) => {
      try {
        child.kill(signal);
      } catch (error) {
        console.error(`${LOG_PREFIX} cannot terminate ${binary}: ${errorMessage(error)}`);
      }
    };
    const budgetTimer = setTimeout(() => {
      spawnError = new Error(timedOutMessage(binary, timeoutMs));
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    budgetTimer.unref?.();
    child.stdout?.on("data", (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode) => {
      clearTimeout(budgetTimer);
      if (killTimer) clearTimeout(killTimer);
      liveChildren.delete(child);
      resolve({ exitCode, stdout, stderr, error: spawnError });
    });
  });
}
function runGraphify(args, root, options = {}) {
  return runCommand(GRAPHIFY_BINARY, args, root, { ...options, env: { [GRAPHIFY_OUT_ENV]: OUT_RELATIVE } });
}
function isMissingBinary(result) {
  return Boolean(result.error && "code" in result.error && result.error.code === "ENOENT");
}
async function isBinaryMissing(root) {
  return isMissingBinary(await runGraphify(VERSION_ARGS, root));
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function outBasePath(root) {
  return path.join(root, OUT_BASE);
}
function outDirPath(root) {
  return path.join(outBasePath(root), OUT_DIR);
}
function graphFilePath(root) {
  return path.join(outDirPath(root), GRAPH_FILE);
}
function nodeCountOf(payload) {
  if (!isRecord(payload)) return void 0;
  if (Array.isArray(payload.nodes)) return payload.nodes.length;
  if (isRecord(payload.stats) && typeof payload.stats.nodes === "number") return payload.stats.nodes;
  return void 0;
}
async function readGraph(root) {
  const graphPath = graphFilePath(root);
  try {
    const stat = await fs.stat(graphPath);
    if (!stat.isFile()) return void 0;
    const payload = JSON.parse(await fs.readFile(graphPath, "utf8"));
    if (!isRecord(payload)) return void 0;
    const builtAtCommit = typeof payload.built_at_commit === "string" ? payload.built_at_commit : void 0;
    return { mtimeMs: stat.mtimeMs, builtAtCommit, nodeCount: nodeCountOf(payload) };
  } catch {
    return void 0;
  }
}
async function gitValue(root, args) {
  const result = await runCommand(GIT_BINARY, args, root);
  if (result.error || result.exitCode !== 0) return void 0;
  return result.stdout.trim() || void 0;
}
async function isGraphStale(root, graph) {
  const head = await gitValue(root, GIT_HEAD_ARGS);
  if (!head) return false;
  if (graph.builtAtCommit) return graph.builtAtCommit !== head;
  const headTime = Number.parseInt(await gitValue(root, GIT_HEAD_TIME_ARGS) ?? "", 10);
  if (!Number.isFinite(headTime)) return false;
  return graph.mtimeMs < headTime * 1e3;
}
function emptyMarkerPath(root) {
  return path.join(outDirPath(root), EMPTY_MARKER_FILE);
}
async function readEmptyMarker(root) {
  try {
    return (await fs.readFile(emptyMarkerPath(root), "utf8")).trim() || void 0;
  } catch {
    return void 0;
  }
}
async function writeEmptyMarker(root, commit) {
  try {
    await fs.writeFile(emptyMarkerPath(root), `${commit ?? EMPTY_MARKER_NO_COMMIT}
`);
    return true;
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot record empty-corpus marker for ${root}: ${errorMessage(error)}`);
    return false;
  }
}
async function clearEmptyMarker(root) {
  try {
    await fs.unlink(emptyMarkerPath(root));
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return true;
    console.error(`${LOG_PREFIX} cannot clear empty-corpus marker for ${root}: ${errorMessage(error)}`);
    return false;
  }
}
function modeFilePath(root) {
  return path.join(outDirPath(root), MODE_FILE);
}
async function readIndexState(root) {
  try {
    const payload = JSON.parse(await fs.readFile(modeFilePath(root), "utf8"));
    if (!isRecord(payload) || payload.mode !== MODE_CODE_ONLY && payload.mode !== "docs") return void 0;
    return {
      mode: MODE_CODE_ONLY,
      policyVersion: payload.mode === MODE_CODE_ONLY && payload.policyVersion === POLICY_VERSION ? POLICY_VERSION : void 0,
      pendingGlobal: payload.pendingGlobal === true
    };
  } catch {
    return void 0;
  }
}
async function persistIndexState(root, state) {
  const target = modeFilePath(root);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(state)}
`, { flag: "wx" });
    await fs.rename(temporary, target);
    return true;
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot record indexing policy for ${root}: ${errorMessage(error)}`);
    await fs.rm(temporary, { force: true }).catch(() => {
    });
    return false;
  }
}
function lockFilePath(root) {
  return path.join(outDirPath(root), LOCK_FILE);
}
async function safeStateDirectory(root) {
  for (const dir of [outBasePath(root), outDirPath(root)]) {
    try {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") return false;
      try {
        await fs.mkdir(dir);
      } catch {
        return false;
      }
    }
  }
  return true;
}
async function acquireLock(lockPath) {
  try {
    const handle = await fs.open(lockPath, "wx", 384);
    try {
      await handle.writeFile(`${process.pid}
`);
      return handle;
    } catch (error) {
      await handle.close();
      console.error(`${LOG_PREFIX} cannot initialize lock ${lockPath}: ${errorMessage(error)}`);
      return void 0;
    }
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      console.error(`${LOG_PREFIX} lock already exists at ${lockPath}; refusing automatic takeover`);
    } else console.error(`${LOG_PREFIX} cannot acquire lock ${lockPath}: ${errorMessage(error)}`);
    return void 0;
  }
}
async function acquireExtractLock(root) {
  if (!await safeStateDirectory(root)) return void 0;
  return acquireLock(lockFilePath(root));
}
async function recordLockChildPid(lock, childPid) {
  if (childPid === void 0) return false;
  try {
    const bytes = Buffer.from(`${process.pid}
${childPid}
`);
    const result = await lock.write(bytes, 0, bytes.length, 0);
    if (result.bytesWritten !== bytes.length) return false;
    await lock.truncate(bytes.length);
    return true;
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot record CLI child PID: ${errorMessage(error)}`);
    return false;
  }
}
async function releaseLock(lockPath, lock, safeToRelease) {
  try {
    if (!safeToRelease) return;
    const [held, current] = await Promise.all([lock.stat(), fs.lstat(lockPath)]);
    if (current.isFile() && !current.isSymbolicLink() && held.dev === current.dev && held.ino === current.ino) {
      await fs.unlink(lockPath);
    } else console.error(`${LOG_PREFIX} lock owner changed at ${lockPath}; retaining it`);
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot release lock ${lockPath}: ${errorMessage(error)}`);
  } finally {
    await lock.close().catch(() => {
    });
  }
}
async function cleanGeneratedArtifacts(root) {
  const directory = outDirPath(root);
  for (const name of GENERATED_ARTIFACTS) {
    try {
      const stat = await fs.lstat(path.join(directory, name));
      if (stat.isSymbolicLink() || (name === "cache" ? !stat.isDirectory() : !stat.isFile())) return false;
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") return false;
    }
  }
  for (const name of GENERATED_ARTIFACTS) {
    const target = path.join(directory, name);
    if (name === "cache") {
      const scan = async (dir) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) return false;
          if (entry.isDirectory() && !await scan(path.join(dir, entry.name))) return false;
        }
        return true;
      };
      try {
        if (!await scan(target)) return false;
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") return false;
      }
    }
    try {
      await fs.rm(target, { recursive: name === "cache", force: true });
    } catch {
      return false;
    }
  }
  return true;
}
function globalDirectory() {
  return path.join(process.env.HOME ?? "", ".graphify");
}
async function reconcileGlobal(root, empty) {
  if (!isGlobalEnabled()) return false;
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) return false;
  const dir = globalDirectory();
  try {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") return false;
    try {
      await fs.mkdir(dir);
    } catch {
      return false;
    }
  }
  const lockPath = path.join(dir, GLOBAL_LOCK);
  const lock = await acquireLock(lockPath);
  if (!lock) return false;
  let safeToRelease = true;
  try {
    const manifestPath = path.join(dir, GLOBAL_MANIFEST);
    const graphPath = path.join(dir, GLOBAL_GRAPH);
    const existing = await Promise.all([manifestPath, graphPath].map(async (file) => {
      try {
        const stat = await fs.lstat(file);
        return stat.isFile() && !stat.isSymbolicLink() ? "file" : "unsafe";
      } catch (error) {
        return isRecord(error) && error.code === "ENOENT" ? "absent" : "unsafe";
      }
    }));
    if (existing.includes("unsafe") || existing[0] === "absent" && existing[1] === "file" || existing[0] === "file" && existing[1] === "absent") return false;
    let repos = {};
    if (existing[0] === "file") {
      const data = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (!isRecord(data) || !isRecord(data.repos)) return false;
      repos = data.repos;
      const graph = JSON.parse(await fs.readFile(graphPath, "utf8"));
      if (!isRecord(graph) || !Array.isArray(graph.nodes) || !(Array.isArray(graph.links) || Array.isArray(graph.edges))) return false;
      if (Object.values(repos).some((entry) => !isRecord(entry) || typeof entry.source_path !== "string")) return false;
    }
    const tag = slugify(repoName(await realRoot(root)));
    const owner = repos[tag];
    const ownedPath = await fs.realpath(outDirPath(root));
    const expected = path.join(ownedPath, GRAPH_FILE);
    if (owner && (!isRecord(owner) || owner.source_path !== expected)) return false;
    if (!empty) {
      const stat = await fs.lstat(graphFilePath(root));
      if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(graphFilePath(root)) !== expected) return false;
    }
    if (empty && !owner) return true;
    const args = empty ? ["global", "remove", tag] : ["global", "add", expected, AS_FLAG, tag];
    let childPidRecorded = Promise.resolve(false);
    const run = await runGraphify(args, root, {
      onSpawn: (child) => {
        safeToRelease = false;
        childPidRecorded = recordLockChildPid(lock, child.pid);
      },
      timeoutMs: extractTimeoutMs()
    });
    if (!await childPidRecorded || run.error || run.exitCode !== 0 || GLOBAL_MERGE_WARNING_PATTERN.test(run.stderr)) return false;
    safeToRelease = true;
    return true;
  } catch (error) {
    console.error(`${LOG_PREFIX} global reconciliation refused: ${errorMessage(error)}`);
    return false;
  } finally {
    await releaseLock(lockPath, lock, safeToRelease);
  }
}
async function planRepo(root) {
  const state = await readIndexState(root);
  const graph = await readGraph(root);
  const emptyAtCommit = await readEmptyMarker(root);
  if (!state && !graph && !emptyAtCommit) return { kind: "needs-consent" };
  if (state?.policyVersion !== POLICY_VERSION) return { kind: "build" };
  const head = await gitValue(root, GIT_HEAD_ARGS) ?? EMPTY_MARKER_NO_COMMIT;
  if (emptyAtCommit === head || graph && !await isGraphStale(root, graph)) {
    return state.pendingGlobal && isGlobalEnabled() ? { kind: "reconcile" } : { kind: "none" };
  }
  return { kind: graph ? "update" : "build" };
}
async function realRoot(dir) {
  try {
    return await fs.realpath(dir);
  } catch {
    return path.resolve(dir);
  }
}
function slugify(value) {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, "-");
}
function isGlobalEnabled() {
  return process.env[GLOBAL_ENV] !== GLOBAL_OPT_OUT;
}
var toastClientReady = false;
var toastFallbackTimer;
var pendingToasts = [];
function toastFallbackDelayMs() {
  const raw = process.env[TOAST_DELAY_ENV];
  if (raw !== void 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return TOAST_READY_FALLBACK_MS;
}
async function sendToast(input, message, variant, duration) {
  try {
    await input.client.tui.showToast({
      body: { message, variant, duration },
      query: { directory: input.directory }
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} toast failed: ${errorMessage(error)}`);
  }
}
var CLIENT_EVENT_PREFIXES = ["session.", "message.", "permission.", "tui.", "command."];
function isClientDrivenEvent(type) {
  return CLIENT_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}
async function releaseQueuedToasts() {
  if (toastClientReady) return;
  toastClientReady = true;
  if (toastFallbackTimer !== void 0) {
    clearTimeout(toastFallbackTimer);
    toastFallbackTimer = void 0;
  }
  for (const toast of pendingToasts.splice(0)) {
    await sendToast(toast.input, toast.message, toast.variant, toast.duration);
  }
}
function armToastFallback() {
  if (toastClientReady || toastFallbackTimer !== void 0) return;
  toastFallbackTimer = setTimeout(() => {
    toastFallbackTimer = void 0;
    void releaseQueuedToasts();
  }, toastFallbackDelayMs());
  toastFallbackTimer.unref?.();
}
async function showToastBestEffort(input, message, variant, duration) {
  if (!toastClientReady) {
    pendingToasts.push({ input, message, variant, duration });
    return;
  }
  await sendToast(input, message, variant, duration);
}
async function resolveGitExcludePath(root) {
  const result = await runCommand(GIT_BINARY, GIT_EXCLUDE_ARGS, root);
  const stderr = result.stderr.trim();
  if (result.error || result.exitCode !== 0) {
    if (!result.error && stderr.toLowerCase().includes(NOT_GIT_REPOSITORY_ERROR)) return;
    const detail = result.error ? errorMessage(result.error) : stderr || `exit ${result.exitCode}`;
    console.error(`${LOG_PREFIX} cannot resolve Git exclude path: ${detail}`);
    return;
  }
  const [insideWorkTree, excludePath] = result.stdout.trim().split(/\r?\n/, 2);
  if (insideWorkTree !== GIT_WORK_TREE_RESULT) return;
  if (!excludePath) {
    console.error(`${LOG_PREFIX} Git did not return an exclude path`);
    return;
  }
  return path.resolve(root, excludePath);
}
async function ensureGitExclude(root, artifactPath) {
  const relativeArtifactPath = path.relative(root, artifactPath);
  if (!relativeArtifactPath || relativeArtifactPath.startsWith("..") || path.isAbsolute(relativeArtifactPath)) {
    console.error(`${LOG_PREFIX} cannot exclude artifact path outside project: ${artifactPath}`);
    return;
  }
  const entry = relativeArtifactPath.split(path.sep).join("/").replace(/\/$/, "");
  const excludePath = await resolveGitExcludePath(root);
  if (!excludePath) return;
  let text;
  try {
    text = await fs.readFile(excludePath, "utf8");
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot read Git exclude file: ${errorMessage(error)}`);
    return;
  }
  if (text.split(/\r?\n/).includes(entry)) return;
  try {
    await fs.appendFile(excludePath, text.endsWith("\n") ? `${entry}
` : `
${entry}
`);
  } catch (error) {
    console.error(`${LOG_PREFIX} cannot update Git exclude file: ${errorMessage(error)}`);
  }
}
function recoveryGlobalCommand(root, tag, empty) {
  if (empty) return `${GRAPHIFY_BINARY} global remove ${quoteForDisplay(tag)}`;
  const graphPath = path.join(root, OUT_RELATIVE, GRAPH_FILE);
  return [GRAPHIFY_BINARY, "global", "add", quoteForDisplay(graphPath), AS_FLAG, tag].join(" ");
}
async function buildRepoGraph(root, action, onStart) {
  const lock = await acquireExtractLock(root);
  if (!lock) return { kind: "locked" };
  let safeToRelease = true;
  try {
    const current = await planRepo(root);
    if (current.kind === "none" || current.kind === "needs-consent") return { kind: "locked" };
    const tag = slugify(repoName(await realRoot(root)));
    const state = await readIndexState(root);
    const migrate = state?.policyVersion !== POLICY_VERSION;
    if (migrate && !await cleanGeneratedArtifacts(root)) {
      console.error(`${LOG_PREFIX} unsafe generated artifacts; refusing migration for ${root}`);
      return { kind: "action-failed", action };
    }
    const args = [...EXTRACT_ARGS, root, CODE_ONLY_FLAG];
    await ensureGitExclude(root, outDirPath(root));
    const reconcile = async (empty) => {
      const ok = await reconcileGlobal(root, empty);
      const saved = ok && await persistIndexState(root, { mode: MODE_CODE_ONLY, policyVersion: POLICY_VERSION, pendingGlobal: false });
      if (!saved && isGlobalEnabled()) console.error(`${LOG_PREFIX} global reconciliation pending for ${root}`);
      return saved ? void 0 : isGlobalEnabled() ? recoveryGlobalCommand(root, tag, empty) : void 0;
    };
    if (current.kind === "reconcile") {
      const empty = await readEmptyMarker(root) !== void 0 || (await readGraph(root))?.nodeCount === 0;
      const recovery = await reconcile(empty);
      return { kind: "reconciled", globalRecovery: recovery };
    }
    await onStart(action);
    for (let attempt = 0; ; attempt += 1) {
      const headBefore = await gitValue(root, GIT_HEAD_ARGS);
      let childPidRecorded = Promise.resolve(false);
      const run = await runGraphify(args, root, {
        onSpawn: (child) => {
          safeToRelease = false;
          childPidRecorded = recordLockChildPid(lock, child.pid);
        },
        timeoutMs: extractTimeoutMs()
      });
      if (!await childPidRecorded) return { kind: "action-failed", action };
      if (run.error || run.exitCode !== 0) {
        if (!run.error && EMPTY_CORPUS_PATTERN.test(`${run.stdout}
${run.stderr}`)) {
          if (headBefore !== await gitValue(root, GIT_HEAD_ARGS)) return { kind: "action-failed", action };
          if (!await cleanGeneratedArtifacts(root)) return { kind: "action-failed", action };
          if (!await writeEmptyMarker(root, headBefore)) return { kind: "action-failed", action };
          if (!await persistIndexState(root, { mode: MODE_CODE_ONLY, policyVersion: POLICY_VERSION, pendingGlobal: true })) return { kind: "action-failed", action };
          safeToRelease = true;
          return { kind: "empty", globalRecovery: await reconcile(true) };
        }
        const detail = run.error ? errorMessage(run.error) : run.stderr.trim();
        if (detail) console.error(`${LOG_PREFIX} ${action} failed for ${root}: ${detail}`);
        return { kind: "action-failed", action };
      }
      const graph = await readGraph(root);
      if (!graph) return { kind: "incomplete", action };
      if (headBefore !== await gitValue(root, GIT_HEAD_ARGS)) {
        if (attempt === 0) continue;
        console.error(`${LOG_PREFIX} HEAD kept moving during extraction of ${root}; giving up for this session`);
        return { kind: "action-failed", action };
      }
      if (!await clearEmptyMarker(root)) return { kind: "action-failed", action };
      if (!await persistIndexState(root, { mode: MODE_CODE_ONLY, policyVersion: POLICY_VERSION, pendingGlobal: true })) return { kind: "action-failed", action };
      safeToRelease = true;
      const globalRecovery = await reconcile(graph.nodeCount === 0);
      if (graph.nodeCount === 0) return { kind: "zero-nodes", globalRecovery };
      return { kind: "ready", action, nodeCount: graph.nodeCount, globalRecovery };
    }
  } finally {
    await releaseLock(lockFilePath(root), lock, safeToRelease);
  }
}
async function presentSingleRoot(input, root, action) {
  const repo = repoName(root);
  let startedAt = Date.now();
  const onStart = async (started) => {
    startedAt = Date.now();
    const message = started === "update" ? updateStartMessage(repo) : buildStartMessage(repo);
    await showToastBestEffort(input, message, TOAST_VARIANTS.INFO, INFO_DURATION_MS);
  };
  const outcome = await buildRepoGraph(root, action, onStart);
  const warnGlobalMerge = async (recovery) => {
    if (!recovery) return;
    await showToastBestEffort(input, globalMergeWarningMessage(repo, recovery), TOAST_VARIANTS.WARNING, WARNING_DURATION_MS);
  };
  switch (outcome.kind) {
    case "reconciled":
      await warnGlobalMerge(outcome.globalRecovery);
      return;
    case "empty":
      await showToastBestEffort(input, emptyCorpusMessage(repo), TOAST_VARIANTS.INFO, INFO_DURATION_MS);
      await warnGlobalMerge(outcome.globalRecovery);
      return;
    case "zero-nodes":
      await showToastBestEffort(input, zeroNodeMessage(repo), TOAST_VARIANTS.INFO, INFO_DURATION_MS);
      await warnGlobalMerge(outcome.globalRecovery);
      return;
    case "locked":
      return;
    case "action-failed":
      await showToastBestEffort(
        input,
        processFailureMessage(repo, recoveryBuildCommand(root)),
        TOAST_VARIANTS.ERROR,
        ERROR_DURATION_MS
      );
      return;
    case "incomplete":
      await showToastBestEffort(
        input,
        incompleteMessage(repo, recoveryBuildCommand(root)),
        TOAST_VARIANTS.WARNING,
        WARNING_DURATION_MS
      );
      return;
    case "ready":
      await showToastBestEffort(
        input,
        successMessage(repo, outcome.nodeCount, formatElapsed(Date.now() - startedAt)),
        TOAST_VARIANTS.SUCCESS,
        INFO_DURATION_MS
      );
      await warnGlobalMerge(outcome.globalRecovery);
      return;
  }
}
async function presentAggregate(input, root, work) {
  const rootName = repoName(root);
  await showToastBestEffort(input, aggregateStartMessage(work.length, rootName), TOAST_VARIANTS.INFO, INFO_DURATION_MS);
  const startedAt = Date.now();
  const failed = [];
  let built = 0;
  let locked = 0;
  for (const item of work) {
    const outcome = await buildRepoGraph(item.root, item.action, async () => {
    });
    if (outcome.kind === "ready") built += 1;
    else if (outcome.kind === "locked" || outcome.kind === "reconciled") locked += 1;
    else if (outcome.kind !== "empty" && outcome.kind !== "zero-nodes") failed.push(item.root);
    if ((outcome.kind === "ready" || outcome.kind === "zero-nodes" || outcome.kind === "empty" || outcome.kind === "reconciled") && outcome.globalRecovery) {
      await showToastBestEffort(
        input,
        globalMergeWarningMessage(repoName(item.root), outcome.globalRecovery),
        TOAST_VARIANTS.WARNING,
        WARNING_DURATION_MS
      );
    }
  }
  if (failed.length === 0) {
    if (built === 0) {
      if (locked > 0) return;
      await showToastBestEffort(input, aggregateEmptyMessage(rootName), TOAST_VARIANTS.INFO, INFO_DURATION_MS);
      return;
    }
    await showToastBestEffort(
      input,
      aggregateSuccessMessage(built, rootName, formatElapsed(Date.now() - startedAt)),
      TOAST_VARIANTS.SUCCESS,
      INFO_DURATION_MS
    );
    return;
  }
  await showToastBestEffort(
    input,
    aggregateFailureMessage(
      built,
      work.length,
      rootName,
      failed.map((repo) => path.relative(root, repo))
    ),
    TOAST_VARIANTS.WARNING,
    WARNING_DURATION_MS
  );
}
async function hasGitEntry(dir) {
  try {
    const stat = await fs.stat(path.join(dir, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}
async function discoverNestedRepos(root) {
  const repos = [];
  async function scan(dir, depth) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (await hasGitEntry(child)) {
        repos.push(child);
        continue;
      }
      if (depth < NESTED_REPO_MAX_DEPTH) await scan(child, depth + 1);
    }
  }
  await scan(root, 1);
  return repos.sort((a, b) => a.localeCompare(b));
}
async function collectWork(roots) {
  const work = [];
  const needsConsent = [];
  for (const root of roots) {
    const plan = await planRepo(root);
    if (plan.kind === "needs-consent") needsConsent.push(root);
    else if (plan.kind !== "none") work.push({ root, action: plan.kind === "reconcile" ? "update" : plan.kind });
  }
  return { work, needsConsent };
}
async function initializeGraphify(input) {
  if (process.env[AUTOINIT_ENV] === AUTOINIT_OPT_OUT) return;
  const { root } = input;
  const aggregated = await hasGitEntry(root) ? [] : await discoverNestedRepos(root);
  const roots = aggregated.length > 0 ? aggregated : [root];
  const { work, needsConsent } = await collectWork(roots);
  if (needsConsent.length > 0) {
    const message = aggregated.length === 0 ? noGraphMessage(repoName(needsConsent[0])) : aggregateNoGraphMessage(needsConsent.length, repoName(root));
    await showToastBestEffort(input, message, TOAST_VARIANTS.INFO, HINT_DURATION_MS);
  }
  if (work.length === 0) return;
  if (await isBinaryMissing(root)) {
    await showToastBestEffort(input, missingBinaryMessage(), TOAST_VARIANTS.WARNING, WARNING_DURATION_MS);
    return;
  }
  if (aggregated.length === 0) return presentSingleRoot(input, work[0].root, work[0].action);
  return presentAggregate(input, root, work);
}
var GraphifyInitPlugin = async (input) => {
  const root = projectRoot(input);
  armToastFallback();
  void initializeGraphify({ client: input.client, directory: input.directory, root }).catch((error) => {
    console.error(`${LOG_PREFIX} ${errorMessage(error)}`);
  });
  return {
    config: registerGraphifyIndexCommand,
    // A client-driven bus event means a subscribed client is interacting, so queued
    // toasts can land; boot-time housekeeping events must not trip the latch.
    event: async ({ event }) => {
      if (isClientDrivenEvent(event?.type ?? "")) await releaseQueuedToasts();
    }
  };
};
var server_default = {
  id: GRAPHIFY_INIT_PLUGIN_ID,
  server: GraphifyInitPlugin
};
export {
  GRAPHIFY_INIT_PLUGIN_ID,
  GraphifyInitPlugin,
  server_default as default,
  registerGraphifyIndexCommand
};
